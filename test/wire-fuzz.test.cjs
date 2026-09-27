'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decodeFrames, parseTrailers, metadataFromHeaders, METADATA_LIMIT } = require('../dist/wire.js');
const SEED = 0x57a913e5;
function random(seed) {
    let value = seed >>> 0;
    return limit => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) % limit; };
}
// This oracle deliberately writes the protocol header without encodeFrame.
function frame(payload, flag = 0) {
    const size = payload.length;
    return Buffer.concat([Buffer.from([flag, (size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255]), payload]);
}
function chunks(bytes, next, injectEmpty = false) {
    let offset = 0;
    return new ReadableStream({
        pull(controller) {
            if (offset === bytes.length) return controller.close();
            if (injectEmpty && next(4) === 0) controller.enqueue(new Uint8Array(0));
            const end = Math.min(bytes.length, offset + 1 + next(73));
            controller.enqueue(bytes.subarray(offset, end));
            offset = end;
        },
    });
}
async function parse(bytes, seed, limit = 8192) {
    const source = chunks(bytes, random(seed), true);
    const result = [];
    try {
        for await (const value of decodeFrames(source, limit)) result.push({ trailer: value.trailer, payload: value.payload });
        return result;
    } finally {
        assert.equal(source.locked, false, `reader leaked (seed ${seed})`);
    }
}

test('FUZZ deterministic seeded payloads, arbitrary fragmentation and empty chunks match independent frame oracle', async () => {
    const next = random(SEED);
    for (let sample = 0; sample < 96; sample++) {
        const payloads = Array.from({ length: 1 + next(8) }, () => Buffer.from(Array.from({ length: next(2049) }, () => next(256))));
        const trailer = Buffer.from(`grpc-status: ${next(17)}\r\ntrace-bin: AQID\r\n`);
        const expected = [...payloads.map(payload => ({ trailer: false, payload })), { trailer: true, payload: trailer }];
        const bytes = Buffer.concat(expected.map(value => frame(value.payload, value.trailer ? 128 : 0)));
        assert.deepEqual(await parse(bytes, next(0x7fffffff)), expected, `seed=${SEED}, sample=${sample}`);
    }
});

test('FUZZ every byte truncation is accepted only at complete frame boundaries', async () => {
    const payloads = [Buffer.alloc(0), Buffer.from([0, 255, 1, 128]), Buffer.alloc(19, 173), Buffer.from('grpc-status: 0\r\n')];
    const frames = payloads.map((payload, index) => frame(payload, index === payloads.length - 1 ? 128 : 0));
    const bytes = Buffer.concat(frames);
    const boundaries = new Map([[0, 0]]);
    let end = 0;
    frames.forEach((value, index) => { end += value.length; boundaries.set(end, index + 1); });
    for (let length = 0; length <= bytes.length; length++) {
        const task = parse(bytes.subarray(0, length), SEED + length);
        if (boundaries.has(length)) assert.equal((await task).length, boundaries.get(length));
        else await assert.rejects(task, { code: 13, diagnostic: 'WGA_TRUNCATED_FRAME' }, `cut ${length}`);
    }
});

test('FUZZ all 254 noncanonical flag values fail with exact protocol/compression status', async () => {
    for (let flag = 0; flag <= 255; flag++) {
        if (flag === 0 || flag === 128) continue;
        await assert.rejects(parse(frame(Buffer.alloc(0), flag), SEED + flag), {
            code: flag === 129 ? 12 : 13,
            diagnostic: flag === 129 ? 'WGA_COMPRESSED_TRAILER' : flag === 1 ? 'WGA_COMPRESSED_WITH_IDENTITY' : 'WGA_FRAME_FLAGS',
        });
    }
});

test('FUZZ malicious size headers reject without requesting payload bytes', async () => {
    for (const [flag, limit] of [[0, 4096], [128, METADATA_LIMIT]]) {
        for (const size of [limit + 1, 0x7fffffff, 0xffffffff]) {
            let pulls = 0;
            let cancelled = false;
            const source = new ReadableStream({
                pull(controller) {
                    pulls++;
                    assert.equal(pulls, 1, 'parser requested forbidden payload');
                    controller.enqueue(Buffer.from([flag, size >>> 24, size >>> 16 & 255, size >>> 8 & 255, size & 255]));
                },
                cancel() { cancelled = true; },
            }, { highWaterMark: 0 });
            await assert.rejects(async () => { for await (const value of decodeFrames(source, 4096)) void value; }, { code: 8 });
            assert.equal(pulls, 1);
            assert.equal(cancelled, true);
            assert.equal(source.locked, false);
        }
    }
});

test('FUZZ any complete frame following a trailer is rejected under arbitrary fragmentation', async () => {
    const trailer = frame(Buffer.from('grpc-status: 0\r\n'), 128);
    const next = random(SEED);
    for (let sample = 0; sample < 32; sample++) {
        const payload = Buffer.alloc(next(100), next(256));
        await assert.rejects(parse(Buffer.concat([trailer, frame(payload, sample % 2 ? 128 : 0)]), SEED + sample), { code: 13, diagnostic: 'WGA_FRAME_AFTER_TRAILER' });
    }
});

test('FUZZ binary metadata round-trips padding variants and rejects invalid alphabets and trailing bits', () => {
    const next = random(SEED);
    for (let length = 0; length < 192; length++) {
        const value = Buffer.from(Array.from({ length }, () => next(256)));
        const padded = value.toString('base64');
        for (const encoded of [padded, padded.replace(/=+$/, '')]) {
            const headers = new Headers({ 'trace-bin': encoded });
            assert.deepEqual(metadataFromHeaders(headers).get('trace-bin'), [value]);
            assert.deepEqual(parseTrailers(Buffer.from(`grpc-status: 0\r\ntrace-bin: ${encoded}\r\n`)).metadata.get('trace-bin'), [value]);
        }
    }
    for (const invalid of ['A', 'AAAAA', 'AB==', 'AAB=', 'AA===', '=AAA', 'AA=A', 'A_A=', 'A-A=', '!!', 'AA BB', 'AA\tBB']) {
        assert.throws(() => metadataFromHeaders(new Headers({ 'trace-bin': invalid })), { code: 13, diagnostic: 'WGA_BINARY_METADATA' }, invalid);
    }
});

test('FUZZ exact metadata budget boundaries cover text and binary expansion', () => {
    const available = METADATA_LIMIT - Buffer.byteLength('x-pad') - 32;
    assert.equal(metadataFromHeaders(new Headers({ 'x-pad': 'a'.repeat(available) })).get('x-pad')[0].length, available);
    assert.throws(() => metadataFromHeaders(new Headers({ 'x-pad': 'a'.repeat(available + 1) })), { code: 8 });
    const binaryAvailable = METADATA_LIMIT - Buffer.byteLength('trace-bin') - 32;
    const bytes = Buffer.alloc(Math.floor(binaryAvailable / 4) * 3);
    assert.deepEqual(metadataFromHeaders(new Headers({ 'trace-bin': bytes.toString('base64') })).get('trace-bin'), [bytes]);
    assert.throws(() => metadataFromHeaders(new Headers({ 'trace-bin': Buffer.alloc(bytes.length + 3).toString('base64') })), { code: 8 });
});
