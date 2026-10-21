'use strict';
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, response, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { decodeFrames } = require('../dist/wire.js');

const supportedCalls = [
    ['cloudflare', 'unary'], ['cloudflare', 'stream'],
    ['grpc-web', 'unary'], ['grpc-web', 'stream'], ['grpc-web', 'clientStream'], ['grpc-web', 'bidi'],
];

function clock(t) {
    // Advance the absolute clock without letting the deadline timer run. An
    // interceptor continuation can legitimately precede the timer's callback.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    return at => { now = at; };
}
function fixture(mode, kind, interceptors, { serializerFails = false, defaultTimeoutMs, beforeSerialize } = {}) {
    const counts = { serialized: 0, fetches: 0 };
    const transport = createWorkersGrpcTransport({ mode, defaultTimeoutMs,
        ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
        fetcher: { async fetch(_url, init) {
            counts.fetches++;
            if (!Buffer.isBuffer(init.body)) {
                for await (const frame of decodeFrames(init.body, 1024)) assert.equal(frame.trailer, false);
            }
            return response();
        } },
    });
    const method = { path: '/test.Outgoing/Invoke', requestStream: kind === 'clientStream' || kind === 'bidi',
        responseStream: kind === 'stream' || kind === 'bidi',
        requestSerialize(value) {
            counts.serialized++;
            beforeSerialize?.();
            if (serializerFails) throw new Error('Controlled request serializer failure');
            return Buffer.from(value.text);
        },
        responseDeserialize: () => ({ text: 'ok' }),
    };
    const Client = grpc.makeGenericClientConstructor({ invoke: method }, 'test.Outgoing');
    const client = new Client('echo.test', transport.channelCredentials, transport.grpcOptions({ interceptors }));
    return { client, transport, counts, method };
}
function start(f, kind, options = { deadline: 1100 }, write = true) {
    const statuses = [], callbacks = [], values = [], writes = [];
    const callback = (error, value) => { callbacks.push(error?.code ?? grpc.status.OK); if (value) values.push(value); };
    const call = kind === 'unary' || kind === 'stream'
        ? f.client.invoke({ text: 'request' }, options, ...(kind === 'unary' ? [callback] : []))
        : f.client.invoke(options, ...(kind === 'clientStream' ? [callback] : []));
    call.on('error', () => {});
    if (f.method.responseStream) call.on('data', value => values.push(value));
    const done = new Promise(resolve => call.on('status', value => { statuses.push(value.code); resolve(value.code); }));
    if (f.method.requestStream && write) {
        call.write({ text: 'request' }, error => writes.push(error));
        call.end();
    }
    return { call, done, statuses, callbacks, values, writes };
}
async function completed(f, result, kind, expected, written = f.method.requestStream) {
    assert.equal(await result.done, expected);
    await immediate();
    assert.deepEqual(result.statuses, [expected]);
    assert.deepEqual(result.callbacks, kind === 'unary' || kind === 'clientStream' ? [expected] : []);
    assert.deepEqual(result.values, expected === grpc.status.OK ? [{ text: 'ok' }] : []);
    assert.equal(result.writes.length, written ? 1 : 0);
    assert.equal(f.client.getChannel().activeCallCount(), 0);
    const usage = f.transport.resourceUsage();
    assert.equal(usage.activeCalls, 0);
    assert.equal(usage.queuedCalls, 0);
    assert.equal(usage.bufferedBytes, 0);
    assert.equal(transportCall(result.call).diagnostics().timerActive, false);
}

for (const [mode, kind] of supportedCalls) for (const boundary of ['start', 'message']) {
    for (const at of [1099, 1100, 1101]) for (const serializerFails of [false, true]) {
        test(`LIFETIME ${mode} ${kind} held ${boundary} at=${at} serializerFails=${serializerFails}`, async t => {
            const advance = clock(t);
            let resume;
            const interceptors = [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), boundary === 'start'
                ? { start(metadata, listener, next) { resume = () => next(metadata, listener); } }
                : { sendMessage(message, next) { resume = () => next(message); } })];
            const f = fixture(mode, kind, interceptors, { serializerFails });
            try {
                const result = start(f, kind);
                assert.equal(typeof resume, 'function');
                advance(at);
                resume();
                const expired = at >= 1100;
                const expected = expired ? grpc.status.DEADLINE_EXCEEDED : serializerFails ? grpc.status.INTERNAL : grpc.status.OK;
                await completed(f, result, kind, expected);
                assert.equal(f.counts.serialized, expired ? 0 : 1);
                assert.equal(f.counts.fetches, expired || serializerFails ? 0 : 1);
                // Duplicate and late continuations cannot restart owned work.
                resume();
                await immediate();
                assert.deepEqual(result.statuses, [expected]);
                assert.equal(f.counts.serialized, expired ? 0 : 1);
            } finally { f.client.close(); }
        });
    }
}

