'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, response, unary } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

for (const kind of ['channelOverride', 'channelFactoryOverride']) {
  test(`CLIENT ${kind} uses the owned channel route, credentials and resources`, async () => {
    const routes = [];
    const transport = createWorkersGrpcTransport({ fetcher: { async fetch(url) {
      routes.push(new URL(url).hostname); return response();
    } } });
    const channel = new grpc.Channel('selected.test', transport.channelCredentials, transport.grpcOptions());
    const credentials = grpc.credentials.createSsl();
    let factoryCalls = 0, interceptors = 0, transforms = 0;
    const options = {
      interceptors: [(options, next) => { interceptors++; return next(options); }],
      callInvocationTransformer(properties) { transforms++; return properties; },
      ...(kind === 'channelOverride' ? { channelOverride: channel } : {
        channelFactoryOverride(address, passedCredentials, passedOptions) {
          factoryCalls++;
          assert.equal(address, 'original.test');
          assert.strictEqual(passedCredentials, credentials);
          assert.notStrictEqual(passedOptions, options);
          assert.equal(Object.hasOwn(passedOptions, 'channelFactoryOverride'), false);
          assert.equal(Object.hasOwn(passedOptions, 'interceptors'), false);
          assert.equal(Object.hasOwn(passedOptions, 'callInvocationTransformer'), false);
          return channel;
        },
      }),
    };
    const client = new Echo('original.test', credentials, options);
    try {
      assert.strictEqual(grpc.getClientChannel(client), channel);
      assert.deepEqual(await unary(client).promise, { text: 'ok' });
      assert.deepEqual(routes, ['selected.test']);
      assert.equal(factoryCalls, kind === 'channelFactoryOverride' ? 1 : 0);
      assert.equal(interceptors, 1);
      assert.equal(transforms, 1);
      assert.equal(transport.resourceUsage().peakActiveCalls, 1);
      assert.equal(transport.resourceUsage().activeCalls, 0);
      assert.ok(options.interceptors);
      assert.ok(options.callInvocationTransformer);
      assert.ok(options[kind]);
    } finally { client.close(); }
    assert.equal(channel.getConnectivityState(), grpc.connectivityState.SHUTDOWN);
  });
}

test('CLIENT a direct channel override takes precedence over the factory', () => {
  const transport = createWorkersGrpcTransport();
  const channel = new grpc.Channel('selected.test', transport.channelCredentials, transport.grpcOptions());
  const client = new grpc.Client('ignored.test', transport.channelCredentials, {
    channelOverride: channel,
    channelFactoryOverride() { assert.fail('Direct override takes precedence'); },
  });
  assert.strictEqual(grpc.getClientChannel(client), channel);
  client.close();
});

test('CLIENT a channel factory can construct a channel from the remaining instance options', async () => {
  let fetches = 0;
  const transport = createWorkersGrpcTransport({ fetcher: { async fetch() { fetches++; return response(); } } });
  // grpcOptions deliberately rejects existing override hooks; direct Client
  // options may add the hook after obtaining the transport snapshot.
  const options = { ...transport.grpcOptions(), channelFactoryOverride: (address, credentials, channelOptions) =>
    new grpc.Channel(address, credentials, channelOptions) };
  const client = new Echo('factory.test', transport.channelCredentials, options);
  try {
    assert.deepEqual(await unary(client).promise, { text: 'ok' });
    assert.equal(fetches, 1);
    assert.equal(transport.resourceUsage().peakActiveCalls, 1);
    assert.ok(options.channelFactoryOverride);
  } finally { client.close(); }
});

test('CLIENT overrides reject foreign and forged channels before invoking channel methods', () => {
  let foreignCalls = 0;
  const forged = Object.create(grpc.Channel.prototype);
  const foreign = { createCall() { foreignCalls++; }, createCallForMethod() { foreignCalls++; } };
  for (const candidate of [null, {}, forged, foreign, Promise.resolve(foreign)]) {
    assert.throws(() => new Echo('original.test', grpc.credentials.createSsl(), { channelOverride: candidate }), { code: 'WGA_UNSUPPORTED_OPTION' });
    let factories = 0;
    assert.throws(() => new Echo('original.test', grpc.credentials.createSsl(), {
      channelFactoryOverride() { factories++; return candidate; },
    }), { code: 'WGA_UNSUPPORTED_OPTION' });
    assert.equal(factories, 1);
  }
  assert.throws(() => new grpc.Client('original.test', grpc.credentials.createSsl(), { channelFactoryOverride: {} }), { code: 'WGA_UNSUPPORTED_OPTION' });
  assert.equal(foreignCalls, 0);
});
