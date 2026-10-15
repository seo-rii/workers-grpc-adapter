'use strict';
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { getEventListeners, once } = require('node:events');
const { cancellableCall, cancellableQueryStream } = require('../dist/sdk.js');
const { assert, grpc, client, unary, withFetch, response, deferred, immediate, transportCall } = require('./helpers.cjs');

const epoch = 1_700_000_000_000;
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const rpcOptions = options => options.otherArgs.options;
function clock(t) { t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch }); }

test('SDK absolute deadline validates before starting and skips expired factories', async () => {
    let starts = 0;
    for (const helper of [cancellableCall, cancellableQueryStream]) {
        for (const deadline of [NaN, -Infinity, new Date(NaN), null, '1000', {}, []]) {
            assert.throws(() => helper(() => { starts++; }, { deadline }), /WGA_SDK_DEADLINE/);
        }
        for (const deadline of [0, Date.now() - 1, new Date(0)]) {
            const aborter = new AbortController();
            const operation = helper(() => { starts++; }, { deadline, signal: aborter.signal });
            const pending = helper === cancellableCall ? operation.promise : (async () => { for await (const _row of operation) {} })();
            await assert.rejects(pending, error => {
                assert.equal(error.code, grpc.status.DEADLINE_EXCEEDED);
                assert.equal(error.details, 'Deadline exceeded by SDK helper');
                assert.ok(error.metadata instanceof grpc.Metadata);
                assert.deepEqual(error.metadata.getMap(), {});
                return true;
            });
            assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
        }
    }
    assert.equal(starts, 0);
    const aborter = new AbortController(); aborter.abort();
    const preAborted = cancellableCall(() => { starts++; }, { signal: aborter.signal, deadline: 0 });
    await assert.rejects(preAborted.promise, { code: 1 }); assert.equal(starts, 0);
});

test('SDK deadline snapshots Date and preserves GAX timeouts while propagating a single parent', async t => {
    clock(t);
    const deadline = new Date(epoch + 500), metadata = new grpc.Metadata(); let supplied;
    const original = Object.freeze({ timeout: 1000, retry: null,
        otherArgs: Object.freeze({ metadata, options: Object.freeze({ deadline: epoch + 100 }) }) });
    const scoped = cancellableCall(options => { supplied = options; return Promise.resolve('done'); }, { deadline, gaxOptions: original });
    deadline.setTime(epoch + 50_000);
    assert.equal(await scoped.promise, 'done');
    assert.equal(rpcOptions(supplied).parent.getDeadline(), epoch + 500);
    assert.equal(rpcOptions(supplied).deadline, epoch + 100);
    assert.equal(rpcOptions(supplied).propagate_flags, grpc.propagate.DEADLINE | grpc.propagate.CANCELLATION);
    assert.equal(supplied.timeout, 1000); assert.equal(supplied.retry, null);
    assert.equal(supplied.otherArgs.metadata, metadata);
    assert.equal(Object.hasOwn(original.otherArgs.options, 'parent'), false);
    t.mock.timers.tick(50_000); assert.equal(rpcOptions(supplied).parent.cancelled, false);
});

test('SDK total deadline covers lazy initialization and blocks late RPCs without closing the shared client', async t => {
    clock(t);
    const c = client(), ready = deferred(), aborter = new AbortController(); let supplied, late, fetches = 0, cancels = 0;
    try {
        await withFetch(async () => { fetches++; return response(); }, async () => {
            const scoped = cancellableCall(options => {
                supplied = options;
                const pending = ready.promise.then(() => { late = unary(c, undefined, rpcOptions(options)); return late.promise; });
                pending.cancel = () => { cancels++; };
                return pending;
            }, { deadline: epoch + 500, signal: aborter.signal });
            const result = observe(scoped.promise);
            t.mock.timers.tick(500);
            assert.equal((await result).error.code, 4);
            assert.equal(rpcOptions(supplied).parent.cancelled, true); assert.equal(cancels, 1);
            assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
            ready.resolve(); await immediate();
            assert.equal(fetches, 0); assert.equal(c.getChannel().activeCallCount(), 0);
            assert.equal(transportCall(late.call).diagnostics().timerActive, false);
            scoped.cancel(); aborter.abort(); t.mock.timers.tick(1000); assert.equal(cancels, 1);
            assert.deepEqual(await unary(c).promise, { text: 'ok' }); assert.equal(fetches, 1);
        });
    } finally { c.close(); }
});

