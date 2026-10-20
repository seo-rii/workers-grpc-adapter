'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { createGrpcWebHandler } = require('../dist/server.js');
const { encodeFrame, decodeFrames, metadataFromHeaders, parseTrailers, statusFromHeaders, METADATA_LIMIT } = require('../dist/wire.js');

const codec = bytes => bytes;
const method = { path: '/fixture.MetadataTolerance/Call', requestStream: false, responseStream: false,
    requestDeserialize: codec, responseSerialize: codec };
const message = Buffer.from('response');

for (const [name, value] of [['HTAB', 'alpha\tbeta'], ['Latin-1', 'café']]) {
    for (const kind of ['request', 'response']) {
        test(`WIRE discards HTTP-valid ${name} metadata in ${kind} headers without losing valid fields`, () => {
            const result = metadataFromHeaders(new Headers({ 'x-invalid': value, 'x-proof': 'retained', 'proof-bin': 'AQI=' }), kind);
            assert.deepEqual(result.get('x-invalid'), []);
            assert.deepEqual(result.get('x-proof'), ['retained']);
            assert.deepEqual(result.get('proof-bin'), [Buffer.from([1, 2])]);
        });
    }
    for (const source of ['headers', 'trailers']) {
        test(`WIRE ${source} with ${name} custom metadata preserves remote status`, () => {
            const result = source === 'headers'
                ? statusFromHeaders(new Headers({ 'grpc-status': '7', 'grpc-message': 'denied', 'x-invalid': value, 'x-proof': 'retained' }))
                : parseTrailers(Buffer.from(`grpc-status: 7\r\ngrpc-message: denied\r\nx-invalid: ${value}\r\nx-proof: retained\r\n`));
            assert.equal(result.code, grpc.status.PERMISSION_DENIED);
            assert.equal(result.details, 'denied');
            assert.deepEqual(result.metadata.get('x-invalid'), []);
            assert.deepEqual(result.metadata.get('x-proof'), ['retained']);
        });
    }
    test(`SERVER accepts a request containing irrelevant ${name} metadata`, async () => {
        let calls = 0;
        const handle = createGrpcWebHandler({ call: method }, { call(input, context) {
            calls++;
            assert.deepEqual(context.metadata.get('x-invalid'), []);
            assert.deepEqual(context.metadata.get('x-proof'), ['retained']);
            return input;
        } });
        const response = await handle(new Request('https://fixture.test' + method.path, { method: 'POST',
            headers: { 'content-type': 'application/grpc-web+proto', 'x-invalid': value, 'x-proof': 'retained' },
            body: encodeFrame(message) }));
        const frames = [];
        for await (const frame of decodeFrames(response.body, 1024)) frames.push(frame);
        assert.equal(calls, 1);
        assert.deepEqual(frames[0].payload, message);
        assert.equal(parseTrailers(frames[1].payload).code, grpc.status.OK);
    });
    for (const source of ['headers', 'trailers']) {
        test(`CLIENT succeeds with irrelevant ${name} metadata in ${source}`, async () => {
            const transport = createWorkersGrpcTransport({ fetcher: { async fetch() {
                const trailers = `grpc-status: 0\r\nx-proof: retained\r\n${source === 'trailers' ? `x-invalid: ${value}\r\n` : ''}`;
                return new Response(Buffer.concat([encodeFrame(message), encodeFrame(Buffer.from(trailers), true)]),
                    { headers: { 'content-type': 'application/grpc-web+proto', ...(source === 'headers' ? { 'x-invalid': value } : {}) } });
            } } });
            const client = new grpc.Client('fixture.test', transport.channelCredentials, transport.grpcOptions());
            try {
                const result = await new Promise((resolve, reject) => client.makeUnaryRequest(method.path, codec, codec, Buffer.alloc(0),
                    (error, value) => error ? reject(error) : resolve(value)));
                assert.deepEqual(result, message);
            } finally { client.close(); }
        });
    }
}

test('WIRE incoming tolerance retains ASCII metadata and keeps outgoing validation strict', () => {
    assert.deepEqual(metadataFromHeaders(new Headers({ 'x-proof': 'alpha beta' })).get('x-proof'), ['alpha beta']);
    const metadata = new grpc.Metadata();
    for (const value of ['alpha\tbeta', 'café']) assert.throws(() => metadata.set('x-proof', value));
});

for (const [key, value, diagnostic] of [
    ['x-bad!', 'café', 'WGA_INVALID_METADATA'],
    ['x-bad', 'unsafe\0value', 'WGA_INVALID_METADATA'],
    ['x-bad', 'unsafe\x01value', 'WGA_INVALID_METADATA'],
    ['x-bad', 'unsafe\x7fvalue', 'WGA_INVALID_METADATA'],
    ['x-bad-bin', 'café', 'WGA_BINARY_METADATA'],
    ['x-bad-bin', 'AQI=, !', 'WGA_BINARY_METADATA'],
]) {
    test(`WIRE tolerant reception still rejects invalid field ${JSON.stringify([key, value])}`, () => {
        assert.throws(() => metadataFromHeaders({ entries: () => [[key, value]] }), { code: grpc.status.INTERNAL, diagnostic });
    });
}

test('WIRE discarded metadata is still included in both header and trailer budgets', () => {
    const value = 'é'.repeat(METADATA_LIMIT);
    assert.throws(() => metadataFromHeaders(new Headers({ 'x-invalid': value })), { code: grpc.status.RESOURCE_EXHAUSTED });
    assert.throws(() => parseTrailers(Buffer.from(`grpc-status: 0\r\nx-invalid: ${value}\r\n`)), { code: grpc.status.RESOURCE_EXHAUSTED });
});
