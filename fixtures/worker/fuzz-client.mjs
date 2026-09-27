import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, credentials } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

function diagnostics(surface) {
    let call = surface.call;
    while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
    assert.ok(call, 'transport diagnostics are observable');
    return call.diagnostics();
}

async function invoke(client, sample) {
    let callbacks = 0, errors = 0, callbackCode, value, surface;
    const statuses = [], payloads = [], metadata = [];
    const requestBytes = Buffer.from(sample.request, 'base64');
    const backing = Buffer.alloc(requestBytes.length + 12, 253);
    requestBytes.copy(backing, 5);
    const input = backing.subarray(5, 5 + requestBytes.length);
    const done = new Promise(resolve => {
        const options = { deadline: Date.now() + 5000 };
        if (sample.streaming) {
            surface = client.makeServerStreamRequest('/fixture.Fuzz/Stream', data => data, data => data, input, options);
            surface.on('data', data => payloads.push(data.toString('base64')));
            surface.on('error', () => { errors++; });
        } else {
            surface = client.makeUnaryRequest('/fixture.Fuzz/Unary', data => data, data => data, input, options, (error, data) => {
                callbacks++; callbackCode = error?.code ?? 0; value = data?.toString('base64');
            });
        }
        surface.on('metadata', item => metadata.push(item.get('x-fuzz-peer')));
        surface.on('status', result => { statuses.push({ code: result.code, details: result.details,
            trace: result.metadata.get('trace-bin').map(data => data.toString('base64')) }); resolve(); });
    });
    await done;
    // Include callbacks queued by stream EOF and abort cleanup before inspecting.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(statuses.length, 1, 'exactly one terminal status');
    assert.equal(callbacks, sample.streaming ? 0 : 1, 'exactly one unary callback');
    assert.equal(errors, sample.streaming && statuses[0].code !== 0 ? 1 : 0, 'one stream error at most');
    assert.equal(client.getChannel().activeCallCount(), 0, 'no active call after completion');
    assert.deepEqual(diagnostics(surface), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
    return { statuses, callbackCode, value, callbacks, errors, payloads, metadata, activeCalls: 0, diagnostics: diagnostics(surface) };
}

let invocations = 0;
export default {
    async fetch(request, env) {
        const clients = [];
        try {
            const { sample, recovery } = await request.json();
            const invocation = ++invocations, results = [];
            for (const mode of ['cloudflare', 'grpc-web']) {
                const observed = [];
                let current = { ...sample, mode };
                const fetcher = { async fetch(url, init) {
                    assert.equal(init.cf?.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough', 'mode option reaches Fetch');
                    const headers = new Headers(init.headers);
                    const { expected: _expected, ...peerSample } = current;
                    headers.set('x-fuzz-fixture', btoa(JSON.stringify(peerSample)));
                    const response = await env.PEER.fetch(url, { ...init, headers });
                    assert.equal(response.headers.get('x-fuzz-peer'), 'validated', 'independent peer accepted the request');
                    assert.ok(response.body, 'peer response body');
                    const state = { pulls: 0, cancellations: 0, ended: false, released: false, emptyChunks: 0, offsetChunks: 0 };
                    const plan = current.plan;
                    let reader;
                    const release = () => { if (reader && !state.released) { reader.releaseLock(); state.released = true; } };
                    const body = new ReadableStream({
                        async pull(controller) {
                            reader ??= response.body.getReader();
                            state.pulls++;
                            try {
                                const item = await reader.read();
                                if (item.done) { state.ended = true; release(); controller.close(); }
                                else {
                                    // Service boundaries may coalesce source chunks.
                                    // Also inject empty and offset views at the exact
                                    // parser boundary, so those invariants are tested.
                                    if (plan.empties[(state.pulls - 1) % plan.empties.length]) {
                                        controller.enqueue(new Uint8Array(plan.padding).subarray(plan.padding));
                                        state.emptyChunks++;
                                    }
                                    const storage = new Uint8Array(plan.padding + item.value.length + 3).fill(253);
                                    storage.set(item.value, plan.padding);
                                    controller.enqueue(storage.subarray(plan.padding, plan.padding + item.value.length));
                                    state.offsetChunks++;
                                }
                            } catch (error) { release(); controller.error(error); }
                        },
                        async cancel(reason) {
                            state.cancellations++;
                            try { if (reader) await reader.cancel(reason); else await response.body.cancel(reason); }
                            finally { release(); }
                        },
                    }, { highWaterMark: 0 });
                    observed.push({ body, source: response.body, state });
                    return new Response(body, { status: response.status, headers: response.headers });
                } };
                const transport = createWorkersGrpcTransport({ mode, fetcher, transportMaxReceiveBytes: 2048,
                    ...(mode === 'grpc-web' ? { endpoints: { 'fuzz.test': 'https://fuzz-gateway.test' } } : {}) });
                const client = new Client('fuzz.test', credentials.createSsl(), transport.grpcOptions({ 'grpc.max_receive_message_length': 512 }));
                clients.push(client);
                const actual = await invoke(client, current);
                current = { ...recovery, mode };
                const reused = await invoke(client, current);
                assert.equal(observed.length, 2, `one fetch per call, including channel reuse: ${JSON.stringify({ actual, reused, observed: observed.length })}`);
                const cleanup = observed.map(({ body, source, state }) => {
                    assert.equal(body.locked, false, 'adapter released its response reader');
                    assert.equal(source.locked, false, 'binding response reader released');
                    assert.equal(state.cancellations, state.ended ? 0 : 1, 'unfinished response cancelled once');
                    return { ...state, bodyLocked: body.locked, sourceLocked: source.locked };
                });
                client.close();
                assert.equal(client.getChannel().activeCallCount(), 0);
                results.push({ mode, actual, reused, cleanup });
            }
            return Response.json({ status: 'passed', invocation, results });
        } catch (error) {
            return Response.json({ status: 'failed', diagnostic: error.message, stack: error.stack }, { status: 500 });
        } finally { clients.forEach(client => client.close()); }
    },
};
