import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, Metadata } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { createGrpcWebHandler, GrpcWebServerError } from '@grpc/grpc-js/server';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const codec = { requestDeserialize: bytes => bytes.toString(), responseSerialize: value => Buffer.from(value) };
const method = '/fixture.Upload/Call';
async function until(check) {
    const end = Date.now() + 3000;
    while (!check()) { assert.ok(Date.now() < end, 'SERVER_UPLOAD_TRANSITION_TIMEOUT'); await sleep(0); }
}
async function run() {
    const cases = [];
    for (const kind of ['sum', 'empty', 'bidi', 'early-error', 'early-success', 'cancel', 'deadline', 'slow-consumer', 'gzip', 'receive-limit']) {
        let serverMessages = 0, serverClosed = false, serverContext, fetches = 0;
        const requests = [], clients = [];
        const streaming = kind === 'bidi' || kind === 'slow-consumer';
        const handler = createGrpcWebHandler({ call: { ...codec, path: method, requestStream: true, responseStream: streaming } }, {
            call(input, context) {
                serverContext = context;
                if (kind === 'early-error') throw new GrpcWebServerError(7, 'controlled refusal');
                if (kind === 'early-success') return 'early';
                if (streaming) return (async function* () {
                    try { for await (const value of input) { serverMessages++; yield value; } }
                    finally { serverClosed = true; }
                })();
                return (async () => {
                    const values = [];
                    try { for await (const value of input) { serverMessages++; values.push(value); } return values.join('|'); }
                    finally { serverClosed = true; }
                })();
            },
        }, { compression: kind === 'gzip' ? 2 : 0, maxReceiveMessageBytes: kind === 'receive-limit' ? 2 : 1024 });
        const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'server-stream.test': 'https://server.test' },
            experimentalRequestStreaming: true, resourceLimits: { readableHighWaterMark: 1, maxBufferedBytes: 65536 },
            fetcher: { async fetch(url, init) {
                fetches++; assert.equal(init.cf.grpcWeb, 'passthrough');
                const request = new Request(url, { ...init, duplex: 'half' }); requests.push(request);
                return handler(request);
            } },
        });
        const client = new Client('server-stream.test', transport.channelCredentials,
            transport.grpcOptions(kind === 'gzip' ? { 'grpc.default_compression_algorithm': 2 } : {}));
        clients.push(client);
        try {
            const errors = [], statuses = [], values = [], callbacks = [];
            const options = { deadline: Date.now() + (kind === 'deadline' ? 60 : 2500) };
            const call = streaming
                ? client.makeBidiStreamRequest(method, value => Buffer.from(value), bytes => bytes.toString(), new Metadata(), options)
                : client.makeClientStreamRequest(method, value => Buffer.from(value), bytes => bytes.toString(), new Metadata(), options,
                    (error, value) => callbacks.push({ code: error?.code ?? 0, value }));
            call.on('error', error => errors.push(error.code));
            const done = new Promise(resolve => call.on('status', value => { statuses.push(value.code); resolve(value.code); }));
            const write = value => new Promise(resolve => call.write(value, error => resolve(error?.code ?? 0)));
            const expected = kind === 'early-error' ? 7 : kind === 'cancel' ? 1 : kind === 'deadline' ? 4 : kind === 'receive-limit' ? 8 : 0;
            if (kind === 'bidi') {
                call.on('data', value => values.push(value));
                assert.equal(await write('one'), 0); await until(() => values.length === 1);
                assert.equal(call.writableEnded, false); assert.equal(serverMessages, 1);
                assert.equal(await write('two'), 0); call.end();
            } else if (kind === 'slow-consumer') {
                // Pull one item at a time through the public async iterator.
                const consumer = (async () => { for await (const value of call) { values.push(value); await sleep(1); } })();
                for (let i = 0; i < 12; i++) assert.equal(await write(String(i)), 0);
                call.end(); await consumer;
            } else if (kind === 'empty') call.end();
            else if (['early-error', 'early-success'].includes(kind)) {
                void write('unconsumed'); // Peer may respond before upload consumption or half-close.
            } else if (kind === 'cancel' || kind === 'deadline') {
                assert.equal(await write('one'), 0); await until(() => serverMessages === 1);
                if (kind === 'cancel') call.cancel();
            } else if (kind === 'receive-limit') { void write('oversized'); call.end(); }
            else { assert.equal(await write('one'), 0); assert.equal(await write('two'), 0); call.end(); }
            assert.equal(await done, expected); await sleep(0);
            assert.deepEqual(statuses, [expected]); assert.equal(fetches, 1);
            if (streaming) {
                assert.deepEqual(values, kind === 'bidi' ? ['one', 'two'] : Array.from({ length: 12 }, (_, index) => String(index)));
                assert.deepEqual(errors, []);
            } else {
                assert.equal(callbacks.length, 1); assert.equal(callbacks[0].code, expected);
                if (expected === 0) assert.equal(callbacks[0].value, kind === 'empty' ? '' : kind === 'early-success' ? 'early' : 'one|two');
            }
            await until(() => requests.every(value => !value.body.locked));
            if (['cancel', 'deadline'].includes(kind)) await until(() => serverClosed && serverContext.signal.aborted);
            await until(() => transport.resourceUsage().bufferedBytes === 0);
            assert.equal(client.getChannel().activeCallCount(), 0);
            assert.equal(transport.resourceUsage().activeCalls, 0);
            cases.push({ kind, status: 'passed', grpcStatus: expected, fetches, serverMessages,
                responseBeforeHalfClose: kind === 'bidi' || kind === 'early-error' || kind === 'early-success',
                uploadUnlocked: true, activeCalls: 0, bufferedBytes: 0,
                cancellationObserved: ['cancel', 'deadline'].includes(kind) ? serverContext.signal.aborted : null });
        } finally { clients.forEach(value => value.close()); }
    }
    return { status: 'passed', cases, caseCount: cases.length, rpcCount: cases.length, fetchCount: cases.length, cleanupVerifiedBeforeDispose: true };
}
async function runBindings(env) {
    const cases = [];
    for (const kind of ['client-eof', 'bidi-demand', 'cancel', 'deadline']) {
        const id = `binding-${kind}`;
        const transport = createWorkersGrpcTransport({ mode: 'grpc-web',
            endpoints: { 'binding-upload.test': 'https://backend.test' }, experimentalRequestStreaming: true,
            resourceLimits: { readableHighWaterMark: 1, maxBufferedBytes: 65536 }, fetcher: env.RPC });
        const client = new Client('binding-upload.test', transport.channelCredentials, transport.grpcOptions());
        try {
            const metadata = new Metadata(); metadata.set('x-case-id', id);
            const streaming = kind === 'bidi-demand';
            const path = `/fixture.BindingUpload/${streaming ? 'Bidi' : 'Client'}`;
            const statuses = [], errors = [], values = [], callbacks = [];
            const options = { deadline: Date.now() + (kind === 'deadline' ? 750 : kind === 'cancel' ? 1000 : 2500) };
            const call = streaming
                ? client.makeBidiStreamRequest(path, value => Buffer.from(value), bytes => bytes.toString(), metadata, options)
                : client.makeClientStreamRequest(path, value => Buffer.from(value), bytes => bytes.toString(), metadata, options,
                    (error, value) => callbacks.push({ code: error?.code ?? 0, value }));
            call.on('error', error => errors.push(error.code));
            call.on('data', value => values.push(value));
            const done = new Promise(resolve => call.on('status', value => { statuses.push(value.code); resolve(value.code); }));
            const write = value => new Promise(resolve => call.write(value, error => resolve(error?.code ?? 0)));
            const state = async () => (await env.RPC.fetch(`https://backend.test/control/${id}`)).json();
            const waitState = async check => {
                const end = Date.now() + 3000;
                for (;;) { const value = await state(); if (value && check(value)) return value;
                    assert.ok(Date.now() < end, `BINDING_UPLOAD_CLEANUP_TIMEOUT: ${id}: ${JSON.stringify(value)}`); await sleep(5); }
            };
            assert.equal(await write('one'), 0);
            await waitState(value => value.messages === 1);
            if (kind === 'bidi-demand') {
                await until(() => values.length === 1); assert.equal(call.writableEnded, false);
                assert.equal(await write('two'), 0); call.end();
            } else if (kind === 'client-eof') { assert.equal(await write('two'), 0); call.end(); }
            else if (kind === 'cancel') call.cancel();
            const expected = kind === 'cancel' ? 1 : kind === 'deadline' ? 4 : 0;
            assert.equal(await done, expected); await sleep(0); assert.deepEqual(statuses, [expected]);
            if (streaming) assert.deepEqual(values, ['one', 'two']);
            else { assert.equal(callbacks.length, 1); assert.equal(callbacks[0].code, expected);
                if (expected === 0) assert.equal(callbacks[0].value, 'one|two'); }
            const cleanup = await waitState(value => value.closed && value.inputReleased && !value.bodyLocked
                && (expected === 0 ? value.eof : value.cancelled));
            await until(() => transport.resourceUsage().bufferedBytes === 0);
            assert.equal(client.getChannel().activeCallCount(), 0);
            cases.push({ kind, status: 'passed', grpcStatus: expected, serverMessages: cleanup.messages,
                eof: cleanup.eof, serverCancelled: cleanup.cancelled, serverClosed: cleanup.closed, inputReleased: cleanup.inputReleased,
                uploadUnlocked: !cleanup.bodyLocked, activeCalls: 0, bufferedBytes: 0,
                responseBeforeHalfClose: kind === 'bidi-demand', cleanupRetainedWithWaitUntil: true,
                immediateRemoteCancellationRequired: false });
        } finally { client.close(); }
    }
    return { status: 'passed', cases, caseCount: cases.length, rpcCount: cases.length, fetchCount: cases.length,
        cleanupVerifiedBeforeDispose: true };
}
export default { async fetch(request, env) {
    try { return Response.json(await (new URL(request.url).pathname === '/bindings' ? runBindings(env) : run())); }
    catch (error) { return Response.json({ status: 'failed', diagnostic: error.message, stack: error.stack }, { status: 500 }); }
} };