for (const kind of ['clientStream', 'bidi']) for (const at of [1099, 1100, 1101]) for (const hookThrows of [false, true]) {
    test(`LIFETIME ${kind} public half-close at=${at} hookThrows=${hookThrows}`, async t => {
        const advance = clock(t);
        let halfCloses = 0;
        const f = fixture('grpc-web', kind, [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
            halfClose(next) { halfCloses++; if (hookThrows) throw new Error('Controlled half-close failure'); next(); },
        })]);
        try {
            const result = start(f, kind, { deadline: 1100 }, false);
            advance(at);
            result.call.end();
            const expired = at >= 1100;
            const expected = expired ? grpc.status.DEADLINE_EXCEEDED : hookThrows ? grpc.status.INTERNAL : grpc.status.OK;
            await completed(f, result, kind, expected, false);
            assert.equal(halfCloses, expired ? 0 : 1);
            assert.equal(f.counts.fetches, expired || hookThrows ? 0 : 1);
        } finally { f.client.close(); }
    });
}

for (const boundary of ['start', 'message', 'halfClose']) for (const hookThrows of [false, true]) {
    test(`LIFETIME nested ${boundary} continuation stops before the next requester hook throws=${hookThrows}`, async t => {
        const advance = clock(t), kind = boundary === 'halfClose' ? 'bidi' : 'unary';
        let resume, nested = 0;
        const hook = (...args) => {
            nested++;
            if (hookThrows) throw new Error('Controlled nested requester failure');
            const next = args.pop(); next(...args);
        };
        const outer = boundary === 'start'
            ? { start(metadata, listener, next) { resume = () => next(metadata, listener); } }
            : boundary === 'message' ? { sendMessage(message, next) { resume = () => next(message); } }
                : { halfClose(next) { resume = next; } };
        const inner = { [boundary === 'message' ? 'sendMessage' : boundary]: hook };
        const f = fixture('grpc-web', kind, [
            (options, nextCall) => new grpc.InterceptingCall(nextCall(options), outer),
            (options, nextCall) => new grpc.InterceptingCall(nextCall(options), inner),
        ]);
        try {
            const result = start(f, kind, { deadline: 1100 }, boundary !== 'halfClose');
            if (boundary === 'halfClose') result.call.end();
            assert.equal(typeof resume, 'function');
            advance(1100);
            resume();
            await completed(f, result, kind, grpc.status.DEADLINE_EXCEEDED, false);
            assert.equal(nested, 0);
            assert.equal(f.counts.serialized, 0);
            assert.equal(f.counts.fetches, 0);
        } finally { f.client.close(); }
    });
}

for (const source of ['default', 'parent', 'final-options', 'infinity']) {
    test(`LIFETIME outgoing continuation uses effective ${source} deadline`, async t => {
        const advance = clock(t), parent = new EventEmitter();
        parent.cancelled = false;
        parent.getDeadline = () => 1100;
        let resume;
        const f = fixture('grpc-web', 'unary', [(options, nextCall) => new grpc.InterceptingCall(nextCall({ ...options,
            ...(source === 'final-options' ? { deadline: 1100 } : {}) }), {
            sendMessage(message, next) { resume = () => next(message); },
        })], { defaultTimeoutMs: 100 });
        try {
            const options = source === 'default' ? {} : source === 'parent' ? { deadline: Infinity, parent }
                : source === 'final-options' ? { deadline: Infinity } : { deadline: Infinity };
            const result = start(f, 'unary', options);
            advance(1100);
            resume();
            const expected = source === 'infinity' ? grpc.status.OK : grpc.status.DEADLINE_EXCEEDED;
            await completed(f, result, 'unary', expected, false);
            assert.equal(f.counts.serialized, source === 'infinity' ? 1 : 0);
            assert.equal(f.counts.fetches, source === 'infinity' ? 1 : 0);
            assert.equal(parent.listenerCount('cancelled'), 0);
        } finally { f.client.close(); }
    });
}

