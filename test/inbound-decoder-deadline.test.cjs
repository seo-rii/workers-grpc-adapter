'use strict';
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, serialize, deserialize, response, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { decodeFrames } = require('../dist/wire.js');

const supportedCalls = [
    ['cloudflare', 'unary'], ['cloudflare', 'stream'],
    ['grpc-web', 'unary'], ['grpc-web', 'stream'], ['grpc-web', 'clientStream'], ['grpc-web', 'bidi'],
];

function clock(t) {
    // A synchronous decoder can overrun the deadline before its timer runs.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    return at => { now = at; };
}

function fixture(mode, kind, decode, { defaultTimeoutMs, finalDeadline } = {}) {
    const counts = { decoded: 0, inbound: 0, fetches: 0 };
    const requestStream = kind === 'clientStream' || kind === 'bidi';
    const responseStream = kind === 'stream' || kind === 'bidi';
    const transport = createWorkersGrpcTransport({ mode, defaultTimeoutMs,
        ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
        fetcher: { async fetch(_url, init) {
            counts.fetches++;
            if (requestStream) for await (const frame of decodeFrames(init.body, 1024)) assert.equal(frame.trailer, false);
            return response();
        } },
    });
    const Client = grpc.makeGenericClientConstructor({ invoke: {
        path: '/test.Inbound/Invoke', requestStream, responseStream,
        requestSerialize: serialize,
        responseDeserialize(bytes) { counts.decoded++; decode(); return deserialize(bytes); },
    } }, 'test.Inbound');
    const client = new Client('echo.test', transport.channelCredentials, transport.grpcOptions({
        interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall({ ...options,
            ...(finalDeadline === undefined ? {} : { deadline: finalDeadline }),
        }), {
            start(metadata, _listener, next) {
                next(metadata, { onReceiveMessage(value, forward) { counts.inbound++; forward(value); } });
            },
        })],
    }));
    return { client, transport, counts, requestStream, responseStream };
}

function start(f, options = { deadline: 1100 }) {
    const statuses = [], callbacks = [], values = [], writes = [];
    const callback = (error, value) => { callbacks.push(error?.code ?? grpc.status.OK); if (value) values.push(value); };
    const call = f.requestStream
        ? f.client.invoke(options, ...(!f.responseStream ? [callback] : []))
        : f.client.invoke({ text: 'request' }, options, ...(!f.responseStream ? [callback] : []));
    call.on('error', () => {});
    if (f.responseStream) call.on('data', value => values.push(value));
    const done = new Promise(resolve => call.on('status', result => { statuses.push(result.code); resolve(); }));
    if (f.requestStream) { call.write({ text: 'request' }, error => writes.push(error)); call.end(); }
    return { call, done, statuses, callbacks, values, writes };
}

async function completed(f, result, expected, inbound) {
    await result.done; await immediate();
    assert.deepEqual(result.statuses, [expected]);
    assert.deepEqual(result.callbacks, f.responseStream ? [] : [expected]);
    assert.deepEqual(result.values, expected === grpc.status.OK ? [{ text: 'ok' }] : []);
    assert.equal(result.writes.length, f.requestStream ? 1 : 0);
    assert.equal(f.counts.decoded, 1);
    assert.equal(f.counts.inbound, inbound, 'a decoder overrun must stop before another inbound hook');
    assert.equal(f.counts.fetches, 1);
    assert.equal(f.client.getChannel().activeCallCount(), 0);
    const usage = f.transport.resourceUsage();
    assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
    assert.equal(transportCall(result.call).diagnostics().timerActive, false);
}

for (const [mode, kind] of supportedCalls) for (const at of [1099, 1100, 1101]) for (const throws of [false, true]) {
    test(`LIFETIME response decoder ${mode} ${kind} at=${at} throws=${throws}`, async t => {
        const advance = clock(t);
        const f = fixture(mode, kind, () => { advance(at); if (throws) throw new Error('Controlled response decoder failure'); });
        try {
            const result = start(f);
            const expected = at >= 1100 ? grpc.status.DEADLINE_EXCEEDED : throws ? grpc.status.INTERNAL : grpc.status.OK;
            await completed(f, result, expected, expected === grpc.status.OK ? 1 : 0);
        } finally { f.client.close(); }
    });
}

for (const source of ['default', 'parent', 'final-options', 'infinity']) for (const throws of [false, true]) {
    test(`LIFETIME response decoder honors ${source} deadline throws=${throws}`, async t => {
        const advance = clock(t);
        const parent = Object.assign(new EventEmitter(), { cancelled: false, getDeadline: () => 1100 });
        const f = fixture('grpc-web', 'unary', () => { advance(1100); if (throws) throw new Error('Controlled decoder failure'); },
            { defaultTimeoutMs: 100, ...(source === 'final-options' ? { finalDeadline: 1100 } : {}) });
        try {
            const result = start(f, source === 'default' ? {} : source === 'parent' ? { deadline: Infinity, parent } : { deadline: Infinity });
            const expected = source === 'infinity' ? throws ? grpc.status.INTERNAL : grpc.status.OK : grpc.status.DEADLINE_EXCEEDED;
            await completed(f, result, expected, expected === grpc.status.OK ? 1 : 0);
            assert.equal(parent.listenerCount('cancelled'), 0);
        } finally { f.client.close(); }
    });
}

for (const action of ['cancel', 'close']) for (const throws of [false, true]) {
    test(`LIFETIME response decoder preserves reentrant ${action} throws=${throws}`, async t => {
        const advance = clock(t);
        let result;
        const f = fixture('grpc-web', 'unary', () => {
            if (action === 'cancel') result.call.cancel(); else f.client.close();
            advance(1100);
            if (throws) throw new Error('Controlled decoder failure after termination');
        });
        try {
            result = start(f);
            await completed(f, result, action === 'cancel' ? grpc.status.CANCELLED : grpc.status.UNAVAILABLE, 0);
        } finally { f.client.close(); }
    });
}
