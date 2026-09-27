'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const dist = process.env.WGA_SERVER_STREAM_DIST || path.resolve(__dirname, '../dist');
const { createGrpcWebHandler, GrpcWebServerError } = require(path.join(dist, 'server.js'));
const { encodeFrame, encodeMessageFrame, decodeFrames, parseTrailers } = require(path.join(dist, 'wire.js'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const method = { path: '/fixture.Upload/Call', requestStream: true, responseStream: false,
    requestDeserialize: bytes => bytes.toString(), responseSerialize: text => Buffer.from(text) };
const frames = (...values) => Buffer.concat(values.map(value => encodeFrame(Buffer.from(value))));
function request(body, extra = {}) {
    return new Request(`https://server.test${method.path}`, { method: 'POST',
        headers: { 'content-type': 'application/grpc-web+proto', ...extra.headers },
        body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}), signal: extra.signal });
}
async function observe(response) {
    const messages = [], trailers = [];
    for await (const item of decodeFrames(response.body, 1024 * 1024, undefined, {
        encoding: response.headers.get('grpc-encoding') ?? 'identity', maxWireBytes: 1024 * 1024,
    })) item.trailer ? trailers.push(parseTrailers(item.payload)) : messages.push(item.payload.toString());
    assert.equal(trailers.length, 1);
    return { messages, status: trailers[0] };
}
function source() {
    let controller, pulls = 0, cancels = 0;
    const body = new ReadableStream({ start(value) { controller = value; }, pull() { pulls++; }, cancel() { cancels++; } }, { highWaterMark: 0 });
    return { body, controller, get pulls() { return pulls; }, get cancels() { return cancels; } };
}
async function until(check) {
    for (let i = 0; i < 200; i++) { if (check()) return; await turn(); }
    assert.ok(check(), 'expected transition');
}

test('SERVER UPLOAD accepts empty and multiple messages through a lazy single iterator', async () => {
    const handler = createGrpcWebHandler({ call: method }, { async call(input) {
        const values = []; for await (const value of input) values.push(value); return values.join('|');
    } });
    for (const values of [[], [''], ['one', 'two', 'three']]) {
        const result = await observe(await handler(request(frames(...values))));
        assert.equal(result.status.code, 0); assert.deepEqual(result.messages, [values.join('|')]);
    }
    let calls = 0;
    const incoming = source();
    const rejectEarly = createGrpcWebHandler({ call: method }, { call() { calls++; throw new GrpcWebServerError(7, 'denied'); } });
    const result = await observe(await rejectEarly(request(incoming.body)));
    assert.equal(calls, 1); assert.equal(incoming.pulls, 0); assert.equal(incoming.cancels, 1);
    assert.equal(result.status.code, 7); assert.equal(incoming.body.locked, false);
});

test('SERVER UPLOAD bidi output arrives before upload EOF and input advances only on demand', async () => {
    const incoming = source(); let iterator, reads = 0;
    const handler = createGrpcWebHandler({ call: { ...method, responseStream: true } }, { async *call(input) {
        iterator = input; yield 'ready';
        for await (const value of input) { reads++; yield value.toUpperCase(); }
    } });
    const response = await handler(request(incoming.body));
    const reader = decodeFrames(response.body, 1024)[Symbol.asyncIterator]();
    assert.equal((await reader.next()).value.payload.toString(), 'ready');
    assert.equal(incoming.pulls, 0); assert.equal(reads, 0);
    const next = reader.next(); await until(() => incoming.pulls === 1);
    incoming.controller.enqueue(frames('one', 'two'));
    assert.equal((await next).value.payload.toString(), 'ONE');
    assert.equal(reads, 1); await turn(); assert.equal(reads, 1);
    assert.equal((await reader.next()).value.payload.toString(), 'TWO');
    assert.equal(incoming.pulls, 1);
    incoming.controller.close();
    assert.equal(parseTrailers((await reader.next()).value.payload).code, 0);
    assert.equal((await reader.next()).done, true);
    assert.equal((await iterator.next()).done, true);
    assert.equal(incoming.body.locked, false); assert.equal(incoming.cancels, 0);
});

