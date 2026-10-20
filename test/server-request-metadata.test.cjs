'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { createGrpcWebHandler } = require('../dist/server.js');
const { encodeFrame, decodeFrames, parseTrailers, METADATA_LIMIT } = require('../dist/wire.js');

const codec = bytes => bytes;
const method = { path: '/fixture.Metadata/Call', requestStream: false, responseStream: false,
    requestDeserialize: codec, responseSerialize: codec };
function request(headers) {
    return new Request(`https://server.test${method.path}`, { method: 'POST', body: encodeFrame(Buffer.from('input')),
        headers: { 'content-type': 'application/grpc-web+proto', ...headers } });
}
async function terminal(response) {
    let result;
    for await (const frame of decodeFrames(response.body, 1024)) if (frame.trailer) result = parseTrailers(frame.payload);
    return result;
}

test('SERVER exposes forwardable application metadata while filtering request protocol fields', async () => {
    let incoming;
    const handle = createGrpcWebHandler({ call: method }, { call(value, context) { incoming = context.metadata; return value; } });
    const result = await terminal(await handle(request({
        accept: 'application/grpc-web+proto', 'content-length': '10', 'content-encoding': 'identity',
        connection: 'keep-alive', 'transfer-encoding': 'chunked', host: 'server.test', te: 'trailers',
        'grpc-timeout': '5S', 'grpc-encoding': 'identity', 'grpc-accept-encoding': 'identity',
        'grpc-previous-rpc-attempts': '1', 'x-grpc-web': '1',
        'x-request-id': 'request-1', authorization: 'Bearer test-token',
        'x-context-bin': 'AQID, BAU=',
    })));
    assert.equal(result.code, grpc.status.OK);
    assert.deepEqual(incoming.getMap(), { authorization: 'Bearer test-token', 'x-context-bin': Buffer.from([1, 2, 3]),
        'x-request-id': 'request-1' });
    assert.deepEqual(incoming.get('x-context-bin'), [Buffer.from([1, 2, 3]), Buffer.from([4, 5])]);
});

test('SERVER forwards cloned context metadata to a child RPC with the same parent budget', { timeout: 5000 }, async () => {
    let calls = 0;
    const childTransport = createWorkersGrpcTransport({ fetcher: { async fetch(_url, init) {
        calls++;
        assert.equal(init.headers.get('x-request-id'), 'request-1');
        assert.equal(init.headers.get('authorization'), 'Bearer test-token');
        assert.equal(init.headers.get('x-context-bin'), 'AQID');
        assert.match(init.headers.get('grpc-timeout'), /^\d+[HMSmun]$/);
        return new Response(Buffer.concat([encodeFrame(Buffer.from('response')),
            encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': 'application/grpc-web+proto' } });
    } } });
    const child = new grpc.Client('child.test', childTransport.channelCredentials, childTransport.grpcOptions());
    const handle = createGrpcWebHandler({ call: method }, { call(value, context) {
        return new Promise((resolve, reject) => child.makeUnaryRequest(method.path, codec, codec, value, context.metadata.clone(),
            { parent: context }, (error, result) => error ? reject(error) : resolve(result)));
    } });
    const outerTransport = createWorkersGrpcTransport({ fetcher: { fetch(url, init) { return handle(new Request(url, init)); } } });
    const outer = new grpc.Client('outer.test', outerTransport.channelCredentials, outerTransport.grpcOptions());
    const metadata = new grpc.Metadata();
    metadata.set('x-request-id', 'request-1');
    metadata.set('authorization', 'Bearer test-token');
    metadata.set('x-context-bin', Buffer.from([1, 2, 3]));
    try {
        const result = await new Promise((resolve, reject) => outer.makeUnaryRequest(method.path, codec, codec, Buffer.from('input'),
            metadata, { deadline: Date.now() + 2000 }, (error, value) => error ? reject(error) : resolve(value)));
        assert.equal(result.toString(), 'response');
        assert.equal(calls, 1);
    } finally { outer.close(); child.close(); }
});

test('SERVER budgets filtered request headers and still validates application binary metadata', async () => {
    let calls = 0;
    const handle = createGrpcWebHandler({ call: method }, { call(value) { calls++; return value; } });
    const oversized = await terminal(await handle(request({ accept: 'a'.repeat(METADATA_LIMIT) })));
    assert.equal(oversized.code, grpc.status.RESOURCE_EXHAUSTED);
    assert.equal(oversized.details, 'WGA_METADATA_SIZE');
    const invalid = await terminal(await handle(request({ 'x-invalid-bin': '!' })));
    assert.equal(invalid.code, grpc.status.INTERNAL);
    assert.equal(invalid.details, 'WGA_BINARY_METADATA');
    assert.equal(calls, 0);
});
