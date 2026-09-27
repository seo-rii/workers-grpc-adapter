'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createGrpcWebHandler, GrpcWebServerError } = require('../dist/server.js');
const { Metadata, status } = require('../dist/index.js');
const { encodeFrame, encodeMessageFrame, decodeFrames, parseTrailers, metadataFromHeaders, statusFromHeaders } = require('../dist/wire.js');
const nativeRequire = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const unary = { path: '/fixture.Server/Echo', requestStream: false, responseStream: false,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes, requestSerialize: bytes => bytes, responseDeserialize: bytes => bytes };
const stream = { ...unary, path: '/fixture.Server/Stream', responseStream: true };
const definition = { echo: unary, stream };
function request(body = encodeFrame(Buffer.from('request')), { path = unary.path, headers = {}, signal } = {}) {
    return new Request(`https://server.test${path}`, { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', ...headers },
        body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}), signal });
}
async function observe(response) {
    const messages = [], trailers = [];
    for await (const item of decodeFrames(response.body, 1024 * 1024, undefined, {
        encoding: response.headers.get('grpc-encoding') ?? 'identity', maxWireBytes: 1024 * 1024,
    })) {
        if (item.trailer) trailers.push(parseTrailers(item.payload));
        else messages.push(item.payload);
    }
    assert.equal(trailers.length, 1);
    return { messages, status: trailers[0], headers: response.headers };
}
const echo = (value) => value;

test('SERVER registers immutable exact routes and rejects unsupported or unsafe definitions', async () => {
    for (const value of [null, {}, { echo: { ...unary, path: '/wrong' } }, { echo: { ...unary, requestStream: true } },
        { echo: unary, duplicate: unary }, JSON.parse('{"__proto__": {}}')]) {
        assert.throws(() => createGrpcWebHandler(value, { echo }), /WGA|gRPC-Web/);
    }
    assert.throws(() => createGrpcWebHandler({ echo: unary }, Object.create({ echo })), { code: 'WGA_SERVER_CONFIG' });
    for (const options of [{ compression: 3 }, { compression: null }, { maxWireMessageBytes: -1 }, { maxSendMessageBytes: Infinity },
        { defaultTimeoutMs: -1 }, { unexpected: true }]) assert.throws(() => createGrpcWebHandler({ echo: unary }, { echo }, options), { code: 'WGA_SERVER_CONFIG' });
    const mutable = { echo: { ...unary } }, handlers = { echo };
    const handler = createGrpcWebHandler(mutable, handlers);
    mutable.echo.path = '/changed'; handlers.echo = () => { throw new Error('should not run'); };
    assert.equal((await observe(await handler(request()))).messages[0].toString(), 'request');
    for (const name of ['/constructor', '/__proto__', '/toString', `${unary.path}?unexpected=1`]) {
        assert.equal((await observe(await handler(request(undefined, { path: name })))).status.code, status.UNIMPLEMENTED);
    }
});

test('SERVER enforces binary POST and cancels rejected request bodies', async () => {
    const handler = createGrpcWebHandler({ echo: unary }, { echo });
    assert.equal((await handler(new Request(`https://server.test${unary.path}`))).status, 405);
    for (const type of ['application/grpc', 'application/grpc-web-text', 'application/json']) {
        let cancelled = 0;
        const body = new ReadableStream({ cancel() { cancelled++; } });
        const response = await handler(request(body, { headers: { 'content-type': type } }));
        assert.equal(response.status, 415);
        assert.equal(cancelled, 1);
    }
    for (const type of ['application/grpc-web', 'application/grpc-web+proto; charset=utf-8']) {
        const response = await handler(request(undefined, { headers: { 'content-type': type } }));
        assert.equal(response.headers.get('content-type'), type.split(';')[0]);
        assert.equal((await observe(response)).status.code, 0);
    }
});