for (const boundary of ['start', 'message', 'halfClose', 'serialize']) for (const at of [1099, 1100]) for (const throws of [false, true]) {
    test(`LIFETIME synchronous ${boundary} reaches at=${at} throws=${throws}`, async t => {
        const advance = clock(t), kind = boundary === 'halfClose' ? 'bidi' : 'unary';
        const hook = (...args) => {
            advance(at);
            if (throws) throw new Error('Controlled synchronous requester failure');
            const next = args.pop(); next(...args);
        };
        const requester = boundary === 'serialize' ? {} : { [boundary === 'message' ? 'sendMessage' : boundary]: hook };
        const f = fixture('grpc-web', kind, [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), requester)],
            boundary === 'serialize' ? { beforeSerialize: () => advance(at), serializerFails: throws } : {});
        try {
            const result = start(f, kind, { deadline: 1100 }, boundary !== 'halfClose');
            if (boundary === 'halfClose') result.call.end();
            const expected = at >= 1100 ? grpc.status.DEADLINE_EXCEEDED : throws ? grpc.status.INTERNAL : grpc.status.OK;
            await completed(f, result, kind, expected, false);
            assert.equal(f.counts.fetches, at >= 1100 || throws ? 0 : 1);
        } finally { f.client.close(); }
    });
}

test('LIFETIME a selected cancellation survives a late outgoing continuation', async t => {
    const advance = clock(t);
    let resume;
    const f = fixture('grpc-web', 'bidi', [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        sendMessage(message, next) { resume = () => next(message); },
    })]);
    try {
        const result = start(f, 'bidi');
        result.call.cancel();
        advance(1100);
        resume();
        await completed(f, result, 'bidi', grpc.status.CANCELLED);
        assert.equal(f.counts.serialized, 0);
        assert.equal(f.counts.fetches, 0);
    } finally { f.client.close(); }
});

for (const boundary of ['start', 'message', 'halfClose']) for (const throws of [false, true]) {
    test(`LIFETIME resumed nested ${boundary} consumes its remaining budget throws=${throws}`, async t => {
        const advance = clock(t), kind = boundary === 'halfClose' ? 'bidi' : 'unary';
        let resume, nested = 0;
        const hookName = boundary === 'message' ? 'sendMessage' : boundary;
        const outer = boundary === 'start'
            ? { start(metadata, listener, next) { resume = () => next(metadata, listener); } }
            : boundary === 'message' ? { sendMessage(message, next) { resume = () => next(message); } }
                : { halfClose(next) { resume = next; } };
        const f = fixture('grpc-web', kind, [
            (options, nextCall) => new grpc.InterceptingCall(nextCall(options), outer),
            (options, nextCall) => new grpc.InterceptingCall(nextCall(options), { [hookName](...args) {
                nested++;
                advance(1100);
                if (throws) throw new Error('Controlled resumed requester overrun');
                const next = args.pop(); next(...args);
            } }),
        ]);
        try {
            const result = start(f, kind, { deadline: 1100 }, boundary !== 'halfClose');
            if (boundary === 'halfClose') result.call.end();
            advance(1099);
            assert.doesNotThrow(() => resume());
            await completed(f, result, kind, grpc.status.DEADLINE_EXCEEDED, false);
            assert.equal(nested, 1);
            assert.equal(f.counts.serialized, 0);
            assert.equal(f.counts.fetches, 0);
        } finally { f.client.close(); }
    });
}

for (const mode of ['cloudflare', 'grpc-web']) for (const flags of [2, 4]) for (const at of [1099, 1100]) {
    test(`LIFETIME ${mode} serialization completion precedes flags=${flags} validation at=${at}`, async t => {
        const advance = clock(t);
        let overrides = 0;
        class FlagCall extends grpc.InterceptingCall {
            sendMessage(message) { overrides++; this.sendMessageWithContext({ flags }, message); }
        }
        const f = fixture(mode, 'unary', [(options, nextCall) => new FlagCall(nextCall(options))],
            { beforeSerialize: () => advance(at) });
        try {
            const result = start(f, 'unary');
            const expected = at >= 1100 ? grpc.status.DEADLINE_EXCEEDED : flags === 4 ? grpc.status.UNIMPLEMENTED : grpc.status.OK;
            await completed(f, result, 'unary', expected, false);
            assert.equal(overrides, 1);
            assert.equal(f.counts.serialized, 1);
            assert.equal(f.counts.fetches, expected === grpc.status.OK ? 1 : 0);
        } finally { f.client.close(); }
    });
}

