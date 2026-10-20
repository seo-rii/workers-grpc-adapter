'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function probe(mode, clientKind, helper) {
  const grpc = require('../dist/index.js');
  const { createWorkersGrpcTransport } = require('../dist/adapter.js');
  const { encodeFrame } = require('../dist/wire.js');
  const routes = [], authPaths = [], interceptorPaths = [], service = 'example.Inventory';
  const owner = {};
  const transport = createWorkersGrpcTransport({ mode,
    ...(mode === 'grpc-web' ? { endpoints: { 'health.test': 'https://gateway.test' } } : {}),
    fetcher: { async fetch(url, init) {
      routes.push(new URL(url).pathname);
      assert.equal(new URL(url).origin, mode === 'grpc-web' ? 'https://gateway.test' : 'https://health.test');
      assert.equal(init.headers.get('x-health-proof'), 'request-proof');
      assert.equal(init.headers.get('x-channel-proof'), 'channel-proof');
      assert.equal(init.headers.get('x-call-proof'), 'call-proof');
      assert.equal(init.headers.get('x-interceptor-proof'), 'interceptor-proof');
      const body = Buffer.from(init.body);
      assert.deepEqual(body.subarray(5), Buffer.concat([Buffer.from([10, Buffer.byteLength(service)]), Buffer.from(service)]));
      return new Response(Buffer.concat([encodeFrame(Buffer.from([8, 1])), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), {
        headers: { 'content-type': 'application/grpc-web+proto' },
      });
    } },
  });
  const credential = (name, value) => grpc.credentials.createFromMetadataGenerator((input, callback) => {
    authPaths.push(input.method_name);
    const metadata = new grpc.Metadata(); metadata.set(name, value); callback(null, metadata);
  });
  const definition = (name, stream) => ({
    path: `/demo.Aliases/${name}`, requestStream: false, responseStream: stream,
    requestSerialize: value => Buffer.from(String(value)), responseDeserialize: bytes => ({ text: bytes.toString() }),
    ...(clientKind === 'originalName' ? { originalName: name[0].toLowerCase() + name.slice(1) } : {}),
  });
  const Generated = grpc.makeGenericClientConstructor({
    [clientKind === 'key' ? 'makeUnaryRequest' : 'MakeUnaryRequest']: definition('MakeUnaryRequest', false),
    [clientKind === 'key' ? 'makeServerStreamRequest' : 'MakeServerStreamRequest']: definition('MakeServerStreamRequest', true),
  }, 'demo.Aliases');
  const C = clientKind === 'plain' ? grpc.Client : Generated;
  const channelCredentials = grpc.credentials.combineChannelCredentials(transport.channelCredentials, credential('x-channel-proof', 'channel-proof'));
  const client = new C('health.test', channelCredentials, transport.grpcOptions({
    interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
      start(metadata, listener, next) {
        interceptorPaths.push(options.method_definition.path);
        assert.strictEqual(metadata.getOpaque('owner'), owner);
        metadata.set('x-interceptor-proof', 'interceptor-proof'); next(metadata, listener);
      },
    })],
  }));
  const health = new grpc.HealthClient(client), metadata = new grpc.Metadata();
  metadata.set('x-health-proof', 'request-proof'); metadata.setOpaque('owner', owner);
  const options = { metadata, credentials: credential('x-call-proof', 'call-proof'), deadline: Date.now() + 1500 };
  const expectedPath = `/grpc.health.v1.Health/${helper === 'check' ? 'Check' : 'Watch'}`;
  let monitor;
  try {
    if (clientKind !== 'plain') {
      assert.notStrictEqual(client.makeUnaryRequest, grpc.Client.prototype.makeUnaryRequest);
      assert.notStrictEqual(client.makeServerStreamRequest, grpc.Client.prototype.makeServerStreamRequest);
      if (clientKind === 'originalName') {
        assert.strictEqual(client.makeUnaryRequest, client.MakeUnaryRequest);
        assert.strictEqual(client.makeServerStreamRequest, client.MakeServerStreamRequest);
      }
    }
    if (helper === 'check') assert.deepEqual(await health.check(service, options), { status: 1 });
    else if (helper === 'watch') {
      const values = [];
      for await (const value of health.watch(service, options)) values.push(value);
      assert.deepEqual(values, [{ status: 1 }]);
    } else {
      const { deadline, ...monitorOptions } = options;
      monitor = health.monitor(service, { ...monitorOptions, initialBackoffMs: 10000, maxBackoffMs: 10000, backoffJitter: 0 });
      const result = await monitor.waitForServing({ deadline });
      assert.equal(result.phase, 'serving'); assert.equal(result.servingStatus, 1);
      monitor.close();
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(routes, [expectedPath]);
    assert.deepEqual(interceptorPaths, [expectedPath]);
    assert.deepEqual(authPaths, [expectedPath, expectedPath]);
    assert.deepEqual(metadata.get('x-interceptor-proof'), []);
    assert.equal(grpc.getClientChannel(client).activeCallCount(), 0);
    const usage = transport.resourceUsage();
    assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
  } finally { monitor?.close(); grpc.closeClient(client); }
}

if (process.argv[2] === '--probe') {
  probe(...process.argv.slice(3)).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { test } = require('node:test');
  for (const mode of ['cloudflare', 'grpc-web']) {
    for (const clientKind of ['plain', 'key', 'originalName']) for (const helper of ['check', 'watch']) {
      test(`HEALTH ${helper} uses its standard RPC with ${clientKind} client methods in ${mode}`, () => {
        // The broken Check dispatch invokes its serializer as a callback and
        // throws asynchronously. Isolate it so all matrix cases are reported.
        const result = spawnSync(process.execPath, [__filename, '--probe', mode, clientKind, helper], {
          cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
        });
        assert.equal(result.signal, null, result.error?.message ?? result.stderr);
        assert.equal(result.status, 0, result.stderr);
      });
    }
    test(`HEALTH monitor uses Watch with generated originalName aliases in ${mode}`, () => {
      const result = spawnSync(process.execPath, [__filename, '--probe', mode, 'originalName', 'monitor'], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.signal, null, result.error?.message ?? result.stderr);
      assert.equal(result.status, 0, result.stderr);
    });
  }
}
