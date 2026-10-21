'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { RequestStreamBody } = require('../dist/request-stream.js');
const { ResourceBudget } = require('../dist/resources.js');

const turn = () => new Promise(resolve => setImmediate(resolve));
async function microtasksUntil(predicate) {
    for (let count = 0; count < 100 && !predicate(); count++) await Promise.resolve();
    assert.ok(predicate(), 'the codec must start during asynchronous call preparation');
}
async function microtasks() { for (let count = 0; count < 20; count++) await Promise.resolve(); }

// Observe real zlib operations without delaying or replacing their native writes.
// Promise continuations can run before the next native completion callback, so
// these tests do not need CPU load, forced GC, private handles, or timing sleeps.
function observeInput(t, encoding) {
    const method = encoding === 'gzip' ? 'createGzip' : 'createDeflate';
    const create = zlib[method];
    const state = { started: false, completed: false, codecs: 0 };
    state.done = new Promise(resolve => { state.resolve = resolve; });
    t.mock.method(zlib, method, function (...args) {
        const codec = Reflect.apply(create, this, args);
        state.codecs++;
        const transform = codec._transform;
        codec._transform = function (chunk, format, callback) {
            if (state.started) return Reflect.apply(transform, this, [chunk, format, callback]);
            state.started = true;
            state.codec = codec;
            state.inputBytes = chunk.length;
            return Reflect.apply(transform, this, [chunk, format, (...result) => {
                state.completed = true;
                callback(...result);
                state.resolve();
            }]);
        };
        return codec;
    });
    return state;
}

for (const mode of ['cloudflare', 'grpc-web']) for (const encoding of ['gzip', 'deflate']) {
    test(`CODEC INPUT ${mode} ${encoding} cancellation retains native input and prevents budget reuse`, { timeout: 5000 }, async t => {
        const state = observeInput(t, encoding), bytes = 256 * 1024;
        let fetches = 0, callbackCount = 0;
        const transport = createWorkersGrpcTransport({ mode,
            ...(mode === 'grpc-web' ? { endpoints: { 'codec.test': 'https://gateway.test' } } : {}),
            resourceLimits: { maxBufferedBytes: bytes * 2 + 100 },
            fetcher: { async fetch() { fetches++; throw new Error('Fetch must not start'); } },
        });
        const client = new grpc.Client('codec.test', transport.channelCredentials,
            transport.grpcOptions({ 'grpc.default_compression_algorithm': grpc.compressionAlgorithms[encoding] }));
        let call;
        const outcome = new Promise(resolve => {
            call = client.makeUnaryRequest('/audit.Codec/Encode', value => value, value => value,
                Buffer.alloc(bytes, 42), error => { callbackCount++; resolve(error?.code); });
        });
        const statuses = [];
        call.on('status', value => statuses.push(value.code));
        try {
            await microtasksUntil(() => state.started);
            call.cancel();
            assert.equal(await outcome, grpc.status.CANCELLED, 'public cancellation must not await native work');
            await microtasks();
            assert.equal(state.completed, false);
            assert.equal(state.codec.closed, true, 'close alone does not prove input consumption');
            assert.equal(transport.resourceUsage().activeCalls, 0);
            assert.equal(transport.resourceUsage().bufferedBytes, state.inputBytes,
                'the canceled request is still owned by the native input operation');
            const refused = await new Promise(resolve => {
                client.makeUnaryRequest('/audit.Codec/Encode', value => value, value => value,
                    Buffer.alloc(bytes, 43), error => resolve(error));
            });
            assert.equal(refused.code, grpc.status.RESOURCE_EXHAUSTED);
            assert.equal(refused.details, 'WGA_BUFFER_BUDGET');
            assert.equal(state.codecs, 1, 'another codec must not reuse the pending input reservation');
            assert.equal(transport.resourceUsage().bufferedBytes, state.inputBytes);
            assert.equal(fetches, 0);
        } finally {
            call.cancel(); client.close();
            await state.done; await turn();
        }
        assert.equal(callbackCount, 1);
        assert.deepEqual(statuses, [grpc.status.CANCELLED]);
        assert.equal(transport.resourceUsage().bufferedBytes, 0);
    });
}

for (const encoding of ['gzip', 'deflate']) {
    test(`CODEC INPUT ${encoding} upload cancellation settles its writer before native input ownership`, { timeout: 5000 }, async t => {
        const state = observeInput(t, encoding), bytes = 256 * 1024;
        const budget = new ResourceBudget({ maxBufferedBytes: bytes + 100 });
        const upload = new RequestStreamBody({ maxMessageBytes: bytes, maxWireBytes: bytes, compression: encoding, budget });
        const rejected = assert.rejects(upload.write(Buffer.alloc(bytes, 42)), { code: grpc.status.CANCELLED });
        try {
            assert.equal(state.started, true);
            upload.abort();
            await rejected; await microtasks();
            assert.equal(state.completed, false);
            assert.equal(upload.bufferedBytes(), 0, 'local producer cancellation remains immediate');
            assert.equal(budget.diagnostics().bufferedBytes, bytes);
            const refused = new RequestStreamBody({ maxMessageBytes: bytes, maxWireBytes: bytes, compression: encoding, budget });
            await assert.rejects(refused.write(Buffer.alloc(bytes, 43)), { code: grpc.status.RESOURCE_EXHAUSTED });
            assert.equal(state.codecs, 1);
            assert.equal(budget.diagnostics().bufferedBytes, bytes);
        } finally { upload.abort(); await state.done; await turn(); }
        assert.equal(budget.diagnostics().bufferedBytes, 0);
        const reader = upload.body.getReader();
        await assert.rejects(reader.read(), { code: grpc.status.CANCELLED });
        reader.releaseLock();
    });
}
