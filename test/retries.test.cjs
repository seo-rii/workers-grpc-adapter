'use strict';
const { test } = require('node:test');
const { assert, grpc, client, response, unary, immediate, deferred, transportCall, withFetch } = require('./helpers.cjs');
const { validateRetryPolicy, retryDelay } = require('../dist/retry.js');
const base = { methods: ['/demo.Echo/Unary'], maxAttempts: 3, initialBackoffMs: 1, maxBackoffMs: 100,
    retryableStatusCodes: [grpc.status.UNAVAILABLE] };
const config = (mode, policy = {}) => ({ ...(mode === 'grpc-web' ? { mode, endpoints: { 'echo.test': 'https://gateway.test' } } : { mode }), retryPolicy: { ...base, ...policy } });

test('RETRY explicit policy rejects unbounded or ambiguous replay and snapshots arrays', () => {
    for (const patch of [{ methods: [] }, { methods: ['*'] }, { methods: ['/invalid'] }, { maxAttempts: 1 },
        { maxAttempts: 11 }, { initialBackoffMs: 0 }, { maxBackoffMs: Infinity }, { maxBackoffMs: 300001 },
        { backoffMultiplier: 0.5 }, { retryableStatusCodes: [] }, { retryableStatusCodes: [0] },
        { retryableStatusCodes: [1] }, { retryableStatusCodes: [4] }, { retryOnFetchError: 1 }, { surprise: true }]) {
        assert.throws(() => validateRetryPolicy({ ...base, ...patch }), { code: 'WGA_INVALID_RETRY_POLICY' });
    }
    const input = { ...base, methods: [...base.methods], retryableStatusCodes: [...base.retryableStatusCodes] };
    const snapshot = validateRetryPolicy(input);
    input.methods[0] = '/changed/Method'; input.retryableStatusCodes[0] = 7;
    assert.equal(snapshot.methods[0], '/demo.Echo/Unary');
    assert.deepEqual(snapshot.retryableStatusCodes, [14]);
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.methods));
    assert.equal(retryDelay(snapshot, 3), undefined);
    for (const pushback of [['-1'], ['bad'], ['1', '2'], [Buffer.from('0')], ['101']]) assert.equal(retryDelay(snapshot, 1, pushback), undefined);
    assert.equal(retryDelay(snapshot, 1, ['0']), 0);
    assert.equal(retryDelay(snapshot, 1, ['50']), 50);
});

