'use strict';
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { assert, grpc, Echo, response, withFetch, unary, deferred, immediate, transportCall } = require('./helpers.cjs');
const { validateConfig, GAX_CONFIG_OPTION } = require('../dist/config-internal.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

test('FETCHER rejects malformed bindings before network and snapshots a method with its receiver', async () => {
    for (const fetcher of [null, false, 1, 'fetch', [], {}, { fetch: null }, { fetch: true }, { fetch: Promise.resolve() }]) {
        assert.throws(() => validateConfig({ fetcher }), { code: 'WGA_INVALID_CONFIG' });
    }
    assert.throws(() => validateConfig({ fetcher: { get fetch() { throw new Error('fixture-secret'); } } }),
        error => error.code === 'WGA_INVALID_CONFIG' && !error.message.includes('fixture-secret'));
    let reads = 0, calls = 0;
    const binding = Object.create({ get fetch() {
        reads++;
        return function (url, init) {
            assert.strictEqual(this, binding);
            assert.equal(url, 'https://fixture.test/rpc');
            assert.equal(init.method, 'POST');
            calls++;
            return Promise.resolve(response());
        };
    } });
    const snapshot = validateConfig({ fetcher: binding });
    assert.equal(reads, 1);
    assert.ok(Object.isFrozen(snapshot.fetcher));
    assert.equal(Object.isFrozen(binding), false);
    assert.notStrictEqual(snapshot.fetcher, binding);
    Object.defineProperty(binding, 'fetch', { value() { assert.fail('Mutated binding method used'); } });
    await snapshot.fetcher.fetch('https://fixture.test/rpc', { method: 'POST' });
    assert.equal(reads, 1);
    assert.equal(calls, 1);
    assert.strictEqual(validateConfig({ fetcher: snapshot.fetcher }).fetcher, snapshot.fetcher);
});

test('FETCHER global configuration compares both binding and method identities', () => {
    const script = `
      const assert = require('node:assert/strict');
      const config = require('./dist/config.js');
      const grpc = require('./dist/index.js');
      const binding = { fetch() { return Promise.resolve(new Response()); } };
      const first = config.configureWorkersGrpc({ fetcher: binding });
      assert.strictEqual(config.configureWorkersGrpc({ fetcher: binding }), first);
      assert.strictEqual(config.configureWorkersGrpc({ fetcher: first.fetcher }), first);
      assert.throws(() => config.configureWorkersGrpc({ fetcher: { fetch: binding.fetch } }), { code: 'WGA_CONFIG_ALREADY_SET' });
      const channel = new grpc.Client('fixture.test', grpc.credentials.createSsl());
      assert.strictEqual(config.configureWorkersGrpc({ fetcher: binding }), first);
      binding.fetch = () => Promise.resolve(new Response());
      assert.throws(() => config.configureWorkersGrpc({ fetcher: binding }), { code: 'WGA_CONFIG_LOCKED' });
      assert.throws(() => config.configureWorkersGrpc({}), { code: 'WGA_CONFIG_LOCKED' });
      channel.close();
    `;
    execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
});

test('FETCHER per-instance and GAX token paths preserve independent bindings and global default', async () => {
    const seen = [];
    const binding = label => ({ label, async fetch(url, init) {
        assert.equal(this.label, label);
        assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'manual');
        assert.ok(init.signal instanceof AbortSignal);
        seen.push([label, new URL(url).origin, init.cf.grpcWeb]);
        return response([{ text: label }]);
    } });
    const left = binding('left'), right = binding('right');
    const input = { mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, fetcher: left };
    const first = createWorkersGrpcTransport(input);
    const second = createWorkersGrpcTransport({ fetcher: right });
    const gax = second.gaxOptions({});
    const clients = [new Echo('echo.test', grpc.credentials.createSsl()),
        new Echo('echo.test', grpc.credentials.createSsl(), first.grpcOptions()),
        new Echo('echo.test', grpc.credentials.createSsl(), second.grpcOptions()),
        // Shared constructor models GAX's cache; only the channel token selects binding.
        new Echo('echo.test', grpc.credentials.createSsl(), { [GAX_CONFIG_OPTION]: gax[GAX_CONFIG_OPTION] }),
        new Echo('echo.test', grpc.credentials.createSsl())];
    input.fetcher = right;
    input.endpoints['echo.test'] = 'https://changed.test';
    left.fetch = () => assert.fail('Mutated original binding method');
    try {
        await withFetch(async (url, init) => {
            seen.push(['global', new URL(url).origin, init.cf.grpcWeb]);
            return response([{ text: 'global' }]);
        }, async () => {
            const values = await Promise.all(clients.map(client => unary(client).promise));
            assert.deepEqual(values.map(value => value.text), ['global', 'left', 'right', 'right', 'global']);
        });
        assert.deepEqual(seen, [
            ['global', 'https://echo.test', 'convert'], ['left', 'https://gateway.test', 'passthrough'],
            ['right', 'https://echo.test', 'convert'], ['right', 'https://echo.test', 'convert'],
            ['global', 'https://echo.test', 'convert'],
        ]);
    } finally { clients.forEach(client => client.close()); }
});