test('SERVER requires exactly one complete request message before invoking user code', async () => {
    let calls = 0;
    const handler = createGrpcWebHandler({ echo: unary }, { echo(value) { calls++; return value; } }, { maxReceiveMessageBytes: 8, maxWireMessageBytes: 64 });
    for (const [body, code] of [[Buffer.alloc(0), 3], [Buffer.from([0, 0]), 13], [encodeFrame(Buffer.alloc(9)), 8],
        [Buffer.concat([encodeFrame(Buffer.from('first')), encodeFrame(Buffer.from('second'))]), 3],
        [encodeFrame(Buffer.from('grpc-status: 0\r\n'), true), 3],
        [Buffer.concat([encodeFrame(Buffer.from('first')), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), 3]]) {
        const result = await observe(await handler(request(body)));
        assert.equal(result.status.code, code);
        assert.equal(result.messages.length, 0);
    }
    assert.equal(calls, 0);
    const result = await observe(await handler(request(encodeFrame(Buffer.alloc(0)))));
    assert.equal(result.status.code, 0);
    assert.equal(result.messages[0].length, 0);
    assert.equal(calls, 1);
});

test('SERVER accepts compressed requests and negotiates bounded response compression', async () => {
    for (const [algorithm, encoding] of [[1, 'deflate'], [2, 'gzip']]) {
        const handler = createGrpcWebHandler({ echo: unary }, { echo }, { compression: algorithm, maxReceiveMessageBytes: 1024,
            maxSendMessageBytes: 1024, maxWireMessageBytes: 2048 });
        const payload = Buffer.alloc(1024, 65);
        const body = await encodeMessageFrame(payload, encoding, 2048);
        const response = await handler(request(body, { headers: { 'grpc-encoding': encoding, 'grpc-accept-encoding': `identity,${encoding}` } }));
        assert.equal(response.headers.get('grpc-encoding'), encoding);
        assert.deepEqual((await observe(response)).messages, [payload]);
        const identity = await handler(request(undefined, { headers: { 'grpc-accept-encoding': 'identity' } }));
        assert.equal(identity.headers.get('grpc-encoding'), 'identity');
        await observe(identity);
        const bad = Buffer.from(body); bad[bad.length - 1] ^= 128;
        assert.equal((await observe(await handler(request(bad, { headers: { 'grpc-encoding': encoding } })))).status.code, 13);
        const bomb = await encodeMessageFrame(Buffer.alloc(1025, 65), encoding, 2048);
        assert.equal((await observe(await handler(request(bomb, { headers: { 'grpc-encoding': encoding } })))).status.code, 8);
        const oversized = createGrpcWebHandler({ echo: unary }, { echo: () => Buffer.alloc(1025) }, { maxSendMessageBytes: 1024 });
        assert.equal((await observe(await oversized(request()))).status.code, 8);
    }
});

test('SERVER exposes only intentional status details and validates outgoing metadata', async () => {
    const details = 'Permission denied: 한글 % value';
    const trailing = new Metadata(); trailing.set('trace-bin', Buffer.from([0, 128, 255])); trailing.set('x-result', 'denied');
    const rejected = createGrpcWebHandler({ echo: unary }, { echo() { throw new GrpcWebServerError(7, details, trailing); } });
    const result = await observe(await rejected(request()));
    assert.equal(result.status.code, 7); assert.equal(result.status.details, details);
    assert.deepEqual(result.status.metadata.get('trace-bin'), [Buffer.from([0, 128, 255])]);
    for (const thrower of [() => { throw Object.assign(new Error('secret should not escape'), { code: 7, details: 'secret detail' }); },
        async function* () { yield Buffer.from('first'); throw new Error('secret iterator failure'); }]) {
        const streaming = thrower.constructor.name === 'AsyncGeneratorFunction';
        const handler = createGrpcWebHandler({ echo: { ...unary, responseStream: streaming } }, { echo: thrower });
        const observed = await observe(await handler(request()));
        assert.equal(observed.status.code, 13);
        assert.equal(observed.status.details, 'WGA_SERVER_HANDLER');
    }
    for (const key of ['grpc-status', 'grpc-message', 'grpc-encoding', 'content-type', 'content-encoding', ':status']) {
        const handler = createGrpcWebHandler({ echo: unary }, { echo(value, context) {
            const headers = new Metadata(); headers.set(key, 'malicious'); context.sendMetadata(headers); return value;
        } });
        assert.equal((await observe(await handler(request()))).status.details, 'WGA_SERVER_METADATA');
    }
});

test('SERVER streaming pulls at most one item ahead and invokes iterator return on cancellation', async () => {
    let produced = 0, finalized = false, signal;
    const handler = createGrpcWebHandler({ stream }, { async *stream(_value, context) {
        signal = context.signal;
        try { for (let i = 0; i < 100; i++) { produced++; yield Buffer.from(String(i)); } }
        finally { finalized = true; }
    } });
    const response = await handler(request(undefined, { path: stream.path }));
    assert.equal(produced, 1);
    await turn(); assert.equal(produced, 1);
    const reader = response.body.getReader();
    await reader.read(); assert.equal(produced, 1);
    await turn(); assert.equal(produced, 1);
    await reader.read(); assert.equal(produced, 2);
    await reader.cancel(); await turn();
    assert.equal(signal.aborted, true); assert.equal(finalized, true); assert.equal(produced, 2);
    reader.releaseLock();
});

test('SERVER deadlines and caller cancellation stop pending work and contain late completion', async () => {
    for (const kind of ['deadline', 'cancel']) {
        let entered, release, returned = false, signal;
        const started = new Promise(resolve => { entered = resolve; });
        const pending = new Promise(resolve => { release = resolve; });
        const handler = createGrpcWebHandler({ stream }, { async *stream(_input, context) {
            signal = context.signal; entered();
            try { await pending; yield Buffer.from('late'); }
            finally { returned = true; }
        } });
        const controller = new AbortController();
        const response = handler(request(undefined, { path: stream.path, signal: controller.signal,
            headers: kind === 'deadline' ? { 'grpc-timeout': '10m' } : {} }));
        await started;
        if (kind === 'cancel') controller.abort();
        assert.equal((await observe(await response)).status.code, kind === 'deadline' ? 4 : 1);
        assert.equal(signal.aborted, true);
        release(); await turn(); await turn();
        assert.equal(returned, true);
    }
});

test('SERVER validates timeout grammar, clamps extreme values and removes completed-call timers', async () => {
    const active = new Set();
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => { const timer = originalSet(fn, delay, ...args); active.add(timer); return timer; };
    globalThis.clearTimeout = timer => { active.delete(timer); return originalClear(timer); };
    try {
        let deadline;
        const handler = createGrpcWebHandler({ echo: unary }, { echo(value, context) { deadline = context.deadline; return value; } }, { defaultTimeoutMs: 10000 });
        for (const timeout of ['100000u', '100000000n', '-1S', '1.5S', '1s', '1S,2S', '']) {
            const result = await observe(await handler(request(undefined, { headers: { 'grpc-timeout': timeout } })));
            if (timeout === '100000u') assert.equal(result.status.code, 0);
            else assert.equal(result.status.code, 3);
            assert.equal(active.size, 0);
        }
        const before = Date.now();
        await observe(await handler(request(undefined, { headers: { 'grpc-timeout': '99999999H' } })));
        const duration = 99999999 * 3600000;
        assert.ok(deadline >= before + duration && deadline <= Date.now() + duration);
        assert.equal(active.size, 0);
        const clamped = createGrpcWebHandler({ echo: unary }, { echo(value, context) { deadline = context.deadline; return value; } }, { defaultTimeoutMs: Number.MAX_SAFE_INTEGER });
        await observe(await clamped(request()));
        assert.equal(deadline, Number.MAX_SAFE_INTEGER);
        assert.equal(active.size, 0);
        await observe(await handler(request()));
        assert.equal(active.size, 0);
    } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; for (const timer of active) originalClear(timer); }
});

