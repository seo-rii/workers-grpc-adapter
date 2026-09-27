'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { grpc, Echo, response, unary, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

// Each catalog configuration case starts with a genuinely fresh singleton. A
// test-only reset or deleting one module from require.cache would not establish
// the first-channel contract across the public entry points.
function isolated(fn, args = []) {
  const script = `'use strict';
    const assert = require('node:assert/strict');
    const root = ${JSON.stringify(root)};
    const grpc = require(root + '/dist/index.js');
    const config = require(root + '/dist/config.js');
    const helpers = require(root + '/test/helpers.cjs');
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; throw new Error('Unexpected network'); };
    Promise.resolve().then(() => (${fn.toString()})(...${JSON.stringify(args)})).catch(error => { console.error(error); process.exitCode = 1; });`;
  assert.equal(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 }), '');
}

test('CFG-001 first unconfigured Channel uses cloudflare defaults and no implicit deadline', () => isolated(async () => {
  const client = new helpers.Echo('echo.test', grpc.credentials.createSsl());
  try {
    const snapshot = config.getWorkersGrpcConfig();
    assert.equal(snapshot.mode, 'cloudflare');
    assert.equal(snapshot.defaultTimeoutMs, undefined);
    assert.equal(snapshot.transportMaxSendBytes, 32 * 1024 * 1024);
    assert.equal(snapshot.transportMaxReceiveBytes, 32 * 1024 * 1024);
    assert.deepEqual(client.getChannel().limits, {
      maxSend: 32 * 1024 * 1024, maxReceive: 4 * 1024 * 1024,
      userAgent: 'workers-grpc-adapter/0.0.0-prototype.1', compression: 'identity',
    });
    assert.equal(fetches, 0, 'Channel construction must not fetch');
    globalThis.fetch = async (url, init) => {
      fetches++;
      assert.equal(String(url), 'https://echo.test/demo.Echo/Unary');
      assert.equal(init.cf.grpcWeb, 'convert');
      assert.equal(init.headers.get('content-type'), 'application/grpc-web');
      assert.equal(init.headers.get('grpc-timeout'), null);
      return helpers.response();
    };
    assert.deepEqual(await helpers.unary(client).promise, { text: 'ok' });
    assert.equal(fetches, 1);
    assert.strictEqual(config.getWorkersGrpcConfig(), snapshot);
  } finally { client.close(); }
}));

test('CFG-002 reordered nonempty canonical mappings configure idempotently before and after lock', () => isolated(() => {
  const firstInput = { mode: 'grpc-web', endpoints: { 'B.test:443': 'https://b-gateway.test/', 'a.test': 'https://a-gateway.test' } };
  const reordered = { endpoints: { 'A.test:443': 'https://a-gateway.test/', 'b.test': 'https://b-gateway.test' }, mode: 'grpc-web' };
  const first = config.configureWorkersGrpc(firstInput);
  assert.deepEqual(Object.keys(first.endpoints), ['a.test:443', 'b.test:443']);
  assert.strictEqual(config.configureWorkersGrpc(reordered), first);
  const channel = new grpc.Channel('A.test', grpc.credentials.createSsl());
  try {
    assert.strictEqual(config.configureWorkersGrpc(reordered), first);
    assert.strictEqual(config.getWorkersGrpcConfig(), first);
    assert.equal(fetches, 0);
  } finally { channel.close(); }
}));

function rejectedConfiguration(locked, code) {
  isolated((locked, code) => {
    const original = { mode: 'grpc-web', endpoints: { 'echo.test': 'https://original.test' }, defaultTimeoutMs: 1234 };
    const first = config.configureWorkersGrpc(original);
    const serialized = JSON.stringify(first);
    let channel;
    try {
      if (locked) channel = new grpc.Channel('echo.test', grpc.credentials.createSsl());
      assert.throws(() => config.configureWorkersGrpc({ ...original, defaultTimeoutMs: 2345 }), { code });
      assert.strictEqual(config.getWorkersGrpcConfig(), first);
      assert.equal(JSON.stringify(config.getWorkersGrpcConfig()), serialized);
      assert.strictEqual(config.configureWorkersGrpc(original), first, 'The original configuration remains usable');
      channel ??= new grpc.Channel('echo.test', grpc.credentials.createSsl());
      assert.equal(channel.getTarget(), 'echo.test');
      assert.equal(fetches, 0);
    } finally { channel?.close(); }
  }, [locked, code]);
}

