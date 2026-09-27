'use strict';
const { test } = require('node:test');
const { assert, byteStream, trailers } = require('./helpers.cjs');
const { encodeFrame, decodeFrames, parseTrailers, requestHeaders, metadataFromHeaders, encodeTimeout } = require('../dist/wire.js');
const { Metadata, status } = require('../dist/index.js');
async function collect(bytes, chunk = bytes.length || 1, max = 1024) {
    const out = [];
    for await (const f of decodeFrames(byteStream(bytes, chunk), max)) {
        out.push(f);
    }
    return out;
}
for (const size of [1, 2, 3, 4, 5, 6, 7, 13, 100]) {
    test(`WIRE split chunks size=${size}`, async () => {
        const payload = Buffer.from([0, 10, 255, 128, 4, 5, 6]);
        const bytes = Buffer.concat([encodeFrame(payload), encodeFrame(Buffer.alloc(0)), trailers()]);
        const result = await collect(bytes, size);
        assert.equal(result.length, 3);
        assert.deepEqual(result[0].payload, payload);
        assert.equal(result[1].payload.length, 0);
        assert.equal(parseTrailers(result[2].payload).code, 0);
    });
}
test('WIRE zero-length body has no frames', async () => assert.deepEqual(await collect(Buffer.alloc(0)), []));
for (let i = 1; i < 5; i++) {
    test(`WIRE truncated header (${i} bytes) rejects`, async () => assert.rejects(collect(Buffer.alloc(i)), { code: status.INTERNAL }));
}
test('WIRE truncated payload rejects', async () => assert.rejects(collect(encodeFrame(Buffer.from('abc')).subarray(0, 7)), { code: status.INTERNAL }));
for (const flag of [1, 0x81, 2, 0x40, 0xff]) {
    test(`WIRE flags ${flag}`, async () => {
        const b = Buffer.from([flag, 0, 0, 0, 0]);
        await assert.rejects(collect(b), { code: flag === 0x81 ? status.UNIMPLEMENTED : status.INTERNAL });
    });
}
test('WIRE huge declared size rejects before allocation', async () => assert.rejects(collect(Buffer.from([0, 255, 255, 255, 255])), { code: status.RESOURCE_EXHAUSTED }));
test('WIRE max boundary accepted / max+1 rejected', async () => {
    assert.equal((await collect(encodeFrame(Buffer.alloc(8)), 1, 8))[0].payload.length, 8);
    await assert.rejects(collect(encodeFrame(Buffer.alloc(9)), 1, 8), { code: status.RESOURCE_EXHAUSTED });
});
test('WIRE trailing message and duplicate trailer reject', async () => {
    for (const last of [trailers(), encodeFrame(Buffer.from('x'))]) {
        await assert.rejects(collect(Buffer.concat([trailers(), last])), { code: status.INTERNAL });
    }
});
test('WIRE cancellation releases reader', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({ pull() {
        }, cancel() {
            cancelled = true;
        } });
    const task = (async () => {
        for await (const _ of decodeFrames(stream, 1024, controller.signal)) {
        }
    })();
    controller.abort();
    await task.catch(e => assert.equal(e.code, status.CANCELLED));
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
});
test('WIRE trailers preserve details and binary values', () => {
    const value = Buffer.from('grpc-status: 7\r\ngrpc-message: %ED%95%9C%EA%B8%80\r\ntrace-bin: AQI=, AwQ\r\ngrpc-status-details-bin: CgY=\r\n');
    const t = parseTrailers(value);
    assert.equal(t.code, 7);
    assert.equal(t.details, '한글');
    assert.deepEqual(t.metadata.get('trace-bin'), [Buffer.from([1, 2]), Buffer.from([3, 4])]);
    assert.deepEqual(t.metadata.get('grpc-status-details-bin'), [Buffer.from([10, 6])]);
});
test('WIRE malformed percent escapes do not crash', () => assert.equal(parseTrailers(Buffer.from('grpc-status: 2\r\ngrpc-message: bad%XX\r\n')).details, 'bad%XX'));
for (const text of ['grpc-status: -1\r\n', 'grpc-status: 17\r\n', 'grpc-status: 0\r\ngrpc-status: 0\r\n', 'grpc-status: 0\ngrpc-message: bad\n', 'a-bin: @@\r\ngrpc-status: 0\r\n']) {
    test(`WIRE bad trailer ${JSON.stringify(text)}`, () => assert.throws(() => parseTrailers(Buffer.from(text)), { code: status.INTERNAL }));
}
test('WIRE request retains multiple metadata and encodes binary', () => {
    const m = new Metadata();
    m.add('x-value', 'a');
    m.add('x-value', 'b');
    m.add('data-bin', Buffer.from([1, 2]));
    const h = requestHeaders(m, 100);
    assert.equal(h.get('x-value'), 'a, b');
    assert.equal(h.get('data-bin'), 'AQI=');
    assert.equal(h.get('grpc-timeout'), '100m');
});
test('WIRE duplicate auth / reserved fields reject', () => {
    const m = new Metadata();
    m.add('authorization', 'a');
    m.add('authorization', 'b');
    assert.throws(() => requestHeaders(m), { code: status.INTERNAL });
    for (const key of ['host', 'grpc-timeout', 'content-length']) {
        const x = new Metadata();
        x.set(key, 'x');
        assert.throws(() => requestHeaders(x), { code: status.INTERNAL });
    }
});
test('WIRE metadata budgets apply to headers and trailers', () => {
    const m = new Metadata();
    m.set('x-long', 'a'.repeat(66000));
    assert.throws(() => requestHeaders(m), { code: status.RESOURCE_EXHAUSTED });
    assert.throws(() => metadataFromHeaders(new Headers({ 'x-long': 'a'.repeat(66000) })), { code: status.RESOURCE_EXHAUSTED });
    assert.throws(() => parseTrailers(Buffer.alloc(65537)), { code: status.RESOURCE_EXHAUSTED });
});
test('WIRE timeout uses <=8 digits with safe unit rounding', () => {
    for (const n of [1, 99999999, 100000000, 1e12]) {
        assert.match(encodeTimeout(n), /^[1-9][0-9]{0,7}[mSMH]$/);
    }
    assert.equal(encodeTimeout(1), '1m');
    assert.equal(encodeTimeout(100000000), '100000S');
});
test('WIRE independently fixed protobuf/gRPC-Web golden vector', async () => {
    const bytes = Buffer.from('00000000040a026f6b8000000010677270632d7374617475733a20300d0a', 'hex');
    const frames = await collect(bytes, 1);
    assert.equal(frames[0].payload.toString('hex'), '0a026f6b');
    assert.equal(parseTrailers(frames[1].payload).code, 0);
    assert.equal(encodeFrame(Buffer.from('0a026f6b', 'hex')).toString('hex'), '00000000040a026f6b');
});
