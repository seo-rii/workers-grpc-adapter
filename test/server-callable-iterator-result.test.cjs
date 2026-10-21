'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');

const method = { path: '/fixture.CallableResult/Call', responseStream: true,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };

for (const requestStream of [false, true]) for (const callable of ['first', 'later', 'done', 'all']) {
    test(`SERVER accepts callable ${callable} iterator results requestStream=${requestStream}`, async () => {
        let reads = 0, returns = 0;
        const handle = createGrpcWebHandler({ call: { ...method, requestStream } }, { call() {
            return { [Symbol.asyncIterator]() {
                return { async next() {
                    const index = reads++;
                    const result = index < 2 ? { done: false, value: Buffer.from(index === 0 ? 'first' : 'second') } : { done: true };
                    return callable === ['first', 'later', 'done'][index] || callable === 'all'
                        ? Object.assign(() => {}, result) : result;
                }, async return() { returns++; return { done: true }; } };
            } };
        } });
        const response = await handle(new Request('https://fixture.test' + method.path, { method: 'POST',
            headers: { 'content-type': 'application/grpc-web+proto' }, body: encodeFrame(Buffer.alloc(0)) }));
        const messages = [], statuses = [];
        for await (const frame of decodeFrames(response.body, 1024)) {
            if (frame.trailer) statuses.push(parseTrailers(frame.payload));
            else messages.push(frame.payload.toString());
        }
        assert.deepEqual(messages, ['first', 'second']);
        assert.equal(statuses.length, 1);
        assert.equal(statuses[0].code, 0);
        assert.equal(reads, 3);
        assert.equal(returns, 0);
    });
}
