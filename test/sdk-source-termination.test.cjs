'use strict';
const test = require('node:test');
const { Transform } = require('node:stream');
const { getEventListeners } = require('node:events');
const { cancellableQueryStream } = require('../dist/sdk.js');
const { assert, client, unary, deferred, immediate } = require('./helpers.cjs');

for (const emitClose of [false, true]) {
    test(`SDK source destruction ends local waiting before cleanup settles (emitClose=${emitClose})`, async () => {
        for (const failed of [false, true]) {
            const aborter = new AbortController();
            let source, parent, finishCleanup, originalDestroy, cancellations = 0, closes = 0;
            const errors = [];
            const stream = cancellableQueryStream(options => {
                parent = options.otherArgs.options.parent;
                parent.on('cancelled', () => { cancellations++; });
                source = new Transform({ objectMode: true, emitClose, read() {},
                    destroy(_error, callback) { finishCleanup = callback; } });
                originalDestroy = source._destroy;
                return source;
            }, { signal: aborter.signal });
            stream.on('error', error => errors.push(error));
            stream.on('close', () => { closes++; });
            stream.resume();
            try {
                source.destroy();
                await immediate();
                assert.equal(stream.destroyed, true, 'A pending source cleanup cannot keep the wrapper open');
                assert.equal(source.closed, false, 'The real source work has not settled');
                assert.equal(parent.cancelled, true); assert.equal(cancellations, 1); assert.equal(closes, 1);
                assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
                assert.equal(errors.length, 1); assert.equal(errors[0].message, 'WGA_SDK_STREAM_CLOSED');
                finishCleanup(failed ? new Error('late cleanup failure') : null);
                await immediate();
                assert.equal(source.closed, true); assert.equal(source._destroy, originalDestroy);
                assert.equal(errors.length, 1); assert.equal(cancellations, 1); assert.equal(closes, 1);
                for (const name of ['error', 'close', 'end', 'data', 'info', 'metadata', 'status']) assert.equal(source.listenerCount(name), 0, name);
            } finally {
                stream.destroy();
                if (!source.closed) finishCleanup(null);
                await immediate();
            }
        }
    });

    test(`SDK source destruction preserves its initial error with pending cleanup (emitClose=${emitClose})`, async () => {
        const failure = new Error('source failed');
        let source, finishCleanup;
        const errors = [];
        const stream = cancellableQueryStream(() => {
            source = new Transform({ objectMode: true, emitClose, read() {},
                destroy(_error, callback) { finishCleanup = callback; } });
            return source;
        });
        stream.on('error', error => errors.push(error));
        source.destroy(failure);
        try {
            await immediate();
            assert.equal(stream.destroyed, true); assert.deepEqual(errors, [failure]);
            finishCleanup(new Error('different cleanup failure')); await immediate();
            assert.deepEqual(errors, [failure]);
            assert.equal(source.listenerCount('error'), 0); assert.equal(source.listenerCount('close'), 0);
        } finally { stream.destroy(); if (!source.closed) finishCleanup(null); await immediate(); }
    });
}

test('SDK source cleanup can await its scoped adapter RPC without a circular cancellation wait', async () => {
    const entered = deferred();
    let source, childResult, aborts = 0;
    const c = client({}, { fetcher: { fetch(_url, init) {
        entered.resolve();
        return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => { aborts++; reject(new Error('cancelled')); }, { once: true });
        });
    } } });
    const stream = cancellableQueryStream(options => {
        childResult = unary(c, { text: 'SDK page' }, options.otherArgs.options).promise.catch(error => error);
        source = new Transform({ objectMode: true, emitClose: false, read() {},
            destroy(_error, callback) { void childResult.then(() => callback(null)); } });
        return source;
    });
    const errors = [];
    stream.on('error', error => errors.push(error)); stream.resume();
    try {
        await entered.promise;
        source.destroy(); await immediate(); await immediate();
        assert.equal(stream.destroyed, true);
        assert.equal(c.getChannel().activeCallCount(), 0);
        assert.equal(aborts, 1); assert.equal(source.closed, true);
        assert.equal(errors.length, 1); assert.equal(errors[0].message, 'WGA_SDK_STREAM_CLOSED');
        assert.equal((await childResult).code, 1);
    } finally { stream.destroy(); c.close(); await immediate(); }
});