test('FETCHER preserves logical credential audience and blocks insecure routing before invocation', async () => {
    let fetches = 0, audience;
    const fetcher = { async fetch(url, init) {
        fetches++;
        assert.equal(url, 'https://gateway.test/demo.Echo/Unary');
        assert.equal(init.headers.get('authorization'), 'Bearer fixture');
        return response();
    } };
    const authenticated = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(),
        grpc.credentials.createFromGoogleCredential({ getRequestHeaders(url) {
            audience = url;
            return { authorization: 'Bearer fixture' };
        } }));
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, fetcher });
    const client = new Echo('echo.test', authenticated, transport.grpcOptions());
    try { await unary(client).promise; } finally { client.close(); }
    assert.equal(audience, 'https://echo.test/demo.Echo');
    assert.equal(fetches, 1);
    for (const origin of ['http://remote.test', 'http://localhost:8000', 'https://user:password@gateway.test', 'https://gateway.test/path']) {
        assert.throws(() => createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': origin }, allowInsecureLocalhost: true, fetcher }), { code: 'WGA_INVALID_CONFIG' });
    }
    const local = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'http://127.0.0.1:8000' }, allowInsecureLocalhost: true, fetcher });
    assert.throws(() => new Echo('echo.test', authenticated, local.grpcOptions()), { code: 'WGA_UNSUPPORTED_TLS' });
    assert.throws(() => new Echo('missing.test', grpc.credentials.createSsl(), transport.grpcOptions()), { code: 'WGA_UNMAPPED_TARGET' });
    assert.equal(fetches, 1);
});

test('FETCHER rejection is sanitized and an explicit binding never falls back to global Fetch', async () => {
    for (const asynchronous of [false, true]) {
        let calls = 0;
        const transport = createWorkersGrpcTransport({ fetcher: { fetch() {
            calls++;
            if (asynchronous) return Promise.reject(new Error('fixture-private-binding-error'));
            throw new Error('fixture-private-binding-error');
        } } });
        const client = new Echo('echo.test', grpc.credentials.createSsl(), transport.grpcOptions());
        try {
            await withFetch(() => assert.fail('Unexpected global fallback'), async () => {
                await assert.rejects(unary(client).promise, error => error.code === grpc.status.UNAVAILABLE
                    && !error.message.includes('fixture-private-binding-error'));
            });
            assert.equal(calls, 1);
        } finally { client.close(); }
    }
});

test('FETCHER receives cancellation and a late response is drained without late events', async () => {
    for (const stopping of ['cancel', 'deadline']) {
        const started = deferred(), pending = deferred();
        let signal, bodyCancelled = 0, statuses = 0;
        const transport = createWorkersGrpcTransport({ fetcher: { fetch(_url, init) {
            signal = init.signal;
            started.resolve();
            return pending.promise;
        } } });
        const client = new Echo('echo.test', grpc.credentials.createSsl(), transport.grpcOptions());
        try {
            const call = unary(client, { text: 'request' }, { deadline: Date.now() + (stopping === 'deadline' ? 100 : 5000) });
            call.call.on('status', () => { statuses++; });
            const rejected = assert.rejects(call.promise, { code: stopping === 'cancel' ? grpc.status.CANCELLED : grpc.status.DEADLINE_EXCEEDED });
            await started.promise;
            if (stopping === 'cancel') call.call.cancel();
            await rejected;
            assert.equal(signal.aborted, true);
            pending.resolve(new Response(new ReadableStream({ cancel() { bodyCancelled++; } })));
            await immediate();
            assert.equal(bodyCancelled, 1);
            assert.equal(statuses, 1);
            assert.equal(client.getChannel().activeCallCount(), 0);
            assert.equal(transportCall(call.call).diagnostics().timerActive, false);
        } finally { client.close(); }
    }
});
