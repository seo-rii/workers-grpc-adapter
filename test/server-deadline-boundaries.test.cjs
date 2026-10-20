'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler, GrpcWebServerError } = require('../dist/server.js');
const { Metadata, status } = require('../dist/index.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');

const method = { path: '/fixture.Deadline/Call', requestStream: false, responseStream: false,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };
const payload = Buffer.from('message');
function request(body = encodeFrame(payload), extra = {}) {
    return new Request(`https://server.test${method.path}`, { method: 'POST', body,
        headers: { 'content-type': 'application/grpc-web+proto', 'grpc-timeout': '1000m', ...extra.headers },
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}), signal: extra.signal });
}
async function observed(response) {
    const messages = [], trailers = [];
    for await (const frame of decodeFrames(response.body, 1024)) {
        if (frame.trailer) trailers.push(parseTrailers(frame.payload));
        else messages.push(frame.payload.toString());
    }
    assert.equal(trailers.length, 1, 'Exactly one terminal status');
    return { messages, terminal: trailers[0] };
}
async function withClock(work) {
    const saved = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const base = 1700000000000, timers = new Set();
    let now = base;
    Date.now = () => now;
    // Deliberately withhold timer callbacks, as when synchronous work or a
    // microtask chain prevents an overdue timer from getting an event-loop turn.
    globalThis.setTimeout = callback => { const timer = { callback }; timers.add(timer); return timer; };
    globalThis.clearTimeout = timer => timers.delete(timer);
    try {
        await work({ expire() { now = base + 1000; }, timers });
        assert.equal(timers.size, 0, 'Terminal response releases its deadline timer');
    } finally {
        Date.now = saved.now;
        globalThis.setTimeout = saved.setTimeout;
        globalThis.clearTimeout = saved.clearTimeout;
    }
}
function expired(result, messages = []) {
    assert.deepEqual(result.messages, messages);
    assert.equal(result.terminal.code, status.DEADLINE_EXCEEDED);
    assert.equal(result.terminal.details, 'WGA_SERVER_DEADLINE');
}

for (const boundary of ['deserialize', 'handler-microtask']) {
    test(`SERVER deadline prevents handler startup after ${boundary}`, async () => withClock(async clock => {
        let calls = 0, deserialized = 0;
        const handle = createGrpcWebHandler({ call: { ...method, requestDeserialize(bytes) {
            deserialized++;
            if (boundary === 'deserialize') clock.expire();
            else queueMicrotask(() => clock.expire());
            return bytes;
        } } }, { call(value) { calls++; return value; } });
        const result = await observed(await handle(request()));
        expired(result);
        assert.equal(deserialized, 1);
        assert.equal(calls, 0);
    }));
}

for (const completion of ['value', 'throw', 'iterator']) {
    test(`SERVER rejects handler ${completion} settled after its deadline`, async () => withClock(async clock => {
        let context, serialized = 0, next = 0, returned = 0;
        const handle = createGrpcWebHandler({ call: { ...method, responseStream: completion === 'iterator',
            responseSerialize(bytes) { serialized++; return bytes; } } }, { call(value, ctx) {
            context = ctx;
            clock.expire();
            if (completion === 'throw') throw new GrpcWebServerError(status.PERMISSION_DENIED, 'late denial');
            if (completion === 'value') return value;
            return { [Symbol.asyncIterator]() { return this; },
                async next() { return next++ === 0 ? { done: false, value } : { done: true }; },
                async return() { returned++; return { done: true }; } };
        } });
        expired(await observed(await handle(request())));
        assert.equal(context.signal.aborted, true);
        assert.equal(serialized, 0);
        assert.equal(next, 0, 'Do not start an output read after expiration');
        assert.equal(returned, Number(completion === 'iterator'), 'Dispose late iterator exactly once');
    }));
}

for (const boundary of ['first-value', 'first-done', 'next-value', 'next-done', 'serialize']) {
    test(`SERVER rejects expired ${boundary} without publishing a late message or OK`, async () => withClock(async clock => {
        let context, next = 0, returned = 0;
        const handle = createGrpcWebHandler({ call: { ...method, responseStream: true,
            responseSerialize(bytes) { if (boundary === 'serialize') clock.expire(); return bytes; } } }, {
            call(value, ctx) {
                context = ctx;
                return { [Symbol.asyncIterator]() { return this; },
                    async next() {
                        const index = next++;
                        if (index > 1) return { done: true };
                        if (boundary.startsWith(index === 0 ? 'first-' : 'next-')) {
                            clock.expire();
                            return boundary.endsWith('-done') ? { done: true } : { done: false, value };
                        }
                        return index === 0 ? { done: false, value } : { done: true };
                    },
                    async return() { returned++; return { done: true }; } };
            },
        });
        expired(await observed(await handle(request())), boundary.startsWith('next-') ? ['message'] : []);
        assert.equal(context.signal.aborted, true);
        assert.equal(returned, 1);
        assert.equal(next, boundary.startsWith('next-') ? 2 : 1);
    }));
}

