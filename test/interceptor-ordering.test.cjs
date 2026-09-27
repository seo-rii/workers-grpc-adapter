'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, dist } = require('./interceptor-helpers.cjs');

for (const asyncStart of [false, true]) for (const asyncMessage of [false, true]) {
    test(`INTERCEPTOR preserves rewritten messages with start=${asyncStart ? 'async' : 'sync'}, send=${asyncMessage ? 'async' : 'sync'}`, () => {
        const { call, trace, continuations } = fixture({ asyncStart, asyncMessage });
        call.sendMessage({ tenant: 'original', id: 1 });
        call.halfClose();
        if (asyncMessage) continuations.message[0]();
        if (asyncStart) continuations.start();
        assert.deepEqual(trace, [['start'], ['message', { tenant: 'rewritten', id: 1 }], ['halfClose']]);
    });
}

test('INTERCEPTOR start completing before message cannot half-close or half-close twice', () => {
    const { call, trace, continuations } = fixture();
    call.sendMessage({ tenant: 'original' });
    call.halfClose();
    continuations.start();
    assert.deepEqual(trace, [['start']]);
    continuations.message[0]();
    assert.deepEqual(trace, [['start'], ['message', { tenant: 'rewritten' }], ['halfClose']]);
});

test('INTERCEPTOR minimized two-message schedule waits for every transform before half-close', () => {
    // Original failure: seed 1470698469, path 0:0:1:0, [[], 2].
    // Also reverse message completion to require submission-order delivery.
    for (const order of [[0, 1], [1, 0]]) {
        const { call, trace, continuations } = fixture({ asyncClose: true });
        call.sendMessage({ id: 0 });
        call.sendMessage({ id: 1 });
        call.halfClose();
        continuations.start();
        continuations.close();
        call.halfClose();
        continuations.message[order[0]]();
        assert.ok(!trace.some(item => item[0] === 'halfClose'));
        continuations.message[order[1]]();
        assert.deepEqual(trace, [['start'], ['message', { id: 0, tenant: 'rewritten' }],
            ['message', { id: 1, tenant: 'rewritten' }], ['halfClose']]);
    }
});

test('INTERCEPTOR duplicate continuations and reentrant close deliver each operation once', () => {
    let call;
    const state = fixture({ asyncClose: true, onMessage() { call.halfClose(); }, onClose() { call.halfClose(); } });
    call = state.call;
    let callbacks = 0;
    call.sendMessageWithContext({ callback() { callbacks++; call.halfClose(); } }, { id: 1 });
    call.halfClose();
    state.continuations.close();
    state.continuations.close();
    state.continuations.start();
    state.continuations.start();
    state.continuations.message[0]();
    state.continuations.message[0]();
    assert.equal(callbacks, 1);
    assert.deepEqual(state.trace, [['start'], ['message', { id: 1, tenant: 'rewritten' }], ['halfClose']]);
});

test('INTERCEPTOR callback reentry cannot overwrite a queued message or reorder half-close', () => {
    const { call, trace, continuations } = fixture({ asyncMessage: false });
    let callbacks = 0;
    call.sendMessageWithContext({ callback() {
        callbacks++;
        call.sendMessageWithContext({ callback() { callbacks++; } }, { id: 2 });
        call.halfClose();
    } }, { id: 1 });
    continuations.start();
    assert.equal(callbacks, 2);
    assert.deepEqual(trace, [['start'], ['message', { id: 1, tenant: 'rewritten' }],
        ['message', { id: 2, tenant: 'rewritten' }], ['halfClose']]);
});

test('INTERCEPTOR rejects messages submitted after half-close was requested and settles callbacks', () => {
    for (const asyncStart of [false, true]) {
        const { call, trace, continuations } = fixture({ asyncStart, asyncMessage: false });
        call.halfClose();
        let callbacks = 0;
        call.sendMessageWithContext({ callback(error) {
            callbacks++;
            assert.match(error.message, /WGA_WRITE_AFTER_HALF_CLOSE/);
        } }, { id: 'late' });
        assert.throws(() => call.sendMessage({ id: 'also late' }), /WGA_WRITE_AFTER_HALF_CLOSE/);
        if (asyncStart) continuations.start();
        assert.equal(callbacks, 1);
        assert.equal(continuations.message.length, 0);
        assert.deepEqual(trace, [['start'], ['halfClose']]);
    }
});