test('SDK later page calls use remaining total budget and preserve a shorter per-RPC deadline', async t => {
    clock(t);
    const c = client(), next = deferred(), pages = deferred(), finish = deferred();
    const timeouts = []; let supplied, firstParent, lastCall;
    try {
        await withFetch(async (_url, init) => { timeouts.push(init.headers.get('grpc-timeout')); return response(); }, async () => {
            const scoped = cancellableCall(async options => {
                supplied = options; firstParent = rpcOptions(options).parent;
                await unary(c, undefined, { ...rpcOptions(options), deadline: Date.now() + 100 }).promise;
                await next.promise;
                lastCall = unary(c, undefined, { ...rpcOptions(options), deadline: Date.now() + 10_000 });
                await lastCall.promise;
                pages.resolve(); await finish.promise;
                return unary(c, undefined, rpcOptions(options)).promise;
            }, { deadline: epoch + 500, gaxOptions: { timeout: 10_000 } });
            const result = observe(scoped.promise);
            await immediate(); assert.deepEqual(timeouts, ['100m']);
            t.mock.timers.tick(300); next.resolve(); await pages.promise;
            assert.deepEqual(timeouts, ['100m', '200m']);
            assert.equal(rpcOptions(supplied).parent, firstParent);
            assert.equal(firstParent.getDeadline() - Date.now(), 200);
            t.mock.timers.tick(200); assert.equal((await result).error.code, 4);
            finish.resolve(); await immediate();
            assert.equal(timeouts.length, 2); assert.equal(c.getChannel().activeCallCount(), 0);
            assert.equal(transportCall(lastCall.call).diagnostics().timerActive, false);
        });
    } finally { c.close(); }
});

test('SDK total deadline expires queue admission without cancelling the occupying sibling', async t => {
    clock(t);
    const c = client({}, { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 } });
    const entered = deferred(); let fetches = 0, aborted = false, queued;
    try {
        await withFetch(async (_url, init) => {
            fetches++; entered.resolve();
            return new Promise((_yes, no) => init.signal.addEventListener('abort', () => { aborted = true; no(new Error('stopped')); }, { once: true }));
        }, async () => {
            const held = unary(c); const heldResult = observe(held.promise); await entered.promise;
            const scoped = cancellableCall(options => {
                queued = unary(c, undefined, rpcOptions(options)); return queued.promise;
            }, { deadline: epoch + 500 });
            const result = observe(scoped.promise); await immediate();
            assert.equal(c.getChannel().activeCallCount(), 2);
            t.mock.timers.tick(500); assert.equal((await result).error.code, 4); await immediate();
            assert.equal(c.getChannel().activeCallCount(), 1); assert.equal(fetches, 1); assert.equal(aborted, false);
            assert.equal(transportCall(queued.call).diagnostics().timerActive, false);
            held.call.cancel(); await heldResult; await immediate();
            assert.equal(c.getChannel().activeCallCount(), 0); assert.equal(aborted, true);
        });
    } finally { c.close(); }
});

test('SDK total deadline interrupts adapter retry backoff with no additional attempt', async t => {
    clock(t);
    const c = client({}, { retryPolicy: { methods: ['/demo.Echo/Unary'], maxAttempts: 3, initialBackoffMs: 1000,
        maxBackoffMs: 1000, backoffMultiplier: 1, retryableStatusCodes: [14] } });
    let fetches = 0, child;
    try {
        await withFetch(async () => { fetches++; return response([], { code: 14 }); }, async () => {
            const scoped = cancellableCall(options => { child = unary(c, undefined, rpcOptions(options)); return child.promise; }, { deadline: epoch + 500 });
            const result = observe(scoped.promise); await immediate(); await immediate(); assert.equal(fetches, 1);
            t.mock.timers.tick(500); assert.equal((await result).error.code, 4); await immediate();
            t.mock.timers.tick(10_000); await immediate();
            assert.equal(fetches, 1); assert.equal(c.getChannel().activeCallCount(), 0);
            assert.equal(transportCall(child.call).diagnostics().timerActive, false);
        });
    } finally { c.close(); }
});

test('SDK pending Fetch observes deadline abort and releases the call', async t => {
    clock(t);
    const c = client(), entered = deferred(); let aborts = 0;
    try {
        await withFetch(async (_url, init) => {
            entered.resolve();
            return new Promise((_yes, no) => init.signal.addEventListener('abort', () => { aborts++; no(new Error('stopped')); }, { once: true }));
        }, async () => {
            const scoped = cancellableCall(options => unary(c, undefined, rpcOptions(options)).promise, { deadline: epoch + 500 });
            const result = observe(scoped.promise); await entered.promise;
            t.mock.timers.tick(500); assert.equal((await result).error.code, 4); await immediate();
            assert.equal(aborts, 1); assert.equal(c.getChannel().activeCallCount(), 0);
        });
    } finally { c.close(); }
});

test('SDK deadline handles long timers without overflow and permits Infinity', async t => {
    clock(t);
    const pending = deferred(); let cancels = 0, settled = false;
    pending.promise.cancel = () => { cancels++; };
    const scoped = cancellableCall(() => pending.promise, { deadline: epoch + 2147483657 });
    const result = observe(scoped.promise).then(value => { settled = true; return value; });
    t.mock.timers.tick(1); await immediate(); assert.equal(settled, false);
    t.mock.timers.tick(2147483646); await immediate(); assert.equal(settled, false);
    t.mock.timers.tick(10); assert.equal((await result).error.code, 4); assert.equal(cancels, 1);
    const infinite = cancellableCall(() => Promise.resolve('done'), { deadline: Infinity });
    assert.equal(await infinite.promise, 'done');
});

