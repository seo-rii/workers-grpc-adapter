'use strict';
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, client, serialize, trailers, immediate, transportCall, response } = require('./helpers.cjs');
const { encodeFrame } = require('../dist/wire.js');

function clock(t) {
    // Advance wall time independently of timer delivery, as when a sequence of
    // immediately fulfilled stream reads keeps the task queue from running.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    return value => { now = value; };
}
function config(mode, fetcher, extra = {}) {
    return { mode, ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}), fetcher, ...extra };
}
function invoke(c, kind, options) {
    const messages = [], statuses = [], errors = [];
    let call, completions = 0;
    const done = new Promise(resolve => {
        if (kind === 'direct') {
            call = c.getChannel().createCallForMethod('/demo.Echo/Stream', false, true, options);
            call.start(new grpc.Metadata(), { onReceiveMetadata() {}, onReceiveMessage(value) {
                messages.push(value); call.startRead();
            }, onReceiveStatus(value) { statuses.push(value.code); completions++; resolve(); } });
            call.startRead(); call.sendMessageWithContext({}, serialize({ text: 'request' })); call.halfClose();
        } else if (kind === 'unary') {
            call = c.unary({ text: 'request' }, options, (error, value) => {
                completions++; if (error) errors.push(error.code); else messages.push(value);
            });
            call.on('status', value => { statuses.push(value.code); resolve(); });
        } else {
            call = c.stream({ text: 'request' }, options);
            call.on('data', value => messages.push(value));
            call.on('error', error => errors.push(error.code));
            call.on('status', value => { statuses.push(value.code); completions++; resolve(); });
        }
    });
    return { call, done, messages, statuses, errors, completions: () => completions };
}

for (const mode of ['cloudflare', 'grpc-web']) {
    for (const kind of ['direct', 'unary', 'stream']) for (const boundary of ['message', 'trailer', 'eof']) {
        test(`DEADLINE expiry without timer delivery at ${boundary}, ${mode} ${kind}`, async t => {
            const advance = clock(t);
            let pulls = 0, cancelled = 0;
            const body = new ReadableStream({ pull(controller) {
                const step = pulls++;
                if (step === ['message', 'trailer', 'eof'].indexOf(boundary)) advance(1100);
                if (step === 0) controller.enqueue(encodeFrame(serialize({ text: 'response' })));
                else if (step === 1) controller.enqueue(trailers());
                else controller.close();
            }, cancel() { cancelled++; } }, { highWaterMark: 0 });
            const c = client({}, config(mode, { async fetch() {
                return new Response(body, { headers: { 'content-type': 'application/grpc-web' } });
            } }));
            try {
                const result = invoke(c, kind, { deadline: 1100 });
                await result.done; await immediate();
                assert.deepEqual(result.statuses, [grpc.status.DEADLINE_EXCEEDED]);
                assert.equal(result.completions(), 1);
                assert.equal(result.messages.length, boundary === 'message' || kind === 'unary' ? 0 : 1);
                if (kind !== 'direct') assert.deepEqual(result.errors, [grpc.status.DEADLINE_EXCEEDED]);
                assert.equal(cancelled, boundary === 'eof' ? 0 : 1);
                assert.equal(body.locked, false);
                assert.equal(c.getChannel().activeCallCount(), 0);
                assert.equal((kind === 'direct' ? result.call : transportCall(result.call)).diagnostics().timerActive, false);
            } finally { c.close(); }
        });
    }

    for (const source of ['parent', 'default']) test(`DEADLINE ${mode} checks inherited ${source} expiry after Fetch`, async t => {
        const advance = clock(t);
        const parent = Object.assign(new EventEmitter(), { cancelled: false, getDeadline: () => 1100 });
        let cancelled = 0;
        const c = client({}, config(mode, { async fetch() {
            advance(1100);
            return response([], { onCancel() { cancelled++; } });
        } }, { defaultTimeoutMs: 100 }));
        try {
            const result = invoke(c, 'stream', source === 'parent' ? { deadline: Infinity, parent } : {});
            await result.done; await immediate();
            assert.deepEqual(result.statuses, [grpc.status.DEADLINE_EXCEEDED]);
            assert.equal(result.messages.length, 0);
            assert.equal(parent.listenerCount('cancelled'), 0);
            assert.equal(cancelled, 1);
        } finally { c.close(); }
    });

    for (const boundary of ['Metadata', 'Message', 'Status']) test(`DEADLINE ${mode} checks expired interceptor ${boundary} continuation`, async t => {
        const advance = clock(t);
        let resume;
        const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
            start(metadata, _listener, next) { next(metadata, {
                [`onReceive${boundary}`](value, forward) { resume = () => forward(value); },
            }); },
        })] }, config(mode, { async fetch() { return response(); } }));
        try {
            const result = invoke(c, 'stream', { deadline: 1100 });
            await immediate();
            assert.equal(typeof resume, 'function');
            advance(1100); resume();
            await result.done; await immediate();
            assert.deepEqual(result.statuses, [grpc.status.DEADLINE_EXCEEDED]);
            assert.deepEqual(result.errors, [grpc.status.DEADLINE_EXCEEDED]);
            assert.equal(result.messages.length, boundary === 'Status' ? 1 : 0);
            resume(); await immediate();
            assert.equal(result.completions(), 1);
            assert.equal(c.getChannel().activeCallCount(), 0);
            assert.equal(transportCall(result.call).diagnostics().timerActive, false);
        } finally { c.close(); }
    });

    test(`DEADLINE ${mode} preserves a success selected before expiry and accepts an infinite deadline`, async t => {
        const advance = clock(t);
        const c = client({}, config(mode, { async fetch() { advance(1099); return response(); } }));
        try {
            const result = invoke(c, 'unary', { deadline: 1100 });
            await result.done;
            advance(1100); result.call.cancel(); t.mock.timers.tick(1000); await immediate();
            assert.deepEqual(result.statuses, [grpc.status.OK]);
            assert.deepEqual(result.messages, [{ text: 'ok' }]);
            assert.equal(result.completions(), 1);
            const infinite = invoke(c, 'unary', { deadline: Infinity });
            await infinite.done;
            assert.deepEqual(infinite.statuses, [grpc.status.OK]);
        } finally { c.close(); }
    });
}