test('SERVER UPLOAD early successful response closes unread upload without changing success to cancellation', async () => {
    for (const streaming of [false, true]) {
        const incoming = source(); let context, input;
        const handler = createGrpcWebHandler({ call: { ...method, responseStream: streaming } }, {
            call(value, ctx) { context = ctx; input = value; return streaming ? (async function* () { yield 'done'; })() : 'done'; },
        });
        const result = await observe(await handler(request(incoming.body)));
        assert.equal(result.status.code, 0); assert.deepEqual(result.messages, ['done']);
        assert.equal(incoming.pulls, 0); assert.equal(incoming.cancels, 1);
        assert.equal(context.signal.aborted, false); assert.equal((await input.next()).done, true);
    }
});

test('SERVER UPLOAD for-await break cancels input while allowing the handler response to finish', async () => {
    const incoming = source();
    incoming.controller.enqueue(frames('first', 'unconsumed'));
    const handler = createGrpcWebHandler({ call: method }, { async call(input) {
        for await (const value of input) return value;
        return 'empty';
    } });
    const result = await observe(await handler(request(incoming.body)));
    await until(() => !incoming.body.locked);
    assert.equal(result.status.code, 0); assert.deepEqual(result.messages, ['first']); assert.equal(incoming.cancels, 1);
});

test('SERVER UPLOAD abort and deadline unblock pending input reads and permit recovery', async () => {
    for (const kind of ['abort', 'deadline']) {
        const incoming = source(), aborter = new AbortController(); let context, count = 0;
        const handler = createGrpcWebHandler({ call: method }, { async call(input, ctx) {
            context = ctx; for await (const value of input) count += value.length; return String(count);
        } });
        const pending = handler(request(incoming.body, { signal: aborter.signal,
            ...(kind === 'deadline' ? { headers: { 'grpc-timeout': '25m' } } : {}) }));
        await until(() => incoming.pulls === 1);
        if (kind === 'abort') aborter.abort();
        const result = await observe(await pending);
        await until(() => !incoming.body.locked);
        assert.equal(result.status.code, kind === 'abort' ? 1 : 4);
        assert.equal(context.signal.aborted, true); assert.equal(incoming.cancels, 1);
        assert.deepEqual((await observe(await handler(request(frames('ok'))))).messages, ['2']);
    }
});

test('SERVER UPLOAD response cancellation interrupts a pending input next and returns output once', async () => {
    const incoming = source(); let context, outputReturns = 0, pendingInput;
    const handler = createGrpcWebHandler({ call: { ...method, responseStream: true } }, { call(input, ctx) {
        context = ctx; let first = true;
        return { [Symbol.asyncIterator]() { return this; }, async next() {
            if (first) { first = false; return { value: 'ready', done: false }; }
            pendingInput = input.next(); return pendingInput;
        }, async return() { outputReturns++; return { done: true }; } };
    } });
    const response = await handler(request(incoming.body)); const reader = response.body.getReader();
    await reader.read(); const blocked = reader.read(); await until(() => incoming.pulls === 1);
    await reader.cancel(); await blocked; await assert.rejects(pendingInput);
    await until(() => !incoming.body.locked);
    assert.equal(context.signal.aborted, true); assert.equal(outputReturns, 1); assert.equal(incoming.cancels, 1);
    reader.releaseLock();
});

test('SERVER UPLOAD request framing/deserialization errors remain terminal even when the handler catches them', async () => {
    const variants = [[Buffer.from([0, 0]), 13], [encodeFrame(Buffer.from('grpc-status: 0\r\n'), true), 3],
        [frames('oversized'), 8], [frames('bad'), 3]];
    for (const [body, code] of variants) {
        const handler = createGrpcWebHandler({ call: { ...method, requestDeserialize(bytes) {
            if (bytes.toString() === 'bad') throw new Error('private'); return bytes.toString();
        } } }, { async call(input) { try { for await (const ignored of input) {} } catch {} return 'swallowed'; } }, { maxReceiveMessageBytes: 4 });
        const result = await observe(await handler(request(body)));
        assert.equal(result.status.code, code); assert.deepEqual(result.messages, []);
        assert.equal(result.status.details.includes('private'), false);
    }
});

