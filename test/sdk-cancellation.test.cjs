'use strict';
const test = require('node:test');
const { Readable, Transform, PassThrough } = require('node:stream');
const { getEventListeners, once } = require('node:events');
const { cancellableCall, cancellableQueryStream } = require('../dist/sdk.js');
const { assert, client, unary, withFetch, response, deferred, immediate, grpc } = require('./helpers.cjs');

function observe(promise) { return promise.then(value => ({ value }), error => ({ error })); }
function parentOptions(options) { return options.otherArgs.options; }
function sourceFactory(values, options, capture = () => {}) {
    const source = new Transform({ objectMode: true, read() {
        if (this.started) return;
        this.started = true;
        for (const value of values) this.push(value);
        this.emit('info', { count: values.length }); this.emit('metadata', 'metadata'); this.emit('status', { code: 0 }); this.push(null);
    } });
    capture(source, parentOptions(options).parent);
    return source;
}
function hang(c, options, arrivals) {
    const call = unary(c, { text: 'pending' }, parentOptions(options));
    arrivals.push(call);
    return call.promise;
}

test('SDK promise rejects pre-abort without starting, and detaches signal on every outcome', async () => {
    for (const scenario of ['pre-abort', 'cancel', 'abort', 'success', 'reject', 'throw']) {
        const aborter = new AbortController(), pending = deferred(); let starts = 0, parent;
        const failure = new Error('original SDK failure');
        if (scenario === 'pre-abort') aborter.abort('reason is not exposed');
        const scoped = cancellableCall(options => {
            starts++; parent = parentOptions(options).parent;
            if (scenario === 'throw') throw failure;
            return pending.promise;
        }, { signal: aborter.signal });
        const result = observe(scoped.promise);
        if (scenario === 'cancel') { scoped.cancel(); scoped.cancel(); }
        else if (scenario === 'abort') aborter.abort();
        else if (scenario === 'success') pending.resolve('complete');
        else if (scenario === 'reject') pending.reject(failure);
        const { error, value } = await result;
        assert.equal(starts, scenario === 'pre-abort' ? 0 : 1);
        assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
        if (['pre-abort', 'cancel', 'abort'].includes(scenario)) {
            assert.equal(error.code, grpc.status.CANCELLED); assert.equal(error.details, 'Cancelled by SDK helper');
            assert.ok(error.metadata instanceof grpc.Metadata);
            if (parent) assert.equal(parent.cancelled, true);
            if (starts) pending.reject(failure); await immediate();
        } else if (scenario === 'success') {
            assert.equal(value, 'complete'); scoped.cancel(); aborter.abort(); assert.equal(parent.cancelled, false);
        } else assert.equal(error, failure);
    }
});

test('SDK helper copies only option containers, preserves metadata, and rejects parent conflicts before start', async () => {
    const credentials = grpc.credentials.createFromMetadataGenerator((_input, cb) => cb(null, new grpc.Metadata()));
    const metadata = new grpc.Metadata(); metadata.set('x-test', 'kept');
    const headers = { 'x-extra': 'kept' }, retry = { retryCodes: [14] };
    const original = Object.freeze({ timeout: 123, retry, otherArgs: Object.freeze({ headers, metadata,
        options: Object.freeze({ credentials, host: 'same.test' }) }) });
    let received;
    await cancellableCall(options => { received = options; return Promise.resolve(); }, { gaxOptions: original }).promise;
    assert.notEqual(received, original); assert.notEqual(received.otherArgs, original.otherArgs);
    assert.notEqual(received.otherArgs.options, original.otherArgs.options);
    assert.equal(received.timeout, 123); assert.equal(received.retry, retry); assert.equal(received.otherArgs.headers, headers);
    assert.equal(received.otherArgs.metadata, metadata); assert.equal(received.otherArgs.options.credentials, credentials);
    assert.equal(received.otherArgs.options.host, 'same.test'); assert.equal(received.otherArgs.options.propagate_flags, 8);
    assert.equal(Object.hasOwn(original.otherArgs.options, 'parent'), false);
    let starts = 0;
    for (const nested of [{ parent: {} }, { parent: null }, { parent: undefined }, { propagate_flags: 0 }, { propagate_flags: 8 }]) {
        const options = { gaxOptions: { otherArgs: { options: nested } } };
        for (const helper of [cancellableCall, cancellableQueryStream]) {
            assert.throws(() => helper(() => { starts++; }, options), /WGA_SDK_PARENT_CONFLICT/);
        }
    }
    assert.equal(starts, 0);
});