for (const mode of ['cloudflare', 'grpc-web']) {
    test(`RETRY ${mode} retries explicit unary status with fresh credentials and a single public completion`, async () => {
        let requests = 0, credentials = 0;
        const bodies = [], metadata = [], statuses = [];
        await withFetch(async (_url, init) => {
            requests++; bodies.push(Buffer.from(init.body));
            assert.equal(init.headers.get('authorization'), `Bearer synthetic-${requests}`);
            assert.equal(init.headers.get('grpc-previous-rpc-attempts'), requests === 1 ? null : String(requests - 1));
            assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
            return requests < 3 ? response([], { code: 14, extra: 'grpc-retry-pushback-ms: 0\r\n', headers: { 'x-attempt': String(requests) } })
                : response([{ text: 'recovered' }], { headers: { 'x-attempt': '3' } });
        }, async () => {
            const c = client({}, config(mode));
            const auth = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
                const m = new grpc.Metadata(); m.set('authorization', `Bearer synthetic-${++credentials}`); callback(null, m);
            });
            const { call, promise } = unary(c, { text: 'immutable' }, { credentials: auth });
            call.on('metadata', m => metadata.push(m.get('x-attempt')[0]));
            call.on('status', s => statuses.push(s.code));
            assert.deepEqual(await promise, { text: 'recovered' });
            assert.deepEqual(metadata, ['3']); assert.deepEqual(statuses, [0]);
            assert.equal(requests, 3); assert.equal(credentials, 3);
            assert.ok(bodies.every(body => body.equals(bodies[0])));
            assert.equal(transportCall(call).diagnostics().fetchCount, 3);
            assert.equal(c.getChannel().activeCallCount(), 0); c.close();
        });
    });
    test(`RETRY ${mode} exhaustion, nonretryable status and negative pushback stop exactly`, async () => {
        for (const [code, extra, expected] of [[14, '', 3], [7, '', 1], [14, 'grpc-retry-pushback-ms: -1\r\n', 1], [14, 'grpc-retry-pushback-ms: garbage\r\n', 1]]) {
            let requests = 0;
            await withFetch(async () => { requests++; return response([], { code, extra }); }, async () => {
                const c = client({}, config(mode));
                await assert.rejects(unary(c).promise, { code });
                assert.equal(requests, expected); assert.equal(c.getChannel().activeCallCount(), 0); c.close();
            });
        }
    });
    test(`RETRY ${mode} default, unlisted method, streaming and delivered message are never replayed`, async () => {
        for (const variant of ['default', 'unlisted', 'stream', 'message']) {
            let requests = 0;
            await withFetch(async () => { requests++; return response(variant === 'message' ? [{ text: 'partial' }] : [], { code: 14 }); }, async () => {
                const selected = config(mode, variant === 'unlisted' ? { methods: ['/other.Service/Get'] } : variant === 'stream' ? { methods: ['/demo.Echo/Stream'] } : {});
                if (variant === 'default') delete selected.retryPolicy;
                const c = client({}, selected);
                if (variant === 'stream') await new Promise(resolve => {
                    const stream = c.stream({ text: '' }); stream.on('data', () => {}); stream.on('error', e => { assert.equal(e.code, 14); resolve(); });
                });
                else await assert.rejects(unary(c).promise, { code: 14 });
                assert.equal(requests, 1); c.close();
            });
        }
    });
    test(`RETRY ${mode} Fetch failures require separate opt-in and protocol errors never replay`, async () => {
        for (const variant of ['network-default', 'network-opt-in', 'malformed']) {
            let requests = 0;
            await withFetch(async () => {
                requests++;
                if (variant === 'malformed') return new Response(new Uint8Array([0, 0]), { headers: { 'content-type': 'application/grpc-web' } });
                throw new Error('Synthetic network failure');
            }, async () => {
                const c = client({}, config(mode, { retryOnFetchError: variant === 'network-opt-in', retryableStatusCodes: [13, 14] }));
                await assert.rejects(unary(c).promise, { code: variant === 'malformed' ? 13 : 14 });
                assert.equal(requests, variant === 'network-opt-in' ? 3 : 1); c.close();
            });
        }
    });
    test(`RETRY ${mode} cancellation, channel close and deadline interrupt backoff without late auth or Fetch`, async () => {
        for (const variant of ['cancel', 'close', 'deadline']) {
            let requests = 0, credentials = 0;
            const arrived = deferred();
            await withFetch(async () => { requests++; arrived.resolve(); return response([], { code: 14 }); }, async () => {
                const c = client({}, config(mode, { initialBackoffMs: 100, maxBackoffMs: 100 }));
                const auth = grpc.credentials.createFromMetadataGenerator((_options, callback) => { credentials++; callback(null, new grpc.Metadata()); });
                const { call, promise } = unary(c, { text: '' }, { credentials: auth, ...(variant === 'deadline' ? { deadline: Date.now() + 40 } : {}) });
                const rejected = assert.rejects(promise, { code: variant === 'cancel' ? 1 : variant === 'close' ? 14 : 4 });
                await arrived.promise; await immediate();
                if (variant === 'cancel') call.cancel();
                if (variant === 'close') c.close();
                await rejected; await new Promise(resolve => setTimeout(resolve, 120));
                assert.equal(requests, 1); assert.equal(credentials, 1);
                assert.equal(transportCall(call).diagnostics().timerActive, false);
                assert.equal(c.getChannel().activeCallCount(), 0); c.close();
            });
        }
    });
    test(`RETRY ${mode} failed refreshed authentication never starts another Fetch`, async () => {
        let requests = 0, generations = 0;
        await withFetch(async () => { requests++; return response([], { code: 14, extra: 'grpc-retry-pushback-ms: 0\r\n' }); }, async () => {
            const c = client({}, config(mode));
            const auth = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
                generations++;
                callback(generations === 1 ? null : Object.assign(new Error('Synthetic rejection'), { code: 16 }), new grpc.Metadata());
            });
            await assert.rejects(unary(c, { text: '' }, { credentials: auth }).promise, { code: 16 });
            assert.equal(requests, 1); assert.equal(generations, 2); c.close();
        });
    });
}
