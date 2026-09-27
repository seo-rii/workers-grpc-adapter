'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fc, check } = require('./property-helpers.cjs');
const { decodeFrames } = require('../dist/wire.js');

// Construct wire records from the protocol layout, independently of encodeFrame.
function record(payload, trailer = false) {
    const bytes = new Uint8Array(5 + payload.length);
    bytes[0] = trailer ? 128 : 0;
    new DataView(bytes.buffer).setUint32(1, payload.length, false);
    bytes.set(payload, 5);
    return bytes;
}

// Whole-buffer grammar oracle: no stream operations or production framing helpers.
// Codes express framing/compression/size policy; diagnostic spelling is not an oracle.
function oracle(bytes, maxMessageBytes) {
    const frames = [];
    let position = 0;
    const fail = error => ({ frames, error });
    while (position < bytes.length) {
        const header = Array.from(bytes.slice(position, position + 5));
        if (header.length !== 5 || frames.at(-1)?.trailer) return fail(13);
        const [flag, a, b, c, d] = header;
        if (flag === 129) return fail(12);
        if (flag !== 0 && flag !== 128) return fail(13);
        const size = a * 16777216 + b * 65536 + c * 256 + d;
        if (size > (flag === 128 ? 65536 : maxMessageBytes)) return fail(8);
        const end = position + 5 + size;
        if (end > bytes.length) return fail(13);
        frames.push({ trailer: flag === 128, payload: Array.from(bytes.slice(position + 5, end)) });
        position = end;
    }
    return { frames, error: null };
}

const fragmentation = fc.record({
    sizes: fc.array(fc.integer({ min: 1, max: 29 }), { minLength: 1, maxLength: 8 }),
    empties: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
    padding: fc.integer({ min: 1, max: 8 }),
});

function fragments(bytes, plan) {
    const chunks = [];
    function view(payload) {
        // Poison both surrounding regions: treating the entire backing buffer as
        // this view would introduce invalid framing bytes or corrupt a payload.
        const storage = new Uint8Array(plan.padding + payload.length + 8).fill(0xfd);
        storage.set(payload, plan.padding);
        return storage.subarray(plan.padding, plan.padding + payload.length);
    }
    let position = 0, index = 0;
    while (position < bytes.length) {
        if (plan.empties[index % plan.empties.length]) chunks.push(view(new Uint8Array(0)));
        const end = Math.min(bytes.length, position + plan.sizes[index % plan.sizes.length]);
        chunks.push(view(bytes.subarray(position, end)));
        position = end;
        index++;
    }
    if (plan.empties[index % plan.empties.length]) chunks.push(view(new Uint8Array(0)));
    return chunks;
}

function sourceFor(chunks) {
    const state = { pulls: 0, cancellations: 0, closed: false };
    let index = 0;
    const stream = new ReadableStream({
        pull(controller) {
            state.pulls++;
            if (index < chunks.length) controller.enqueue(chunks[index++]);
            else { state.closed = true; controller.close(); }
        },
        cancel() { state.cancellations++; },
    }, { highWaterMark: 0 });
    return { stream, state };
}

async function observe(chunks, limit) {
    const { stream, state } = sourceFor(chunks);
    const result = { frames: [], error: null };
    try {
        for await (const frame of decodeFrames(stream, limit)) {
            result.frames.push({ trailer: frame.trailer, payload: Array.from(frame.payload) });
        }
    } catch (error) {
        assert.ok(Number.isInteger(error.code), 'Unexpected non-protocol exception');
        result.error = error.code;
    } finally {
        assert.equal(stream.locked, false, 'Decoder leaked its reader');
        assert.equal(state.cancellations, state.closed ? 0 : 1, 'An unfinished input must be cancelled exactly once');
    }
    return result;
}

