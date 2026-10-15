'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, response, unary } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { version } = require('../package.json');

const limit = 65536;
const userAgent = `workers-grpc-adapter/${version} budget-regression`;
function headerBytes(headers) {
  return [...headers].reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value) + 32, 0);
}

for (const mode of ['cloudflare', 'grpc-web']) {
  for (const scenario of ['initial', 'retry', 'refreshed-auth']) {
    for (const delta of [-1, 0, 1]) {
      test(`RETRY final header budget ${mode} ${scenario} limit${delta >= 0 ? '+' : ''}${delta}`, async () => {
        const attempt = scenario === 'initial' ? 1 : 2;
        const tokens = ['Bearer first', scenario === 'refreshed-auth' ? `Bearer ${'n'.repeat(128)}` : 'Bearer first'];
        const contentType = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
        // Independent encoded-field accounting for the complete target attempt.
        const expected = new Headers({ 'content-type': contentType, accept: contentType,
          'x-grpc-web': '1', 'grpc-encoding': 'identity', 'grpc-accept-encoding': 'identity,deflate,gzip',
          'x-user-agent': userAgent, authorization: tokens[attempt - 1], 'x-padding': '' });
        if (attempt > 1) expected.set('grpc-previous-rpc-attempts', '1');
        const metadata = new grpc.Metadata();
        metadata.set('x-padding', 'p'.repeat(limit + delta - headerBytes(expected)));
        const sent = [];
        let authCalls = 0;
        const transport = createWorkersGrpcTransport({ mode,
          ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
          retryPolicy: { methods: ['/demo.Echo/Unary'], maxAttempts: 2, initialBackoffMs: 1,
            maxBackoffMs: 1, retryableStatusCodes: [grpc.status.UNAVAILABLE] },
          fetcher: { async fetch(_url, init) {
            sent.push(new Headers(init.headers));
            return sent.length < attempt ? response([], { code: grpc.status.UNAVAILABLE }) : response();
          } } });
        const credentials = grpc.credentials.combineChannelCredentials(transport.channelCredentials,
          grpc.credentials.createFromMetadataGenerator((_options, done) => {
            const auth = new grpc.Metadata();
            auth.set('authorization', tokens[authCalls++]);
            done(null, auth);
          }));
        const c = new Echo('echo.test', credentials, transport.grpcOptions({ 'grpc.primary_user_agent': 'budget-regression' }));
        try {
          const { promise } = unary(c, { text: 'request' }, metadata);
          if (delta > 0) await assert.rejects(promise, { code: grpc.status.RESOURCE_EXHAUSTED, details: 'WGA_METADATA_SIZE' });
          else assert.deepEqual(await promise, { text: 'ok' });
          assert.equal(authCalls, attempt);
          assert.equal(sent.length, delta > 0 ? attempt - 1 : attempt);
          for (const [index, headers] of sent.entries()) {
            assert.ok(headerBytes(headers) <= limit, 'Fetch must never receive over-budget headers');
            assert.equal(headers.get('authorization'), tokens[index]);
            assert.equal(headers.get('grpc-previous-rpc-attempts'), index === 0 ? null : '1');
          }
          if (delta <= 0) assert.equal(headerBytes(sent.at(-1)), limit + delta);
          assert.equal(c.getChannel().activeCallCount(), 0);
        } finally { c.close(); }
      });
    }
  }
}
