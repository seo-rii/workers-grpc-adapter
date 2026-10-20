'use strict';
const test = require('node:test');
const { assert, grpc, Echo, response, unary } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

for (const mode of ['cloudflare', 'grpc-web']) {
    for (const encoding of ['identity', 'gzip']) {
        for (const origin of ['metadata', 'call credentials', 'channel credentials']) {
            test(`WIRE rejects HTTP content-encoding from ${origin}, ${mode}, ${encoding} messages`, async () => {
                let fetches = 0;
                const transport = createWorkersGrpcTransport({ mode,
                    ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
                    fetcher: { fetch() { fetches++; return Promise.resolve(response()); } },
                });
                const unsupported = new grpc.Metadata();
                unsupported.set('Content-Encoding', 'gzip');
                const credentials = grpc.credentials.createFromMetadataGenerator((_options, done) => done(null, unsupported));
                const channel = origin === 'channel credentials'
                    ? grpc.credentials.combineChannelCredentials(transport.channelCredentials, credentials)
                    : transport.channelCredentials;
                const c = new Echo('echo.test:443', channel, transport.grpcOptions({
                    'grpc.default_compression_algorithm': grpc.compressionAlgorithms[encoding],
                }));
                try {
                    await assert.rejects(unary(c, { text: 'request' },
                        origin === 'metadata' ? unsupported : new grpc.Metadata(),
                        origin === 'call credentials' ? { credentials } : {}).promise,
                    { code: grpc.status.INTERNAL, details: 'WGA_RESERVED_METADATA' });
                    assert.equal(fetches, 0, 'reject an inconsistent HTTP representation before transport');
                    assert.equal(c.getChannel().activeCallCount(), 0);
                } finally { c.close(); }
            });
        }
    }
}
