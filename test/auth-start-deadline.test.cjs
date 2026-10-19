'use strict';
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, client, response, deferred, serialize, transportCall, immediate } = require('./helpers.cjs');

function clock(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    return value => { now = value; };
}
function config(mode, extra = {}) {
    return { mode, ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}), ...extra };
}
function invoke(c, kind, options) {
    const statuses = [], messages = [];
    let call, callbacks = 0;
    const done = new Promise(resolve => {
        if (kind === 'direct') {
            call = c.getChannel().createCallForMethod('/demo.Echo/Unary', false, false, options);
            call.start(new grpc.Metadata(), { onReceiveMetadata() {}, onReceiveMessage(value) { messages.push(value); },
                onReceiveStatus(value) { callbacks++; statuses.push(value.code); resolve(value.code); } });
            call.startRead(); call.sendMessageWithContext({}, serialize({ text: 'request' })); call.halfClose();
        } else if (kind === 'stream') {
            call = c.stream({ text: 'request' }, options);
            call.on('data', value => messages.push(value));
            call.on('error', () => {});
            call.on('status', value => { callbacks++; statuses.push(value.code); resolve(value.code); });
        } else {
            call = c.unary({ text: 'request' }, options, (error, value) => {
                callbacks++; if (value) messages.push(value); resolve(error?.code ?? grpc.status.OK);
            });
            call.on('status', value => statuses.push(value.code));
        }
    });
    return { call, done, messages, statuses, callbacks: () => callbacks };
}
async function completed(c, result, expected) {
    assert.equal(await result.done, expected);
    await immediate();
    assert.equal(result.callbacks(), 1);
    assert.deepEqual(result.statuses, [expected]);
    assert.equal(c.getChannel().activeCallCount(), 0);
    const raw = typeof result.call.diagnostics === 'function' ? result.call : transportCall(result.call);
    assert.equal(raw.diagnostics().timerActive, false);
    assert.equal(raw.diagnostics().requestBytes, 0);
}

for (const mode of ['cloudflare', 'grpc-web']) {
    for (const source of ['explicit', 'default', 'parent']) for (const expires of [false, true]) {
        test(`AUTH ${mode} ${source} deadline before deferred auth expires=${expires}`, async t => {
            const advance = clock(t);
            let authCalls = 0, fetches = 0;
            const auth = grpc.credentials.createFromMetadataGenerator((_options, cb) => {
                authCalls++; cb(null, new grpc.Metadata());
            });
            const parent = Object.assign(new EventEmitter(), { cancelled: false, getDeadline: () => 1100 });
            const c = client({}, config(mode, { ...(source === 'default' ? { defaultTimeoutMs: 100 } : {}),
                fetcher: { async fetch() { fetches++; return response(); } } }));
            try {
                const options = { credentials: auth, ...(source === 'explicit' ? { deadline: 1100 }
                    : source === 'parent' ? { deadline: Infinity, parent } : {}) };
                const result = invoke(c, 'unary', options);
                // Authentication's microtask becomes runnable before the timer.
                advance(expires ? 1100 : 1099);
                await completed(c, result, expires ? grpc.status.DEADLINE_EXCEEDED : grpc.status.OK);
                assert.equal(authCalls, expires ? 0 : 1, 'expired calls cannot start a credential operation');
                assert.equal(fetches, expires ? 0 : 1);
                assert.equal(parent.listenerCount('cancelled'), 0);
            } finally { c.close(); }
        });
    }

    for (const kind of ['direct', 'stream']) {
        test(`AUTH ${mode} expired deferred ${kind} call does not start credentials`, async t => {
            const advance = clock(t);
            let authCalls = 0, fetches = 0;
            const auth = grpc.credentials.createFromMetadataGenerator((_options, cb) => {
                authCalls++; cb(null, new grpc.Metadata());
            });
            const c = client({}, config(mode, { fetcher: { async fetch() { fetches++; return response(); } } }));
            try {
                const result = invoke(c, kind, { credentials: auth, deadline: 1100 });
                advance(1100);
                await completed(c, result, grpc.status.DEADLINE_EXCEEDED);
                assert.equal(authCalls, 0); assert.equal(fetches, 0); assert.equal(result.messages.length, 0);
            } finally { c.close(); }
        });
    }

    for (const boundary of ['backoff', 'auth-yield']) {
        test(`AUTH ${mode} retry expiry at ${boundary} prevents another credential operation`, async t => {
            const advance = clock(t), scheduled = deferred();
            const events = [];
            let authCalls = 0, fetches = 0;
            const auth = grpc.credentials.createFromMetadataGenerator((_options, cb) => {
                authCalls++; cb(null, new grpc.Metadata());
            });
            const c = client({}, config(mode, {
                retryPolicy: { methods: ['/demo.Echo/Unary'], maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1,
                    retryableStatusCodes: [grpc.status.UNAVAILABLE] },
                observer(event) {
                    events.push(event);
                    if (event.type === 'retry-scheduled') scheduled.resolve();
                    if (event.type === 'attempt-start' && event.attempt === 2 && boundary === 'auth-yield') advance(1100);
                },
                fetcher: { async fetch() {
                    fetches++;
                    return fetches === 1 ? response([], { code: grpc.status.UNAVAILABLE, extra: 'grpc-retry-pushback-ms: 1\r\n' }) : response();
                } },
            }));
            try {
                const result = invoke(c, 'unary', { credentials: auth, deadline: 1100 });
                await scheduled.promise;
                if (boundary === 'backoff') advance(1100);
                t.mock.timers.tick(1);
                await completed(c, result, grpc.status.DEADLINE_EXCEEDED);
                assert.equal(authCalls, 1, 'only the first attempt may acquire credentials');
                assert.equal(fetches, 1);
                const ends = events.filter(event => event.type === 'call-end');
                assert.equal(ends.length, 1);
                assert.equal(ends[0].statusCode, grpc.status.DEADLINE_EXCEEDED);
                assert.equal(ends[0].attemptCount, boundary === 'backoff' ? 1 : 2);
            } finally { c.close(); }
        });
    }

    for (const action of ['cancel', 'close']) {
        test(`AUTH ${mode} ${action} before deferred auth retains its terminal status`, async t => {
            const advance = clock(t);
            let authCalls = 0, fetches = 0;
            const auth = grpc.credentials.createFromMetadataGenerator((_options, cb) => {
                authCalls++; cb(null, new grpc.Metadata());
            });
            const c = client({}, config(mode, { fetcher: { async fetch() { fetches++; return response(); } } }));
            try {
                const result = invoke(c, 'unary', { credentials: auth, deadline: 1100 });
                if (action === 'cancel') result.call.cancel(); else c.close();
                advance(1100);
                await completed(c, result, action === 'cancel' ? grpc.status.CANCELLED : grpc.status.UNAVAILABLE);
                assert.equal(authCalls, 0); assert.equal(fetches, 0);
            } finally { c.close(); }
        });
    }
}
