'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, response, unary, immediate, deferred } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { validateConfig } = require('../dist/config-internal.js');
const { RetryThrottle } = require('../dist/retry.js');
const policy = { methods: ['/demo.Echo/Unary'], maxAttempts: 10, initialBackoffMs: 1,
  maxBackoffMs: 100, retryableStatusCodes: [14] };
const make = (t, target = 'echo.test', credentials = t.channelCredentials) => new Echo(target, credentials, t.grpcOptions());
async function until(check) {
  const end = performance.now() + 3000;
  while (!check()) { assert.ok(performance.now() < end, 'transition timed out'); await immediate(); }
}
test('RETRY THROTTLE rejects malformed settings and snapshots millitokens', () => {
  for (const retryThrottling of [null, [], {}, { maxTokens: 0, tokenRatio: 1 }, { maxTokens: 1001, tokenRatio: 1 },
    { maxTokens: 2.5, tokenRatio: 1 }, { maxTokens: 4, tokenRatio: 0 }, { maxTokens: 4, tokenRatio: Infinity },
    { maxTokens: 4, tokenRatio: '1' }, { maxTokens: 4, tokenRatio: 1, unknown: true }]) {
    assert.throws(() => validateConfig({ retryPolicy: policy, retryThrottling }), { code: 'WGA_INVALID_RETRY_THROTTLING' });
  }
  assert.throws(() => validateConfig({ retryThrottling: { maxTokens: 4, tokenRatio: 1 } }), { code: 'WGA_INVALID_RETRY_THROTTLING' });
  const input = { maxTokens: 4, tokenRatio: 0.1239 }, snapshot = validateConfig({ retryPolicy: policy, retryThrottling: input });
  input.maxTokens = 10;
  assert.deepEqual(snapshot.retryThrottling, { maxTokens: 4, tokenRatio: 0.123 });
  assert.ok(Object.isFrozen(snapshot.retryThrottling));
  assert.equal(createWorkersGrpcTransport().retryUsage('echo.test'), undefined);
  for (const tokenRatio of [1.001, 1.005, 2.01]) {
    assert.equal(validateConfig({ retryPolicy: policy, retryThrottling: { maxTokens: 2, tokenRatio } }).retryThrottling.tokenRatio, tokenRatio);
  }
  const recovery = new RetryThrottle(validateConfig({ retryPolicy: policy, retryThrottling: { maxTokens: 2, tokenRatio: 1.001 } }).retryThrottling);
  recovery.failure(); recovery.failure(); recovery.success();
  assert.equal(recovery.diagnostics().tokens, 1.001); assert.equal(recovery.allowed(), true);
});

for (const mode of ['cloudflare', 'grpc-web']) test(`RETRY THROTTLE ${mode} shares failures and recovery across calls but isolates endpoints and factories`, async () => {
  let fetches = 0, succeeds = false;
  const events = [], config = { mode, ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test', 'other.test': 'https://gateway.test' } } : {}),
    retryPolicy: policy, retryThrottling: { maxTokens: 4, tokenRatio: 1 }, observer: event => events.push(event),
    fetcher: { async fetch() { fetches++; return succeeds ? response() : response([], { code: 14 }); } } };
  const t = createWorkersGrpcTransport(config), isolated = createWorkersGrpcTransport(config);
  const a = make(t), b = make(t), other = make(t, 'other.test'), separate = make(isolated);
  try {
    await assert.rejects(unary(a).promise, { code: 14 }); assert.equal(fetches, 2);
    assert.deepEqual(t.retryUsage('ECHO.test:443'), { tokens: 2, maxTokens: 4, tokenRatio: 1, retriesAllowed: false, suppressedRetries: 1 });
    await assert.rejects(unary(b).promise, { code: 14 }); assert.equal(fetches, 3);
    assert.equal(t.retryUsage('echo.test').tokens, 1);
    await assert.rejects(unary(other).promise, { code: 14 }); assert.equal(fetches, 5);
    await assert.rejects(unary(separate).promise, { code: 14 }); assert.equal(fetches, 7);
    assert.equal(t.retryUsage('echo.test').tokens, 1);
    succeeds = true;
    await unary(a).promise; await unary(b).promise; await unary(a).promise; await unary(b).promise;
    assert.equal(t.retryUsage('echo.test').tokens, 4); assert.ok(Object.isFrozen(t.retryUsage('echo.test')));
    succeeds = false;
    await assert.rejects(unary(a).promise, { code: 14 }); assert.equal(fetches, 13);
    await immediate();
    assert.equal(events.filter(e => e.type === 'retry-throttled').length, 5);
    assert.equal(new Set(events.filter(e => e.type === 'call-end').map(e => e.logicalCallId)).size, 9);
  } finally { [a, b, other, separate].forEach(c => c.close()); }
});

