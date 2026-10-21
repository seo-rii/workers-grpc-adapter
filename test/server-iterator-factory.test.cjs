'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');

const method = { path: '/fixture.IteratorFactory/Call', requestStream: false, responseStream: true,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };
const turn = () => new Promise(resolve => setImmediate(resolve));
function request(signal) {
    return new Request('https://fixture.test' + method.path, { method: 'POST', signal,
        headers: { 'content-type': 'application/grpc-web+proto' }, body: encodeFrame(Buffer.alloc(0)) });
}
async function observe(response) {
    const messages = [], statuses = [];
    for await (const frame of decodeFrames(response.body, 1024)) {
        if (frame.trailer) statuses.push(parseTrailers(frame.payload));
        else messages.push(frame.payload.toString());
    }
    assert.equal(statuses.length, 1);
    return { messages, status: statuses[0] };
}

for (const requestStream of [false, true]) for (const promised of [false, true]) {
    test(`SERVER looks up the async iterator factory once requestStream=${requestStream}, promised=${promised}`, async () => {
        let getters = 0, factories = 0, next = 0, returned = 0;
        const output = { get [Symbol.asyncIterator]() {
            assert.equal(++getters, 1);
            return function () {
                assert.equal(this, output, 'invoke the cached factory with its iterable receiver');
                factories++;
                return {
                    async next() { return ++next === 1 ? { done: false, value: Buffer.from('message') } : { done: true }; },
                    async return() { returned++; return { done: true }; },
                };
            };
        } };
        const handle = createGrpcWebHandler({ call: { ...method, requestStream } }, { call() {
            return promised ? Promise.resolve(output) : output;
        } });
        const result = await observe(await handle(request()));
        assert.deepEqual(result.messages, ['message']);
        assert.equal(result.status.code, 0);
        assert.deepEqual({ getters, factories, next, returned }, { getters: 1, factories: 1, next: 2, returned: 0 });
    });
}

test('SERVER reads an absent async iterator factory once for unary output', async () => {
    let getters = 0;
    const output = Buffer.from('unary');
    Object.defineProperty(output, Symbol.asyncIterator, { get() { assert.equal(++getters, 1); return undefined; } });
    const handle = createGrpcWebHandler({ call: { ...method, responseStream: false } }, { call() { return output; } });
    const result = await observe(await handle(request()));
    assert.equal(result.status.code, 0);
    assert.deepEqual(result.messages, ['unary']);
    assert.equal(getters, 1);
});

test('SERVER invokes the iterator factory independently of its own call property', async () => {
    let factories = 0;
    const output = { [Symbol.asyncIterator]: Object.assign(function () {
        assert.equal(this, output);
        factories++;
        return { async next() { return { done: true }; } };
    }, { call: undefined }) };
    const handle = createGrpcWebHandler({ call: method }, { call() { return output; } });
    const result = await observe(await handle(request()));
    assert.equal(result.status.code, 0);
    assert.deepEqual(result.messages, []);
    assert.equal(factories, 1);
});

for (const late of [false, true]) {
    test(`SERVER retains iterator cleanup ownership with a single factory getter, late=${late}`, async () => {
        const controller = new AbortController();
        let getters = 0, factories = 0, next = 0, returned = 0, started, finish;
        const ready = new Promise(resolve => { started = resolve; });
        const pending = new Promise(resolve => { finish = resolve; });
        const output = { get [Symbol.asyncIterator]() {
            assert.equal(++getters, 1);
            if (!late) controller.abort();
            return function () {
                assert.equal(this, output);
                factories++;
                return { async next() { next++; return { done: true }; }, async return() { returned++; return { done: true }; } };
            };
        } };
        const handle = createGrpcWebHandler({ call: method }, { call() { started(); return late ? pending : output; } });
        const response = handle(request(controller.signal));
        await ready;
        if (late) controller.abort();
        const result = await observe(await response);
        assert.equal(result.status.code, 1);
        if (late) finish(output);
        await turn();
        assert.deepEqual({ getters, factories, next, returned }, { getters: 1, factories: 1, next: 0, returned: 1 });
    });
}

test('SERVER contains a factory getter failure without acquiring an iterator', async () => {
    let getters = 0;
    const handle = createGrpcWebHandler({ call: method }, { call() {
        return { get [Symbol.asyncIterator]() { getters++; throw new Error('private getter failure'); } };
    } });
    const result = await observe(await handle(request()));
    assert.equal(result.status.code, 13);
    assert.equal(result.status.details, 'WGA_SERVER_HANDLER');
    assert.deepEqual(result.messages, []);
    assert.equal(getters, 1);
});