for (const boundary of ['before-read', 'chunk', 'fragment', 'deserialize']) {
    test(`SERVER input ${boundary} respects deadline without delivering an expired request`, async () => withClock(async clock => {
        let pulls = 0, cancels = 0, deserialized = 0, delivered = 0, context, readError;
        const body = new ReadableStream({
            pull(controller) {
                pulls++;
                if (boundary === 'chunk' || boundary === 'fragment') clock.expire();
                controller.enqueue(boundary === 'fragment' ? encodeFrame(payload).subarray(0, 1) : encodeFrame(payload));
                if (boundary !== 'fragment') controller.close();
                else if (pulls === 2) controller.close();
            },
            cancel() { cancels++; },
        }, { highWaterMark: 0 });
        const handle = createGrpcWebHandler({ call: { ...method, requestStream: true, requestDeserialize(bytes) {
            deserialized++;
            if (boundary === 'deserialize') clock.expire();
            return bytes;
        } } }, { async call(input, ctx) {
            context = ctx;
            if (boundary === 'before-read') clock.expire();
            try { await input.next(); delivered++; } catch (error) { readError = error; }
            return payload;
        } });
        expired(await observed(await handle(request(body))));
        assert.equal(context.signal.aborted, true);
        assert.equal(delivered, 0);
        assert.equal(readError.code, status.DEADLINE_EXCEEDED);
        assert.equal(deserialized, Number(boundary === 'deserialize'));
        assert.equal(pulls, Number(boundary !== 'before-read'), 'Do not start another read after expiration');
        assert.equal(body.locked, false);
        assert.equal(cancels, Number(boundary === 'before-read' || boundary === 'fragment'));
    }));
}

for (const published of [false, true]) {
    test(`SERVER deadline during response backpressure preserves ${published ? 'partial output' : 'buffered output boundary'}`, async () => withClock(async clock => {
        let next = 0, serialized = 0, returned = 0, context;
        const handle = createGrpcWebHandler({ call: { ...method, responseStream: true,
            responseSerialize(bytes) { serialized++; return bytes; } } }, { call(value, ctx) {
            context = ctx;
            const trailing = new Metadata(); trailing.set('x-receipt', 'known'); ctx.setTrailer(trailing);
            return { [Symbol.asyncIterator]() { return this; },
                async next() { next++; return { done: false, value }; },
                async return() { returned++; return { done: true }; } };
        } });
        const response = await handle(request());
        const frames = decodeFrames(response.body, 1024)[Symbol.asyncIterator]();
        if (published) assert.equal((await frames.next()).value.payload.toString(), 'message');
        clock.expire();
        const terminal = await frames.next();
        assert.equal(terminal.value.trailer, true);
        const result = parseTrailers(terminal.value.payload);
        assert.equal(result.code, status.DEADLINE_EXCEEDED);
        assert.deepEqual(result.metadata.get('x-receipt'), ['known']);
        assert.equal((await frames.next()).done, true);
        assert.equal(context.signal.aborted, true);
        assert.equal(next, 1, 'Do not pull the disposed output iterator');
        assert.equal(serialized, Number(published));
        assert.equal(returned, 1);
    }));
}

test('SERVER deadline during unread-input cleanup cannot publish an OK trailer', async () => withClock(async clock => {
    let cancels = 0, context;
    const body = new ReadableStream({ cancel() { cancels++; clock.expire(); } }, { highWaterMark: 0 });
    const handle = createGrpcWebHandler({ call: { ...method, requestStream: true } }, {
        call(_input, ctx) { context = ctx; return payload; },
    });
    expired(await observed(await handle(request(body))), ['message']);
    assert.equal(cancels, 1);
    assert.equal(context.signal.aborted, true);
    assert.equal(body.locked, false);
}));

for (const boundary of ['handler', 'serialize']) {
    test(`SERVER cancellation already selected during ${boundary} wins over a later deadline`, async () => withClock(async clock => {
        const controller = new AbortController();
        const cancel = () => { controller.abort(); clock.expire(); };
        const handle = createGrpcWebHandler({ call: { ...method,
            responseSerialize(value) { if (boundary === 'serialize') cancel(); return value; } } }, {
            call(value) {
                if (boundary === 'handler') { cancel(); throw new Error('private failure after cancellation'); }
                return value;
            },
        });
        const result = await observed(await handle(request(undefined, { signal: controller.signal })));
        assert.deepEqual(result.messages, []);
        assert.equal(result.terminal.code, status.CANCELLED);
        assert.equal(result.terminal.details, 'WGA_SERVER_CANCELLED');
    }));
}

test('SERVER selected input failure remains sticky after clock expiry', async () => withClock(async clock => {
    const handle = createGrpcWebHandler({ call: { ...method, requestStream: true,
        requestDeserialize() { throw new Error('private parse failure'); } } }, { async call(input) {
        await assert.rejects(input.next(), { code: status.INVALID_ARGUMENT });
        clock.expire();
        return payload;
    } });
    const result = await observed(await handle(request()));
    assert.deepEqual(result.messages, []);
    assert.equal(result.terminal.code, status.INVALID_ARGUMENT);
    assert.equal(result.terminal.details, 'WGA_SERVER_DESERIALIZE');
}));

for (const requestStream of [false, true]) for (const responseStream of [false, true]) {
    test(`SERVER active deadline preserves valid requestStream=${requestStream}, responseStream=${responseStream}`, async () => withClock(async () => {
        let context;
        const handle = createGrpcWebHandler({ call: { ...method, requestStream, responseStream } }, { async call(input, ctx) {
            context = ctx;
            const initial = new Metadata(); initial.set('x-initial', 'ready'); ctx.sendMetadata(initial);
            const trailing = new Metadata(); trailing.set('x-receipt', 'known'); ctx.setTrailer(trailing);
            let value = input;
            if (requestStream) { value = (await input.next()).value; assert.equal((await input.next()).done, true); }
            return responseStream ? (async function* () { yield value; })() : value;
        } });
        const response = await handle(request());
        const result = await observed(response);
        assert.equal(response.headers.get('x-initial'), 'ready');
        assert.deepEqual(result.messages, ['message']);
        assert.equal(result.terminal.code, status.OK);
        assert.deepEqual(result.terminal.metadata.get('x-receipt'), ['known']);
        assert.equal(context.signal.aborted, false);
    }));
}