const mutatedRecords = fc.record({
    frames: fc.array(fc.record({ payload: fc.uint8Array({ maxLength: 24 }), trailer: fc.boolean() }), { minLength: 1, maxLength: 6 }),
    mutation: fc.constantFrom('keep', 'byte', 'truncate', 'append', 'flag', 'length'),
    position: fc.nat({ max: 1024 }),
    byte: fc.integer({ min: 0, max: 255 }),
    flag: fc.constantFrom(0, 1, 2, 128, 129, 255),
    length: fc.oneof(fc.integer({ min: 0, max: 96 }), fc.constantFrom(65535, 65536, 65537, 0xffffffff)),
    suffix: fc.uint8Array({ maxLength: 16 }),
}).map(sample => {
    const records = sample.frames.map(frame => record(frame.payload, frame.trailer));
    const bytes = Buffer.concat(records);
    const selected = sample.position % records.length;
    const start = records.slice(0, selected).reduce((sum, frame) => sum + frame.length, 0);
    switch (sample.mutation) {
        case 'byte': bytes[sample.position % bytes.length] = sample.byte; break;
        case 'truncate': return bytes.subarray(0, sample.position % (bytes.length + 1));
        case 'append': return Buffer.concat([bytes, sample.suffix]);
        case 'flag': bytes[start] = sample.flag; break;
        case 'length': new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(start + 1, sample.length, false); break;
    }
    return bytes;
});

test('FUZZ property arbitrary and mutated wire bytes match an independent framing oracle', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(
        fc.oneof(fc.uint8Array({ maxLength: 192 }), mutatedRecords),
        fragmentation,
        fc.integer({ min: 0, max: 64 }),
        async (bytes, plan, limit) => {
            const expected = oracle(bytes, limit);
            // Compare yielded prefixes as well as final failure codes. A decoder
            // that loses a valid message before malformed input must fail here.
            assert.deepEqual(await observe(bytes.length ? [bytes] : [], limit), expected);
            assert.deepEqual(await observe(fragments(bytes, plan), limit), expected);
        },
    ));
});

test('FUZZ property generated payloads survive empty chunks and offset views', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 96 }), { maxLength: 6 }),
        fc.option(fc.uint8Array({ maxLength: 96 }), { nil: null }),
        fragmentation,
        async (payloads, trailer, plan) => {
            const frames = payloads.map(payload => ({ trailer: false, payload }));
            if (trailer !== null) frames.push({ trailer: true, payload: trailer });
            const bytes = Buffer.concat(frames.map(frame => record(frame.payload, frame.trailer)));
            const expected = frames.map(frame => ({ trailer: frame.trailer, payload: Array.from(frame.payload) }));
            assert.deepEqual(await observe(fragments(bytes, plan), 96), { frames: expected, error: null });
        },
    ));
});

test('FUZZ property early consumer exit cancels once and releases the reader', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(
        fc.array(fc.uint8Array({ maxLength: 80 }), { minLength: 2, maxLength: 8 }),
        fc.nat({ max: 1024 }),
        fc.boolean(),
        fragmentation,
        async (payloads, position, throwFromConsumer, plan) => {
            const take = 1 + position % (payloads.length - 1);
            const bytes = Buffer.concat(payloads.map(payload => record(payload)));
            const { stream, state } = sourceFor(fragments(bytes, plan));
            const received = [], consumerError = new Error('fixture-consumer-stop');
            let caught;
            try {
                for await (const frame of decodeFrames(stream, 80)) {
                    received.push(Array.from(frame.payload));
                    if (received.length === take) {
                        if (throwFromConsumer) throw consumerError;
                        break;
                    }
                }
            } catch (error) { caught = error; }
            assert.strictEqual(caught, throwFromConsumer ? consumerError : undefined);
            assert.deepEqual(received, payloads.slice(0, take).map(payload => Array.from(payload)));
            assert.equal(state.closed, false, 'Consumer stopped before input EOF');
            assert.equal(state.cancellations, 1);
            assert.equal(stream.locked, false);
            const pullsAtStop = state.pulls;
            const reader = stream.getReader();
            try { assert.deepEqual(await reader.read(), { done: true, value: undefined }); }
            finally { reader.releaseLock(); }
            assert.equal(state.pulls, pullsAtStop, 'Cancelled input was pulled again');
            assert.equal(state.cancellations, 1);
            assert.equal(stream.locked, false);
        },
    ));
});
