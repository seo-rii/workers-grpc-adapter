'use strict';
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { assert, grpc, client, response, deferred, immediate } = require('./helpers.cjs');

async function probe(kind, action, cleanup) {
    const ready = deferred(), failure = new Error('INTERCEPTOR_CANCEL_FAILURE');
    let fetches = 0, callbacks = 0, hooks = 0;
    const errors = [], statuses = [];
    const cancel = function (next) {
        hooks++;
        assert.equal(this.cancel, cancel, 'Preserve the requester receiver');
        if (cleanup === 'throw') throw failure;
        if (cleanup === 'reject') return Promise.reject(failure);
        return (async () => {
            // The local result must not wait for cleanup or its continuation.
            await ready.promise;
            next(); next();
            if (cleanup === 'late-reject') throw failure;
        })();
    };
    const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        start() {}, cancel,
    })] }, { mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true,
        defaultTimeoutMs: action === 'deadline' ? 15 : 1000,
        fetcher: { async fetch() { fetches++; return response(); } } });
    try {
        const callback = error => { callbacks++; errors.push(error?.code ?? 0); };
        const call = kind === 'unary' ? c.unary({ text: 'held' }, callback)
            : kind === 'clientStream' ? c.clientStream(callback)
            : kind === 'bidi' ? c.bidi() : c.stream({ text: 'held' });
        call.on('error', error => errors.push(error.code));
        const terminal = new Promise(resolve => call.on('status', result => { statuses.push(result.code); resolve(); }));
        if (action === 'cancel') call.cancel();
        else if (action === 'close') c.close();
        await terminal;
        const expected = action === 'close' ? grpc.status.UNAVAILABLE
            : action === 'deadline' ? grpc.status.DEADLINE_EXCEEDED : grpc.status.CANCELLED;
        assert.deepEqual(statuses, [expected]);
        assert.deepEqual(errors, [expected]);
        assert.equal(callbacks, kind === 'unary' || kind === 'clientStream' ? 1 : 0);
        assert.equal(hooks, 1);
        assert.equal(fetches, 0);
        assert.equal(c.getChannel().activeCallCount(), 0);
        call.cancel(); c.close(); call.cancel();
        ready.resolve();
        await immediate(); await immediate();
        assert.deepEqual(statuses, [expected]);
        assert.deepEqual(errors, [expected]);
        assert.equal(hooks, 1);
        assert.equal(fetches, 0);
        assert.equal(c.getChannel().activeCallCount(), 0);
    } finally { c.close(); }
}

if (process.argv[2] === '--probe') {
    probe(...process.argv.slice(3)).then(() => process.stdout.write('completed\n'),
        error => { console.error(error); process.exitCode = 1; });
} else {
    for (const kind of ['unary', 'stream', 'clientStream', 'bidi']) {
        for (const action of ['cancel', 'close', 'deadline']) {
            for (const cleanup of ['throw', 'reject', 'late-reject', 'late-resolve']) {
                test(`INTERCEPTOR cancellation ${kind}/${action} contains ${cleanup} without waiting or resettling`, () => {
                    // Fatal rejection policy detects leaks independently of the test runner.
                    const child = spawnSync(process.execPath,
                        ['--unhandled-rejections=strict', __filename, '--probe', kind, action, cleanup],
                        { encoding: 'utf8', timeout: 5000 });
                    assert.ifError(child.error);
                    assert.equal(child.status, 0, child.stderr || child.stdout);
                    assert.equal(child.stdout, 'completed\n', 'Probe exited before the cleanup assertions finished');
                });
            }
        }
    }
}
