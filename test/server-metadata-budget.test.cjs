'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Metadata, makeGenericClientConstructor, credentials, status, compressionAlgorithms } = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { createGrpcWebHandler, GrpcWebServerError } = require('../dist/server.js');
const { METADATA_LIMIT, encodeFrame, decodeFrames, parseTrailers, metadataFromHeaders, requestHeaders } = require('../dist/wire.js');
const unary = { path: '/fixture.Metadata/Echo', requestStream: false, responseStream: false,
    requestSerialize: value => value, requestDeserialize: value => value,
    responseSerialize: value => value, responseDeserialize: value => value };
const Echo = makeGenericClientConstructor({ echo: unary }, 'Metadata');
// Independent oracle: account for the exact encoded field values, with one
// 32-byte field overhead per entry. Do not use the production budget helper.
const budget = entries => Array.from(entries).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value) + 32, 0);
const metadata = (key, value) => { const result = new Metadata(); result.set(key, value); return result; };

async function observe(handler, value = Buffer.from('request'), headers = {}) {
    const response = await handler(new Request(`https://server.test${unary.path}`, {
        method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', ...headers }, body: encodeFrame(value),
    }));
    assert.ok(budget(response.headers) <= METADATA_LIMIT);
    const initial = metadataFromHeaders(response.headers), messages = [], trailers = [];
    for await (const frame of decodeFrames(response.body, 1024, undefined, { encoding: response.headers.get('grpc-encoding') ?? 'identity' })) {
        if (!frame.trailer) { messages.push(frame.payload); continue; }
        const entries = frame.payload.toString('ascii').trimEnd().split('\r\n').map(line => {
            const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()];
        });
        assert.ok(budget(entries) <= METADATA_LIMIT);
        trailers.push(parseTrailers(frame.payload));
    }
    assert.equal(trailers.length, 1);
    return { initial, messages, status: trailers[0] };
}

test('SERVER final trailer budget includes grpc-status and grpc-message at the exact boundary', async () => {
    const maximum = METADATA_LIMIT - budget([['grpc-status', '0'], ['grpc-message', ''], ['x', '']]);
    for (const length of [maximum - 1, maximum, maximum + 1, 65470]) {
        const handler = createGrpcWebHandler({ echo: unary }, { echo(value, context) {
            context.setTrailer(metadata('x', 'a'.repeat(length))); return value;
        } });
        const result = await observe(handler);
        assert.equal(result.status.code, length <= maximum ? status.OK : status.RESOURCE_EXHAUSTED);
        if (length <= maximum) assert.equal(result.status.metadata.get('x')[0].length, length);
        else {
            assert.equal(result.status.details, 'WGA_SERVER_METADATA_SIZE');
            assert.deepEqual(result.status.metadata.getMap(), {});
        }
    }
});

test('SERVER final initial metadata budget reserves response control fields and rejects merged overflow', async () => {
    for (const encoding of ['identity', 'gzip']) {
        const maximum = METADATA_LIMIT - budget([['content-type', 'application/grpc-web+proto'],
            ['grpc-accept-encoding', 'identity,deflate,gzip'], ['grpc-encoding', encoding], ['x', '']]);
        for (const length of [maximum, maximum + 1]) {
            const handler = createGrpcWebHandler({ echo: unary }, { echo(value, context) {
                context.sendMetadata(metadata('x', 'a'.repeat(length))); return value;
            } }, { compression: compressionAlgorithms.gzip });
            const result = await observe(handler, undefined, { 'grpc-accept-encoding': encoding });
            assert.equal(result.status.code, length === maximum ? status.OK : status.RESOURCE_EXHAUSTED);
            assert.equal(result.initial.get('x').length, length === maximum ? 1 : 0);
        }
        const merged = createGrpcWebHandler({ echo: unary }, { echo(value, context) {
            context.sendMetadata(metadata('x', 'a'.repeat(maximum)));
            context.sendMetadata(metadata('y', 'overflow')); return value;
        } }, { compression: compressionAlgorithms.gzip });
        const result = await observe(merged, undefined, { 'grpc-accept-encoding': encoding });
        assert.equal(result.status.code, status.RESOURCE_EXHAUSTED);
        assert.equal(result.initial.get('x')[0].length, maximum, 'previous valid metadata remains readable');
        assert.deepEqual(result.initial.get('y'), []);
    }
});