test('SERVER disposes an iterator returned by a handler promise after its deadline', async () => {
    let release, next = 0, returned = 0;
    const pending = new Promise(resolve => { release = resolve; });
    const handler = createGrpcWebHandler({ stream }, { async stream() {
        await pending;
        return { [Symbol.asyncIterator]() { return this; },
            async next() { next++; return { done: false, value: Buffer.from('late') }; },
            async return() { returned++; return { done: true }; },
        };
    } });
    const response = await handler(request(undefined, { path: stream.path, headers: { 'grpc-timeout': '10m' } }));
    assert.equal((await observe(response)).status.code, 4);
    release(); await turn(); await turn();
    assert.equal(next, 0);
    assert.equal(returned, 1);
});

test('SERVER unary and stream bytes/status/metadata match an actual pinned native grpc-js server', async () => {
    assert.equal(nativeRequire('@grpc/grpc-js/package.json').version, '1.14.0');
    const nativeServer = new native.Server();
    nativeServer.addService(definition, {
        echo(call, callback) { const initial = new native.Metadata(); initial.set('x-initial', 'fixture'); call.sendMetadata(initial);
            const end = new native.Metadata(); end.set('trace-bin', Buffer.from([0, 255])); callback(null, call.request, end); },
        stream(call) { const initial = new native.Metadata(); initial.set('x-initial', 'fixture'); call.sendMetadata(initial);
            for (let i = 0; i < 3; i++) call.write(Buffer.from(`part-${i}`));
            const end = new native.Metadata(); end.set('trace-bin', Buffer.from([0, 255])); call.end(end); },
    });
    let session;
    try {
        const port = await new Promise((resolve, reject) => nativeServer.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
        session = http2.connect(`http://127.0.0.1:${port}`);
        const decorate = context => { const initial = new Metadata(); initial.set('x-initial', 'fixture'); context.sendMetadata(initial);
            const end = new Metadata(); end.set('trace-bin', Buffer.from([0, 255])); context.setTrailer(end); };
        const handler = createGrpcWebHandler(definition, { echo(value, context) { decorate(context); return value; },
            async *stream(_value, context) { decorate(context); for (let i = 0; i < 3; i++) yield Buffer.from(`part-${i}`); } });
        for (const method of [unary, stream]) {
            const expected = await new Promise((resolve, reject) => {
                const call = session.request({ ':method': 'POST', ':path': method.path, 'content-type': 'application/grpc', te: 'trailers' });
                const chunks = []; let headers, trailers;
                call.on('response', value => { headers = value; }); call.on('trailers', value => { trailers = value; });
                call.on('data', value => chunks.push(value)); call.on('error', reject);
                call.on('end', () => resolve({ bytes: Buffer.concat(chunks), headers, trailers }));
                call.end(encodeFrame(Buffer.from('request')));
            });
            const actualResponse = await handler(request(undefined, { path: method.path }));
            const actual = await observe(actualResponse);
            assert.deepEqual(Buffer.concat(actual.messages.map(value => encodeFrame(value))), expected.bytes);
            assert.equal(actual.headers.get('x-initial'), expected.headers['x-initial']);
            const nativeStatus = statusFromHeaders(new Headers(Object.entries(expected.trailers).filter(([key]) => !key.startsWith(':'))));
            assert.equal(actual.status.code, nativeStatus.code);
            assert.deepEqual(actual.status.metadata.get('trace-bin'), nativeStatus.metadata.get('trace-bin'));
        }
    } finally { session?.destroy(); nativeServer.forceShutdown(); }
});