test('SDK promise cancellation wins until completion is observed; late success/failure never resettles', async () => {
    for (const late of ['resolve', 'reject']) {
        const pending = deferred(); let settles = 0, parent;
        const scoped = cancellableCall(options => { parent = parentOptions(options).parent; return pending.promise; });
        const result = observe(scoped.promise).then(value => { settles++; return value; });
        pending[late](late === 'resolve' ? 'late response' : new Error('late failure'));
        scoped.cancel(); assert.equal((await result).error.code, 1);
        scoped.cancel(); await immediate(); assert.equal(settles, 1); assert.equal(parent.cancelled, true);
    }
    const scoped = cancellableCall(() => Promise.resolve('complete'));
    assert.equal(await scoped.promise, 'complete'); scoped.cancel(); assert.equal(await scoped.promise, 'complete');
});

test('SDK cancel hook is optional, once-only and isolated; synchronous abort during start also cancels returned work', async () => {
    for (const kind of ['normal', 'throw', 'abort-in-start']) {
        const pending = deferred(), aborter = new AbortController(); let cancels = 0;
        pending.promise.cancel = () => { cancels++; if (kind === 'throw') throw new Error('SDK cancel failed'); };
        const scoped = cancellableCall(() => { if (kind === 'abort-in-start') aborter.abort(); return pending.promise; }, { signal: aborter.signal });
        const result = observe(scoped.promise);
        scoped.cancel(); scoped.cancel(); assert.equal((await result).error.code, 1);
        pending.reject(new Error('settled after cancellation')); await immediate(); assert.equal(cancels, 1);
    }
});

test('SDK parent stays cancelled through lazy startup and prevents any subsequent Fetch', async () => {
    for (const mode of ['grpc-web', 'cloudflare']) {
        const c = client({}, mode === 'grpc-web' ? { mode, endpoints: { 'echo.test:443': 'https://gateway.test' } } : { mode }), ready = deferred(), arrivals = []; let fetches = 0, options, parent;
        try {
            await withFetch(async () => { fetches++; return response(); }, async () => {
                const scoped = cancellableCall(async supplied => {
                    options = supplied; parent = parentOptions(supplied).parent;
                    await ready.promise; return hang(c, supplied, arrivals);
                });
                const rejected = assert.rejects(scoped.promise, { code: 1 }); scoped.cancel(); await rejected;
                assert.equal(parent.cancelled, true); ready.resolve(); await immediate(); await immediate();
                assert.equal(fetches, 0); assert.equal(c.getChannel().activeCallCount(), 0);
                const late = unary(c, { text: 'late retry' }, parentOptions(options));
                await assert.rejects(late.promise, { code: 1 }); assert.equal(fetches, 0);
                assert.deepEqual(await unary(c).promise, { text: 'ok' }); assert.equal(fetches, 1);
            });
        } finally { c.close(); }
    }
});