test('CFG-003 rejected pre-lock changes preserve the original configuration and recovery', () =>
  rejectedConfiguration(false, 'WGA_CONFIG_ALREADY_SET'));
test('CFG-004 rejected post-lock changes preserve the original configuration and recovery', () =>
  rejectedConfiguration(true, 'WGA_CONFIG_LOCKED'));

test('CFG-005 original nested inputs and frozen returned snapshots cannot mutate stored configuration', () => isolated(() => {
  const input = {
    mode: 'grpc-web', endpoints: { 'echo.test': 'https://original.test' }, defaultTimeoutMs: 1234,
    retryPolicy: { methods: ['/demo.Echo/Unary'], maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 2, retryableStatusCodes: [14] },
    retryThrottling: { maxTokens: 10, tokenRatio: 0.1 },
    resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 2, maxBufferedBytes: 1024, readableHighWaterMark: 1 },
  };
  const snapshot = config.configureWorkersGrpc(input);
  const expected = JSON.stringify(snapshot);
  input.endpoints['echo.test'] = 'https://mutated.test';
  input.defaultTimeoutMs = 999;
  input.retryPolicy.methods.push('/demo.Echo/Other');
  input.retryPolicy.retryableStatusCodes[0] = 13;
  input.retryPolicy.maxAttempts = 5;
  input.retryThrottling.maxTokens = 100;
  input.resourceLimits.maxConcurrentCalls = 100;
  for (const object of [snapshot, snapshot.endpoints, snapshot.retryPolicy, snapshot.retryPolicy.methods,
    snapshot.retryPolicy.retryableStatusCodes, snapshot.retryThrottling, snapshot.resourceLimits]) assert.ok(Object.isFrozen(object));
  for (const mutate of [
    () => { snapshot.mode = 'cloudflare'; },
    () => { snapshot.endpoints['echo.test:443'] = 'https://returned-mutation.test'; },
    () => { snapshot.retryPolicy.methods.push('/demo.Echo/Returned'); },
    () => { snapshot.retryPolicy.retryableStatusCodes[0] = 13; },
    () => { snapshot.retryPolicy.maxAttempts = 9; },
    () => { snapshot.retryThrottling.maxTokens = 20; },
    () => { snapshot.resourceLimits.maxConcurrentCalls = 20; },
  ]) assert.throws(mutate, TypeError);
  assert.strictEqual(config.getWorkersGrpcConfig(), snapshot);
  assert.equal(JSON.stringify(config.getWorkersGrpcConfig()), expected);
  assert.equal(fetches, 0);
}));

test('CFG-006 invalid timeout and cap numbers fail exactly without changing fresh configured or locked state', () => isolated(() => {
  const keys = ['defaultTimeoutMs', 'transportMaxSendBytes', 'transportMaxReceiveBytes'];
  const invalid = [0, -1, NaN, Infinity, -Infinity, 0.5, 1.5, Number.MAX_SAFE_INTEGER + 1, '100', null];
  for (const phase of ['fresh', 'configured', 'locked']) {
    let channel;
    if (phase === 'configured') config.configureWorkersGrpc({ defaultTimeoutMs: 100, transportMaxSendBytes: 123, transportMaxReceiveBytes: 456 });
    if (phase === 'locked') channel = new grpc.Channel('echo.test', grpc.credentials.createSsl());
    const before = config.getWorkersGrpcConfig(), serialized = JSON.stringify(before);
    try {
      for (const key of keys) {
        for (const value of [...invalid, ...(key === 'defaultTimeoutMs' ? [] : [2147483648])]) {
          assert.throws(() => config.configureWorkersGrpc({ [key]: value }), { code: 'WGA_INVALID_CONFIG' }, `${phase}: ${key}=${value}`);
          assert.strictEqual(config.getWorkersGrpcConfig(), before);
          assert.equal(JSON.stringify(config.getWorkersGrpcConfig()), serialized);
        }
      }
    } finally { channel?.close(); }
  }
  assert.equal(fetches, 0);
}));

