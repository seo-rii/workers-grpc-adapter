'use strict';
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { getEventListeners } = require('node:events');
const { cancellableCall, cancellableQueryStream } = require('../dist/sdk.js');
const { assert, grpc, deferred, immediate } = require('./helpers.cjs');

const epoch = 1_700_000_000_000;
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
function clock(t) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
    return offset => t.mock.timers.setTime(epoch + offset);
}

for (const offset of [499, 500, 501]) for (const outcome of ['resolve', 'reject']) {
    test(`SDK promise ${outcome} at deadline offset ${offset} checks time before settling`, async t => {
        const setTime = clock(t), aborter = new AbortController(), pending = deferred();
        const failure = Object.assign(new Error('provider failure'), { code: 7 });
        let parent, cancellations = 0, notifications = 0;
        pending.promise.cancel = () => { cancellations++; };
        const scoped = cancellableCall(options => {
            parent = options.otherArgs.options.parent;
            parent.on('cancelled', () => { notifications++; });
            return pending.promise;
        }, { deadline: epoch + 500, signal: aborter.signal });
        setTime(offset); // Move the clock without running the queued deadline timer.
        if (outcome === 'resolve') pending.resolve('value'); else pending.reject(failure);
        const result = await observe(scoped.promise);
        if (offset >= 500) {
            assert.equal(result.error?.code, grpc.status.DEADLINE_EXCEEDED);
            assert.equal(cancellations, 1);
        } else if (outcome === 'resolve') assert.equal(result.value, 'value');
        else assert.equal(result.error, failure);
        assert.equal(parent.cancelled, offset >= 500 || outcome === 'reject');
        assert.equal(notifications, parent.cancelled ? 1 : 0);
        assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
        scoped.cancel(); aborter.abort(); t.mock.timers.tick(1000);
        assert.equal(cancellations, offset >= 500 ? 1 : 0);
    });
}

test('SDK expiry after synchronous factory work cancels the returned operation immediately', async t => {
    const setTime = clock(t), pending = deferred();
    let parent, cancellations = 0;
    pending.promise.cancel = () => { cancellations++; };
    const scoped = cancellableCall(options => {
        parent = options.otherArgs.options.parent;
        setTime(500);
        return pending.promise;
    }, { deadline: epoch + 500 });
    assert.equal(parent.cancelled, true);
    assert.equal(cancellations, 1);
    await assert.rejects(scoped.promise, { code: 4 });
    pending.resolve('late'); scoped.cancel();
    assert.equal(cancellations, 1);
});

test('SDK expiry wins a synchronous factory error after its budget is exhausted', async t => {
    const setTime = clock(t);
    const scoped = cancellableCall(() => { setTime(500); throw new Error('late startup'); }, { deadline: epoch + 500 });
    await assert.rejects(scoped.promise, { code: 4 });
});

for (const offset of [499, 500, 501]) for (const outcome of ['data', 'end', 'error']) {
    test(`SDK query ${outcome} at deadline offset ${offset} checks time before delivery`, async t => {
        const setTime = clock(t), source = new PassThrough({ objectMode: true }), aborter = new AbortController();
        let parent, ends = 0, notifications = 0;
        const originalEnd = source.end;
        source.end = function(...args) { ends++; return originalEnd.apply(this, args); };
        const stream = cancellableQueryStream(options => {
            parent = options.otherArgs.options.parent;
            parent.on('cancelled', () => { notifications++; });
            return source;
        }, { deadline: epoch + 500, signal: aborter.signal });
        const rows = [], failure = Object.assign(new Error('provider failure'), { code: 7 });
        const consumed = observe((async () => { for await (const row of stream) rows.push(row); })());
        source.write({ id: 'before' }); await immediate();
        setTime(offset);
        if (outcome === 'data') { source.emit('data', { id: 'boundary' }); source.emit('end'); }
        else if (outcome === 'end') source.emit('end');
        else source.emit('error', failure);
        const result = await consumed; await immediate();
        if (offset >= 500) assert.equal(result.error?.code, 4);
        else if (outcome === 'error') assert.equal(result.error, failure);
        else assert.equal(result.error, undefined);
        assert.deepEqual(rows, [{ id: 'before' }, ...(offset < 500 && outcome === 'data' ? [{ id: 'boundary' }] : [])]);
        assert.equal(parent.cancelled, offset >= 500 || outcome === 'error');
        assert.equal(notifications, parent.cancelled ? 1 : 0);
        assert.equal(source.destroyed, true);
        assert.equal(ends, 1);
        assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
        for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
        stream.destroy(); aborter.abort(); t.mock.timers.tick(1000);
        assert.equal(ends, 1);
    });
}

test('SDK expiry after query factory work stops its source before resuming', async t => {
    const setTime = clock(t), source = new PassThrough({ objectMode: true });
    let parent, resumed = 0, ends = 0;
    source.resume = () => { resumed++; return source; };
    const originalEnd = source.end;
    source.end = function(...args) { ends++; return originalEnd.apply(this, args); };
    const stream = cancellableQueryStream(options => {
        parent = options.otherArgs.options.parent; setTime(500); return source;
    }, { deadline: epoch + 500 });
    const result = observe((async () => { for await (const _ of stream) {} })());
    assert.equal(parent.cancelled, true);
    assert.equal(source.destroyed, true);
    assert.equal(resumed, 0);
    assert.equal(ends, 1);
    assert.equal((await result).error?.code, 4);
});

test('SDK cancellation that already won remains final after expiry', async t => {
    const setTime = clock(t), pending = deferred();
    const scoped = cancellableCall(() => pending.promise, { deadline: epoch + 500 });
    scoped.cancel(); setTime(500); pending.resolve('late');
    await assert.rejects(scoped.promise, { code: 1 });
});
