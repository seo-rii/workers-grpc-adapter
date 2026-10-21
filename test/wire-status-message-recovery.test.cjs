'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame, metadataFromHeaders, parseTrailers, statusFromHeaders, METADATA_LIMIT } = require('../dist/wire.js');

for (const [name, message, expected] of [
    ['ASCII', 'denied', 'denied'],
    ['percent encoded', 'caf%C3%A9', 'café'],
    ['raw UTF-8', 'café 한글', 'café 한글'],
    ['malformed percent escapes', 'café%XX', 'café%XX'],
    ['literal non-ASCII space', '\u00a0denied\u00a0', '\u00a0denied\u00a0'],
]) {
    test(`WIRE trailer ${name} grpc-message preserves the remote status`, () => {
        const result = parseTrailers(Buffer.from(`grpc-status: 7\r\ngrpc-message: ${message}\r\nx-proof: retained\r\n`));
        assert.equal(result.code, grpc.status.PERMISSION_DENIED);
        assert.equal(result.details, expected);
        assert.deepEqual(result.metadata.get('x-proof'), ['retained']);
    });
}

test('WIRE headers and trailers preserve the same raw Latin-1 status text', () => {
    const headers = statusFromHeaders(new Headers({ 'grpc-status': '7', 'grpc-message': 'café' }));
    const trailers = parseTrailers(Buffer.from('grpc-status: 7\r\ngrpc-message: café\r\n'));
    assert.equal(headers.code, trailers.code);
    assert.equal(headers.details, trailers.details);
});

test('WIRE malformed UTF-8 in grpc-message is replaced without changing the status', () => {
    const result = parseTrailers(Buffer.concat([Buffer.from('grpc-status: 7\r\ngrpc-message: '),
        Buffer.from([0xc3, 0x28]), Buffer.from('\r\n')]));
    assert.equal(result.code, grpc.status.PERMISSION_DENIED);
    assert.equal(result.details, '\ufffd(');
});

test('WIRE malformed UTF-8 recovery budgets encoded bytes instead of replacement characters', () => {
    const result = parseTrailers(Buffer.concat([Buffer.from('grpc-status: 7\r\ngrpc-message: '),
        Buffer.alloc(22000, 0xff), Buffer.from('\r\n')]));
    assert.equal(result.code, grpc.status.PERMISSION_DENIED);
    assert.equal(result.details, '\ufffd'.repeat(22000));
});

// The two fields cost 11+1+32 and 12+messageBytes+32 encoded bytes.
for (const delta of [-1, 0, 1]) {
    test(`WIRE recovered status respects the encoded header-list budget at limit${delta < 0 ? delta : '+' + delta}`, () => {
        const messageBytes = METADATA_LIMIT - 88 + delta;
        const payload = Buffer.concat([Buffer.from('grpc-status: 7\r\ngrpc-message: '),
            Buffer.alloc(messageBytes, 0xff), Buffer.from('\r\n')]);
        assert.ok(payload.length < METADATA_LIMIT, 'exercise field accounting below the independent raw-payload cap');
        if (delta > 0) {
            assert.throws(() => parseTrailers(payload), { code: grpc.status.RESOURCE_EXHAUSTED, diagnostic: 'WGA_METADATA_SIZE' });
        } else {
            const result = parseTrailers(payload);
            assert.equal(result.code, grpc.status.PERMISSION_DENIED);
            assert.equal(result.details, '\ufffd'.repeat(messageBytes));
        }
    });
}

for (const bytes of [
    Buffer.from('grpc-status: 7\ngrpc-message: café\n'),
    Buffer.from('grpc-status: 7\r\ngrpc-message: unsafe\0value\r\n'),
    Buffer.from('grpc-status: 7\r\ngrpc-message: unsafe\x7fvalue\r\n'),
    Buffer.from('grpc-status: 7\r\nx-bad!: value\r\n'),
    Buffer.from('grpc-status: 7\r\nx-bád: value\r\n'),
]) {
    test(`WIRE status text recovery keeps malformed field structure strict ${bytes.toString('hex')}`, () => {
        assert.throws(() => parseTrailers(bytes), { code: grpc.status.INTERNAL, diagnostic: 'WGA_INVALID_TRAILERS' });
    });
}

test('WIRE client exposes raw UTF-8 trailer text with the provider error code', async () => {
    const transport = createWorkersGrpcTransport({ fetcher: { async fetch() {
        return new Response(encodeFrame(Buffer.from('grpc-status: 7\r\ngrpc-message: accès refusé\r\n'), true),
            { headers: { 'content-type': 'application/grpc-web+proto' } });
    } } });
    const client = new grpc.Client('fixture.test', transport.channelCredentials, transport.grpcOptions());
    try {
        const result = await new Promise(resolve => client.makeUnaryRequest('/fixture.Status/Call', bytes => bytes,
            bytes => bytes, Buffer.alloc(0), (error, value) => resolve({ error, value })));
        assert.equal(result.error.code, grpc.status.PERMISSION_DENIED);
        assert.equal(result.error.details, 'accès refusé');
        assert.equal(result.value, undefined);
    } finally { client.close(); }
});

for (const whitespace of ['\u00a0', '\u2003', '\ufeff']) {
    test(`WIRE binary fields reject non-ASCII separator whitespace ${JSON.stringify(whitespace)}`, () => {
        const value = `${whitespace}AQI=${whitespace}`;
        assert.throws(() => parseTrailers(Buffer.from(`grpc-status: 7\r\nx-proof-bin: ${value}\r\n`)),
            { code: grpc.status.INTERNAL, diagnostic: 'WGA_BINARY_METADATA' });
        // Fetch Headers are ByteString-valued; NBSP also exercises actual headers.
        if (whitespace === '\u00a0') assert.throws(() => metadataFromHeaders(new Headers({ 'x-proof-bin': value })),
            { code: grpc.status.INTERNAL, diagnostic: 'WGA_BINARY_METADATA' });
    });
}

test('WIRE binary fields keep HTTP optional whitespace around comma-separated values', () => {
    const value = ' \tAQI=\t ,\t AwQ \t';
    const expected = [Buffer.from([1, 2]), Buffer.from([3, 4])];
    assert.deepEqual(metadataFromHeaders(new Headers({ 'x-proof-bin': value })).get('x-proof-bin'), expected);
    assert.deepEqual(parseTrailers(Buffer.from(`grpc-status: 7\r\nx-proof-bin: ${value}\r\n`)).metadata.get('x-proof-bin'), expected);
});
