import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Channel, Client, InterceptingCall, Metadata, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const serialize = value => Buffer.from(JSON.stringify(value));
const deserialize = bytes => JSON.parse(bytes.toString());
function diagnostics(surface) {
    let call = surface.call;
    while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
    assert.ok(call); return call.diagnostics();
}
async function run(env) {
    const clients = [], bodies = [], results = [], callReceipts = [], transports = new Map();
    let rpcCount = 0, fetchCount = 0, sequence = 0;
    let restoreClock;
    function client(mode, options = {}, config = {}, onFetch) {
        const fetcher = { async fetch(url, init) {
            fetchCount++;
            assert.equal(init.cf?.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
            if (onFetch) init = onFetch(init) ?? init;
            const response = await env.BACKEND.fetch(url, init);
            assert.ok(response.body);
            let reader, released = false, ended = false, cancellations = 0;
            const release = () => { if (reader && !released) { reader.releaseLock(); released = true; } };
            const body = new ReadableStream({
                async pull(controller) {
                    reader ??= response.body.getReader();
                    try {
                        const item = await reader.read();
                        if (item.done) { ended = true; release(); controller.close(); }
                        else controller.enqueue(item.value);
                    } catch (error) { release(); controller.error(error); }
                },
                async cancel(reason) {
                    cancellations++;
                    try { if (reader) await reader.cancel(reason); else await response.body.cancel(reason); }
                    finally { release(); }
                },
            }, { highWaterMark: 0 });
            bodies.push({ body, source: response.body, state: () => ({ released, ended, cancellations,
                encoding: response.headers.get('grpc-encoding') ?? 'identity' }) });
            return new Response(body, { headers: response.headers, status: response.status });
        } };
        const transport = createWorkersGrpcTransport({ mode, fetcher,
            ...(mode === 'grpc-web' ? { endpoints: { 'lifecycle.test': 'https://gateway.test' } } : {}), ...config });
        const value = new Client('lifecycle.test', transport.channelCredentials, transport.grpcOptions(options));
        clients.push(value); transports.set(value, transport); return value;
    }
    function metadata(extra = {}) {
        const value = new Metadata(); value.set('x-case-id', `review-${sequence++}`);
        for (const [name, entry] of Object.entries(extra)) value.set(name, entry);
        return value;
    }
    function sharedClient(transport) {
        const value = new Client('lifecycle.test', transport.channelCredentials, transport.grpcOptions());
        clients.push(value); transports.set(value, transport); return value;
    }
    async function until(predicate) {
        const end = Date.now() + 5000;
        while (!predicate()) { assert.ok(Date.now() < end, 'resource transition timed out'); await sleep(0); }
    }
    async function idle(transport) {
        await until(() => transport.resourceUsage().bufferedBytes === 0);
        const usage = transport.resourceUsage();
        assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
        return usage;
    }
    function observe(surface, callbacks) {
        rpcCount++;
        const statuses = [], errors = [];
        surface.on('error', error => errors.push(error));
        const done = new Promise(resolve => surface.on('status', result => { statuses.push(result); resolve(result); }));
        return { surface, callbacks, statuses, errors, done };
    }
    function unary(c, value = { kind: 'recovery' }, options = { deadline: Date.now() + 5000 }, headers = {}) {
        const callbacks = [];
        const surface = c.makeUnaryRequest('/fixture.Lifecycle/Unary', serialize, deserialize, value, metadata(headers), options,
            (error, result) => callbacks.push({ code: error?.code ?? 0, details: error?.details, value: result }));
        return observe(surface, callbacks);
    }
    async function completed(c, observed, expectedCode, expectedFetches) {
        assert.equal((await observed.done).code, expectedCode);
        await sleep(0);
        assert.equal(observed.statuses.length, 1);
        if (observed.callbacks) {
            assert.equal(observed.callbacks.length, 1);
            assert.equal(observed.callbacks[0].code, expectedCode);
        }
        assert.equal(c.getChannel().activeCallCount(), 0);
        assert.deepEqual(diagnostics(observed.surface), { terminal: true, fetchCount: expectedFetches,
            requestBytes: 0, responseBytes: 0, timerActive: false });
        callReceipts.push({ code: expectedCode, fetchCount: expectedFetches, statuses: observed.statuses.length,
            callbacks: observed.callbacks?.length ?? 0, diagnostics: diagnostics(observed.surface) });
    }
    async function recovery(c) {
        const call = unary(c); await completed(c, call, 0, 1);
        assert.deepEqual(call.callbacks[0].value, { kind: 'recovery' });
    }
    try {
        // No valid global channel is constructed: reject invalid constructors
        // before the first configuration, while real RPCs use instance configs.
        for (const reject of [() => new Channel('https://invalid.test', credentials.createSsl()),
            () => new Channel('valid.test', credentials.createSsl(), { 'grpc.max_receive_message_length': -2 }),
            () => new Channel('valid.test', credentials.createInsecure())]) {
            assert.throws(reject);
        }
        assert.equal(configureWorkersGrpc({ defaultTimeoutMs: 1234 }).defaultTimeoutMs, 1234);
        results.push({ kind: 'failed-config-recovery', constructors: 3 });
        for (const mode of ['cloudflare', 'grpc-web']) {
            for (const [asyncStart, asyncMessage, order] of [[false, false, 'none'], [false, true, 'message'],
                [true, false, 'start'], [true, true, 'message-first'], [true, true, 'start-first']]) {
                let start, message;
                const c = client(mode, { interceptors: [(options, nextCall) => new InterceptingCall(nextCall(options), {
                    start(md, listener, next) { start = () => next(md, listener); if (!asyncStart) start(); },
                    sendMessage(value, next) { message = () => next({ ...value, tenant: 'rewritten' }); if (!asyncMessage) message(); },
                })] });
                const call = unary(c, { tenant: 'original' });
                if (order === 'message-first') { message(); await Promise.resolve(); start(); }
                else { if (asyncStart) start(); await Promise.resolve(); if (asyncMessage) message(); }
                await completed(c, call, 0, 1);
                assert.deepEqual(call.callbacks[0].value, { tenant: 'rewritten' });
                results.push({ mode, kind: 'interceptor-order', asyncStart, asyncMessage, order }); c.close();
            }
            for (const kind of ['cancel', 'default-timeout', 'close']) {
                let resume, held = true;
                const c = client(mode, { interceptors: [(options, nextCall) => new InterceptingCall(nextCall(options), {
                    start(md, listener, next) { resume = () => next(md, listener); if (!held) resume(); },
                    cancel(_next) {},
                })] }, { defaultTimeoutMs: kind === 'default-timeout' ? 40 : 5000 });
                const before = fetchCount, call = unary(c, { kind }, {});
                if (kind === 'cancel') call.surface.cancel();
                if (kind === 'close') c.close();
                const code = kind === 'cancel' ? 1 : kind === 'close' ? 14 : 4;
                await completed(c, call, code, 0);
                resume(); await sleep(0);
                assert.equal(fetchCount, before, 'late interceptor next must not fetch');
                assert.equal(call.statuses.length, 1); assert.equal(call.callbacks.length, 1);
                held = false;
                await recovery(kind === 'close' ? client(mode) : c);
                results.push({ mode, kind: `stalled-${kind}`, code, lateFetches: 0 }); c.close();
            }
            for (const kind of ['destroy', 'iterator-break']) {
                const c = client(mode);
                const stream = c.makeServerStreamRequest('/fixture.Lifecycle/Stream', serialize, deserialize,
                    { kind }, metadata(), { deadline: Date.now() + 5000 });
                const call = observe(stream);
                if (kind === 'destroy') {
                    await new Promise(resolve => stream.once('data', resolve));
                    stream.destroy(); stream.destroy();
                } else { for await (const value of stream) { assert.deepEqual(value, { first: true }); break; } }
                await completed(c, call, 1, 1);
                assert.equal(call.errors.length, kind === 'destroy' ? 0 : 1);
                await recovery(c);
                results.push({ mode, kind, code: 1, statuses: 1 }); c.close();
            }
            for (const kind of ['large-trailer', 'large-initial']) {
                const c = client(mode), call = unary(c, { kind });
                await completed(c, call, 8, 1);
                assert.equal(call.callbacks[0].details, 'WGA_SERVER_METADATA_SIZE');
                await recovery(c);
                results.push({ mode, kind, code: 8, readableGrpcError: true }); c.close();
            }
            for (const kind of ['compression-expiry', 'positive-header-snapshot']) {
                const now = Date.now, origin = now(), deadline = origin + 60000;
                let release, enteredResolve, clockReads = 0, timeout;
                const entered = new Promise(resolve => { enteredResolve = resolve; });
                const auth = credentials.createFromMetadataGenerator((_options, callback) => {
                    release = () => callback(null, new Metadata()); enteredResolve();
                });
                const c = client(mode, {}, {}, init => {
                    timeout = init.headers.get('grpc-timeout');
                    assert.equal(timeout, '1m');
                    Date.now = now; restoreClock = undefined;
                    // The checked 1ms header is the assertion. Give the separate
                    // backend Worker a stable deadline for its echo operation.
                    const headers = new Headers(init.headers); headers.set('grpc-timeout', '5S');
                    return { ...init, headers };
                });
                const call = unary(c, { kind }, { deadline, credentials: auth });
                await entered;
                const times = kind === 'compression-expiry' ? [deadline - 1, deadline] : [deadline - 1, deadline - 1, deadline + 1];
                restoreClock = now;
                Date.now = () => times[Math.min(clockReads++, times.length - 1)];
                release();
                try { await completed(c, call, kind === 'compression-expiry' ? 4 : 0, kind === 'compression-expiry' ? 0 : 1); }
                finally { Date.now = now; restoreClock = undefined; }
                if (kind === 'positive-header-snapshot') { assert.equal(clockReads, 2); assert.equal(timeout, '1m'); }
                results.push({ mode, kind, code: kind === 'compression-expiry' ? 4 : 0, clockReads }); c.close();
            }
            {
                // Admission belongs to the transport snapshot, so distinct
                // clients share capacity while one admitted call awaits auth.
                const limits = { maxConcurrentCalls: 1, maxQueuedCalls: 1, maxBufferedBytes: 4096 };
                const a = client(mode, {}, { resourceLimits: limits }), transport = transports.get(a);
                const b = sharedClient(transport), overflowClient = sharedClient(transport);
                let releaseAuth, authCalls = 0;
                const auth = credentials.createFromMetadataGenerator((_options, callback) => {
                    authCalls++; releaseAuth = () => callback(null, new Metadata());
                });
                const before = fetchCount;
                const active = unary(a, { kind: 'resource-admitted' }, { deadline: Date.now() + 5000, credentials: auth });
                await until(() => typeof releaseAuth === 'function');
                const cancelled = unary(b, { kind: 'resource-queued-cancel' });
                await until(() => transport.resourceUsage().queuedCalls === 1);
                const overflow = unary(overflowClient, { kind: 'resource-overflow' });
                await completed(overflowClient, overflow, 8, 0);
                assert.equal(overflow.callbacks[0].details, 'WGA_CALL_QUEUE_FULL');
                cancelled.surface.cancel(); await completed(b, cancelled, 1, 0);
                const deadline = unary(b, { kind: 'resource-queued-deadline' }, { deadline: Date.now() + 40 });
                await completed(b, deadline, 4, 0);
                assert.equal(fetchCount, before, 'queued termination and overflow precede all Fetch calls');
                assert.equal(transport.resourceUsage().activeCalls, 1);
                assert.equal(transport.resourceUsage().queuedCalls, 0);
                const survivor = unary(b, { kind: 'resource-survivor' });
                await until(() => transport.resourceUsage().queuedCalls === 1);
                releaseAuth();
                await completed(a, active, 0, 1); await completed(b, survivor, 0, 1);
                await recovery(b);
                const usage = await idle(transport);
                assert.equal(authCalls, 1); assert.equal(usage.peakActiveCalls, 1); assert.equal(usage.peakQueuedCalls, 1);
                assert.ok(usage.peakBufferedBytes <= limits.maxBufferedBytes);
                results.push({ mode, kind: 'resource-admission', limits, usage, queuedTerminalCodes: [1, 4], overloadCode: 8,
                    queuedFetches: 0, sharedClients: 3, recovered: true });
                a.close(); b.close(); overflowClient.close();
            }
            {
                const limits = { maxBufferedBytes: 512 };
                const c = client(mode, {}, { resourceLimits: limits }), transport = transports.get(c);
                const call = unary(c, { padding: 'x'.repeat(2048) });
                await completed(c, call, 8, 0);
                assert.equal(call.callbacks[0].details, 'WGA_BUFFER_BUDGET');
                await recovery(c);
                const usage = await idle(transport); assert.ok(usage.peakBufferedBytes <= 512);
                results.push({ mode, kind: 'resource-send-budget', limits, usage, code: 8, recovered: true }); c.close();
            }
            {
                const limits = { maxBufferedBytes: 512 };
                const c = client(mode, {}, { resourceLimits: limits }), transport = transports.get(c);
                const call = unary(c, { kind: 'resource-large-response' }, { deadline: Date.now() + 5000 }, { 'x-compression': 'gzip' });
                await completed(c, call, 8, 1);
                assert.equal(call.callbacks[0].details, 'WGA_BUFFER_BUDGET');
                await recovery(c);
                const usage = await idle(transport); assert.ok(usage.peakBufferedBytes <= 512);
                results.push({ mode, kind: 'resource-receive-budget', limits, usage, code: 8, compressed: true, recovered: true }); c.close();
            }
            {
                const limits = { maxConcurrentCalls: 2, maxQueuedCalls: 1, maxBufferedBytes: 16384, readableHighWaterMark: 1 };
                const c = client(mode, {}, { resourceLimits: limits }), transport = transports.get(c), peer = sharedClient(transport);
                let releaseAuth;
                const auth = credentials.createFromMetadataGenerator((_options, callback) => {
                    releaseAuth = () => callback(null, new Metadata());
                });
                const stream = c.makeServerStreamRequest('/fixture.Lifecycle/Stream', serialize, deserialize,
                    { kind: 'resource-finite' }, metadata({ 'x-compression': 'gzip' }), { deadline: Date.now() + 5000, credentials: auth });
                const call = observe(stream);
                assert.equal(stream.readableHighWaterMark, 1); stream.read(0);
                await until(() => typeof releaseAuth === 'function');
                const simultaneous = unary(peer, { kind: 'resource-peer-during-auth' });
                await completed(peer, simultaneous, 0, 1);
                assert.equal(transport.resourceUsage().activeCalls, 1);
                releaseAuth();
                let peakReadableLength = 0;
                for (let index = 0; index < 8; index++) {
                    await until(() => stream.readableLength === 1);
                    await sleep(0);
                    peakReadableLength = Math.max(peakReadableLength, stream.readableLength);
                    assert.equal(stream.readableLength, 1);
                    assert.deepEqual(stream.read(), { index, padding: 'x'.repeat(128) });
                }
                // EOF still requires demand after the final queued message.
                stream.read(0);
                await completed(c, call, 0, 1);
                assert.equal(call.errors.length, 0); await recovery(c);
                const usage = await idle(transport);
                assert.equal(usage.peakActiveCalls, 2); assert.ok(usage.peakBufferedBytes <= limits.maxBufferedBytes);
                results.push({ mode, kind: 'resource-slow-compressed', limits, usage, peakReadableLength,
                    messages: 8, compressed: true, peerDuringAuth: true, recovered: true }); c.close(); peer.close();
            }
        }
        for (const kind of ['ClientStream', 'Bidi']) {
            let start;
            const c = client('grpc-web', { interceptors: [(options, nextCall) => new InterceptingCall(nextCall(options), {
                start(md, listener, next) { start = () => next(md, listener); },
                sendMessage(value, next) { queueMicrotask(() => next({ ...value, tenant: 'rewritten' })); },
            })] }, { experimentalRequestStreaming: true });
            const callbacks = kind === 'ClientStream' ? [] : undefined;
            const args = [`/fixture.Lifecycle/${kind}`, serialize, deserialize, metadata(), { deadline: Date.now() + 5000 }];
            const stream = kind === 'ClientStream' ? c.makeClientStreamRequest(...args, (error, value) => callbacks.push({ code: error?.code ?? 0, value }))
                : c.makeBidiStreamRequest(...args);
            const call = observe(stream, callbacks), values = [], writes = [];
            if (kind === 'Bidi') stream.on('data', value => values.push(value));
            for (let id = 0; id < 3; id++) stream.write({ id, tenant: 'original' }, error => writes.push(error));
            stream.end(); start();
            await completed(c, call, 0, 1);
            assert.equal(writes.length, 3); for (const error of writes) assert.ifError(error);
            assert.deepEqual(kind === 'ClientStream' ? callbacks[0].value : values[0], { accepted: 3 });
            results.push({ mode: 'grpc-web', kind, writes: 3, uploadEOF: true }); c.close();
        }
        // A service binding may defer idle backend cancellation until its RPC
        // deadline. Require real finalization before runtime disposal.
        let backend;
        const end = Date.now() + 7500;
        do {
            backend = await (await env.BACKEND.fetch('https://control.test/control')).json();
            if (backend.active === 0) break;
            await sleep(10);
        } while (Date.now() < end);
        assert.equal(backend.active, 0);
        assert.equal(backend.receipts.length, fetchCount);
        assert.ok(backend.receipts.every(item => item.finalized));
        const cleanup = bodies.map(({ body, source, state }) => {
            const result = state();
            assert.equal(body.locked, false); assert.equal(source.locked, false);
            assert.equal(result.cancellations, result.ended ? 0 : 1);
            return { ...result, bodyLocked: body.locked, sourceLocked: source.locked };
        });
        const coreCaseCount = results.filter(item => !item.kind.startsWith('resource-')).length;
        const resourceCaseCount = results.length - coreCaseCount;
        assert.equal(coreCaseCount, 31); assert.equal(resourceCaseCount, 8);
        assert.equal(callReceipts.length, rpcCount);
        assert.equal(callReceipts.reduce((sum, item) => sum + item.fetchCount, 0), fetchCount);
        return { status: 'passed', results, caseCount: results.length, coreCaseCount, resourceCaseCount, rpcCount, fetchCount, callReceipts, cleanup, backend,
            activeClientCalls: clients.reduce((sum, value) => sum + value.getChannel().activeCallCount(), 0) };
    } finally { if (restoreClock) Date.now = restoreClock; clients.forEach(value => value.close()); }
}
export default {
    async fetch(_request, env) {
        try { return Response.json(await run(env)); }
        catch (error) { return Response.json({ status: 'failed', diagnostic: error.message, stack: error.stack }, { status: 500 }); }
    },
};