test('RETRY THROTTLE concurrent failures recheck the budget after backoff', async () => {
  const gate = deferred(); let fetches = 0, auth = 0;
  const t = createWorkersGrpcTransport({ retryPolicy: { ...policy, initialBackoffMs: 50 },
    retryThrottling: { maxTokens: 4, tokenRatio: 0.1 }, fetcher: { async fetch() { fetches++; await gate.promise; return response([], { code: 14 }); } } });
  const credentials = grpc.credentials.combineChannelCredentials(t.channelCredentials, grpc.credentials.createFromMetadataGenerator((_, done) => { auth++; done(null, new grpc.Metadata()); }));
  const c = make(t, 'echo.test', credentials);
  try {
    const calls = Array.from({ length: 8 }, () => unary(c).promise.then(() => assert.fail('must fail'), e => assert.equal(e.code, 14)));
    await until(() => fetches === 8); gate.resolve(); await Promise.all(calls);
    assert.equal(fetches, 8); assert.equal(auth, 8);
    assert.deepEqual(t.retryUsage('echo.test'), { tokens: 0, maxTokens: 4, tokenRatio: 0.1, retriesAllowed: false, suppressedRetries: 8 });
  } finally { gate.resolve(); c.close(); }
});

test('RETRY THROTTLE refuses a pending authenticated retry without charging its old failure twice', async () => {
  const held = deferred(); let auth = 0, fetches = 0;
  const events = [];
  const t = createWorkersGrpcTransport({ retryPolicy: policy, retryThrottling: { maxTokens: 4, tokenRatio: 1 },
    observer: e => events.push(e), fetcher: { async fetch() { fetches++; return response([], { code: 14, extra: fetches > 1 ? 'grpc-retry-pushback-ms: -1\r\n' : '' }); } } });
  const credentials = grpc.credentials.combineChannelCredentials(t.channelCredentials, grpc.credentials.createFromMetadataGenerator((_, done) => {
    auth++; if (auth === 2) void held.promise.then(() => done(null, new grpc.Metadata())); else done(null, new grpc.Metadata());
  }));
  const first = make(t, 'echo.test', credentials), second = make(t);
  try {
    const pending = unary(first).promise.then(() => assert.fail('must fail'), e => assert.equal(e.code, 14));
    await until(() => auth === 2);
    await assert.rejects(unary(second).promise, { code: 14 }); assert.equal(t.retryUsage('echo.test').tokens, 2);
    held.resolve(); await pending; await immediate();
    assert.equal(fetches, 2); assert.equal(t.retryUsage('echo.test').tokens, 2);
    assert.equal(t.retryUsage('echo.test').suppressedRetries, 1);
    assert.equal(events.filter(e => e.type === 'retry-throttled').length, 1);
    assert.equal(events.find(e => e.type === 'attempt-end' && e.attempt === 2).fetchStarted, false);
  } finally { held.resolve(); first.close(); second.close(); }
});

test('RETRY THROTTLE ignores local auth and invalid response errors, restores on unlisted successful methods', async () => {
  let kind = 'auth';
  const t = createWorkersGrpcTransport({ retryPolicy: policy, retryThrottling: { maxTokens: 4, tokenRatio: 1 },
    fetcher: { async fetch() {
      if (kind === 'invalid') return new Response('bad', { headers: { 'content-type': 'text/plain' } });
      if (kind === 'denied') return response([], { code: 7 });
      if (kind === 'failure') return response([], { code: 14, extra: 'grpc-retry-pushback-ms: -1\r\n' });
      return response();
    } } });
  const bad = make(t, 'echo.test', grpc.credentials.combineChannelCredentials(t.channelCredentials,
    grpc.credentials.createFromMetadataGenerator((_, done) => done(new Error('auth rejected')))));
  const c = make(t);
  try {
    await assert.rejects(unary(bad).promise); assert.equal(t.retryUsage('echo.test').tokens, 4);
    kind = 'invalid'; await assert.rejects(unary(c).promise); assert.equal(t.retryUsage('echo.test').tokens, 4);
    kind = 'denied'; await assert.rejects(unary(c).promise, { code: 7 }); assert.equal(t.retryUsage('echo.test').tokens, 4);
    kind = 'failure'; await assert.rejects(unary(c).promise, { code: 14 }); assert.equal(t.retryUsage('echo.test').tokens, 3);
    kind = 'ok'; for await (const message of c.stream({ text: 'x' })) assert.equal(message.text, 'ok');
    assert.equal(t.retryUsage('echo.test').tokens, 4);
  } finally { bad.close(); c.close(); }
});

test('RETRY THROTTLE Fetch failures count only under explicit Fetch-error replay', async () => {
  for (const retryOnFetchError of [false, true]) {
    let fetches = 0;
    const t = createWorkersGrpcTransport({ retryPolicy: { ...policy, retryOnFetchError },
      retryThrottling: { maxTokens: 4, tokenRatio: 1 }, fetcher: { async fetch() { fetches++; throw new Error('offline'); } } });
    const c = make(t);
    try {
      await assert.rejects(unary(c).promise, { code: 14 });
      assert.equal(fetches, retryOnFetchError ? 2 : 1); assert.equal(t.retryUsage('echo.test').tokens, retryOnFetchError ? 2 : 4);
    } finally { c.close(); }
  }
});