test('SDK scoped cancellation aborts only its own Fetch and releases concurrent calls on a shared client', async () => {
    const c = client(), entered = deferred(); let count = 0, aborts = 0;
    try {
        await withFetch(async (_url, init) => {
            count++;
            if (count === 1) { entered.resolve(); return new Promise((_yes, no) => init.signal.addEventListener('abort', () => { aborts++; no(new Error('aborted')); }, { once: true })); }
            return response();
        }, async () => {
            const first = cancellableCall(options => unary(c, undefined, parentOptions(options)).promise);
            const firstResult = observe(first.promise); await entered.promise;
            const second = cancellableCall(options => unary(c, undefined, parentOptions(options)).promise);
            first.cancel(); assert.equal((await firstResult).error.code, 1);
            assert.deepEqual(await second.promise, { text: 'ok' }); await immediate();
            assert.equal(aborts, 1); assert.equal(count, 2); assert.equal(c.getChannel().activeCallCount(), 0);
        });
    } finally { c.close(); }
});

test('SDK startup throw or rejection also cancels RPCs started before failure', async () => {
    for (const kind of ['throw', 'reject', 'invalid-result']) {
        const c = client(); let parent, child, fetches = 0;
        const failure = new Error('factory failed');
        try {
            await withFetch(async () => { fetches++; return response(); }, async () => {
                const scoped = cancellableCall(options => {
                    parent = parentOptions(options).parent;
                    child = observe(unary(c, undefined, parentOptions(options)).promise);
                    if (kind === 'throw') throw failure;
                    return kind === 'reject' ? Promise.reject(failure) : undefined;
                });
                const result = await observe(scoped.promise);
                assert.equal(kind === 'invalid-result' ? result.error.message : result.error,
                    kind === 'invalid-result' ? 'WGA_SDK_PROMISE_REQUIRED' : failure);
                assert.equal(parent.cancelled, true); assert.equal((await child).error.code, 1);
                assert.equal(c.getChannel().activeCallCount(), 0); assert.equal(fetches, 0);
            });
        } finally { c.close(); }
    }
});

test('SDK query natural EOF preserves success, forwards info and removes helper listeners', async () => {
    const aborter = new AbortController(); let source, parent;
    const stream = cancellableQueryStream(options => sourceFactory([1, 2, 3], options, (s, p) => { source = s; parent = p; }), { signal: aborter.signal });
    const info = [], metadata = [], statuses = [];
    stream.on('info', value => info.push(value)); stream.on('metadata', value => metadata.push(value)); stream.on('status', value => statuses.push(value));
    const values = []; for await (const value of stream) values.push(value);
    assert.deepEqual(values, [1, 2, 3]); assert.deepEqual(info, [{ count: 3 }]); assert.deepEqual(metadata, ['metadata']); assert.deepEqual(statuses, [{ code: 0 }]);
    assert.equal(stream.destroyed, true); assert.equal(parent.cancelled, false);
    aborter.abort(); assert.equal(parent.cancelled, false); assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
    for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
});

test('SDK query EOF stays successful when owned source autoDestroy reports a cleanup error', async () => {
    for (const delayed of [false, true]) {
        const cleanup = deferred(), failure = new Error('SDK_CLOSE_FAILURE');
        let source, parent, destroys = 0, ends = 0, closes = 0, errors = 0;
        const stream = cancellableQueryStream(options => {
            parent = parentOptions(options).parent;
            source = new PassThrough({ objectMode: true, destroy(_error, callback) {
                destroys++;
                const finish = () => { callback(failure); cleanup.resolve(); };
                if (delayed) setImmediate(finish); else finish();
            } });
            source.end('row');
            return source;
        });
        stream.on('error', () => { errors++; }); stream.on('end', () => { ends++; }); stream.on('close', () => { closes++; });
        const rows = []; for await (const row of stream) rows.push(row);
        await cleanup.promise; await immediate();
        assert.deepEqual(rows, ['row']); assert.equal(ends, 1); assert.equal(closes, 1); assert.equal(errors, 0);
        assert.equal(destroys, 1); assert.equal(source.closed, true); assert.equal(parent.cancelled, false);
        for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
    }
});

