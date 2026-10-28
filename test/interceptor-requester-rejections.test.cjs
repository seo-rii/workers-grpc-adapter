'use strict';
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { assert, grpc, client, response, deferred, immediate } = require('./helpers.cjs');

const diagnostics = { start: 'WGA_INTERCEPTOR_START', sendMessage: 'WGA_INTERCEPTOR_SEND', halfClose: 'WGA_INTERCEPTOR_HALF_CLOSE' };
async function probe(mode, phase, scenario, kind = 'unary') {
    const returned = deferred(), fetched = deferred(), peer = deferred();
    const failure = new Error('REQUESTER_FAILURE');
    const statuses = [], errors = [], writes = [];
    let callbacks = 0, hooks = 0, fetches = 0, resume, signal;
    // Failure belongs to the logical call even if cancellation is withheld.
    const requester = { cancel() {}, [phase](...args) {
        hooks++;
        assert.equal(this[phase], requester[phase], 'Preserve the requester receiver');
        resume = () => args.at(-1)(...args.slice(0, -1));
        if (scenario === 'throw') throw failure;
        if (scenario === 'reject') return Promise.reject(failure);
        if (scenario === 'thenable') return { then(_resolve, reject) { reject(failure); } };
        if (scenario === 'then-getter') return { get then() { throw failure; } };
        if (scenario === 'fulfilled-without-next') return Promise.resolve();
        if (scenario === 'resolve') return Promise.resolve().then(resume);
        if (['next-reject', 'terminal-reject'].includes(scenario)) resume();
        return returned.promise;
    } };
    const c = client({ interceptors: [(options, next) => new grpc.InterceptingCall(next(options), requester)] }, {
        mode, ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
        defaultTimeoutMs: 2000,
        fetcher: { async fetch(_url, init) {
            fetches++; signal = init.signal; fetched.resolve();
            if (scenario === 'next-reject') return peer.promise;
            return response();
        } },
    });
    try {
        const callback = error => { callbacks++; errors.push(error?.code ?? grpc.status.OK); };
        const call = kind === 'unary' ? c.unary({ text: 'request' }, callback) : c.clientStream(callback);
        call.on('error', error => errors.push(error.code));
        const terminal = new Promise(resolve => call.on('status', value => { statuses.push(value); resolve(value); }));
        if (kind !== 'unary') {
            call.write({ text: 'request' }, error => writes.push(error));
            call.end();
        }
        if (scenario === 'next-reject') { await fetched.promise; returned.reject(failure); }
        if (scenario === 'cancel-reject') { call.cancel(); await terminal; returned.reject(failure); }
        if (scenario === 'deadline-reject') {
            const now = Date.now;
            try {
                Date.now = () => now() + 10000;
                returned.reject(failure);
                await terminal;
            } finally { Date.now = now; }
        }
        if (scenario === 'fulfilled-without-next') {
            await immediate(); await immediate();
            assert.equal(fetches, 0, 'Fulfillment cannot implicitly invoke next');
            assert.deepEqual(statuses, []);
            resume();
        }
        const result = await terminal;
        if (scenario === 'terminal-reject') returned.reject(failure);
        const expected = scenario === 'cancel-reject' ? grpc.status.CANCELLED
            : scenario === 'deadline-reject' ? grpc.status.DEADLINE_EXCEEDED
            : ['terminal-reject', 'resolve', 'fulfilled-without-next'].includes(scenario) ? grpc.status.OK : grpc.status.INTERNAL;
        assert.equal(result.code, expected);
        if (expected === grpc.status.INTERNAL) assert.equal(result.details, diagnostics[phase]);
        assert.equal(callbacks, 1);
        assert.deepEqual(errors, [expected]);
        assert.equal(hooks, 1);
        assert.equal(c.getChannel().activeCallCount(), 0);
        if (scenario === 'next-reject') { assert.equal(signal.aborted, true); peer.resolve(response()); }
        if (expected !== grpc.status.OK) { resume?.(); resume?.(); }
        await immediate(); await immediate();
        assert.equal(statuses.length, 1);
        assert.equal(callbacks, 1);
        assert.deepEqual(errors, [expected]);
        assert.equal(fetches, ['next-reject', 'terminal-reject', 'resolve', 'fulfilled-without-next'].includes(scenario) ? 1 : 0);
        if (kind !== 'unary') { assert.equal(writes.length, 1); assert.ok(writes[0] instanceof Error); }
        assert.equal(c.getChannel().activeCallCount(), 0);
    } finally { c.close(); }
}

if (process.argv[2] === '--probe') {
    probe(...process.argv.slice(3)).then(() => process.stdout.write('completed\n'),
        error => { console.error(error); process.exitCode = 1; });
} else {
    function run(mode, phase, scenario, kind = 'unary') {
        const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', __filename, '--probe', mode, phase, scenario, kind],
            { encoding: 'utf8', timeout: 5000 });
        assert.ifError(child.error);
        assert.equal(child.status, 0, child.stderr || child.stdout);
        assert.equal(child.stdout, 'completed\n', 'Probe must finish every assertion');
    }
    for (const mode of ['cloudflare', 'grpc-web']) for (const phase of Object.keys(diagnostics)) {
        for (const scenario of ['throw', 'reject', 'thenable', 'then-getter', 'next-reject', 'terminal-reject', 'cancel-reject', 'deadline-reject', 'fulfilled-without-next', 'resolve']) {
            test(`INTERCEPTOR requester ${mode}/${phase} contains ${scenario} and preserves logical completion`, () => run(mode, phase, scenario));
        }
    }
    for (const phase of Object.keys(diagnostics)) {
        test(`INTERCEPTOR standalone requester ${phase} rejection cancels the next call`, async () => {
            const cancellations = [];
            const call = new grpc.InterceptingCall({
                cancelWithStatus(code, details) { cancellations.push({ code, details }); },
                disposePending() {}, start() {}, sendMessageWithContext() {}, halfClose() {},
            }, { [phase]() { return Promise.reject(new Error('REQUESTER_FAILURE')); } });
            if (phase === 'start') call.start(new grpc.Metadata());
            else if (phase === 'sendMessage') call.sendMessage({ text: 'request' });
            else call.halfClose();
            await immediate();
            assert.deepEqual(cancellations, [{ code: grpc.status.INTERNAL, details: diagnostics[phase] }]);
        });
    }
    for (const phase of ['start', 'sendMessage']) {
        test(`INTERCEPTOR requester ${phase} rejection settles a pending stream write once`, () => run('grpc-web', phase, 'reject', 'clientStream'));
    }
}
