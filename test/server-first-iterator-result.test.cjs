'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');

const method = { path: '/fixture.Result/Call', responseStream: true,
    requestDeserialize: bytes => bytes, responseSerialize: value => Buffer.from(value) };

async function observe(first, requestStream) {
    let factories = 0, reads = 0, returns = 0;
    const handler = createGrpcWebHandler({ call: { ...method, requestStream } }, { call() {
        return { [Symbol.asyncIterator]() {
            factories++;
            return { async next() {
                reads++;
                if (reads === 1) return first;
                if (reads === 2) return { done: false, value: 'second' };
                return { done: true };
            }, async return() { returns++; return { done: true }; } };
        } };
    } });
    const response = await handler(new Request('https://fixture.test' + method.path, {
        method: 'POST', headers: { 'content-type': 'application/grpc-web+proto' }, body: encodeFrame(Buffer.from('request')),
    }));
    const messages = [], statuses = [];
    for await (const frame of decodeFrames(response.body, 1024)) {
        if (frame.trailer) statuses.push(parseTrailers(frame.payload));
        else messages.push(frame.payload.toString());
    }
    assert.equal(factories, 1);
    assert.equal(statuses.length, 1);
    return { messages, status: statuses[0], reads, returns };
}

for (const requestStream of [false, true]) {
    for (const [kind, value] of [['null', null], ['undefined', undefined], ['false', false], ['number', 0], ['string', 'invalid']]) {
        test(`SERVER first iterator result rejects ${kind} with requestStream=${requestStream}`, async () => {
            const result = await observe(value, requestStream);
            assert.equal(result.status.code, 13);
            assert.equal(result.status.details, 'WGA_SERVER_HANDLER_KIND');
            assert.deepEqual(result.messages, []);
            assert.equal(result.reads, 1, 'do not consume another result after an invalid first result');
            assert.equal(result.returns, 1);
        });
    }
    test(`SERVER first iterator result preserves a normal message with requestStream=${requestStream}`, async () => {
        const result = await observe({ done: false, value: 'first' }, requestStream);
        assert.equal(result.status.code, 0);
        assert.deepEqual(result.messages, ['first', 'second']);
        assert.equal(result.reads, 3);
        assert.equal(result.returns, 0);
    });
    test(`SERVER first iterator result preserves empty completion with requestStream=${requestStream}`, async () => {
        const result = await observe({ done: true }, requestStream);
        assert.equal(result.status.code, 0);
        assert.deepEqual(result.messages, []);
        assert.equal(result.reads, 1);
        assert.equal(result.returns, 0);
    });
}
