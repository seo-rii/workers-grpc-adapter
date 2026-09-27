'use strict';
const { test } = require('node:test');
const { assert, grpc, client, response, unary, transportCall, withFetch, immediate } = require('./helpers.cjs');
for (const action of ['cancel', 'close']) test(`RETRY metadata ${action} leaves no retained response or extra attempt`, async () => {
  let requests = 0;
  await withFetch(async () => { requests++; return response([{ text: 'never delivered' }]); }, async () => {
    const c = client({}, { mode: 'cloudflare', retryPolicy: { methods: ['/demo.Echo/Unary'], maxAttempts: 3,
      initialBackoffMs: 1, maxBackoffMs: 10, retryableStatusCodes: [14] } });
    const { call, promise } = unary(c);
    call.on('metadata', () => action === 'cancel' ? call.cancel() : c.close());
    await assert.rejects(promise, { code: action === 'cancel' ? grpc.status.CANCELLED : grpc.status.UNAVAILABLE });
    await immediate();
    assert.deepEqual(transportCall(call).diagnostics(), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
    assert.equal(requests, 1); assert.equal(c.getChannel().activeCallCount(), 0); c.close();
  });
});
