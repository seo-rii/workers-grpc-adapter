'use strict';
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { getEventListeners } = require('node:events');
const { Readable } = require('node:stream');
const { cancellableCall, cancellableQueryStream } = require('../dist/sdk.js');
const { assert, deferred, immediate } = require('./helpers.cjs');

async function probe(boundary, kind) {
    const aborter = new AbortController(), cleanupReady = deferred();
    const cleanupFailure = new Error('SDK cleanup hook failed');
    let parent, expectedReceiver, actualReceiver, hooks = 0, parentCancels = 0, settlements = 0;
    const cleanup = function () {
        hooks++;
        actualReceiver = this;
        if (kind === 'throw') throw cleanupFailure;
        return (async () => {
            // Keep cleanup pending until the public operation has settled, so
            // the test also rejects implementations that wait for the hook.
            await cleanupReady.promise;
            if (kind === 'reject') throw cleanupFailure;
        })();
    };
    const captureParent = options => {
        parent = options.otherArgs.options.parent;
        parent.on('cancelled', () => { parentCancels++; });
    };
    const observe = promise => promise.then(value => { settlements++; return { value }; }, error => { settlements++; return { error }; });
    if (boundary === 'call-cancel') {
        const pending = deferred();
        expectedReceiver = pending.promise;
        pending.promise.cancel = cleanup;
        const call = cancellableCall(options => { captureParent(options); return pending.promise; }, { signal: aborter.signal });
        const result = observe(call.promise);
        call.cancel(); aborter.abort(); call.cancel();
        assert.equal((await result).error.code, 1);
        assert.equal(parent.cancelled, true);
        assert.equal(parentCancels, 1);
        pending.reject(new Error('SDK rejected after cancellation'));
    } else {
        let source, destroys = 0, errors = 0, ends = 0, closes = 0;
        const eof = boundary === 'query-eof';
        const stream = cancellableQueryStream(options => {
            captureParent(options);
            source = new Readable({ objectMode: true,
                read() { if (eof) { this.push('row'); this.push(null); } },
                destroy(error, callback) { destroys++; callback(error); },
            });
            source.end = cleanup;
            expectedReceiver = source;
            return source;
        }, { signal: aborter.signal });
        stream.on('error', () => { errors++; });
        stream.on('end', () => { ends++; });
        stream.on('close', () => { closes++; });
        const result = observe((async () => {
            const rows = [];
            for await (const row of stream) rows.push(row);
            return rows;
        })());
        if (!eof) aborter.abort();
        const outcome = await result;
        if (eof) assert.deepEqual(outcome, { value: ['row'] });
        else assert.equal(outcome.error.code, 1);
        assert.equal(parent.cancelled, !eof);
        assert.equal(parentCancels, eof ? 0 : 1);
        assert.equal(source.destroyed, true);
        // Repeated termination cannot re-invoke end() or change an EOF result.
        stream.destroy(); aborter.abort();
        await immediate();
        assert.equal(destroys, 1);
        assert.equal(errors, eof ? 0 : 1);
        assert.equal(ends, eof ? 1 : 0);
        assert.equal(closes, 1);
        for (const event of ['data', 'end', 'info', 'metadata', 'status', 'error', 'close']) {
            assert.equal(source.listenerCount(event), 0, event);
        }
    }
    assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
    assert.equal(actualReceiver, expectedReceiver);
    assert.equal(hooks, 1);
    cleanupReady.resolve();
    await immediate(); await immediate();
    assert.equal(settlements, 1);
    assert.equal(hooks, 1);
}

if (process.argv[2] === '--probe') {
    probe(process.argv[3], process.argv[4]).then(() => { process.stdout.write('completed\n'); },
        error => { console.error(error); process.exitCode = 1; });
} else {
    for (const boundary of ['call-cancel', 'query-cancel', 'query-eof']) {
        for (const kind of ['throw', 'resolve', 'reject']) {
            test(`SDK cleanup ${boundary} contains ${kind} without waiting or resettling`, () => {
                // A child with fatal rejections detects leaked hook failures
                // independently of the test runner's rejection listeners.
                const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', __filename, '--probe', boundary, kind],
                    { encoding: 'utf8', timeout: 5000 });
                assert.ifError(child.error);
                assert.equal(child.status, 0, child.stderr || child.stdout);
                assert.equal(child.stdout, 'completed\n', 'Probe exited before cleanup assertions finished');
            });
        }
    }
}