test('SERVER budgets binary base64 and percent-encoded details including error fallback after stream data', async () => {
    const binaryMaximum = Math.floor((METADATA_LIMIT - budget([['grpc-status', '7'], ['grpc-message', ''], ['x-bin', '']])) / 4) * 3;
    for (const length of [binaryMaximum, binaryMaximum + 1]) {
        const handler = createGrpcWebHandler({ echo: unary }, { echo() {
            throw new GrpcWebServerError(status.PERMISSION_DENIED, '', metadata('x-bin', Buffer.alloc(length, 255)));
        } });
        const result = await observe(handler);
        assert.equal(result.status.code, length === binaryMaximum ? status.PERMISSION_DENIED : status.RESOURCE_EXHAUSTED);
        if (length === binaryMaximum) assert.equal(result.status.metadata.get('x-bin')[0].length, length);
    }
    const encodedMaximum = METADATA_LIMIT - budget([['grpc-status', '7'], ['grpc-message', '']]);
    const characters = Math.floor(encodedMaximum / encodeURIComponent('한').length);
    for (const streamed of [false, true]) for (const length of [characters, characters + 1]) {
        const details = '한'.repeat(length);
        const handler = createGrpcWebHandler({ echo: { ...unary, responseStream: streamed } }, { echo: streamed
            ? async function* () { yield Buffer.from('first'); throw new GrpcWebServerError(status.PERMISSION_DENIED, details); }
            : () => { throw new GrpcWebServerError(status.PERMISSION_DENIED, details); } });
        const result = await observe(handler);
        assert.equal(result.status.code, length === characters ? status.PERMISSION_DENIED : status.RESOURCE_EXHAUSTED);
        assert.equal(result.status.details, length === characters ? details : 'WGA_SERVER_METADATA_SIZE');
        assert.equal(result.messages.length, streamed ? 1 : 0);
    }
});

test('SERVER final error trailer accounts for previously accepted metadata and application error metadata together', async () => {
    const maximum = METADATA_LIMIT - budget([['grpc-status', '0'], ['grpc-message', ''], ['x', '']]);
    for (const streamed of [false, true]) {
        function reject(context) {
            context.setTrailer(metadata('x', 'a'.repeat(maximum)));
            throw new GrpcWebServerError(status.PERMISSION_DENIED, '', metadata('y', 'overflow'));
        }
        const handler = createGrpcWebHandler({ echo: { ...unary, responseStream: streamed } }, { echo: streamed
            ? async function* (_value, context) { yield Buffer.from('first'); reject(context); }
            : (_value, context) => reject(context) });
        const result = await observe(handler);
        assert.equal(result.status.code, status.RESOURCE_EXHAUSTED);
        assert.equal(result.status.details, 'WGA_SERVER_METADATA_SIZE');
        assert.deepEqual(result.status.metadata.getMap(), {});
        assert.equal(result.messages.length, streamed ? 1 : 0);
    }
});

test('SERVER oversized metadata returns a readable gRPC error and the same client recovers', async () => {
    const handler = createGrpcWebHandler({ echo: unary }, { echo(value, context) {
        if (value.toString() === 'large') context.setTrailer(metadata('x', 'a'.repeat(65470)));
        return value;
    } });
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'server.test': 'https://server.test' },
        fetcher: { fetch: (url, init) => handler(new Request(url, init)) } });
    const client = new Echo('server.test', credentials.createSsl(), transport.grpcOptions());
    const invoke = value => new Promise(resolve => client.echo(Buffer.from(value), (error, response) => resolve({ error, response })));
    try {
        const rejected = await invoke('large');
        assert.equal(rejected.error.code, status.RESOURCE_EXHAUSTED);
        assert.equal(rejected.error.details, 'WGA_SERVER_METADATA_SIZE');
        const recovered = await invoke('small');
        assert.equal(recovered.error, null);
        assert.equal(recovered.response.toString(), 'small');
        assert.equal(client.getChannel().activeCallCount(), 0);
    } finally { client.close(); }
});

test('WIRE request budget includes final control fields and binary base64 expansion', () => {
    const controls = requestHeaders(new Metadata(), 100, 'fixture-agent');
    const maximum = METADATA_LIMIT - budget(controls) - budget([['x', '']]);
    assert.equal(budget(requestHeaders(metadata('x', 'a'.repeat(maximum)), 100, 'fixture-agent')), METADATA_LIMIT);
    assert.throws(() => requestHeaders(metadata('x', 'a'.repeat(maximum + 1)), 100, 'fixture-agent'),
        error => error.code === status.RESOURCE_EXHAUSTED);
    const binaryMaximum = Math.floor((METADATA_LIMIT - budget(controls) - budget([['x-bin', '']])) / 4) * 3;
    assert.ok(budget(requestHeaders(metadata('x-bin', Buffer.alloc(binaryMaximum)), 100, 'fixture-agent')) <= METADATA_LIMIT);
    assert.throws(() => requestHeaders(metadata('x-bin', Buffer.alloc(binaryMaximum + 1)), 100, 'fixture-agent'),
        error => error.code === status.RESOURCE_EXHAUSTED);
});
