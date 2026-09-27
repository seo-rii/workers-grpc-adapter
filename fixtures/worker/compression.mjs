import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, credentials, Metadata, InterceptingCall } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const cases = ['unary', 'no-compress', 'stream', 'empty', 'malformed', 'truncated', 'decoded-limit', 'wire-limit',
    'compressed-trailer', 'unsupported-encoding', 'identity-flag', 'unknown-plain', 'cancel', 'deadline'];
class NoCompressCall extends InterceptingCall {
    sendMessage(message) { this.sendMessageWithContext({ flags: 2 }, message); }
}
function payload(index = 0) { return Buffer.alloc(128, 65 + index); }
function diagnostics(surface) {
    let call = surface.call;
    while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
    assert.ok(call, 'transport diagnostics');
    return call.diagnostics();
}
async function exercise(mode, algorithm, invocation, kind) {
    const config = { mode, transportMaxReceiveBytes: 1024,
        ...(mode === 'grpc-web' ? { endpoints: { 'compression.test': 'https://compression-gateway.test' } } : {}) };
    const transport = createWorkersGrpcTransport(config);
    const client = new Client('compression.test', credentials.createSsl(), transport.grpcOptions({
        'grpc.default_compression_algorithm': algorithm, 'grpc.max_receive_message_length': 512,
        ...(kind === 'no-compress' ? { interceptors: [(options, next) => new NoCompressCall(next(options))] } : {}),
    }));
    const metadata = new Metadata();
    for (const [key, value] of Object.entries({ mode, algorithm, invocation, kind })) metadata.set(`x-fixture-${key}`, String(value));
    const streaming = ['stream', 'cancel', 'deadline'].includes(kind);
    const expected = ({ malformed: 13, truncated: 13, 'decoded-limit': 8, 'wire-limit': 8,
        'compressed-trailer': 12, 'unsupported-encoding': 12, 'identity-flag': 13, cancel: 1, deadline: 4 })[kind] ?? 0;
    let surface, callbacks = 0, errors = 0, received = 0;
    const statuses = [];
    try {
        if (streaming) {
            surface = client.makeServerStreamRequest('/fixture.Compression/Stream', value => value, value => value,
                payload(), metadata, { deadline: Date.now() + (kind === 'deadline' ? 100 : 10000) });
            const done = new Promise(resolve => surface.on('status', result => { statuses.push(result.code); resolve(); }));
            surface.on('error', () => { errors++; });
            surface.on('data', value => {
                assert.deepEqual(value, payload(received));
                received++;
                if (kind === 'cancel') surface.cancel();
            });
            await done;
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.equal(received, kind === 'stream' ? 3 : 1);
            assert.equal(errors, expected ? 1 : 0);
        } else {
            const result = await new Promise(resolve => {
                surface = client.makeUnaryRequest('/fixture.Compression/Unary', value => value, value => value,
                    kind === 'empty' ? Buffer.alloc(0) : payload(), metadata, { deadline: Date.now() + 10000 }, (error, value) => {
                        callbacks++;
                        resolve({ code: error?.code ?? 0, value });
                    });
                surface.on('status', result => statuses.push(result.code));
            });
            assert.equal(result.code, expected);
            if (!expected) assert.deepEqual(result.value, kind === 'empty' ? Buffer.alloc(0) : payload());
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.equal(callbacks, 1);
        }
        assert.deepEqual(statuses, [expected]);
        assert.deepEqual(diagnostics(surface), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
        assert.equal(client.getChannel().activeCallCount(), 0);
        return { mode, algorithm, invocation, kind, code: expected, statuses: statuses.length, received };
    } finally { client.close(); }
}
export default {
    async fetch(request) {
        const invocation = new URL(request.url).pathname.slice(1);
        let stage = 'invocation';
        try {
            assert.ok(['cold', 'warm'].includes(invocation));
            const results = [];
            for (const mode of ['cloudflare', 'grpc-web']) for (const algorithm of [0, 1, 2]) for (const kind of cases) {
                stage = `${mode}-${algorithm}-${kind}`;
                results.push(await exercise(mode, algorithm, invocation, kind));
            }
            return Response.json({ status: 'passed', results });
        } catch {
            return Response.json({ status: 'failed', stage }, { status: 500 });
        }
    },
};