test('SDK query invalid source cleanup preserves the validation error and handles destroy failure', async () => {
    for (const delayed of [false, true]) {
        const cleanup = deferred(); let source;
        const stream = cancellableQueryStream(() => {
            source = new Readable({ objectMode: true, read() {}, destroy(_error, callback) {
                const finish = () => { callback(new Error('SDK_INVALID_SOURCE_CLOSE')); cleanup.resolve(); };
                if (delayed) setImmediate(finish); else finish();
            } });
            return source;
        });
        await assert.rejects(async () => { for await (const _row of stream) {} }, /WGA_SDK_QUERY_SOURCE/);
        await cleanup.promise; await immediate(); assert.equal(source.closed, true);
        for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
    }
});

test('SDK query releases cleanup listeners after delayed destroy with emitClose false', async () => {
    for (const failed of [false, true]) {
        const cleanup = deferred(); let source, originalDestroy, destroys = 0;
        const stream = cancellableQueryStream(() => {
            source = new Transform({ objectMode: true, emitClose: false, destroy(_error, callback) {
                destroys++; setImmediate(() => { callback(failed ? new Error('SDK_NO_CLOSE_FAILURE') : null); cleanup.resolve(); });
            } });
            originalDestroy = source._destroy;
            return source;
        });
        stream.destroy(); await cleanup.promise; await immediate();
        assert.equal(destroys, 1); assert.equal(source.closed, true); assert.equal(source._destroy, originalDestroy);
        for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
    }
});

test('SDK query pre-abort skips factory and source startup throw reaches a single stream error', async () => {
    let starts = 0;
    const aborter = new AbortController(); aborter.abort('not copied');
    const stream = cancellableQueryStream(() => { starts++; }, { signal: aborter.signal });
    await assert.rejects(async () => { for await (const _value of stream) {} }, { code: 1 }); assert.equal(starts, 0);
    const failure = new Error('query startup');
    const thrown = cancellableQueryStream(() => { throw failure; });
    await assert.rejects(async () => { for await (const _value of thrown) {} }, error => error === failure);
    const invalid = cancellableQueryStream(() => Readable.from([1]));
    await assert.rejects(async () => { for await (const _value of invalid) {} }, /WGA_SDK_QUERY_SOURCE/);
    for (const errored of [false, true]) {
        const failedSource = cancellableQueryStream(() => new Transform({ objectMode: true }).destroy(errored ? failure : undefined));
        await assert.rejects(async () => { for await (const _value of failedSource) {} },
            error => errored ? error === failure : error.message === 'WGA_SDK_STREAM_CLOSED');
    }
});

test('SDK query destroy and iterator break synchronously end pagination and cancel pending RPCs', async () => {
    for (const action of ['destroy', 'break', 'abort']) {
        const c = client(), aborter = new AbortController(), entered = deferred(); let parent, source, endCalls = 0, aborts = 0, pages = 0;
        try {
            await withFetch(async (_url, init) => {
                pages++; entered.resolve(); return new Promise((_yes, no) => init.signal.addEventListener('abort', () => { aborts++; no(new Error('cancelled')); }, { once: true }));
            }, async () => {
                const stream = cancellableQueryStream(options => {
                    parent = parentOptions(options).parent;
                    source = new Transform({ objectMode: true, read() {
                        if (this.started) return;
                        this.started = true;
                        unary(c, undefined, parentOptions(options)).promise.catch(error => this.destroy(error));
                        this.push('first');
                    } });
                    const originalEnd = source.end;
                    source.end = function(...args) { assert.equal(parent.cancelled, true); endCalls++; return originalEnd.apply(this, args); };
                    return source;
                }, { signal: aborter.signal });
                if (action === 'break') { for await (const value of stream) { assert.equal(value, 'first'); await entered.promise; break; } }
                else {
                    const failure = action === 'abort' ? observe(once(stream, 'error').then(([error]) => { throw error; })) : undefined;
                    stream.resume(); await entered.promise;
                    if (action === 'abort') { aborter.abort(); assert.equal((await failure).error.code, 1); }
                    else stream.destroy();
                }
                assert.equal(parent.cancelled, true); assert.equal(source.readableEnded || source._readableState.ended, true);
                assert.equal(endCalls, 1); await immediate(); await immediate();
                assert.equal(aborts, 1); assert.equal(pages, 1); assert.equal(c.getChannel().activeCallCount(), 0);
                assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
                for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
            });
        } finally { c.close(); }
    }
});

