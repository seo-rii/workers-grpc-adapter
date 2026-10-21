'use strict';
const { test } = require('node:test');
const { createRequire } = require('node:module');
const path = require('node:path');
const { assert, grpc, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');
const loader = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'))('@grpc/proto-loader');

function definition(collision) {
  return loader.fromJSON({ nested: { demo: { nested: {
    Text: { fields: { value: { type: 'string', id: 1 } } },
    Helpers: { methods: {
      Echo: { requestType: 'Text', responseType: 'Text' },
      Rows: { requestType: 'Text', responseType: 'Text', responseStream: true },
      Input: { requestType: 'Text', responseType: 'Text', requestStream: true },
      Duplex: { requestType: 'Text', responseType: 'Text', requestStream: true, responseStream: true },
      ...(collision ? { [collision]: { requestType: 'Text', responseType: 'Text' } } : {}),
    } },
  } } } });
}

for (const mode of ['cloudflare', 'grpc-web']) {
  for (const collision of ['', 'CheckOptionalUnaryResponseArguments', 'CheckMetadataAndOptions']) {
    test(`CLIENT private helpers cannot collide with ${collision || 'ordinary RPCs'} in ${mode}`, { timeout: 3000 }, async () => {
      const definitions = definition(collision);
      const Constructor = grpc.loadPackageDefinition(definitions).demo.Helpers;
      const routes = [];
      const transport = createWorkersGrpcTransport({ mode,
        ...(mode === 'grpc-web' ? { endpoints: { 'helpers.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
        fetcher: { async fetch(url, init) {
          const route = new URL(url).pathname;
          routes.push(route);
          assert.equal(init.headers.get('x-request'), 'present');
          assert.match(init.headers.get('grpc-timeout'), /^[0-9]+[HMSmun]$/);
          if (!Buffer.isBuffer(init.body)) for await (const _ of init.body) { /* Drain the upload. */ }
          const bytes = route.startsWith('/grpc.health.v1.Health/') ? Buffer.from([8, 1])
            : definitions['demo.Helpers'].Echo.responseSerialize({ value: 'ok' });
          return new Response(Buffer.concat([encodeFrame(bytes), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]),
            { headers: { 'content-type': 'application/grpc-web+proto' } });
        } },
      });
      const client = new Constructor('helpers.test', transport.channelCredentials, transport.grpcOptions());
      const metadata = new grpc.Metadata();
      metadata.set('x-request', 'present');
      const options = { deadline: Date.now() + 2000 };
      const request = { value: 'request' };
      const invoke = name => new Promise((resolve, reject) => client[name](request, metadata, options,
        (error, value) => error ? reject(error) : resolve(value)));
      const collect = async stream => {
        const values = [];
        for await (const value of stream) values.push(value);
        return values;
      };
      const expectedRoutes = [];
      try {
        assert.deepEqual(await invoke('Echo'), { value: 'ok' });
        expectedRoutes.push('/demo.Helpers/Echo');
        assert.deepEqual(await collect(client.Rows(request, metadata, options)), [{ value: 'ok' }]);
        expectedRoutes.push('/demo.Helpers/Rows');
        if (mode === 'grpc-web') {
          const input = new Promise((resolve, reject) => {
            const stream = client.Input(metadata, options, (error, value) => error ? reject(error) : resolve(value));
            stream.on('error', () => {});
            stream.end(request);
          });
          assert.deepEqual(await input, { value: 'ok' });
          expectedRoutes.push('/demo.Helpers/Input');
          const duplex = client.Duplex(metadata, options);
          duplex.end(request);
          assert.deepEqual(await collect(duplex), [{ value: 'ok' }]);
          expectedRoutes.push('/demo.Helpers/Duplex');
        }
        if (collision) {
          const originalName = collision[0].toLowerCase() + collision.slice(1);
          assert.strictEqual(client[originalName], client[collision], 'keep the generated originalName alias');
          assert.deepEqual(await invoke(originalName), { value: 'ok' });
          expectedRoutes.push(`/demo.Helpers/${collision}`);
        }
        const health = new grpc.HealthClient(client);
        assert.deepEqual(await health.check('', { ...options, metadata }), { status: grpc.HealthServingStatus.SERVING });
        expectedRoutes.push('/grpc.health.v1.Health/Check');
        assert.deepEqual(await collect(health.watch('', { ...options, metadata })), [{ status: grpc.HealthServingStatus.SERVING }]);
        expectedRoutes.push('/grpc.health.v1.Health/Watch');
        await immediate();
        assert.deepEqual(routes, expectedRoutes);
        assert.equal(grpc.getClientChannel(client).activeCallCount(), 0);
        assert.equal(transport.resourceUsage().activeCalls, 0);
      } finally { grpc.closeClient(client); }
    });
  }
}
