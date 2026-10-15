'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');

const method = { path: '/fixture.Early/Echo', requestStream: false, responseStream: false,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };
const rejections = [
    { name: '405', method: 'PUT', path: method.path, type: 'application/grpc-web+proto', status: 405 },
    { name: '415', method: 'POST', path: method.path, type: 'application/json', status: 415 },
    { name: 'unknown RPC', method: 'POST', path: '/fixture.Early/Missing', type: 'application/grpc-web+proto', status: 200 },
];

for (const rejection of rejections) {
    for (const cancellation of ['resolve', 'reject', 'pending']) {
        for (const aborted of [false, true]) {
            test(`SERVER early ${rejection.name} returns when body cancellation is ${cancellation}, aborted=${aborted}`, async () => {
                let cancelled = 0, handled = 0;
                const handler = createGrpcWebHandler({ echo: method }, { echo(value) { handled++; return value; } });
                const body = new ReadableStream({ cancel() {
                    cancelled++;
                    if (cancellation === 'reject') return Promise.reject(new Error('private cleanup failure'));
                    if (cancellation === 'pending') return new Promise(() => {});
                    return Promise.resolve();
                } });
                const controller = new AbortController();
                if (aborted) controller.abort();
                const request = new Request(`https://server.test${rejection.path}`, {
                    method: rejection.method, headers: { 'content-type': rejection.type }, body,
                    duplex: 'half', signal: controller.signal,
                });
                const pending = Symbol('pending response');
                // Rejection needs no I/O: it must settle before the next event-loop turn,
                // even when the underlying source never finishes cancelling.
                const response = await Promise.race([
                    handler(request), new Promise(resolve => setImmediate(() => resolve(pending))),
                ]);
                assert.notEqual(response, pending, 'Body cleanup must not hold the early response open');
                assert.equal(response.status, rejection.status);
                assert.equal(cancelled, 1, 'Start body cleanup exactly once');
                assert.equal(handled, 0, 'Do not invoke the RPC handler');
                if (rejection.status === 405) assert.equal(response.headers.get('allow'), 'POST');
                if (rejection.name === 'unknown RPC') {
                    assert.equal(response.headers.get('content-type'), 'application/grpc-web+proto');
                    const bytes = Buffer.from(await response.arrayBuffer());
                    assert.equal(bytes[0], 0x80);
                    assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
                    assert.equal(bytes.subarray(5).toString(), 'grpc-status: 12\r\ngrpc-message: WGA_SERVER_METHOD\r\n');
                }
            });
        }
    }
}
