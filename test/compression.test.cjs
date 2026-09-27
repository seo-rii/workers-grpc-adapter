'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const zlib = require('node:zlib');
const { encodeFrame, encodeMessageFrame, decodeFrames, requestHeaders, responseCompression } = require('../dist/wire.js');
const { transformMessage } = require('../dist/compression.js');
const { validateOptions } = require('../dist/options.js');
const { Metadata, compressionAlgorithms } = require('../dist/index.js');
const nativeRequire = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const { CompressionFilter } = nativeRequire('@grpc/grpc-js/build/src/compression-filter');
const encodings = ['identity', 'deflate', 'gzip'];
const limit = 2 * 1024 * 1024;
function frame(payload, flag = 1) {
    const header = Buffer.alloc(5);
    header[0] = flag;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}
function source(bytes, size = bytes.length || 1) {
    let offset = 0;
    const state = { pulls: 0, cancelled: 0 };
    const stream = new ReadableStream({
        pull(controller) {
            state.pulls++;
            if (offset === bytes.length) { controller.close(); return; }
            const end = Math.min(bytes.length, offset + size);
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
        },
        cancel() { state.cancelled++; },
    }, { highWaterMark: 0 });
    return { stream, state };
}
async function decode(bytes, encoding, maxMessageBytes = limit, maxWireBytes = limit, chunkSize) {
    const { stream } = source(bytes, chunkSize);
    try {
        const result = [];
        for await (const item of decodeFrames(stream, maxMessageBytes, undefined, { encoding, maxWireBytes })) result.push(item);
        return result;
    } finally { assert.equal(stream.locked, false); }
}

test('COMPRESSION strict channel enum and metadata negotiation support identity/deflate/gzip', async () => {
    assert.deepEqual(compressionAlgorithms, native.compressionAlgorithms);
    for (const [algorithm, encoding] of encodings.entries()) {
        const options = validateOptions({ 'grpc.default_compression_algorithm': algorithm }, 'fixture.test:443', {
            transportMaxSendBytes: limit, transportMaxReceiveBytes: limit,
        });
        assert.equal(options.compression, encoding);
        for (const mode of ['cloudflare', 'grpc-web']) {
            const headers = requestHeaders(new Metadata(), 1000, undefined, mode, encoding);
            assert.equal(headers.get('grpc-encoding'), encoding);
            assert.equal(headers.get('grpc-accept-encoding'), 'identity,deflate,gzip');
            assert.equal(headers.get('content-encoding'), null);
        }
    }
    for (const value of [-1, 3, 1.5, 'gzip', '2', null, NaN, Infinity, true]) {
        assert.throws(() => validateOptions({ 'grpc.default_compression_algorithm': value }, 'fixture.test:443', {
            transportMaxSendBytes: limit, transportMaxReceiveBytes: limit,
        }), { code: 'WGA_UNSUPPORTED_OPTION' });
    }
    assert.equal(responseCompression(new Headers()), 'identity');
    for (const encoding of encodings) assert.equal(responseCompression(new Headers({ 'grpc-encoding': encoding })), encoding);
    for (const encoding of ['br', 'GZIP', 'gzip,deflate', 'gzip,gzip', '', 'gzip; q=1']) {
        const actual = responseCompression(new Headers({ 'grpc-encoding': encoding }));
        const bytes = encodeFrame(Buffer.from('plain'));
        const oracle = new CompressionFilter({}, {});
        const metadata = new native.Metadata();
        metadata.set('grpc-encoding', encoding);
        oracle.receiveMetadata(metadata);
        assert.deepEqual((await decode(bytes, actual))[0].payload, await oracle.receiveMessage(Promise.resolve(bytes)));
        await assert.rejects(decode(frame(Buffer.alloc(0)), actual), { code: 12, diagnostic: 'WGA_COMPRESSION_ENCODING' });
    }
});

test('COMPRESSION framing and decoded bytes match pinned native grpc-js codecs and NoCompress', async () => {
    assert.equal(nativeRequire('@grpc/grpc-js/package.json').version, '1.14.0');
    const payloads = [Buffer.alloc(0), Buffer.from([0, 255, 128, 13, 10]), Buffer.from('한글 payload '.repeat(2000))];
    for (const [algorithm, encoding] of encodings.entries()) for (const payload of payloads) for (const flags of [0, 1, 2, 3]) {
        const oracle = new CompressionFilter({ 'grpc.default_compression_algorithm': algorithm, 'grpc.max_receive_message_length': limit }, {});
        const expected = (await oracle.sendMessage(Promise.resolve({ message: payload, flags }))).message;
        const actual = await encodeMessageFrame(payload, encoding, limit, undefined, !!(flags & 2));
        assert.deepEqual(actual, expected);
        assert.equal(actual[0], encoding !== 'identity' && !(flags & 2) ? 1 : 0);
        const metadata = new native.Metadata();
        metadata.set('grpc-encoding', encoding);
        oracle.receiveMetadata(metadata);
        assert.deepEqual(await oracle.receiveMessage(Promise.resolve(actual)), payload);
        assert.deepEqual((await decode(expected, encoding, limit, limit, 7))[0].payload, payload);
    }
});