test('SDK query destruction before demand creates no RPC, including synchronous signal abort inside factory', async () => {
    for (const inside of [false, true]) {
        const aborter = new AbortController(); let parent, source, reads = 0;
        const stream = cancellableQueryStream(options => {
            parent = parentOptions(options).parent;
            source = new Transform({ objectMode: true, read() { reads++; } });
            if (inside) aborter.abort();
            return source;
        }, { signal: aborter.signal });
        const result = inside ? observe(once(stream, 'error').then(([error]) => { throw error; })) : undefined;
        stream.destroy(); await immediate();
        if (result) assert.equal((await result).error.code, 1);
        assert.equal(parent.cancelled, true); assert.equal(reads, 0); assert.equal(source.destroyed, true);
        assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
    }
});

test('SDK query bounds its wrapper queue and pauses a source that honors Readable backpressure', async () => {
    const source = new PassThrough({ objectMode: true, highWaterMark: 1 }); let parent;
    const stream = cancellableQueryStream(options => { parent = parentOptions(options).parent; return source; });
    assert.equal(stream.readableHighWaterMark, 1);
    stream.read(0); source.write({ id: 1 }); source.write({ id: 2 }); await immediate();
    assert.equal(stream.readableLength, 1); assert.equal(source.isPaused(), true);
    const first = stream.read(); assert.deepEqual(first, { id: 1 }); await immediate();
    assert.equal(stream.readableLength, 1); assert.deepEqual(stream.read(), { id: 2 });
    source.end(); stream.resume(); await once(stream, 'end'); assert.equal(parent.cancelled, false);
});

test('SDK query source errors and premature close cancel the scope without duplicate errors or stuck writes', async () => {
    for (const scenario of ['error', 'close', 'pending-write']) {
        let source, parent, writeError, errors = 0;
        const failure = new Error('source failed');
        const stream = cancellableQueryStream(options => {
            parent = parentOptions(options).parent;
            source = new Transform({ objectMode: true, transform(_value, _encoding, callback) { this.pending = callback; } });
            return source;
        });
        const ended = observe(once(stream, 'error').then(([error]) => { errors++; throw error; }));
        stream.resume();
        if (scenario === 'pending-write') {
            source.write('pending', error => { writeError = error; });
            source._destroy = function(error, callback) { this.pending(error || new Error('write cancelled')); callback(error); };
            stream.destroy(failure);
        } else source.destroy(scenario === 'error' ? failure : undefined);
        const { error } = await ended;
        assert.equal(scenario === 'close' ? error.message : error, scenario === 'close' ? 'WGA_SDK_STREAM_CLOSED' : failure);
        await immediate(); assert.equal(errors, 1); assert.equal(parent.cancelled, true);
        if (scenario === 'pending-write') assert.ok(writeError instanceof Error);
        for (const name of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) assert.equal(source.listenerCount(name), 0, name);
    }
});

test('SDK helper validates malformed options and limits without starting SDK work', () => {
    let starts = 0;
    for (const helper of [cancellableCall, cancellableQueryStream]) {
        for (const options of [null, [], { gaxOptions: [] }, { gaxOptions: { otherArgs: null } }, { gaxOptions: { otherArgs: { options: [] } } }, { signal: {} }, { signal: null }]) {
            assert.throws(() => helper(() => { starts++; }, options), TypeError);
        }
        assert.throws(() => helper(null), /WGA_SDK_START/);
    }
    for (const highWaterMark of [0, -1, 1.5, 1025, Infinity, NaN, '1']) {
        assert.throws(() => cancellableQueryStream(() => { starts++; }, { highWaterMark }), /WGA_SDK_QUEUE_LIMIT/);
    }
    assert.equal(starts, 0);
});
