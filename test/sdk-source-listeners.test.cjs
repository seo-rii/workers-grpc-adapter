'use strict';
const test = require('node:test');
const { Transform } = require('node:stream');
const { getEventListeners } = require('node:events');
const { cancellableQueryStream } = require('../dist/sdk.js');
const { assert, immediate } = require('./helpers.cjs');

for (const emitClose of [false, true]) for (const failed of [false, true]) {
    test(`SDK already-destroying source releases wrapper closures (emitClose=${emitClose}, failed=${failed})`, async () => {
        let finishCleanup;
        const source = new Transform({ objectMode: true, emitClose,
            destroy(_error, callback) { finishCleanup = callback; } });
        source.destroy();
        const guards = {};
        const wrappers = [];
        try {
            for (let index = 0; index < 3; index++) {
                const aborter = new AbortController();
                let parent;
                const errors = [];
                const stream = cancellableQueryStream(options => {
                    parent = options.otherArgs.options.parent;
                    return source;
                }, { signal: aborter.signal });
                wrappers.push(stream);
                stream.on('error', error => errors.push(error));
                await immediate();
                assert.equal(stream.destroyed, true); assert.equal(parent.cancelled, true);
                assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
                assert.equal(errors.length, 1); assert.equal(errors[0].message, 'WGA_SDK_STREAM_CLOSED');
                for (const event of ['error', 'close']) {
                    const listeners = source.listeners(event);
                    assert.equal(listeners.length, 1, `${event} guard must not accumulate for each wrapper`);
                    if (index === 0) guards[event] = listeners[0];
                    else assert.equal(listeners[0], guards[event], 'Only a shared guard may outlive a wrapper');
                }
                for (const event of ['data', 'end', 'info', 'metadata', 'status']) assert.equal(source.listenerCount(event), 0, event);
            }
            // The outstanding callback has no observable silent-success event
            // with emitClose:false. Its guards must not capture any wrapper.
            finishCleanup(failed ? new Error('late source failure') : null);
            await immediate();
            assert.equal(source.closed, true);
            for (const event of ['error', 'close']) {
                assert.equal(source.listenerCount(event), !emitClose && !failed ? 1 : 0, event);
            }
        } finally {
            for (const stream of wrappers) stream.destroy();
            if (!source.closed) finishCleanup(null);
            await immediate();
        }
    });
}

test('SDK already-destroying sources share guards without taking over application listeners', async () => {
    const sources = [], finishes = [], observed = [];
    const appError = error => observed.push(error);
    let sharedError, sharedClose;
    for (let index = 0; index < 2; index++) {
        const source = new Transform({ objectMode: true, emitClose: false,
            destroy(_error, callback) { finishes.push(callback); } });
        source.on('error', appError); source.destroy(); sources.push(source);
        const stream = cancellableQueryStream(() => source);
        stream.on('error', () => {}); await immediate();
        assert.equal(source.listenerCount('error'), 2);
        const guard = source.listeners('error').find(listener => listener !== appError);
        const closeGuard = source.listeners('close')[0];
        if (index === 0) { sharedError = guard; sharedClose = closeGuard; }
        else { assert.equal(guard, sharedError); assert.equal(closeGuard, sharedClose); }
    }
    const failure = new Error('late shared source error');
    for (const finish of finishes) finish(failure);
    await immediate();
    assert.deepEqual(observed, [failure, failure]);
    for (const source of sources) {
        assert.deepEqual(source.listeners('error'), [appError]);
        assert.equal(source.listenerCount('close'), 0);
    }
});

test('SDK already-destroying source preserves its initial error and handles a different late cleanup error', async () => {
    const initial = new Error('source already failed');
    let finishCleanup;
    const source = new Transform({ objectMode: true, emitClose: false,
        destroy(_error, callback) { finishCleanup = callback; } });
    source.destroy(initial);
    const errors = [];
    const stream = cancellableQueryStream(() => source);
    stream.on('error', error => errors.push(error));
    await immediate();
    assert.deepEqual(errors, [initial]);
    finishCleanup(new Error('later cleanup failed')); await immediate();
    assert.deepEqual(errors, [initial]);
    assert.equal(source.listenerCount('error'), 0); assert.equal(source.listenerCount('close'), 0);
});