// Exercise the public Client and real upload stream, not just the scheduler stub.
for (const kind of ['unary', 'clientStream', 'bidi']) {
    test(`INTERCEPTOR ${kind} transport preserves rewritten requests across all startup combinations`, async () => {
        const path = require('node:path');
        const grpc = require(path.join(dist, 'index.js'));
        const { createWorkersGrpcTransport } = require(path.join(dist, 'adapter.js'));
        const { decodeFrames, encodeFrame } = require(path.join(dist, 'wire.js'));
        for (const asyncStart of [false, true]) for (const asyncMessage of [false, true]) {
            let fetches = 0, callbackCount = 0, statusCount = 0;
            const received = [];
            const requestStream = kind !== 'unary', responseStream = kind === 'bidi';
            const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'interceptor.test': 'https://gateway.test' },
                experimentalRequestStreaming: true, defaultTimeoutMs: 2000, fetcher: { async fetch(_url, init) {
                    fetches++;
                    if (requestStream) {
                        for await (const frame of decodeFrames(init.body, 1024)) {
                            assert.equal(frame.trailer, false);
                            received.push(JSON.parse(Buffer.from(frame.payload).toString()));
                        }
                    } else received.push(JSON.parse(Buffer.from(init.body).subarray(5).toString()));
                    const expected = requestStream ? [1, 2, 3] : [1];
                    assert.deepEqual(received, expected.map(id => ({ id, tenant: 'rewritten' })));
                    return new Response(Buffer.concat([
                        encodeFrame(Buffer.from(JSON.stringify({ accepted: received.length }))),
                        encodeFrame(Buffer.from('grpc-status: 0\r\n'), true),
                    ]), { headers: { 'content-type': 'application/grpc-web+proto' } });
                } } });
            const Client = grpc.makeGenericClientConstructor({ invoke: {
                path: '/test.Interceptor/Invoke', requestStream, responseStream,
                requestSerialize: value => Buffer.from(JSON.stringify(value)),
                responseDeserialize: bytes => JSON.parse(bytes.toString()),
            } }, 'test.Interceptor');
            const c = new Client('interceptor.test', transport.channelCredentials, transport.grpcOptions({
                interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                    start(metadata, listener, next) {
                        const resume = () => next(metadata, listener);
                        if (asyncStart) setImmediate(resume); else resume();
                    },
                    sendMessage(message, next) {
                        const resume = () => next({ ...message, tenant: 'rewritten' });
                        if (asyncMessage) setImmediate(resume); else resume();
                    },
                })],
            }));
            try {
                let call;
                const values = [];
                let result;
                if (responseStream) {
                    call = c.invoke();
                    call.on('data', value => values.push(value));
                } else result = new Promise((resolve, reject) => {
                    const callback = (error, value) => { callbackCount++; error ? reject(error) : resolve(value); };
                    call = requestStream ? c.invoke(callback) : c.invoke({ id: 1, tenant: 'original' }, callback);
                });
                call.on('error', () => {});
                const terminal = new Promise(resolve => call.on('status', status => { statusCount++; resolve(status); }));
                if (requestStream) {
                    for (let id = 1; id <= 3; id++) call.write({ id, tenant: 'original' });
                    call.end();
                }
                if (result) assert.deepEqual(await result, { accepted: requestStream ? 3 : 1 });
                assert.equal((await terminal).code, grpc.status.OK);
                await new Promise(resolve => setImmediate(resolve));
                if (responseStream) assert.deepEqual(values, [{ accepted: 3 }]);
                assert.equal(callbackCount, responseStream ? 0 : 1);
                assert.equal(statusCount, 1);
                assert.equal(fetches, 1);
                assert.equal(c.getChannel().activeCallCount(), 0);
            } finally { c.close(); }
        }
    });
}

test('INTERCEPTOR logical lifetime preserves custom sendMessage overrides', async () => {
    const { grpc, response, serialize, deserialize } = require('./helpers.cjs');
    const { createWorkersGrpcTransport } = require('../dist/adapter.js');
    for (const streaming of [false, true]) {
        let overrides = 0, fetches = 0;
        class NoCompressCall extends grpc.InterceptingCall {
            sendMessage(message) { overrides++; this.sendMessageWithContext({ flags: 2 }, message); }
        }
        const factory = createWorkersGrpcTransport({
            fetcher: { async fetch(_url, init) {
                fetches++;
                assert.equal(init.headers.get('grpc-encoding'), 'gzip');
                assert.equal(init.body[0], 0, 'NoCompress override must reach the transport');
                assert.deepEqual(init.body.subarray(5), serialize({ text: 'request' }));
                return response();
            } },
        });
        const client = new grpc.Client('echo.test', factory.channelCredentials, factory.grpcOptions({
            'grpc.default_compression_algorithm': 2,
            interceptors: [(options, next) => new NoCompressCall(next(options))],
        }));
        try {
            if (streaming) {
                const stream = client.makeServerStreamRequest('/demo.Echo/Stream', serialize, deserialize, { text: 'request' });
                const values = []; for await (const value of stream) values.push(value);
                assert.deepEqual(values, [{ text: 'ok' }]);
            } else {
                const value = await new Promise((resolve, reject) => client.makeUnaryRequest('/demo.Echo/Unary',
                    serialize, deserialize, { text: 'request' }, (error, result) => error ? reject(error) : resolve(result)));
                assert.deepEqual(value, { text: 'ok' });
            }
            assert.equal(overrides, 1); assert.equal(fetches, 1);
        } finally { client.close(); }
    }
});
