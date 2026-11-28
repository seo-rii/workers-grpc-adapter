'use strict';
// Workers ends a request context once its Response is returned: that context's
// timers never fire, its promise continuations are cancelled and its Fetch I/O
// is cancelled without settling any JavaScript promise. An SDK can still have
// an RPC running there (Firestore's background Rollback, or a RunQuery stream
// drained after get() resolved). These tests reproduce that state in Node by
// withholding timer delivery and never settling the Fetch work, then check
// that later activity on the shared transport ends and releases the call.
const { test } = require('node:test');
const { assert, grpc, Echo, serialize, trailers, immediate, transportCall } = require('./helpers.cjs');
const { encodeFrame } = require('../dist/wire.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { createCancellationScope } = require('../dist/sdk.js');
const { DETACHED_DEADLINE_GRACE_MS: GRACE } = require('../dist/resources.js');

const START = 1_000_000;
function detachedRuntime(t) {
    // Timers registered by the ended context are never delivered.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = START;
    t.mock.method(Date, 'now', () => now);
    return { set(value) { now = value; } };
}
const never = () => new Promise(() => {});
// The suspended context's Fetch: headers never arrive and abort is not observed.
const pendingFetch = () => never();
// Headers and one message arrived; the trailer read never settles, and a
// cancel from another request cannot reach the reader (workerd rejects it).
function pendingBody() {
    let reads = 0;
    const reader = {
        read: () => reads++ === 0 ? Promise.resolve({ done: false, value: encodeFrame(serialize({ text: 'first' })) }) : never(),
        cancel: () => Promise.reject(new Error('Cannot perform I/O on behalf of a different request.')),
        releaseLock() {},
    };
    return { status: 200, headers: new Headers({ 'content-type': 'application/grpc-web+proto' }),
        body: { getReader: () => reader, cancel: () => Promise.reject(new Error('different request')) } };
}
function reply(text) {
    return new Response(Buffer.concat([encodeFrame(serialize({ text })), trailers()]),
        { headers: { 'content-type': 'application/grpc-web+proto' } });
}
function setup(fetches, resourceLimits) {
    let index = 0;
    const transport = createWorkersGrpcTransport({ fetcher: { fetch: () => fetches[index++]() },
        ...(resourceLimits ? { resourceLimits } : {}) });
    const client = new Echo('echo.test:443', transport.channelCredentials, transport.grpcOptions());
    return { transport, client, fetchCount: () => index };
}
function unary(client, deadline, extra = {}) {
    const record = { callbacks: [], statuses: [] };
    record.call = client.unary({ text: 'request' }, { ...(deadline === undefined ? {} : { deadline }), ...extra },
        error => record.callbacks.push(error?.code ?? grpc.status.OK));
    record.call.on('status', value => record.statuses.push(value.code));
    return record;
}
function stream(client, deadline) {
    const record = { messages: [], errors: [], statuses: [] };
    record.call = client.stream({ text: 'request' }, { deadline });
    record.call.on('data', value => record.messages.push(value.text));
    record.call.on('error', error => record.errors.push(error.code));
    record.call.on('status', value => record.statuses.push(value.code));
    return record;
}
async function settle() { for (let i = 0; i < 4; i++) await immediate(); }
const usage = transport => {
    const { activeCalls, queuedCalls, bufferedBytes } = transport.resourceUsage();
    return { activeCalls, queuedCalls, bufferedBytes };
};

for (const phase of ['awaiting-headers', 'reading-body']) {
    test(`DETACHED a call whose context ended while ${phase} is expired and released after its deadline`, async t => {
        const clock = detachedRuntime(t);
        const deadline = START + 5000;
        const { transport, client } = setup([phase === 'awaiting-headers' ? pendingFetch : async () => pendingBody()]);
        try {
            const call = phase === 'awaiting-headers' ? unary(client, deadline) : stream(client, deadline);
            await settle();
            if (phase === 'reading-body') assert.deepEqual(call.messages, ['first']);
            const held = usage(transport);
            assert.equal(held.activeCalls, 1, phase);
            assert.ok(held.bufferedBytes > 0, `${phase}: the attempt holds its encoded request`);
            // The deadline passed but its timer never ran. Within the grace
            // period the adapter does not pre-empt a timer that may still run.
            clock.set(deadline + GRACE - 1);
            assert.deepEqual(usage(transport), held);
            assert.equal(client.getChannel().activeCallCount(), 1);
            clock.set(deadline + GRACE);
            assert.deepEqual(usage(transport), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }, phase);
            assert.equal(client.getChannel().activeCallCount(), 0);
            await settle();
            assert.deepEqual(call.statuses, [grpc.status.DEADLINE_EXCEEDED], phase);
            if (phase === 'awaiting-headers') assert.deepEqual(call.callbacks, [grpc.status.DEADLINE_EXCEEDED]);
            else assert.deepEqual(call.errors, [grpc.status.DEADLINE_EXCEEDED]);
            const diagnostics = transportCall(call.call).diagnostics();
            assert.equal(diagnostics.terminal, true);
            assert.equal(diagnostics.fetchCount, 1);
            // A later sweep finds nothing left to expire.
            clock.set(deadline + 10 * GRACE);
            assert.deepEqual(usage(transport), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
            assert.equal(call.statuses.length, 1);
        } finally { client.close(); }
    });
}

test('DETACHED admission slots held by ended contexts are recovered by the next call', async t => {
    const clock = detachedRuntime(t);
    const deadline = START + 2000;
    const { transport, client, fetchCount } = setup([pendingFetch, async () => pendingBody(), async () => reply('later')],
        { maxConcurrentCalls: 2 });
    try {
        const rollback = unary(client, deadline), drain = stream(client, deadline);
        await settle();
        assert.equal(usage(transport).activeCalls, 2);
        assert.equal(fetchCount(), 2);
        // Before the change these slots were held forever: every later call
        // failed immediately (maxQueuedCalls defaults to 0).
        clock.set(deadline + GRACE - 1);
        const rejected = unary(client, START + 60_000);
        await settle();
        assert.deepEqual(rejected.callbacks, [grpc.status.RESOURCE_EXHAUSTED]);
        assert.equal(fetchCount(), 2, 'a rejected call never reaches Fetch');
        clock.set(deadline + GRACE);
        const admitted = unary(client, START + 60_000);
        await settle();
        assert.equal(fetchCount(), 3);
        assert.deepEqual(admitted.callbacks, [grpc.status.OK]);
        assert.deepEqual(rollback.callbacks, [grpc.status.DEADLINE_EXCEEDED]);
        assert.deepEqual(drain.statuses, [grpc.status.DEADLINE_EXCEEDED]);
        assert.deepEqual(usage(transport), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
        assert.equal(transport.resourceUsage().peakActiveCalls, 2);
    } finally { client.close(); }
});

test('DETACHED a queued call from an ended context leaves the queue at its deadline', async t => {
    const clock = detachedRuntime(t);
    const { transport, client, fetchCount } = setup([pendingFetch, async () => reply('next')], { maxConcurrentCalls: 1, maxQueuedCalls: 1 });
    try {
        const active = unary(client, START + 1000), queued = unary(client, START + 3000);
        await settle();
        assert.deepEqual(usage(transport).queuedCalls, 1);
        clock.set(START + 1000 + GRACE);
        // The active call is expired first; the queued one is admitted by the
        // same sweep and reaches Fetch with its own remaining budget.
        assert.equal(usage(transport).queuedCalls, 0);
        await settle();
        assert.deepEqual(active.callbacks, [grpc.status.DEADLINE_EXCEEDED]);
        assert.equal(fetchCount(), 2);
        assert.deepEqual(queued.callbacks, [grpc.status.OK]);
        assert.deepEqual(usage(transport), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
    } finally { client.close(); }
});

test('DETACHED channel close from a later request releases admission now and stranded bytes at the deadline', async t => {
    const clock = detachedRuntime(t);
    const deadline = START + 4000;
    const { transport, client } = setup([async () => pendingBody()]);
    const call = stream(client, deadline);
    await settle();
    client.close();
    await settle();
    assert.deepEqual(call.statuses, [grpc.status.UNAVAILABLE]);
    const closed = usage(transport);
    assert.equal(closed.activeCalls, 0);
    assert.ok(closed.bufferedBytes > 0, 'the suspended attempt cannot unwind to release its reservations');
    clock.set(deadline + GRACE);
    assert.deepEqual(usage(transport), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
    await settle();
    assert.deepEqual(call.statuses, [grpc.status.UNAVAILABLE], 'the first terminal status is retained');
});

test('DETACHED expiry detaches the call from a shared cancellation scope', async t => {
    const clock = detachedRuntime(t);
    const deadline = START + 2000;
    const { transport, client } = setup([pendingFetch]);
    const scope = createCancellationScope();
    try {
        const options = scope.gaxOptions().otherArgs.options;
        const call = unary(client, deadline, options);
        await settle();
        clock.set(deadline + GRACE);
        assert.equal(usage(transport).activeCalls, 0);
        scope.cancel();
        await settle();
        assert.deepEqual(call.callbacks, [grpc.status.DEADLINE_EXCEEDED]);
        assert.deepEqual(call.statuses, [grpc.status.DEADLINE_EXCEEDED]);
    } finally { scope.dispose(); client.close(); }
});

test('DETACHED a call without a deadline cannot be bounded and stays until close', async t => {
    const clock = detachedRuntime(t);
    const { transport, client } = setup([pendingFetch]);
    const call = unary(client, Infinity);
    await settle();
    clock.set(START + 365 * 24 * 3600 * 1000);
    assert.equal(usage(transport).activeCalls, 1);
    client.close();
    await settle();
    assert.deepEqual(call.callbacks, [grpc.status.UNAVAILABLE]);
    assert.equal(usage(transport).activeCalls, 0);
});

test('DETACHED a call that expired by its own timer is not expired again; an unsettled Fetch keeps bytes only until the grace ends', async t => {
    const clock = detachedRuntime(t);
    const { transport, client } = setup([pendingFetch]);
    try {
        const call = unary(client, START + 100);
        await settle();
        clock.set(START + 100);
        t.mock.timers.tick(100);
        await settle();
        assert.deepEqual(call.callbacks, [grpc.status.DEADLINE_EXCEEDED]);
        const expired = usage(transport);
        assert.equal(expired.activeCalls, 0);
        assert.ok(expired.bufferedBytes > 0, 'an unsettled Fetch still owns its request body');
        clock.set(START + 100 + GRACE - 1);
        assert.deepEqual(usage(transport), expired);
        // Work that has not unwound a full grace period after its deadline is
        // treated as detached, even in a runtime whose timers still run.
        clock.set(START + 100 + GRACE);
        assert.deepEqual(usage(transport), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
        await settle();
        assert.equal(call.callbacks.length, 1);
        assert.equal(call.statuses.length, 1);
    } finally { client.close(); }
});
