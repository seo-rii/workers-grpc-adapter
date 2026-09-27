'use strict';
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, client, response, withFetch, immediate, transportCall } = require('./helpers.cjs');

for (const action of ['deadline', 'default-timeout', 'cancel', 'close', 'parent']) {
    test(`LIFETIME stalled interceptor start terminates on ${action} and ignores late next`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
        let resume, fetches = 0, callbacks = 0;
        const statuses = [], results = [];
        const parent = Object.assign(new EventEmitter(), { cancelled: false, getDeadline: () => Infinity });
        await withFetch(async () => { fetches++; return response(); }, async () => {
            const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                start(md, listener, next) { resume = () => next(md, listener); },
                cancel(_next) { /* A stalled cancellation interceptor cannot veto local cleanup. */ },
            })] }, { defaultTimeoutMs: 10 });
            try {
                const options = action === 'default-timeout' ? {} : { deadline: action === 'deadline' ? 1010 : Infinity,
                    ...(action === 'parent' ? { parent } : {}) };
                const call = c.unary({ text: 'held' }, options, error => { callbacks++; results.push(error?.code ?? 0); });
                call.on('status', value => statuses.push(value.code));
                if (action === 'cancel') call.cancel();
                else if (action === 'close') c.close();
                else if (action === 'parent') { parent.cancelled = true; parent.emit('cancelled'); }
                else t.mock.timers.tick(10);
                await immediate();
                const expected = ['deadline', 'default-timeout'].includes(action) ? grpc.status.DEADLINE_EXCEEDED
                    : action === 'close' ? grpc.status.UNAVAILABLE : grpc.status.CANCELLED;
                assert.deepEqual(results, [expected]);
                assert.deepEqual(statuses, [expected]);
                assert.equal(c.getChannel().activeCallCount(), 0);
                assert.equal(parent.listenerCount('cancelled'), 0);
                resume(); await immediate();
                assert.equal(fetches, 0);
                assert.equal(callbacks, 1);
                assert.deepEqual(statuses, [expected]);
                assert.equal(transportCall(call).diagnostics().timerActive, false);
            } finally { c.close(); }
        });
    });
}

test('LIFETIME holds the deadline through asynchronous inbound status delivery', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let resume, callbacks = 0;
    const codes = [];
    await withFetch(async () => response(), async () => {
        const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
            start(md, listener, next) { next(md, { onReceiveStatus(result, next) { resume = () => next(result); } }); },
        })] }, { defaultTimeoutMs: 10 });
        try {
            const call = c.unary({ text: 'request' }, error => { callbacks++; codes.push(error?.code ?? 0); });
            const statuses = []; call.on('status', result => statuses.push(result.code));
            await immediate(); assert.equal(typeof resume, 'function');
            assert.equal(c.getChannel().activeCallCount(), 1);
            t.mock.timers.tick(10); await immediate();
            assert.deepEqual(codes, [grpc.status.DEADLINE_EXCEEDED]);
            assert.equal(c.getChannel().activeCallCount(), 0);
            resume(); await immediate();
            assert.equal(callbacks, 1);
            assert.deepEqual(statuses, [grpc.status.DEADLINE_EXCEEDED]);
        } finally { c.close(); }
    });
});
