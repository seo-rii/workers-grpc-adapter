'use strict';
const { test } = require('node:test');
const { assert, Echo, response, unary, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

const policy = {
    methods: ['/demo.Echo/Unary'], maxAttempts: 2,
    initialBackoffMs: 1, maxBackoffMs: 1, retryableStatusCodes: [14],
};

for (const [field, valid] of [['methods', '/demo.Echo/Unary'], ['retryableStatusCodes', 14]]) {
    for (const [name, values] of [
        ['only a hole', new Array(1)],
        ['leading hole', [, valid]],
        ['trailing hole', [valid, ,]],
        ['explicit undefined', [undefined]],
    ]) {
        test(`RETRY POLICY rejects ${field} with ${name}`, () => {
            assert.throws(() => createWorkersGrpcTransport({
                retryPolicy: { ...policy, [field]: values },
            }), { code: 'WGA_INVALID_RETRY_POLICY' });
        });
    }
}

test('RETRY POLICY dense duplicate entries preserve the bounded retry behavior', async () => {
    let fetches = 0;
    const methods = ['/demo.Echo/Unary', '/demo.Echo/Unary'];
    const codes = [14, 14];
    const transport = createWorkersGrpcTransport({
        retryPolicy: { ...policy, methods, retryableStatusCodes: codes },
        fetcher: { async fetch() {
            fetches++;
            return fetches === 1 ? response([], { code: 14 }) : response();
        } },
    });
    // Later caller mutations must not alter the captured, validated policy.
    methods.length = 0;
    codes.length = 0;
    const client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions());
    try {
        assert.deepEqual(await unary(client, { text: 'request' }, { deadline: Date.now() + 3000 }).promise, { text: 'ok' });
        await immediate();
        assert.equal(fetches, 2);
        assert.equal(transport.resourceUsage().activeCalls, 0);
    } finally { client.close(); }
});
