'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');

const method = { path: '/fixture.InputClose/Call', requestStream: true,
    requestDeserialize: bytes => bytes.toString(), responseSerialize: value => Buffer.from(value) };
const turn = () => new Promise(resolve => setImmediate(resolve));
const resultOf = promise => promise.then(value => ({ value }), error => ({ error }));

function source() {
    let controller, cancels = 0, pulled;
    const nextPull = new Promise(resolve => { pulled = resolve; });
    const body = new ReadableStream({
        start(value) { controller = value; }, pull() { pulled(); }, cancel() { cancels++; },
    }, { highWaterMark: 0 });
    return { body, controller, nextPull, get cancels() { return cancels; } };
}

async function observe(handle, body, signal) {
    const response = await handle(new Request('https://fixture.test' + method.path, {
        method: 'POST', headers: { 'content-type': 'application/grpc-web+proto' }, body, duplex: 'half', signal,
    }));
    const messages = [], trailers = [];
    for await (const frame of decodeFrames(response.body, 1024)) {
        if (frame.trailer) trailers.push(parseTrailers(frame.payload));
        else messages.push(frame.payload.toString());
    }
    assert.equal(trailers.length, 1);
    return { messages, status: trailers[0] };
}

for (const responseStream of [false, true]) {
    const answer = text => responseStream ? (async function* () { yield text; })() : text;
    for (const closure of ['pending-return', 'before-next', 'response-completion']) {
        test(`SERVER input closure preserves successful ${closure} with responseStream=${responseStream}`, { timeout: 2000 }, async () => {
            const incoming = source();
            incoming.controller.enqueue(encodeFrame(Buffer.from('record-one')));
            let context, input, pending, accepted;
            const handle = createGrpcWebHandler({ call: { ...method, responseStream } }, { async call(requests, ctx) {
                context = ctx;
                input = requests[Symbol.asyncIterator]();
                accepted = await input.next();
                if (closure !== 'before-next') {
                    pending = resultOf(input.next());
                    // The reader is waiting for another message, like an idle
                    // upload that application policy chooses to stop accepting.
                    await incoming.nextPull;
                }
                if (closure !== 'response-completion') {
                    await input.return();
                    await input.return();
                    if (pending) await pending;
                }
                return answer('accepted:1');
            } });
            const result = await observe(handle, incoming.body);
            assert.equal(result.status.code, 0);
            assert.deepEqual(result.messages, ['accepted:1']);
            assert.deepEqual(accepted, { done: false, value: 'record-one' });
            if (pending) assert.deepEqual(await pending, { value: { done: true, value: undefined } });
            assert.deepEqual(await input.next(), { done: true, value: undefined });
            assert.equal(context.signal.aborted, false);
            await turn();
            assert.equal(incoming.cancels, 1);
            assert.equal(incoming.body.locked, false);
        });
    }

    test(`SERVER input closure discards a buffered pending message with responseStream=${responseStream}`, async () => {
        const incoming = source();
        incoming.controller.enqueue(Buffer.concat(['first', 'unconsumed'].map(value => encodeFrame(Buffer.from(value)))));
        const deserialized = [];
        let pending;
        const handle = createGrpcWebHandler({ call: { ...method, responseStream,
            requestDeserialize(bytes) { const value = bytes.toString(); deserialized.push(value); return value; },
        } }, { async call(input) {
            await input.next();
            pending = resultOf(input.next());
            await input.return();
            await pending;
            return answer('accepted:1');
        } });
        const result = await observe(handle, incoming.body);
        assert.equal(result.status.code, 0);
        assert.deepEqual(result.messages, ['accepted:1']);
        assert.deepEqual(await pending, { value: { done: true, value: undefined } });
        assert.deepEqual(deserialized, ['first']);
        await turn();
        assert.equal(incoming.cancels, 1);
        assert.equal(incoming.body.locked, false);
    });

    test(`SERVER input closure preserves caller cancellation with responseStream=${responseStream}`, async () => {
        const incoming = source(), caller = new AbortController();
        let context, pending;
        const handle = createGrpcWebHandler({ call: { ...method, responseStream } }, { async call(input, ctx) {
            context = ctx;
            pending = resultOf(input.next());
            await incoming.nextPull;
            const closing = input.return();
            caller.abort();
            await closing;
            await pending;
            return answer('must not escape');
        } });
        const result = await observe(handle, incoming.body, caller.signal);
        assert.equal(result.status.code, 1);
        assert.equal(result.status.details, 'WGA_SERVER_CANCELLED');
        assert.deepEqual(result.messages, []);
        assert.equal(context.signal.aborted, true);
        assert.equal((await pending).error?.diagnostic, 'WGA_SERVER_CANCELLED');
        await turn();
        assert.equal(incoming.cancels, 1);
        assert.equal(incoming.body.locked, false);
    });

    test(`SERVER input closure keeps consumed framing errors terminal with responseStream=${responseStream}`, async () => {
        const incoming = source();
        incoming.controller.enqueue(Buffer.from([2, 0, 0, 0, 0]));
        let context, pending;
        const handle = createGrpcWebHandler({ call: { ...method, responseStream } }, { async call(input, ctx) {
            context = ctx;
            pending = resultOf(input.next());
            await pending;
            await input.return();
            return answer('must not escape');
        } });
        const result = await observe(handle, incoming.body);
        assert.equal(result.status.code, 13);
        assert.equal(result.status.details, 'WGA_FRAME_FLAGS');
        assert.deepEqual(result.messages, []);
        assert.equal(context.signal.aborted, true);
        assert.equal((await pending).error?.diagnostic, 'WGA_FRAME_FLAGS');
        await turn();
        assert.equal(incoming.cancels, 1);
        assert.equal(incoming.body.locked, false);
    });
}
