'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, response, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { authErrorCode } = require('../dist/status.js');

test('AUTH error code accessors cannot escape status classification', () => {
    for (const error of [Object.defineProperty(new Error('private'), 'code', {
        get() { throw new Error('private code accessor'); },
    }), new Proxy(new Error('private'), { get() { throw new Error('private error proxy'); } })]) {
        assert.equal(authErrorCode(error), grpc.status.UNKNOWN);
    }
    assert.equal(authErrorCode({ get code() { return grpc.status.UNAUTHENTICATED; } }), grpc.status.UNAUTHENTICATED);
    assert.equal(authErrorCode(new Error('ordinary error')), grpc.status.UNKNOWN);
    assert.equal(authErrorCode({ code: grpc.status.OK }), grpc.status.INTERNAL);
});

for (const mode of ['cloudflare', 'grpc-web']) {
    test(`AUTH throwing code accessor completes and releases admission ${mode}`, { timeout: 2000 }, async () => {
        let fetches = 0, generations = 0, callbacks = 0;
        const statuses = [];
        const transport = createWorkersGrpcTransport({ mode, resourceLimits: { maxConcurrentCalls: 1 },
            ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
            fetcher: { async fetch() { fetches++; return response(); } } });
        const credentials = grpc.credentials.createFromMetadataGenerator((_options, done) => {
            if (++generations > 1) { done(null, new grpc.Metadata()); return; }
            const failure = Object.defineProperty(new Error('private provider error'), 'code', {
                get() { throw new Error('private code accessor'); },
            });
            done(failure);
        });
        const client = new Echo('echo.test', grpc.credentials.combineChannelCredentials(transport.channelCredentials, credentials), transport.grpcOptions());
        try {
            let result;
            const call = client.unary({ text: 'request' }, (error, value) => { callbacks++; result = { error, value }; });
            call.on('status', value => statuses.push([value.code, value.details]));
            // No deadline is needed to finish an authentication failure.
            await immediate(); await immediate();
            assert.equal(callbacks, 1);
            assert.equal(result.value, undefined);
            assert.equal(result.error.code, grpc.status.UNKNOWN);
            assert.equal(result.error.details, 'WGA_AUTH_METADATA');
            assert.equal(result.error.message.includes('private'), false);
            assert.deepEqual(statuses, [[grpc.status.UNKNOWN, 'WGA_AUTH_METADATA']]);
            assert.equal(fetches, 0);
            assert.equal(transport.resourceUsage().activeCalls, 0);
            assert.equal(transport.resourceUsage().bufferedBytes, 0);
            assert.equal(client.getChannel().activeCallCount(), 0);
            const recovered = await new Promise((resolve, reject) => client.unary({ text: 'recovery' },
                (error, value) => error ? reject(error) : resolve(value)));
            assert.deepEqual(recovered, { text: 'ok' });
            assert.equal(fetches, 1);
        } finally { client.close(); }
    });
}
