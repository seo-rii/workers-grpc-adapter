'use strict';
const { test } = require('node:test');
const { assert, grpc, deferred } = require('./helpers.cjs');
const { validateConfig, normalizeAuthority } = require('../dist/config-internal.js');
const { authErrorCode } = require('../dist/status.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
test('CONFIG defaults and frozen endpoint snapshot', () => {
    const c = validateConfig();
    assert.equal(c.defaultTimeoutMs, undefined);
    assert.equal(c.transportMaxReceiveBytes, 33554432);
    assert.ok(Object.isFrozen(c));
    assert.ok(Object.isFrozen(c.endpoints));
});
for (const target of ['https://example.com', 'example.com/path', 'a@b', 'dns:///host', 'a?b', 'a#b', 'host:0', 'host:99999', 'host\\x', '127.0.0.1%2f']) {
    test(`CONFIG reject target ${target}`, () => assert.throws(() => normalizeAuthority(target), { code: 'WGA_INVALID_TARGET' }));
}
test('CONFIG canonical authority and localhost gateway rule', () => {
    assert.equal(normalizeAuthority('EXAMPLE.com'), 'example.com:443');
    assert.equal(normalizeAuthority('[::1]:1234'), '[::1]:1234');
    assert.equal(validateConfig({ mode: 'grpc-web', allowInsecureLocalhost: true, endpoints: { 'a.test': 'http://127.0.0.1:8000' } }).endpoints['a.test:443'], 'http://127.0.0.1:8000');
    for (const url of ['http://localhost:8000', 'http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1']) {
        assert.throws(() => validateConfig({ mode: 'grpc-web', allowInsecureLocalhost: true, endpoints: { 'a.test': url } }));
    }
});
test('CONFIG invalid numeric values and mode combinations', () => {
    for (const value of [0, -1, NaN, Infinity, '100']) {
        assert.throws(() => validateConfig({ defaultTimeoutMs: value }));
    }
    assert.throws(() => validateConfig({ mode: 'cloudflare', endpoints: { 'a.test': 'https://b.test' } }));
    assert.throws(() => validateConfig({ mode: 'grpc-web', endpoints: {} }));
    assert.throws(() => validateConfig({ mode: 'grpc-web', endpoints: { 'a.test': 'https://b.test', 'a.test:443': 'https://b.test' } }));
});
test('CONFIG idempotent configure and lock; public surface has no reset', () => {
    const config = require('../dist/config.js');
    const first = config.configureWorkersGrpc({});
    assert.strictEqual(config.configureWorkersGrpc({}), first);
    assert.throws(() => config.configureWorkersGrpc({ defaultTimeoutMs: 100 }), { code: 'WGA_CONFIG_ALREADY_SET' });
    const client = new grpc.Client('example.test', grpc.credentials.createSsl());
    assert.throws(() => config.configureWorkersGrpc({ defaultTimeoutMs: 200 }), { code: 'WGA_CONFIG_LOCKED' });
    client.close();
    assert.deepEqual(Object.keys(config).sort(), ['WorkersGrpcConfigurationError', 'configureWorkersGrpc', 'getWorkersGrpcConfig'].sort());
});
test('META preserves repeated values and clone buffer isolation', () => {
    const a = new grpc.Metadata({ idempotentRequest: true });
    a.add('X-Test', 'one');
    a.add('x-test', 'two');
    a.set('raw-bin', Buffer.from([7]));
    const b = a.clone();
    a.get('raw-bin')[0][0] = 9;
    assert.equal(b.get('raw-bin')[0][0], 7);
    assert.deepEqual(b.get('x-test'), ['one', 'two']);
    assert.equal(b.getMap()['x-test'], 'one');
    assert.equal(b.getOptions().idempotentRequest, true);
});
test('META rejects type mismatch, CRLF and illegal names', () => {
    const m = new grpc.Metadata();
    for (const [k, v] of [['bad key', 'x'], ['x', 'a\r\nb'], ['x', '한글'], ['x-bin', 'not a buffer'], ['x', Buffer.from('x')]]) {
        assert.throws(() => m.set(k, v));
    }
});
test('AUTH composition is immutable and preserves input order under parallel completion', async () => {
    const first = deferred();
    const a = grpc.credentials.createFromMetadataGenerator((_o, cb) => first.promise.then(() => {
        const m = new grpc.Metadata();
        m.add('x', 'a');
        cb(null, m);
    }));
    const b = grpc.credentials.createFromMetadataGenerator((_o, cb) => {
        const m = new grpc.Metadata();
        m.add('x', 'b');
        cb(null, m);
    });
    const combined = grpc.credentials.combineCallCredentials(a, b);
    const pending = combined.generateMetadata({ service_url: 's', method_name: 'm' });
    first.resolve();
    assert.deepEqual((await pending).get('x'), ['a', 'b']);
    assert.deepEqual((await b.generateMetadata({ service_url: 's', method_name: 'm' })).get('x'), ['b']);
});
test('AUTH public empty credentials add no metadata and compose without adding authentication', async () => {
    const empty = grpc.credentials.createEmpty();
    const options = { service_url: 'https://logical.test/demo.Echo', method_name: '/demo.Echo/Unary' };
    const first = await empty.generateMetadata(options);
    assert.deepEqual(first.getMap(), {});
    first.set('x-mutated', 'local');
    assert.deepEqual((await empty.generateMetadata(options)).getMap(), {});
    let generations = 0;
    const authenticated = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
        generations++;
        const metadata = new grpc.Metadata();
        metadata.set('authorization', 'Bearer controlled-fixture');
        callback(null, metadata);
    });
    const combined = grpc.credentials.combineCallCredentials(empty, authenticated, empty);
    assert.deepEqual((await combined.generateMetadata(options)).getMap(), { authorization: 'Bearer controlled-fixture' });
    assert.equal(generations, 1);
    assert.deepEqual((await empty.generateMetadata(options)).getMap(), {});
    assert.doesNotThrow(() => grpc.credentials.combineChannelCredentials(grpc.credentials.createInsecure(), empty));
    assert.throws(() => grpc.credentials.combineChannelCredentials(grpc.credentials.createInsecure(), combined), { code: 'WGA_UNSUPPORTED_TLS' });
});
test('AUTH duplicate generator callback settles once', async () => {
    const creds = grpc.credentials.createFromMetadataGenerator((_o, cb) => {
        const a = new grpc.Metadata();
        a.set('x', 'first');
        cb(null, a);
        cb(new Error('late'));
    });
    assert.equal((await creds.generateMetadata({ service_url: 's', method_name: 'm' })).get('x')[0], 'first');
});
test('AUTH Google Headers and record result shapes', async () => {
    for (const headers of [new Headers({ authorization: 'Bearer fixture' }), { authorization: 'Bearer fixture' }]) {
        let url;
        const creds = grpc.credentials.createFromGoogleCredential({ async getRequestHeaders(u) {
                url = u;
                return headers;
            } });
        assert.equal((await creds.generateMetadata({ service_url: 'https://logical.test/demo.Echo', method_name: '/demo.Echo/Unary' })).get('authorization')[0], 'Bearer fixture');
        assert.equal(url, 'https://logical.test/demo.Echo');
    }
});
test('AUTH TLS configuration rejects unsupported input rather than ignoring it', () => {
    assert.throws(() => grpc.credentials.createSsl(Buffer.from('certificate')), { code: 'WGA_UNSUPPORTED_TLS' });
    assert.throws(() => grpc.credentials.createSsl(null, null, null, {}), { code: 'WGA_UNSUPPORTED_TLS' });
    assert.throws(() => grpc.credentials.combineChannelCredentials(grpc.credentials.createInsecure(), grpc.credentials.createFromMetadataGenerator(() => {
    })), { code: 'WGA_UNSUPPORTED_TLS' });
});
test('AUTH control-plane error codes are sanitized', () => {
    assert.equal(authErrorCode(new Error()), grpc.status.UNKNOWN);
    for (const code of [0, 3, 5, 6, 9, 10, 11, 15, 100, NaN]) {
        assert.equal(authErrorCode({ code }), grpc.status.INTERNAL);
    }
    assert.equal(authErrorCode({ code: 16 }), 16);
});
test('ADAPTER per-instance options and explicit conflict detection', () => {
    const a = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'a.test': 'https://gateway.test' } });
    assert.throws(() => a.gaxOptions({ fallback: true }), { code: 'WGA_OPTION_CONFLICT' });
    const opts = a.gaxOptions({ projectId: 'fixture' });
    assert.equal(opts.projectId, 'fixture');
    assert.equal(opts.fallback, false);
    assert.strictEqual(opts.grpc.Metadata, grpc.Metadata);
});
test('ADAPTER GAX uses shared constructors with per-channel identity tokens', async () => {
    const { GAX_CONFIG_OPTION } = require('../dist/config-internal.js');
    const { Echo, withFetch, unary, response } = require('./helpers.cjs');
    const first = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://first.test' } });
    const second = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://second.test' } });
    const authClient = { marker: 'preserve-reference' };
    const firstOptions = first.gaxOptions({ authClient, 'grpc.max_send_message_length': 200 });
    const secondOptions = second.gaxOptions({ authClient });
    assert.strictEqual(firstOptions.grpc, grpc);
    assert.strictEqual(secondOptions.grpc, grpc);
    assert.strictEqual(firstOptions.authClient, authClient);
    assert.ok(Object.isFrozen(firstOptions[GAX_CONFIG_OPTION]));
    assert.deepEqual(Object.keys(firstOptions[GAX_CONFIG_OPTION]), []);
    assert.notStrictEqual(firstOptions[GAX_CONFIG_OPTION], secondOptions[GAX_CONFIG_OPTION]);
    // Mirrors GAX's documented channel-option forwarding; constructors are
    // deliberately created before either per-client transport is applied.
    const channelOptions = options => Object.fromEntries(Object.entries(options).filter(([key]) => key.startsWith('grpc.')));
    const clients = [new Echo('echo.test', grpc.credentials.createSsl()),
        new Echo('echo.test', grpc.credentials.createSsl(), channelOptions(firstOptions)),
        new Echo('echo.test', grpc.credentials.createSsl(), channelOptions(secondOptions)),
        new Echo('echo.test', grpc.credentials.createSsl())];
    const seen = [];
    try {
        await withFetch(async (url, init) => {
            seen.push([new URL(url).origin, init.cf.grpcWeb, init.headers.get('content-type')]);
            return response();
        }, () => Promise.all(clients.map(client => unary(client).promise)));
        assert.deepEqual(seen, [
            ['https://echo.test', 'convert', 'application/grpc-web'],
            ['https://first.test', 'passthrough', 'application/grpc-web+proto'],
            ['https://second.test', 'passthrough', 'application/grpc-web+proto'],
            ['https://echo.test', 'convert', 'application/grpc-web'],
        ]);
    } finally { clients.forEach(client => client.close()); }
});
test('ADAPTER GAX rejects forged tokens and conflicting reserved options', () => {
    const { GAX_CONFIG_OPTION } = require('../dist/config-internal.js');
    const transport = createWorkersGrpcTransport();
    const valid = transport.gaxOptions({});
    for (const value of [undefined, null, {}, { ...valid[GAX_CONFIG_OPTION] }, validateConfig(), 'private-input']) {
        assert.throws(() => new grpc.Client('echo.test', grpc.credentials.createSsl(), { [GAX_CONFIG_OPTION]: value }),
            error => error.code === 'WGA_INVALID_CONFIG' && !error.message.includes('private-input'));
    }
    for (const key of [GAX_CONFIG_OPTION, `grpc.${GAX_CONFIG_OPTION}`]) {
        for (const value of [undefined, valid[GAX_CONFIG_OPTION]]) {
            assert.throws(() => transport.gaxOptions({ [key]: value }), { code: 'WGA_OPTION_CONFLICT' });
            assert.throws(() => transport.grpcOptions({ [key]: value }), { code: 'WGA_OPTION_CONFLICT' });
        }
    }
    for (const key of ['channelOverride', 'channelFactoryOverride', 'grpc.channelOverride',
        'grpc.channelFactoryOverride', 'grpc.grpc.channelOverride', 'grpc.grpc.channelFactoryOverride']) {
        assert.throws(() => transport.gaxOptions({ [key]: () => {} }), { code: 'WGA_OPTION_CONFLICT' });
    }
    assert.throws(() => transport.grpcOptions(transport.grpcOptions()), { code: 'WGA_OPTION_CONFLICT' });
    assert.throws(() => transport.gaxOptions(transport.grpcOptions()), { code: 'WGA_OPTION_CONFLICT' });
    assert.throws(() => new grpc.Client('echo.test', grpc.credentials.createSsl(), {
        ...transport.grpcOptions(), [GAX_CONFIG_OPTION]: valid[GAX_CONFIG_OPTION],
    }), { code: 'WGA_OPTION_CONFLICT' });
    assert.throws(() => new grpc.Client('echo.test', grpc.credentials.createSsl(), {
        [GAX_CONFIG_OPTION]: valid[GAX_CONFIG_OPTION], 'grpc.arbitrary-option': 'value',
    }), { code: 'WGA_UNSUPPORTED_OPTION' });
});
test('ADAPTER GAX token preserves the snapshot and enforces transport and channel ceilings', async () => {
    const { GAX_CONFIG_OPTION } = require('../dist/config-internal.js');
    const { Echo, withFetch, unary, response } = require('./helpers.cjs');
    const endpoints = { 'echo.test': 'https://original-gateway.test' };
    const input = { mode: 'grpc-web', endpoints, transportMaxSendBytes: 16 };
    const transport = createWorkersGrpcTransport(input);
    const token = transport.gaxOptions({})[GAX_CONFIG_OPTION];
    endpoints['echo.test'] = 'https://mutated-gateway.test';
    input.mode = 'cloudflare';
    input.transportMaxSendBytes = 1024;
    const ceiling = new Echo('echo.test', grpc.credentials.createSsl(), {
        [GAX_CONFIG_OPTION]: token, 'grpc.max_send_message_length': 1024,
    });
    const smaller = new Echo('echo.test', grpc.credentials.createSsl(), {
        [GAX_CONFIG_OPTION]: token, 'grpc.max_send_message_length': 3,
    });
    const seen = [];
    try {
        await withFetch(async (url, init) => {
            seen.push([new URL(url).origin, init.cf.grpcWeb]);
            return response();
        }, async () => {
            await assert.rejects(unary(ceiling, { text: 'x'.repeat(20) }).promise, { code: grpc.status.RESOURCE_EXHAUSTED });
            await assert.rejects(unary(smaller, { text: 'ok' }).promise, { code: grpc.status.RESOURCE_EXHAUSTED });
            assert.deepEqual(seen, [], 'Rejected payloads must never reach fetch');
            await unary(ceiling, { text: 'ok' }).promise;
            await unary(smaller, { text: '' }).promise;
        });
        assert.deepEqual(seen, [
            ['https://original-gateway.test', 'passthrough'],
            ['https://original-gateway.test', 'passthrough'],
        ]);
    } finally { ceiling.close(); smaller.close(); }
});
test('AUTH async generator rejection is handled, including rejection after callback', async () => {
    const before = grpc.credentials.createFromMetadataGenerator(async () => {
        throw new Error('failed');
    });
    await assert.rejects(before.generateMetadata({ service_url: 's', method_name: 'm' }));
    const after = grpc.credentials.createFromMetadataGenerator(async (_o, cb) => {
        cb(null, new grpc.Metadata());
        throw new Error('late failure');
    });
    await after.generateMetadata({ service_url: 's', method_name: 'm' });
    await new Promise(r => setImmediate(r));
});
test('CONFIG canonical endpoint order does not depend on input case', () => {
    const a = validateConfig({ mode: 'grpc-web', endpoints: { 'b.test': 'https://b.test', 'A.test': 'https://a.test' } });
    const b = validateConfig({ mode: 'grpc-web', endpoints: { 'B.test': 'https://b.test', 'a.test': 'https://a.test' } });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
});
