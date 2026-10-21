'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { createGrpcWebHandler } = require('../dist/server.js');
const nativeRequire = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');

const codec = bytes => bytes;
const method = { path: '/fixture.DateMetadata/Call', requestStream: false, responseStream: false,
    requestSerialize: codec, requestDeserialize: codec, responseSerialize: codec, responseDeserialize: codec };
const dates = { request: 'Tue, 01 Jan 2030 00:00:00 GMT', initial: 'Wed, 02 Jan 2030 00:00:00 GMT',
    trailing: 'Thu, 03 Jan 2030 00:00:00 GMT' };
function metadata(implementation, value) {
    const result = new implementation.Metadata();
    result.set('date', value);
    result.set('x-date', value);
    return result;
}
function checkDate(value, expected) {
    assert.deepEqual(value.get('date'), [expected]);
    assert.deepEqual(value.get('x-date'), [expected]);
}
async function invoke(client, requestMetadata) {
    let call, initial;
    const completed = new Promise(resolve => {
        call = client.call(Buffer.from('request'), requestMetadata, { deadline: Date.now() + 2000 },
            (error, response) => resolve({ error, response }));
    });
    call.on('metadata', value => { initial = value; });
    const ended = new Promise(resolve => call.on('status', resolve));
    const [result, terminal] = await Promise.all([completed, ended]);
    return { ...result, initial, terminal };
}
function transportOptions(mode, fetcher) {
    return { mode, fetcher, ...(mode === 'grpc-web'
        ? { endpoints: { 'metadata.test:443': 'https://gateway.test' } } : {}) };
}

test('METADATA pinned native grpc-js preserves date on all three unary boundaries', { timeout: 5000 }, async () => {
    assert.equal(nativeRequire('@grpc/grpc-js/package.json').version, '1.14.5');
    let incoming, client;
    const server = new native.Server();
    server.addService({ call: method }, { call(call, callback) {
        incoming = call.metadata;
        call.sendMetadata(metadata(native, dates.initial));
        callback(null, call.request, metadata(native, dates.trailing));
    } });
    try {
        const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0',
            native.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)));
        const Client = native.makeGenericClientConstructor({ call: method }, 'fixture.DateMetadata');
        client = new Client(`127.0.0.1:${port}`, native.credentials.createInsecure());
        const result = await invoke(client, metadata(native, dates.request));
        assert.ifError(result.error);
        assert.equal(result.response.toString(), 'request');
        assert.equal(result.terminal.code, native.status.OK);
        checkDate(incoming, dates.request);
        checkDate(result.initial, dates.initial);
        checkDate(result.terminal.metadata, dates.trailing);
    } finally { client?.close(); server.forceShutdown(); }
});

for (const mode of ['cloudflare', 'grpc-web']) {
    test(`METADATA ${mode} client and Fetch server preserve date on all three unary boundaries`, { timeout: 5000 }, async () => {
        let incoming;
        const handle = createGrpcWebHandler({ call: method }, { call(value, context) {
            incoming = context.metadata;
            context.sendMetadata(metadata(grpc, dates.initial));
            context.setTrailer(metadata(grpc, dates.trailing));
            return value;
        } });
        const transport = createWorkersGrpcTransport(transportOptions(mode,
            { fetch(url, init) { return handle(new Request(url, init)); } }));
        const Client = grpc.makeGenericClientConstructor({ call: method }, 'fixture.DateMetadata');
        const client = new Client('metadata.test:443', transport.channelCredentials, transport.grpcOptions());
        try {
            const result = await invoke(client, metadata(grpc, dates.request));
            assert.ifError(result.error);
            assert.equal(result.response.toString(), 'request');
            assert.equal(result.terminal.code, grpc.status.OK);
            checkDate(incoming, dates.request);
            checkDate(result.initial, dates.initial);
            checkDate(result.terminal.metadata, dates.trailing);
            for (const value of [incoming, result.initial, result.terminal.metadata]) {
                for (const key of ['content-type', 'grpc-encoding', 'grpc-status', 'grpc-message']) {
                    assert.deepEqual(value.get(key), [], key);
                }
            }
        } finally { client.close(); }
    });

    test(`METADATA ${mode} headers-only failures retain date with the terminal status`, { timeout: 5000 }, async () => {
        const transport = createWorkersGrpcTransport(transportOptions(mode, { async fetch() {
            return new Response(null, { headers: { 'content-type': 'application/grpc-web+proto',
                'grpc-status': '7', 'grpc-message': 'denied', date: dates.trailing, 'x-date': dates.trailing } });
        } }));
        const Client = grpc.makeGenericClientConstructor({ call: method }, 'fixture.DateMetadata');
        const client = new Client('metadata.test:443', transport.channelCredentials, transport.grpcOptions());
        try {
            const result = await invoke(client, new grpc.Metadata());
            assert.equal(result.error.code, grpc.status.PERMISSION_DENIED);
            assert.equal(result.terminal.code, grpc.status.PERMISSION_DENIED);
            assert.equal(result.terminal.details, 'denied');
            checkDate(result.error.metadata, dates.trailing);
            checkDate(result.terminal.metadata, dates.trailing);
            for (const key of ['content-type', 'grpc-status', 'grpc-message']) {
                assert.deepEqual(result.terminal.metadata.get(key), [], key);
            }
        } finally { client.close(); }
    });
}
