'use strict';
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, immediate, deferred } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');

const reply = value => new Response(Buffer.concat([
    encodeFrame(Buffer.from(value)), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true),
]), { headers: { 'content-type': 'application/grpc-web+proto' } });

function clock(t) {
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    // Ready admission microtasks can run before an overdue deadline timer.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    return value => { now = value; };
}
function fixture(mode, onStart = () => {}, onSend = () => {}) {
    const release = deferred(), entered = deferred();
    const starts = [], serialized = [], sent = [], closed = [], fetched = [];
    const transport = createWorkersGrpcTransport({ mode, defaultTimeoutMs: 100,
        ...(mode === 'grpc-web' ? { endpoints: { 'admission.test': 'https://gateway.test' } } : {}),
        resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 },
        fetcher: { fetch(url) {
            fetched.push(url);
            if (url.endsWith('/Block')) { entered.resolve(); return release.promise; }
            return Promise.resolve(reply('reply'));
        } },
    });
    const client = new grpc.Client('admission.test', transport.channelCredentials, transport.grpcOptions({
        interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
            start(metadata, listener, next) {
                starts.push(options.method_definition.path); onStart(); next(metadata, listener);
            },
            sendMessage(value, next) { sent.push(value); onSend(); next(value); },
            halfClose(next) { closed.push(options.method_definition.path); next(); },
        })],
    }));
    function start(name, options = {}) {
        const statuses = [];
        let callbacks = 0, call;
        const done = new Promise(resolve => {
            call = client.makeUnaryRequest('/fixture.Admission/' + name, value => {
                serialized.push(value); return Buffer.from(value);
            }, bytes => bytes.toString(), name.toLowerCase(), options, (error, value) => {
                callbacks++; resolve({ code: error?.code ?? grpc.status.OK, value });
            });
            call.on('status', value => statuses.push(value.code));
        });
        return { call, done, statuses, callbacks: () => callbacks };
    }
    async function complete(result, expected) {
        assert.equal((await result.done).code, expected);
        await immediate();
        assert.equal(result.callbacks(), 1); assert.deepEqual(result.statuses, [expected]);
        const usage = transport.resourceUsage();
        assert.equal(client.getChannel().activeCallCount(), 0);
        assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
    }
    return { transport, client, release, entered, starts, sent, closed, serialized, fetched, start, complete };
}

for (const mode of ['cloudflare', 'grpc-web']) {
    for (const queued of [false, true]) for (const releaseTime of [1099, 1100, 1101]) {
        test(`ADMISSION ${mode} queued=${queued} checks deadline before outgoing startup at ${releaseTime}`, { timeout: 3000 }, async t => {
            const advance = clock(t), f = fixture(mode);
            let blocker;
            try {
                if (queued) { blocker = f.start('Block', { deadline: Infinity }); await f.entered.promise; }
                const target = f.start('Target', { deadline: 1100 });
                if (queued) {
                    await immediate(); assert.equal(f.transport.resourceUsage().queuedCalls, 1);
                }
                advance(releaseTime);
                if (queued) { f.release.resolve(reply('block')); assert.equal((await blocker.done).code, grpc.status.OK); }
                const live = releaseTime < 1100;
                await f.complete(target, live ? grpc.status.OK : grpc.status.DEADLINE_EXCEEDED);
                assert.equal(f.starts.filter(value => value.endsWith('/Target')).length, live ? 1 : 0,
                    'An expired admitted call must not start an outgoing interceptor');
                assert.equal(f.serialized.filter(value => value === 'target').length, live ? 1 : 0);
                assert.equal(f.fetched.filter(value => value.endsWith('/Target')).length, live ? 1 : 0);
                // Expiry must return the acquired slot for the next live call.
                await f.complete(f.start('Following', { deadline: Infinity }), grpc.status.OK);
            } finally {
                f.release.resolve(reply('block')); f.client.close(); await blocker?.done; await immediate();
            }
        });
    }

    for (const source of ['default', 'parent']) for (const expired of [false, true]) {
        test(`ADMISSION ${mode} applies ${source} deadline after admission expired=${expired}`, { timeout: 3000 }, async t => {
            const advance = clock(t), f = fixture(mode);
            const parent = Object.assign(new EventEmitter(), { cancelled: false, getDeadline: () => 1100 });
            try {
                const target = f.start('Target', source === 'parent' ? { deadline: Infinity, parent } : {});
                advance(expired ? 1100 : 1099);
                await f.complete(target, expired ? grpc.status.DEADLINE_EXCEEDED : grpc.status.OK);
                assert.equal(f.starts.length, expired ? 0 : 1); assert.equal(f.serialized.length, expired ? 0 : 1);
                assert.equal(f.fetched.length, expired ? 0 : 1);
                assert.equal(parent.listenerCount('cancelled'), 0);
            } finally { f.client.close(); }
        });
    }

    for (const boundary of ['start', 'send']) {
        test(`ADMISSION ${mode} stops draining pending operations when ${boundary} exhausts the deadline`, { timeout: 3000 }, async t => {
            const advance = clock(t);
            const expire = () => advance(1100);
            const f = fixture(mode, boundary === 'start' ? expire : undefined, boundary === 'send' ? expire : undefined);
            try {
                const target = f.start('Target', { deadline: 1100 });
                await f.complete(target, grpc.status.DEADLINE_EXCEEDED);
                assert.equal(f.starts.length, 1);
                assert.equal(f.sent.length, boundary === 'start' ? 0 : 1);
                assert.equal(f.closed.length, 0, 'No subsequent half-close requester may run after expiry');
                assert.equal(f.fetched.length, 0);
                if (boundary === 'start') assert.equal(f.serialized.length, 0);
            } finally { f.client.close(); }
        });
    }
}
