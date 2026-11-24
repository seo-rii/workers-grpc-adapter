'use strict';
const test = require('node:test');
const { getEventListeners } = require('node:events');
const { createCancellationScope } = require('../dist/sdk.js');
const { assert, client, unary, withFetch, response, deferred, immediate, grpc } = require('./helpers.cjs');

function observe(promise) { return promise.then(value => ({ value }), error => ({ error })); }
const callOptions = gaxOptions => gaxOptions.otherArgs.options;
// Each fetch waits until its request signal aborts; `entered` resolves per arrival.
function pendingFetch(state) {
    return async (_url, init) => {
        state.fetches++;
        state.arrived?.();
        return new Promise((_yes, no) => init.signal.addEventListener('abort', () => {
            state.aborts++; no(new Error('aborted'));
        }, { once: true }));
    };
}

test('SCOPE cancels every pending call that used its options and fails later ones without Fetch', async () => {
    const c = client(), state = { fetches: 0, aborts: 0 };
    try {
        await withFetch(pendingFetch(state), async () => {
            const scope = createCancellationScope();
            let arrivals = 0; const both = deferred();
            state.arrived = () => { if (++arrivals === 2) both.resolve(); };
            const first = observe(unary(c, { text: 'one' }, callOptions(scope.gaxOptions())).promise);
            const second = observe(unary(c, { text: 'two' }, callOptions(scope.gaxOptions({ timeout: 5000 }))).promise);
            await both.promise;
            assert.equal(scope.cancelled, false);
            scope.cancel(); scope.cancel();
            assert.equal(scope.cancelled, true);
            for (const result of [await first, await second]) {
                assert.equal(result.error.code, grpc.status.CANCELLED);
                assert.equal(result.error.details, 'Cancelled by parent call');
            }
            await immediate();
            assert.equal(state.aborts, 2);
            const late = await observe(unary(c, { text: 'late' }, callOptions(scope.gaxOptions())).promise);
            assert.equal(late.error.code, grpc.status.CANCELLED);
            assert.equal(state.fetches, 2, 'a call started after cancellation never reaches Fetch');
            assert.equal(c.getChannel().activeCallCount(), 0);
        });
    } finally { c.close(); }
});

test('SCOPE follows an AbortSignal, including one aborted before the scope starts', async () => {
    for (const preAbort of [false, true]) {
        const c = client(), state = { fetches: 0, aborts: 0 }, aborter = new AbortController();
        if (preAbort) aborter.abort('reason is not exposed');
        try {
            await withFetch(pendingFetch(state), async () => {
                const entered = deferred(); state.arrived = entered.resolve;
                const scope = createCancellationScope({ signal: aborter.signal });
                assert.equal(scope.cancelled, preAbort);
                const pending = observe(unary(c, undefined, callOptions(scope.gaxOptions())).promise);
                if (!preAbort) { await entered.promise; aborter.abort(); }
                const { error } = await pending;
                assert.equal(error.code, grpc.status.CANCELLED);
                assert.doesNotMatch(String(error.message), /reason is not exposed/);
                assert.equal(state.fetches, preAbort ? 0 : 1);
                scope.dispose();
                assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
            });
        } finally { c.close(); }
    }
});

test('SCOPE deadline bounds every call, never extends an earlier one, and expires calls started late', async () => {
    const c = client(), state = { fetches: 0, aborts: 0 };
    try {
        await withFetch(pendingFetch(state), async () => {
            const scope = createCancellationScope({ deadline: Date.now() + 60 });
            const started = Date.now();
            const bounded = await observe(unary(c, undefined, callOptions(scope.gaxOptions())).promise);
            assert.equal(bounded.error.code, grpc.status.DEADLINE_EXCEEDED);
            assert.ok(Date.now() - started < 2000);
            const late = await observe(unary(c, undefined, callOptions(scope.gaxOptions())).promise);
            assert.equal(late.error.code, grpc.status.DEADLINE_EXCEEDED);
            assert.equal(state.fetches, 1, 'an expired scope starts no Fetch');
            const earlier = createCancellationScope({ deadline: new Date(Date.now() + 60_000) });
            const shortCall = { ...callOptions(earlier.gaxOptions()), deadline: Date.now() + 30 };
            const result = await observe(unary(c, undefined, shortCall).promise);
            assert.equal(result.error.code, grpc.status.DEADLINE_EXCEEDED, 'the per-call deadline still wins');
        });
    } finally { c.close(); }
});

test('SCOPE options copy caller containers, keep parent identity, and reject conflicts and misuse', async () => {
    const scope = createCancellationScope();
    const headers = { 'x-extra': 'kept' }, retry = { retryCodes: [14] };
    const original = Object.freeze({ timeout: 123, retry, otherArgs: Object.freeze({ headers, options: Object.freeze({ host: 'same.test' }) }) });
    const first = scope.gaxOptions(original), second = scope.gaxOptions();
    assert.notEqual(first, original); assert.equal(first.timeout, 123); assert.equal(first.retry, retry);
    assert.equal(first.otherArgs.headers, headers); assert.equal(first.otherArgs.options.host, 'same.test');
    assert.equal(first.otherArgs.options.parent, second.otherArgs.options.parent, 'every call shares one parent');
    assert.equal(first.otherArgs.options.propagate_flags, grpc.propagate.CANCELLATION);
    assert.equal(Object.hasOwn(original.otherArgs.options, 'parent'), false);
    const timed = createCancellationScope({ deadline: Date.now() + 1000 });
    assert.equal(timed.gaxOptions().otherArgs.options.propagate_flags, grpc.propagate.CANCELLATION | grpc.propagate.DEADLINE);
    for (const nested of [{ parent: {} }, { propagate_flags: 8 }]) {
        assert.throws(() => scope.gaxOptions({ otherArgs: { options: nested } }), /WGA_SDK_PARENT_CONFLICT/);
    }
    for (const options of [{ gaxOptions: {} }, { timeout: 1 }, null, 'x']) {
        assert.throws(() => createCancellationScope(options), /WGA_SDK_OPTIONS/);
    }
    assert.throws(() => createCancellationScope({ signal: {} }), /WGA_SDK_SIGNAL/);
    for (const deadline of [Number.NaN, -Infinity, new Date(Number.NaN)]) {
        assert.throws(() => createCancellationScope({ deadline }), /WGA_SDK_DEADLINE/);
    }
    scope.dispose(); scope.dispose();
    assert.throws(() => scope.gaxOptions(), /WGA_SDK_SCOPE_DISPOSED/);
    assert.ok(Object.isFrozen(scope));
});

test('SCOPE dispose leaves pending calls running and detaches only the signal', async () => {
    const c = client(), aborter = new AbortController(), release = deferred(); let fetches = 0;
    try {
        await withFetch(async () => { fetches++; await release.promise; return response(); }, async () => {
            const scope = createCancellationScope({ signal: aborter.signal });
            const pending = unary(c, undefined, callOptions(scope.gaxOptions())).promise;
            await immediate(); await immediate();
            scope.dispose(); aborter.abort(); release.resolve();
            assert.deepEqual(await pending, { text: 'ok' });
            assert.equal(scope.cancelled, false);
            assert.equal(fetches, 1);
            scope.cancel();
            assert.equal(c.getChannel().activeCallCount(), 0);
        });
    } finally { c.close(); }
});
