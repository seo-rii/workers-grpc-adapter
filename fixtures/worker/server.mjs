import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { createGrpcWebHandler, GrpcWebServerError } from '@grpc/grpc-js/server';

const unary = { path: '/fixture.Server/Echo', requestStream: false, responseStream: false,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };
const stream = { ...unary, path: '/fixture.Server/Stream', responseStream: true };
const kinds = ['unary', 'empty', 'stream', 'public-error', 'throw', 'stream-throw', 'response-limit', 'cancel', 'deadline', 'recovery'];
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 0));
function service(state, compression = 0) {
    function begin(context) {
        state.handled++;
        const initial = new Metadata(); initial.set('x-fixture-handler', 'yes'); context.sendMetadata(initial);
        const end = new Metadata(); end.set('x-finished', 'yes'); end.set('trace-bin', Buffer.from([0, 128, 255])); context.setTrailer(end);
    }
    return createGrpcWebHandler({ echo: unary, stream }, {
        async echo(value, context) {
            begin(context);
            const kind = context.metadata.get('x-fixture-kind')[0];
            if (kind === 'public-error') throw new GrpcWebServerError(7, 'Denied: 한글 % value');
            if (kind === 'throw') throw Object.assign(new Error('fixture-secret-handler-detail'), { code: 7 });
            if (kind === 'response-limit') return Buffer.alloc(513);
            if (kind === 'server-deadline') await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
            return value;
        },
        async *stream(_value, context) {
            begin(context);
            state.active++;
            try {
                yield Buffer.alloc(128, 65);
                const kind = context.metadata.get('x-fixture-kind')[0];
                if (kind === 'cancel' || kind === 'deadline') {
                    if (!context.signal.aborted) await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
                    state.aborted++;
                    return;
                }
                if (kind === 'stream-throw') throw new Error('fixture-secret-stream-detail');
                yield Buffer.alloc(128, 66);
                yield Buffer.alloc(128, 67);
            } finally { state.active--; state.finalized++; }
        },
    }, { compression, maxReceiveMessageBytes: 512, maxSendMessageBytes: 512, maxWireMessageBytes: 1024 });
}
async function run(invocation) {
    const state = { handled: 0, active: 0, aborted: 0, finalized: 0, requests: 0 };
    const results = [];
    for (const mode of ['cloudflare', 'grpc-web']) for (const algorithm of [0, 1, 2]) {
        const handler = service(state, algorithm);
        const fetcher = { async fetch(input, init) {
            assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
            const request = new Request(input, init);
            assert.equal(new URL(request.url).origin, mode === 'cloudflare' ? 'https://server.test' : 'https://server-gateway.test');
            assert.equal(request.headers.get('content-type'), mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto');
            state.requests++;
            return handler(request);
        } };
        const transport = createWorkersGrpcTransport({ mode, fetcher,
            ...(mode === 'grpc-web' ? { endpoints: { 'server.test': 'https://server-gateway.test' } } : {}) });
        const client = new Client('server.test', credentials.createSsl(), transport.grpcOptions({ 'grpc.default_compression_algorithm': algorithm }));
        try {
            for (const kind of kinds) {
                const metadata = new Metadata(); metadata.set('x-fixture-kind', kind);
                const streaming = ['stream', 'stream-throw', 'cancel', 'deadline'].includes(kind);
                const expected = ({ 'public-error': 7, throw: 13, 'stream-throw': 13, 'response-limit': 8, cancel: 1, deadline: 4 })[kind] ?? 0;
                let surface, code, details, received = 0, statuses = 0, callbacks = 0;
                if (streaming) {
                    surface = client.makeServerStreamRequest(stream.path, value => value, value => value, Buffer.alloc(128, 65), metadata,
                        { deadline: Date.now() + (kind === 'deadline' ? 100 : 10000) });
                    const done = new Promise(resolve => surface.on('status', value => { statuses++; code = value.code; details = value.details; resolve(); }));
                    surface.on('error', () => {});
                    surface.on('data', value => {
                        assert.deepEqual(value, Buffer.alloc(128, 65 + received)); received++;
                        if (kind === 'cancel') surface.cancel();
                    });
                    await done;
                    assert.equal(received, kind === 'stream' ? 3 : 1);
                } else {
                    await new Promise(resolve => {
                        surface = client.makeUnaryRequest(unary.path, value => value, value => value,
                            kind === 'empty' ? Buffer.alloc(0) : Buffer.alloc(128, 65), metadata, { deadline: Date.now() + 10000 }, (error, value) => {
                                callbacks++; code = error?.code ?? 0; details = error?.details;
                                if (!error) assert.deepEqual(value, kind === 'empty' ? Buffer.alloc(0) : Buffer.alloc(128, 65));
                                resolve();
                            });
                        surface.on('status', () => { statuses++; });
                    });
                    assert.equal(callbacks, 1);
                }
                await nextTurn();
                assert.equal(code, expected, `${mode}-${algorithm}-${kind}`);
                assert.equal(statuses, 1);
                if (kind === 'public-error') assert.equal(details, 'Denied: 한글 % value');
                if (kind === 'throw' || kind === 'stream-throw') assert.equal(details, 'WGA_SERVER_HANDLER');
                assert.equal(state.active, 0, 'handler iterator must finish before the next scenario');
                assert.equal(client.getChannel().activeCallCount(), 0);
                results.push({ invocation, mode, algorithm, kind, code, received });
            }
        } finally { client.close(); }
    }
    assert.equal(state.handled, 60);
    assert.equal(state.requests, 60);
    assert.equal(state.finalized, 24);
    assert.equal(state.active, 0);
    return { status: 'passed', results, state };
}
export default {
    async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.startsWith('/fixture.Server/')) return service({ handled: 0, active: 0, aborted: 0, finalized: 0 })(request);
        if (!['/run/cold', '/run/warm'].includes(path)) return new Response('Not found', { status: 404 });
        try { return Response.json(await run(path.split('/').pop())); }
        catch { return Response.json({ status: 'failed', diagnostic: 'SERVER_WORKER_FIXTURE' }, { status: 500 }); }
    },
};
