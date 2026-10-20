'use strict';
const { test } = require('node:test');
const { createRequire } = require('node:module');
const path = require('node:path');
const { assert, grpc } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');
const nativeRequire = createRequire(path.join(__dirname, '../fixtures/native/package.json'));
const loader = nativeRequire('@grpc/proto-loader');

const definitions = loader.fromJSON({ nested: { fixture: { nested: {
  Text: { fields: { value: { type: 'string', id: 1 } } },
  Kind: { values: { UNKNOWN: 0, KNOWN: 1 } },
  Lowercase: { methods: { format: { requestType: 'Text', responseType: 'Text' } } },
  PascalCase: { methods: { Format: { requestType: 'Text', responseType: 'Text' } } },
} } } });

for (const [service, method] of [['Lowercase', 'format'], ['PascalCase', 'Format']]) {
  test(`FACTORY loads a real proto-loader service with an RPC named ${method}`, async () => {
    const loaded = grpc.loadPackageDefinition(definitions);
    const Constructor = loaded.fixture[service];
    assert.equal(typeof Constructor, 'function');
    assert.strictEqual(Constructor.service, definitions[`fixture.${service}`]);
    assert.strictEqual(loaded.fixture.Text, definitions['fixture.Text']);
    assert.strictEqual(loaded.fixture.Kind, definitions['fixture.Kind']);
    assert.equal(typeof loaded.fixture.Text.format, 'string');
    assert.equal(typeof loaded.fixture.Kind.format, 'string');
    const definition = definitions[`fixture.${service}`][method];
    const routes = [];
    const transport = createWorkersGrpcTransport({ fetcher: { async fetch(url, init) {
      routes.push(new URL(url).pathname);
      assert.deepEqual(definition.requestDeserialize(Buffer.from(init.body).subarray(5)), { value: 'request' });
      return new Response(Buffer.concat([
        encodeFrame(definition.responseSerialize({ value: 'reply' })),
        encodeFrame(Buffer.from('grpc-status: 0\r\n'), true),
      ]), { headers: { 'content-type': 'application/grpc-web+proto' } });
    } } });
    const client = new Constructor('format.test', transport.channelCredentials, transport.grpcOptions());
    try {
      assert.strictEqual(client.format, client[method]);
      const result = await new Promise((resolve, reject) => client[method]({ value: 'request' }, (error, value) => error ? reject(error) : resolve(value)));
      assert.deepEqual(result, { value: 'reply' });
      assert.deepEqual(routes, [definition.path]);
      assert.equal(transport.resourceUsage().activeCalls, 0);
    } finally { client.close(); }
  });
}