test('COMPRESSION messages reset codecs and permit compressed/plain frames under one response encoding', async () => {
    for (const encoding of ['deflate', 'gzip']) {
        const zip = encoding === 'gzip' ? zlib.gzipSync : zlib.deflateSync;
        const payloads = [Buffer.from('first'.repeat(100)), Buffer.from('plain'), Buffer.alloc(0), Buffer.from('last'.repeat(500))];
        const wire = Buffer.concat(payloads.map((payload, index) => index === 1 ? encodeFrame(payload) : frame(zip(payload))));
        for (const size of [1, 3, 5, 17, wire.length]) {
            const actual = await decode(wire, encoding, limit, limit, size);
            assert.deepEqual(actual.map(item => item.payload), payloads);
        }
    }
});

test('COMPRESSION malformed, truncated and corrupt payloads reject with safe diagnostics', async () => {
    for (const encoding of ['deflate', 'gzip']) {
        const zip = encoding === 'gzip' ? zlib.gzipSync : zlib.deflateSync;
        const complete = zip(Buffer.from('fixture-secret-content'.repeat(10)));
        const corrupt = Buffer.from(complete);
        corrupt[corrupt.length - 1] ^= 128;
        const malformed = [Buffer.alloc(0), Buffer.from('fixture-secret-content'), corrupt,
            ...Array.from({ length: complete.length }, (_, length) => complete.subarray(0, length))];
        for (const bytes of malformed) {
            await assert.rejects(decode(frame(bytes), encoding), error => {
                assert.equal(error.code, 13);
                assert.equal(error.diagnostic, 'WGA_COMPRESSION_DATA');
                assert.equal(error.message, 'WGA_COMPRESSION_DATA');
                return true;
            });
        }
        await assert.rejects(decode(frame(complete, 0x81), encoding), { code: 12, diagnostic: 'WGA_COMPRESSED_TRAILER' });
        await assert.rejects(decode(frame(complete), 'identity'), { code: 13, diagnostic: 'WGA_COMPRESSED_WITH_IDENTITY' });
    }
});

test('COMPRESSION independently bounds wire and decoded bytes including empty-message overhead', async () => {
    for (const encoding of ['deflate', 'gzip']) {
        const zip = encoding === 'gzip' ? zlib.gzipSync : zlib.deflateSync;
        const message = Buffer.alloc(65537, 97);
        const zipped = zip(message);
        assert.ok(zipped.length < 1024);
        assert.equal((await decode(frame(zipped), encoding, message.length, zipped.length))[0].payload.length, message.length);
        await assert.rejects(decode(frame(zipped), encoding, message.length - 1, zipped.length), { code: 8, diagnostic: 'WGA_DECOMPRESSED_SIZE' });
        await assert.rejects(decode(frame(zipped), encoding, message.length, zipped.length - 1), { code: 8, diagnostic: 'WGA_FRAME_SIZE' });
        const empty = zip(Buffer.alloc(0));
        assert.equal((await decode(frame(empty), encoding, 0, empty.length))[0].payload.length, 0);
        const encoded = await encodeMessageFrame(message, encoding, zipped.length);
        assert.equal(encoded.length - 5, zipped.length);
        await assert.rejects(encodeMessageFrame(message, encoding, zipped.length - 1), { code: 8, diagnostic: 'WGA_COMPRESSED_SIZE' });
        await assert.rejects(encodeMessageFrame(message, encoding, message.length - 1, undefined, true), { code: 8, diagnostic: 'WGA_FRAME_SIZE' });
    }
});

test('COMPRESSION over-limit declared wire length rejects before reading compressed bytes', async () => {
    let cancelled = 0, pulls = 0;
    const stream = new ReadableStream({
        pull(controller) {
            assert.equal(++pulls, 1);
            controller.enqueue(Buffer.from([1, 255, 255, 255, 255]));
        },
        cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    await assert.rejects(async () => { for await (const item of decodeFrames(stream, 1024, undefined, { encoding: 'gzip', maxWireBytes: 1024 })) void item; }, { code: 8 });
    assert.equal(pulls, 1);
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
});

test('COMPRESSION decoding retains backpressure and cancels the source after a compressed size bomb', async () => {
    const a = frame(zlib.gzipSync(Buffer.alloc(200, 42)));
    const b = frame(zlib.gzipSync(Buffer.alloc(20000, 42)));
    let pulls = 0, cancelled = 0;
    const stream = new ReadableStream({
        pull(controller) { controller.enqueue([a, b][pulls++]); },
        cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    const iterator = decodeFrames(stream, 200, undefined, { encoding: 'gzip', maxWireBytes: 1024 });
    assert.equal((await iterator.next()).value.payload.length, 200);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pulls, 1, 'the second frame must wait for consumer demand');
    await assert.rejects(iterator.next(), { code: 8, diagnostic: 'WGA_DECOMPRESSED_SIZE' });
    assert.equal(pulls, 2);
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
});

test('COMPRESSION abort terminates active encode/decode codecs and releases readers', async () => {
    const payload = Buffer.alloc(limit, 65);
    for (const encoding of ['deflate', 'gzip']) for (const decompress of [false, true]) {
        const data = decompress ? (encoding === 'gzip' ? zlib.gzipSync(payload) : zlib.deflateSync(payload)) : payload;
        const controller = new AbortController();
        const pending = transformMessage(data, encoding, decompress, limit, controller.signal);
        controller.abort();
        await assert.rejects(pending, { code: 1, diagnostic: 'WGA_ABORTED' });
        await assert.rejects(transformMessage(data, encoding, decompress, limit, controller.signal), { code: 1 });
    }
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
    const pending = (async () => { for await (const value of decodeFrames(stream, limit, controller.signal, { encoding: 'gzip' })) void value; })();
    controller.abort();
    await assert.rejects(pending, { code: 1 });
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
});