test('CFG-007 empty mappings and unmapped authorities fail without authentication or fallback Fetch', () => isolated(() => {
  const before = config.getWorkersGrpcConfig();
  assert.throws(() => config.configureWorkersGrpc({ mode: 'grpc-web', endpoints: {} }), { code: 'WGA_INVALID_CONFIG' });
  assert.strictEqual(config.getWorkersGrpcConfig(), before);
  let auth = 0, configuredFetch = 0;
  const snapshot = config.configureWorkersGrpc({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' },
    fetcher: { async fetch() { configuredFetch++; throw new Error('Unexpected configured Fetch'); } } });
  const credentials = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(),
    grpc.credentials.createFromMetadataGenerator((_options, callback) => { auth++; callback(null, new grpc.Metadata()); }));
  for (const Constructor of [grpc.Channel, grpc.Client, helpers.Echo]) {
    assert.throws(() => new Constructor('unmapped.test', credentials), { code: 'WGA_UNMAPPED_TARGET' });
    assert.strictEqual(config.getWorkersGrpcConfig(), snapshot);
  }
  const channel = new grpc.Channel('echo.test', credentials);
  channel.close();
  assert.deepEqual({ auth, configuredFetch, fetches }, { auth: 0, configuredFetch: 0, fetches: 0 });
}));

test('CFG-008 every registered Channel option has exact accepted and rejected value controls', () => isolated(() => {
  const options = [
    ['grpc.max_send_message_length', [-1, 0, 1, 2147483647], [-2, 0.5, NaN, Infinity, '1']],
    ['grpc.max_receive_message_length', [-1, 0, 1, 2147483647], [-2, 0.5, NaN, Infinity, '1']],
    ['grpc.initial_reconnect_backoff_ms', [1000], [0, 999, 1001, '1000']],
    ['grpc.default_compression_algorithm', [0, 1, 2], [-1, 3, 0.5, '0']],
    ['grpc.enable_retries', [0], [1, false, '0']],
    ['grpc.enable_channelz', [0], [1, false, '0']],
    ['grpc.primary_user_agent', ['', 'fixture/1.0', 'x'.repeat(4096)], [1, 'x\r\ninjected', '\u0100', 'x'.repeat(4097)]],
    ['grpc.secondary_user_agent', ['', 'fixture/1.0', 'x'.repeat(4096)], [1, 'x\n', '\u0100', 'x'.repeat(4097)]],
    ['grpc.default_authority', ['echo.test', 'ECHO.test:443'], ['other.test', 'echo.test:444']],
    ['grpc.ssl_target_name_override', ['echo.test', 'ECHO.test:443'], ['other.test', 'echo.test:444']],
    ['grpc-node.flow_control_window', [262144], [0, 262143, 262145, '262144']],
    ['grpc.use_local_subchannel_pool', [1], [0, 2, true, '1']],
  ];
  for (const [key, accepted, rejected] of options) {
    for (const value of [...accepted, undefined]) {
      const channel = new grpc.Channel('echo.test', grpc.credentials.createSsl(), { [key]: value });
      channel.close();
    }
    for (const value of rejected) assert.throws(() => new grpc.Channel('echo.test', grpc.credentials.createSsl(), { [key]: value }),
      { code: 'WGA_UNSUPPORTED_OPTION' }, `${key}=${value}`);
  }
  for (const key of ['unknown', 'grpc.unknown', 'grpc.keepalive_time_ms', 'grpc.keepalive_timeout_ms', 'grpc.keepalive_permit_without_calls',
    'grpc.service_config', 'grpc.service_config_disable_resolution', 'grpc.min_reconnect_backoff_ms', 'grpc.max_reconnect_backoff_ms']) {
    for (const value of [undefined, 1, '{}']) assert.throws(() => new grpc.Channel('echo.test', grpc.credentials.createSsl(), { [key]: value }),
      { code: 'WGA_UNSUPPORTED_OPTION' }, key);
  }
  assert.equal(fetches, 0);
}));