for (const boundary of ['start', 'message', 'halfClose']) {
    test(`LIFETIME custom ${boundary} override cannot throw past its remaining budget`, async t => {
        const advance = clock(t), kind = boundary === 'halfClose' ? 'bidi' : 'unary';
        let resume, overrides = 0;
        const method = boundary === 'message' ? 'sendMessageWithContext' : boundary;
        class OverrunCall extends grpc.InterceptingCall {
            [method]() { overrides++; advance(1100); throw new Error('Controlled custom override overrun'); }
        }
        const requester = boundary === 'start'
            ? { start(metadata, listener, next) { resume = () => next(metadata, listener); } }
            : boundary === 'message' ? { sendMessage(message, next) { resume = () => next(message); } }
                : { halfClose(next) { resume = next; } };
        const f = fixture('grpc-web', kind, [
            (options, nextCall) => new grpc.InterceptingCall(nextCall(options), requester),
            (options, nextCall) => new OverrunCall(nextCall(options)),
        ]);
        try {
            const result = start(f, kind, { deadline: 1100 }, boundary !== 'halfClose');
            if (boundary === 'halfClose') result.call.end();
            advance(1099);
            assert.doesNotThrow(() => resume());
            await completed(f, result, kind, grpc.status.DEADLINE_EXCEEDED, false);
            assert.equal(overrides, 1);
            assert.equal(f.counts.serialized, 0);
            assert.equal(f.counts.fetches, 0);
        } finally { f.client.close(); }
    });

    test(`LIFETIME selected cancellation survives a throwing resumed ${boundary}`, async t => {
        clock(t);
        const kind = boundary === 'halfClose' ? 'bidi' : 'unary';
        let resume, result;
        const hookName = boundary === 'message' ? 'sendMessage' : boundary;
        const requester = boundary === 'start'
            ? { start(metadata, listener, next) { resume = () => next(metadata, listener); } }
            : boundary === 'message' ? { sendMessage(message, next) { resume = () => next(message); } }
                : { halfClose(next) { resume = next; } };
        const f = fixture('grpc-web', kind, [
            (options, nextCall) => new grpc.InterceptingCall(nextCall(options), requester),
            (options, nextCall) => new grpc.InterceptingCall(nextCall(options), { [hookName]() {
                result.call.cancel();
                throw new Error('Controlled failure after cancellation');
            } }),
        ]);
        try {
            result = start(f, kind, { deadline: 1100 }, boundary !== 'halfClose');
            if (boundary === 'halfClose') result.call.end();
            assert.doesNotThrow(() => resume());
            await completed(f, result, kind, grpc.status.CANCELLED, false);
            assert.equal(f.counts.serialized, 0);
            assert.equal(f.counts.fetches, 0);
        } finally { f.client.close(); }
    });
}

for (const at of [1099, 1100]) for (const throws of [false, true]) {
    test(`LIFETIME direct custom read reaches at=${at} throws=${throws}`, async t => {
        const advance = clock(t), failure = new Error('Controlled custom read failure');
        let reads = 0;
        class ReadCall extends grpc.InterceptingCall {
            startRead() {
                reads++;
                advance(at);
                if (throws) throw failure;
                super.startRead();
            }
        }
        const f = fixture('grpc-web', 'unary', [(options, nextCall) => new ReadCall(nextCall(options))]);
        try {
            const result = start(f, 'unary');
            if (throws && at < 1100) {
                assert.throws(() => result.call.call.startRead(), error => error === failure);
                result.call.cancel();
            } else assert.doesNotThrow(() => result.call.call.startRead());
            const expected = at >= 1100 ? grpc.status.DEADLINE_EXCEEDED : throws ? grpc.status.CANCELLED : grpc.status.OK;
            await completed(f, result, 'unary', expected, false);
            assert.equal(reads, 1);
            assert.equal(f.counts.fetches, expected === grpc.status.OK ? 1 : 0);
        } finally { f.client.close(); }
    });
}
