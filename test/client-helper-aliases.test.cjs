'use strict';
const { test } = require('node:test');
const { assert, grpc, methods, response, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

// proto-loader exposes these originalName aliases for valid PascalCase RPCs.
const Helpers = grpc.makeGenericClientConstructor({
  Close: { ...methods.unary, path: '/demo.Helpers/Close', originalName: 'close' },
  WaitForReady: { ...methods.unary, path: '/demo.Helpers/WaitForReady', originalName: 'waitForReady' },
  Watch: { ...methods.stream, path: '/demo.Helpers/Watch', originalName: 'watch' },
}, 'demo.Helpers');

test('CLIENT closeClient closes the channel when a generated RPC owns close', { timeout: 3000 }, async () => {
  let aborts = 0, cancels = 0;
  const routes = [];
  const transport = createWorkersGrpcTransport({ fetcher: { async fetch(url, init) {
    const route = new URL(url).pathname;
    routes.push(route);
    if (route.endsWith('/Close')) return response();
    init.signal.addEventListener('abort', () => aborts++, { once: true });
    return new Response(new ReadableStream({ cancel() { cancels++; } }, { highWaterMark: 0 }), {
      headers: { 'content-type': 'application/grpc-web+proto' },
    });
  } } });
  const client = new Helpers('helpers.test', transport.channelCredentials, transport.grpcOptions());
  const channel = grpc.getClientChannel(client);
  try {
    assert.strictEqual(client.close, client.Close);
    assert.deepEqual(await new Promise((resolve, reject) => client.close({ text: 'request' }, (error, value) => error ? reject(error) : resolve(value))), { text: 'ok' });
    const stream = client.watch({ text: 'watch' });
    stream.on('error', () => {});
    const terminal = new Promise(resolve => stream.once('status', resolve));
    stream.resume();
    await immediate();
    assert.equal(channel.activeCallCount(), 1);
    grpc.closeClient(client);
    assert.equal((await terminal).code, grpc.status.UNAVAILABLE);
    await immediate();
    assert.equal(channel.getConnectivityState(), grpc.connectivityState.SHUTDOWN);
    assert.equal(channel.activeCallCount(), 0);
    assert.equal(transport.resourceUsage().activeCalls, 0);
    assert.equal(aborts, 1);
    assert.equal(cancels, 1);
    assert.deepEqual(routes, ['/demo.Helpers/Close', '/demo.Helpers/Watch']);
    grpc.closeClient(client);
  } finally { channel.close(); }
});

for (const deadlineType of ['number', 'Date']) {
  test(`CLIENT waitForClientReady bypasses the RPC alias for ${deadlineType} deadlines`, async () => {
    let fetches = 0;
    const transport = createWorkersGrpcTransport({ fetcher: { async fetch() { fetches++; return response(); } } });
    const client = new Helpers('helpers.test', transport.channelCredentials, transport.grpcOptions());
    try {
      assert.strictEqual(client.waitForReady, client.WaitForReady);
      let synchronous = true;
      const expires = Date.now() + 1000;
      const result = new Promise(resolve => grpc.waitForClientReady(client, deadlineType === 'Date' ? new Date(expires) : expires, error => {
        resolve({ error, synchronous });
      }));
      synchronous = false;
      const outcome = await result;
      assert.equal(outcome.synchronous, false);
      assert.equal(outcome.error.code, grpc.status.UNIMPLEMENTED);
      assert.match(outcome.error.message, /WGA_CONNECTIVITY_UNSUPPORTED/);
      assert.equal(fetches, 0);
      assert.equal(transport.resourceUsage().activeCalls, 0);
    } finally { grpc.getClientChannel(client).close(); }
  });
}