test('SDK completion, failure and explicit cancellation release the local deadline timer', async t => {
    clock(t);
    for (const outcome of ['success', 'error', 'cancel', 'abort']) {
        const pending = deferred(), aborter = new AbortController(); let parent, cancels = 0, notifications = 0;
        const failure = Object.assign(new Error('original'), { code: 7, metadata: new grpc.Metadata() });
        pending.promise.cancel = () => { cancels++; };
        const scoped = cancellableCall(options => {
            parent = rpcOptions(options).parent; parent.on('cancelled', () => { notifications++; }); return pending.promise;
        }, { deadline: Date.now() + 500, signal: aborter.signal });
        const result = observe(scoped.promise);
        if (outcome === 'success') pending.resolve('ok');
        else if (outcome === 'error') pending.reject(failure);
        else if (outcome === 'cancel') scoped.cancel();
        else aborter.abort();
        const settled = await result;
        if (outcome === 'success') assert.equal(settled.value, 'ok');
        else if (outcome === 'error') assert.equal(settled.error, failure);
        else assert.equal(settled.error.code, 1);
        t.mock.timers.tick(1000);
        assert.equal(notifications, outcome === 'success' ? 0 : 1);
        assert.equal(cancels, outcome === 'cancel' || outcome === 'abort' ? 1 : 0);
        assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
    }
});

test('SDK deadline leaves service errors and trailing metadata unchanged', async t => {
    clock(t);
    const c = client(); let original;
    try {
        await withFetch(async () => response([], { code: 7, details: 'permission denied', extra: 'x-receipt: receipt-id\r\n' }), async () => {
            const scoped = cancellableCall(options => {
                const child = unary(c, undefined, rpcOptions(options));
                return child.promise.catch(error => { original = error; throw error; });
            }, { deadline: epoch + 500 });
            await assert.rejects(scoped.promise, error => {
                assert.equal(error, original); assert.equal(error.code, 7); assert.equal(error.details, 'permission denied');
                assert.deepEqual(error.metadata.get('x-receipt'), ['receipt-id']); return true;
            });
            t.mock.timers.tick(1000); assert.equal(c.getChannel().activeCallCount(), 0);
        });
    } finally { c.close(); }
});

test('SDK query deadline expires an undemanded source and ends pagination once', async t => {
    clock(t);
    const aborter = new AbortController(); let source, parent, reads = 0, ends = 0;
    const stream = cancellableQueryStream(options => {
        parent = rpcOptions(options).parent;
        source = new PassThrough({ objectMode: true, read() { reads++; } });
        const end = source.end;
        source.end = function(...args) { ends++; return end.apply(this, args); };
        return source;
    }, { deadline: epoch + 500, signal: aborter.signal });
    const error = once(stream, 'error');
    t.mock.timers.tick(500);
    assert.equal((await error)[0].code, 4); await immediate();
    assert.equal(parent.cancelled, true); assert.equal(source.destroyed, true); assert.equal(ends, 1); assert.equal(reads, 0);
    assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
    for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
});

test('SDK query deadline preserves partial rows and events; EOF or source errors clear its timer', async t => {
    clock(t);
    for (const outcome of ['deadline', 'eof', 'error']) {
        const source = new PassThrough({ objectMode: true }); let parent;
        const stream = cancellableQueryStream(options => { parent = rpcOptions(options).parent; return source; }, { deadline: Date.now() + 500 });
        const rows = [], events = [], metadata = new grpc.Metadata(); metadata.set('x-receipt', 'kept');
        const failure = Object.assign(new Error('source status'), { code: 7, metadata });
        const finalStatus = { code: 7, details: 'source status', metadata };
        stream.on('metadata', value => events.push(value)); stream.on('status', value => events.push(value));
        const consumed = observe((async () => { for await (const row of stream) rows.push(row); })());
        source.emit('metadata', metadata); source.write({ id: 1 }); await immediate();
        if (outcome === 'deadline') t.mock.timers.tick(500);
        else if (outcome === 'eof') source.end();
        else { source.emit('status', finalStatus); source.destroy(failure); }
        const result = await consumed; await immediate();
        assert.deepEqual(rows, [{ id: 1 }]); assert.equal(events[0], metadata);
        if (outcome === 'deadline') assert.equal(result.error.code, 4);
        else if (outcome === 'error') { assert.equal(result.error, failure); assert.equal(events[1], finalStatus); }
        else { assert.equal(result.error, undefined); assert.equal(parent.cancelled, false); }
        t.mock.timers.tick(1000); assert.equal(source.destroyed, true); assert.equal(parent.cancelled, outcome !== 'eof');
    }
});
