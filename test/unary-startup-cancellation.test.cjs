'use strict';
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, Echo, response, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

function fixture(mode, limited, hook, replace = false) {
  let surface, starts = 0, authenticate = 0, fetches = 0, cancellations = 0, customCancellations = 0;
  const factory = createWorkersGrpcTransport({ mode,
    ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
    ...(limited ? { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 0 } } : {}),
    fetcher: { fetch() { fetches++; return response(); } },
  });
  const credentials = grpc.credentials.combineChannelCredentials(factory.channelCredentials,
    grpc.credentials.createFromMetadataGenerator((_options, done) => { authenticate++; done(null, new grpc.Metadata()); }));
  const client = new Echo('echo.test', credentials, factory.grpcOptions({
    callInvocationTransformer(properties) {
      if (!surface) {
        surface = properties.call;
        if (hook === 'transformer') { surface.cancel(); surface.cancel(); }
        if (replace) {
          surface = Object.assign(new EventEmitter(), {
            cancel() { customCancellations++; }, getPeer() { return 'custom'; }, getAuthContext() { return null; },
          });
          properties.call = surface;
          surface.cancel();
        }
      }
      return properties;
    },
    interceptors: [(options, nextCall) => {
      const downstream = nextCall(options);
      if (hook === 'constructor' && starts === 0 && cancellations === 0) { surface.cancel(); surface.cancel(); }
      return new grpc.InterceptingCall(downstream, {
        start(metadata, listener, next) { starts++; next(metadata, listener); },
        cancel(next) { cancellations++; surface.cancel(); next(); },
      });
    }],
  }));
  return { client, factory, counts: () => ({ starts, authenticate, fetches, cancellations, customCancellations }) };
}
function start(client) {
  const callbacks = [], statuses = [];
  const call = client.unary({ text: 'request' }, (error, value) => callbacks.push({ code: error?.code ?? grpc.status.OK, value }));
  assert.deepEqual(callbacks, [], 'public completion must remain asynchronous');
  call.on('status', value => statuses.push(value.code));
  return { call, callbacks, statuses };
}
function assertClean(f, result, code, fetches) {
  assert.deepEqual(result.statuses, [code]);
  assert.deepEqual(result.callbacks.map(value => value.code), [code]);
  assert.equal(f.client.getChannel().activeCallCount(), 0);
  assert.equal(f.factory.resourceUsage().activeCalls, 0);
  assert.equal(f.factory.resourceUsage().queuedCalls, 0);
  assert.equal(f.factory.resourceUsage().bufferedBytes, 0);
  assert.deepEqual(transportCall(result.call).diagnostics(),
    { terminal: true, fetchCount: fetches, requestBytes: 0, responseBytes: 0, timerActive: false });
}
for (const mode of ['cloudflare', 'grpc-web']) for (const limited of [false, true]) {
  for (const hook of ['transformer', 'constructor']) {
    test(`UNARY STARTUP CANCEL ${mode} ${hook} admission=${limited}`, { timeout: 3000 }, async () => {
      const f = fixture(mode, limited, hook);
      try {
        const result = start(f.client);
        await immediate();
        assertClean(f, result, grpc.status.CANCELLED, 0);
        assert.deepEqual(f.counts(), { starts: 0, authenticate: 0, fetches: 0, cancellations: 1, customCancellations: 0 });
        result.call.cancel(); result.call.cancel();
        await immediate();
        assertClean(f, result, grpc.status.CANCELLED, 0);
        assert.equal(f.counts().cancellations, 1, 'reentrant and repeated cancellation reaches the requester once');
        const later = start(f.client);
        await immediate();
        assertClean(f, later, grpc.status.OK, 1);
        assert.deepEqual(later.callbacks[0].value, { text: 'ok' });
        assert.deepEqual(f.counts(), { starts: 1, authenticate: 1, fetches: 1, cancellations: 1, customCancellations: 0 });
      } finally { f.client.close(); }
    });
  }
  test(`UNARY STARTUP CANCEL ${mode} returned call control admission=${limited}`, async () => {
    const f = fixture(mode, limited);
    try {
      const result = start(f.client);
      result.call.cancel(); result.call.cancel();
      await immediate();
      assertClean(f, result, grpc.status.CANCELLED, 0);
      assert.equal(f.counts().cancellations, 1);
    } finally { f.client.close(); }
  });
  test(`UNARY STARTUP CANCEL ${mode} replacement surface owns cancellation admission=${limited}`, async () => {
    const f = fixture(mode, limited, 'transformer', true);
    try {
      const result = start(f.client);
      await immediate();
      assertClean(f, result, grpc.status.OK, 1);
      assert.deepEqual(f.counts(), { starts: 1, authenticate: 1, fetches: 1, cancellations: 0, customCancellations: 1 });
      result.call.cancel();
      assert.equal(f.counts().customCancellations, 2);
    } finally { f.client.close(); }
  });
}
