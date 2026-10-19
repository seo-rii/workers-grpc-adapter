'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');
const { status } = require('../dist/index.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');

const method = { path: '/fixture.Ownership/Stream', responseStream: true,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };
const turn = () => new Promise(resolve => setImmediate(resolve));
function request(signal) {
    return new Request(`https://server.test${method.path}`, { method: 'POST', signal,
        headers: { 'content-type': 'application/grpc-web+proto' }, body: encodeFrame(Buffer.from('input')) });
}
async function terminal(response) {
    const trailers = [];
    for await (const frame of decodeFrames(response.body, 1024)) if (frame.trailer) trailers.push(parseTrailers(frame.payload));
    assert.equal(trailers.length, 1);
    return trailers[0];
}

for (const requestStream of [false, true]) for (const promised of [false, true]) for (let depth = 0; depth < 6; depth++) {
    test(`SERVER owns resolved iterator across cancellation requestStream=${requestStream}, promised=${promised}, depth=${depth}`, async () => {
        const controller = new AbortController();
        let acquired = 0, returned = 0;
        const handle = createGrpcWebHandler({ call: { ...method, requestStream } }, { call() {
            const output = { [Symbol.asyncIterator]() {
                acquired++;
                // Return a distinct iterator: accidental reacquisition would
                // dispose a different resource from the one used for reads.
                return {
                    next: async () => ({ done: false, value: Buffer.from('output') }),
                    return: async () => { returned++; return { done: true }; },
                };
            } };
            function abortAfterMicrotasks(remaining) {
                if (!remaining) controller.abort();
                else queueMicrotask(() => abortAfterMicrotasks(remaining - 1));
            }
            abortAfterMicrotasks(depth);
            return promised ? Promise.resolve(output) : output;
        } });
        const result = await terminal(await handle(request(controller.signal)));
        await turn();
        assert.equal(result.code, status.CANCELLED);
        assert.equal(acquired, 1, 'Acquire one owner for the returned resource');
        assert.equal(returned, 1, 'Every acquired iterator is disposed exactly once');
    });
}

for (const cleanup of ['throw', 'reject']) {
    test(`SERVER disposes a late handler iterator and contains cleanup ${cleanup}`, async () => {
        let started, finish;
        const ready = new Promise(resolve => { started = resolve; });
        const pending = new Promise(resolve => { finish = resolve; });
        const controller = new AbortController();
        let acquired = 0, returned = 0, reads = 0;
        const handle = createGrpcWebHandler({ call: { ...method, requestStream: false } }, { call() { started(); return pending; } });
        const response = handle(request(controller.signal));
        await ready;
        controller.abort();
        assert.equal((await terminal(await response)).code, status.CANCELLED);
        finish({ [Symbol.asyncIterator]() {
            acquired++;
            return {
                next: async () => { reads++; return { done: true }; },
                return() {
                    returned++;
                    const error = new Error('private cleanup failure');
                    if (cleanup === 'throw') throw error;
                    return Promise.reject(error);
                },
            };
        } });
        await turn();
        await turn();
        assert.equal(acquired, 1);
        assert.equal(returned, 1);
        assert.equal(reads, 0);
    });
}
