'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, response, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

const supported = [['cloudflare', 'stream'], ['grpc-web', 'stream'], ['grpc-web', 'clientStream'], ['grpc-web', 'bidi']];

function fixture(mode, limited, hook, action) {
  let firstSurface, authenticate = 0, starts = 0, cancellations = 0, hanging = true;
  const requests = [];
  const factory = createWorkersGrpcTransport({ mode,
    ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
    ...(limited ? { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 0 } } : {}),
    fetcher: { fetch(_url, init) {
      const request = { signal: init.signal, cancelled: 0 };
      requests.push(request);
      if (!hanging) return response();
      return new Response(new ReadableStream({ cancel() { request.cancelled++; } }),
        { headers: { 'content-type': 'application/grpc-web+proto' } });
    } },
  });
  const credentials = grpc.credentials.combineChannelCredentials(factory.channelCredentials,
    grpc.credentials.createFromMetadataGenerator((_options, done) => { authenticate++; done(null, new grpc.Metadata()); }));
  function stop(surface) {
    surface[action]();
    surface.cancel();
    surface[action]();
  }
  const client = new Echo('echo.test', credentials, factory.grpcOptions({
    callInvocationTransformer(properties) {
      if (!firstSurface) {
        firstSurface = properties.call;
        if (hook === 'transformer') stop(firstSurface);
      }
      return properties;
    },
    interceptors: [(options, nextCall) => {
      const downstream = nextCall(options);
      if (hook === 'constructor' && starts === 0 && cancellations === 0) stop(firstSurface);
      return new grpc.InterceptingCall(downstream, {
        start(metadata, listener, next) { starts++; next(metadata, listener); },
        cancel(next) { cancellations++; firstSurface.cancel(); next(); },
      });
    }],
  }));
  return { client, factory, requests, counts: () => ({ authenticate, starts, cancellations }),
    allowResponse() { hanging = false; } };
}

function start(client, kind) {
  const callbacks = [], statuses = [], errors = [];
  const stream = kind === 'stream' ? client.stream({ text: 'request' })
    : kind === 'clientStream' ? client.clientStream(error => callbacks.push(error?.code ?? grpc.status.OK)) : client.bidi();
  assert.deepEqual(callbacks, [], 'startup cancellation completes asynchronously');
  stream.on('error', error => errors.push(error));
  stream.on('status', value => statuses.push(value.code));
  if (kind !== 'clientStream') stream.resume();
  return { stream, callbacks, statuses, errors };
}

function clean(f, result, kind, fetches) {
  assert.deepEqual(result.statuses, [grpc.status.CANCELLED]);
  assert.deepEqual(result.callbacks, kind === 'clientStream' ? [grpc.status.CANCELLED] : []);
  assert.equal(f.client.getChannel().activeCallCount(), 0);
  assert.equal(f.factory.resourceUsage().activeCalls, 0);
  assert.equal(f.factory.resourceUsage().bufferedBytes, 0);
  assert.deepEqual(transportCall(result.stream).diagnostics(),
    { terminal: true, fetchCount: fetches, requestBytes: 0, responseBytes: 0, timerActive: false });
}

for (const [mode, kind] of supported) for (const limited of [false, true]) {
  for (const hook of ['transformer', 'constructor']) for (const action of ['cancel', 'destroy']) {
    test(`STARTUP CANCEL ${mode} ${kind} ${hook} ${action} admission=${limited}`, { timeout: 3000 }, async () => {
      const f = fixture(mode, limited, hook, action);
      try {
        const result = start(f.client, kind);
        await immediate();
        clean(f, result, kind, 0);
        assert.deepEqual(f.counts(), { authenticate: 0, starts: 0, cancellations: 1 });
        assert.deepEqual(f.requests, []);
        assert.deepEqual(result.errors.map(error => error.code), action === 'cancel' && kind !== 'clientStream' ? [grpc.status.CANCELLED] : []);

        result.stream.cancel(); result.stream.destroy(); result.stream.cancel();
        await immediate();
        clean(f, result, kind, 0);
        assert.equal(f.counts().cancellations, 1);

        // The rejected startup owns no admission slot; the same client remains usable.
        f.allowResponse();
        const value = await new Promise((resolve, reject) => f.client.unary({ text: 'next' }, (error, value) => error ? reject(error) : resolve(value)));
        assert.deepEqual(value, { text: 'ok' });
        assert.deepEqual(f.counts(), { authenticate: 1, starts: 1, cancellations: 1 });
        assert.equal(f.requests.length, 1);
        assert.equal(f.client.getChannel().activeCallCount(), 0);
      } finally { f.client.close(); }
    });
  }

  test(`STARTUP CANCEL ${mode} ${kind} post-start control admission=${limited}`, { timeout: 3000 }, async () => {
    const f = fixture(mode, limited);
    try {
      const result = start(f.client, kind);
      await immediate(); await immediate();
      assert.deepEqual(f.counts(), { authenticate: 1, starts: 1, cancellations: 0 });
      assert.equal(f.requests.length, 1);
      assert.equal(f.client.getChannel().activeCallCount(), 1);
      assert.deepEqual(result.statuses, []);
      result.stream.cancel(); result.stream.cancel(); result.stream.destroy();
      await immediate();
      clean(f, result, kind, 1);
      assert.equal(f.counts().cancellations, 1);
      assert.equal(f.requests[0].signal.aborted, true);
      assert.equal(f.requests[0].cancelled, 1);
    } finally { f.client.close(); }
  });
}