test('CFG-009 pinned GAX runtimes emit exact defaults and retain adapter safety caps', async t => {
  const savedFetch = globalThis.fetch;
  const environmentKeys = ['GOOGLE_API_USE_CLIENT_CERTIFICATE', 'GOOGLE_API_USE_MTLS_ENDPOINT'];
  const savedEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
  process.env.GOOGLE_API_USE_CLIENT_CERTIFICATE = 'false';
  process.env.GOOGLE_API_USE_MTLS_ENDPOINT = 'never';
  let fallbackFetches = 0;
  globalThis.fetch = async () => { fallbackFetches++; throw new Error('Unexpected fallback Fetch'); };
  try {
    const installations = ['google', 'modern'].flatMap(fixture => {
      const profile = require(`../src/build/profiles/google-${fixture === 'google' ? 'static' : 'modern'}-v1.json`);
      return profile.packages.filter(item => item.name === 'google-gax').map(pin => ({ fixture, pin }));
    });
    for (const { fixture, pin } of installations) {
      const fixtureRequire = createRequire(path.join(root, 'fixtures', fixture, 'package.json'));
      const alias = fixtureRequire('@grpc/grpc-js');
      const { createWorkersGrpcTransport: createTransport } = fixtureRequire('@grpc/grpc-js/adapter');
      const installedPath = path.join(root, 'fixtures', fixture, pin.path);
      const { GrpcClient } = require(installedPath);
      const version = require(path.join(installedPath, 'package.json')).version;
      assert.equal(version, pin.version);
      assert.strictEqual(createRequire(path.join(installedPath, 'package.json'))('@grpc/grpc-js'), alias);
      let fetches = 0, receiveBytes = 1, captured;
      const transport = createTransport({ transportMaxSendBytes: 16, transportMaxReceiveBytes: 16, fetcher: {
        async fetch() {
          fetches++;
          const data = Buffer.alloc(5 + receiveBytes); data.writeUInt32BE(receiveBytes, 1);
          const trailer = Buffer.from('grpc-status: 0\r\n'), end = Buffer.alloc(5); end[0] = 128; end.writeUInt32BE(trailer.length, 1);
          return new Response(Buffer.concat([data, end, trailer]), { headers: { 'content-type': 'application/grpc-web+proto' } });
        },
      } });
      const Constructor = alias.makeGenericClientConstructor({ unary: { path: '/catalog.Bytes/Unary', requestStream: false, responseStream: false,
        requestSerialize: value => value, responseDeserialize: value => value } }, 'catalog.Bytes');
      class CapturedStub extends Constructor {
        constructor(target, credentials, options) { captured = { ...options }; super(target, credentials, options); }
      }
      const gax = new GrpcClient({ grpc: alias, auth: { async getUniverseDomain() { return 'googleapis.com'; } } });
      const stubOptions = () => ({ ...transport.gaxOptions({}), servicePath: 'echo.test', port: 443,
        universeDomain: 'googleapis.com', sslCreds: transport.channelCredentials });
      const client = await gax.createStub(CapturedStub, stubOptions());
      try {
        const defaults = Object.fromEntries(Object.entries(captured).filter(([key]) => key !== 'grpc.workers-grpc-adapter.instance-config'));
        assert.deepEqual(defaults, { 'grpc.max_receive_message_length': -1, 'grpc.max_send_message_length': -1,
          'grpc.initial_reconnect_backoff_ms': 1000 });
        t.diagnostic(JSON.stringify({ fixture, packagePath: pin.path, gaxVersion: version, capturedDefaults: defaults, effectiveSafetyCaps: { send: 16, receive: 16 } }));
        assert.equal(client.getChannel().limits.maxSend, 16);
        assert.equal(client.getChannel().limits.maxReceive, 16);
        const invoke = bytes => new Promise((resolve, reject) => client.unary(Buffer.alloc(bytes), (error, value) => error ? reject(error) : resolve(value)));
        await assert.rejects(invoke(17), { code: alias.status.RESOURCE_EXHAUSTED });
        assert.equal(fetches, 0, 'The actual GAX -1 send default must not disable the adapter cap');
        assert.equal((await invoke(1)).length, 1);
        receiveBytes = 17;
        await assert.rejects(invoke(1), { code: alias.status.RESOURCE_EXHAUSTED });
        assert.equal(fetches, 2);
        for (const backoff of [0, 999, 1001, '1000']) {
          await assert.rejects(gax.createStub(CapturedStub, { ...stubOptions(), 'grpc.initial_reconnect_backoff_ms': backoff }),
            { code: 'WGA_UNSUPPORTED_OPTION' });
        }
        assert.equal(fetches, 2);
      } finally { client.close(); }
    }
    assert.equal(fallbackFetches, 0);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('CFG-010 installed alias constructors reject arbitrary and native channelOverride before any call', () => {
  const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
  const native = nativeRequire('@grpc/grpc-js');
  const foreign = new native.Channel('127.0.0.1:1', native.credentials.createInsecure(), {});
  const savedFetch = globalThis.fetch;
  let fetches = 0, calls = 0, factories = 0;
  globalThis.fetch = async () => { fetches++; throw new Error('Unexpected Fetch'); };
  try {
    assert.equal(foreign.getConnectivityState(false), native.connectivityState.IDLE);
    for (const fixture of ['google', 'modern']) {
      const fixtureRequire = createRequire(path.join(root, 'fixtures', fixture, 'package.json'));
      const alias = fixtureRequire('@grpc/grpc-js');
      assert.equal(fixtureRequire('@grpc/grpc-js/package.json').name, 'workers-grpc-adapter');
      assert.notStrictEqual(alias.Channel, native.Channel);
      const Generated = alias.makeGenericClientConstructor({}, 'catalog.Empty');
      for (const Constructor of [alias.Client, Generated]) {
        for (const channelOverride of [foreign, {}, { createCall() { calls++; throw new Error('Foreign call'); } }]) {
          assert.throws(() => new Constructor('echo.test', alias.credentials.createSsl(), { channelOverride }), { code: 'WGA_UNSUPPORTED_OPTION' });
        }
        assert.throws(() => new Constructor('echo.test', alias.credentials.createSsl(), {
          channelFactoryOverride() { factories++; return foreign; },
        }), { code: 'WGA_UNSUPPORTED_OPTION' });
      }
    }
    assert.deepEqual({ fetches, calls, factories }, { fetches: 0, calls: 0, factories: 0 });
    assert.equal(foreign.getConnectivityState(false), native.connectivityState.IDLE);
  } finally { foreign.close(); globalThis.fetch = savedFetch; }
});

test('CFG-011 waitForReady and corked metadata fail once before auth and Fetch in both modes', async () => {
  for (const mode of ['cloudflare', 'grpc-web']) {
    let auth = 0, fetches = 0;
    const transport = createWorkersGrpcTransport({ mode, ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
      fetcher: { async fetch() { fetches++; return response(); } } });
    const credentials = grpc.credentials.combineChannelCredentials(transport.channelCredentials,
      grpc.credentials.createFromMetadataGenerator((_options, callback) => { auth++; callback(null, new grpc.Metadata()); }));
    const client = new Echo('echo.test', credentials, transport.grpcOptions());
    try {
      for (const flags of [{ waitForReady: true }, { corked: true }, { waitForReady: true, corked: true }]) {
        let callbacks = 0, statuses = 0;
        const completion = new Promise((resolve, reject) => {
          const call = client.unary({ text: 'request' }, new grpc.Metadata(flags), (error, value) => {
            callbacks++;
            try { assert.equal(error.code, grpc.status.UNIMPLEMENTED); assert.equal(error.details, 'WGA_METADATA_OPTION'); assert.equal(value, undefined); resolve(); }
            catch (failure) { reject(failure); }
          });
          call.on('status', result => { statuses++; assert.equal(result.code, grpc.status.UNIMPLEMENTED); });
        });
        await completion; await immediate();
        assert.deepEqual({ callbacks, statuses, auth, fetches }, { callbacks: 1, statuses: 1, auth: 0, fetches: 0 });
        assert.equal(client.getChannel().activeCallCount(), 0);
      }
      assert.deepEqual(await unary(client, { text: 'recovery' }, new grpc.Metadata({ waitForReady: false, corked: false })).promise, { text: 'ok' });
      assert.deepEqual({ auth, fetches }, { auth: 1, fetches: 1 });
    } finally { client.close(); }
  }
});