test('SERVER UPLOAD handles compressed messages independently and enforces each decoded limit', async () => {
    for (const [compression, encoding] of [[1, 'deflate'], [2, 'gzip']]) {
        const handler = createGrpcWebHandler({ call: method }, { async call(input) {
            const values = []; for await (const value of input) values.push(value); return values.join('|');
        } }, { compression, maxReceiveMessageBytes: 8 });
        const body = Buffer.concat(await Promise.all(['aaa', 'bbbb'].map(value => encodeMessageFrame(Buffer.from(value), encoding, 1024))));
        const result = await observe(await handler(request(body, { headers: { 'grpc-encoding': encoding, 'grpc-accept-encoding': encoding } })));
        assert.equal(result.status.code, 0); assert.deepEqual(result.messages, ['aaa|bbbb']);
        const bad = await encodeMessageFrame(Buffer.alloc(9), encoding, 1024);
        assert.equal((await observe(await handler(request(bad, { headers: { 'grpc-encoding': encoding } })))).status.code, 8);
    }
});

test('SERVER UPLOAD overlapping reads fail without accumulating unresolved next operations', async () => {
    const incoming = source();
    const handler = createGrpcWebHandler({ call: method }, { async call(input) {
        const outcomes = await Promise.allSettled([input.next(), input.next()]);
        assert.equal(outcomes[1].status, 'rejected'); return 'invalid';
    } });
    const result = await observe(await handler(request(incoming.body)));
    await until(() => !incoming.body.locked);
    assert.equal(result.status.code, 13); assert.equal(result.status.details, 'WGA_SERVER_REQUEST_CONCURRENT_READ');
    assert.equal(incoming.cancels, 1);
});

test('SERVER UPLOAD deadline interrupts blocked output without pulling input and disposes late iterators', async () => {
    const incoming = source(); let context, returned = 0, release;
    const wait = new Promise(resolve => { release = resolve; });
    const handler = createGrpcWebHandler({ call: { ...method, responseStream: true } }, { call(input, ctx) {
        context = ctx;
        return { [Symbol.asyncIterator]() { return this; }, next: () => wait,
            async return() { returned++; return { done: true }; } };
    } });
    const response = await handler(request(incoming.body, { headers: { 'grpc-timeout': '20m' } }));
    const result = await observe(response);
    assert.equal(result.status.code, 4); assert.equal(context.signal.aborted, true);
    assert.equal(incoming.pulls, 0); assert.equal(incoming.cancels, 1); assert.equal(returned, 1);
    release({ done: false, value: 'late' }); await turn(); assert.equal(returned, 1);
});

test('SERVER UPLOAD pre-aborted requests preserve cancellation for all handler kinds', async () => {
    for (const requestStream of [false, true]) {
        const aborter = new AbortController(); aborter.abort(); let calls = 0;
        const incoming = source();
        const handler = createGrpcWebHandler({ call: { ...method, requestStream } }, { call() { calls++; return 'wrong'; } });
        const result = await observe(await handler(request(incoming.body, { signal: aborter.signal })));
        assert.equal(result.status.code, 1); assert.equal(calls, 0); assert.equal(incoming.cancels, 1);
    }
});

test('SERVER UPLOAD consumed input failures interrupt output even if application code catches and blocks', async () => {
    let context, finished = false, release;
    const waiting = new Promise(resolve => { release = resolve; });
    const handler = createGrpcWebHandler({ call: { ...method, responseStream: true } }, { async *call(input, ctx) {
        context = ctx;
        try {
            try { for await (const value of input) {} } catch {}
            await waiting;
            yield 'must-not-escape';
        } finally { finished = true; }
    } });
    const result = await observe(await handler(request(Buffer.from([0, 0]))));
    assert.equal(result.status.code, 13); assert.equal(context.signal.aborted, true); assert.deepEqual(result.messages, []);
    release(); await until(() => finished);
});
