'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { fc, check } = require('./property-helpers.cjs');
const { RequestStreamBody } = require('../dist/request-stream.js');

const turn = () => new Promise(resolve => setImmediate(resolve));
const codec = fc.constantFrom('identity', 'deflate', 'gzip');
const step = async kind => { if (kind === 1) await Promise.resolve(); else if (kind === 2) await turn(); };
function tracked(promise) {
    const item = { settled: 0, ok: undefined, value: undefined };
    item.promise = Promise.resolve(promise).then(value => {
        item.settled++; item.ok = true; item.value = value;
    }, error => { item.settled++; item.ok = false; item.value = error; });
    return item;
}
async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Request stream operation did not settle')), 5000);
    })]); }
    finally { clearTimeout(timer); }
}
// Decode the public wire format independently: no production framing/codec helper.
function payloadOf(value, compression, noCompress) {
    const bytes = Buffer.from(value);
    assert.ok(bytes.length >= 5, 'A pull must contain one complete message record');
    assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
    assert.equal(bytes[0], compression === 'identity' || noCompress ? 0 : 1);
    if (!bytes[0]) return bytes.subarray(5);
    return compression === 'gzip' ? zlib.gunzipSync(bytes.subarray(5)) : zlib.inflateSync(bytes.subarray(5));
}
async function settledClean(request, reader, writes, reads = []) {
    await bounded(Promise.all([...writes, ...reads].map(item => item.promise)));
    await turn(); await turn();
    for (const item of [...writes, ...reads]) assert.equal(item.settled, 1);
    assert.equal(request.bufferedBytes(), 0, 'Terminal calls retain no adapter-owned message');
    if (reader) reader.releaseLock();
    assert.equal(request.body.locked, false);
}

test('FUZZ property request writes preserve byte identity and order with bounded pull acceptance', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(codec, fc.array(fc.record({
        payload: fc.uint8Array({ maxLength: 768 }),
        noCompress: fc.boolean(),
        pullFirst: fc.boolean(),
        delay: fc.integer({ min: 0, max: 2 }),
    }), { minLength: 1, maxLength: 7 }), async (compression, plan) => {
        const request = new RequestStreamBody({ maxMessageBytes: 768, maxWireBytes: 1024, compression });
        const reader = request.body.getReader(), writes = [], actual = [], expected = [];
        try {
            for (const [index, operation] of plan.entries()) {
                const storage = Buffer.alloc(operation.payload.length + 11, 0xfd);
                storage.set(operation.payload, 4);
                const input = storage.subarray(4, 4 + operation.payload.length);
                expected.push(Buffer.from(input));
                const read = operation.pullFirst ? reader.read() : undefined;
                const write = tracked(request.write(input, operation.noCompress)); writes.push(write);
                storage.fill(0xaa);
                if (!read) {
                    await step(operation.delay);
                    // No downstream demand: accepting a second message would hide
                    // an extra queue and violate the producer's bounded contract.
                    const overlap = tracked(request.write(Buffer.from([0xee]))); writes.push(overlap);
                    await overlap.promise;
                    assert.equal(overlap.ok, false);
                    assert.equal(overlap.value.code, 8);
                    assert.equal(write.settled, 0, 'Write was acknowledged before a pull');
                    assert.ok(request.bufferedBytes() <= 1029);
                }
                if (index === plan.length - 1) request.end();
                const received = await bounded(read ?? reader.read());
                await write.promise;
                assert.equal(write.ok, true);
                assert.equal(received.done, false);
                actual.push(payloadOf(received.value, compression, operation.noCompress));
                assert.equal(request.bufferedBytes(), 0);
            }
            assert.deepEqual(actual, expected);
            assert.deepEqual(await bounded(reader.read()), { done: true, value: undefined });
            request.end(); request.abort();
            await settledClean(request, reader, writes);
        } finally {
            request.abort();
            if (request.body.locked) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
    }), { numRuns: 120 });
});

test('FUZZ property racing writes pulls and terminal operations settle once without late data', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(codec, fc.array(fc.record({
        kind: fc.constantFrom('write', 'write', 'pull', 'pull', 'end', 'abort', 'cancel'),
        delay: fc.integer({ min: 0, max: 2 }),
        payload: fc.uint8Array({ maxLength: 512 }),
        noCompress: fc.boolean(),
    }), { minLength: 5, maxLength: 28 }), async (compression, operations) => {
        let cancelled = 0;
        const request = new RequestStreamBody({ maxMessageBytes: 514, maxWireBytes: 1024, compression,
            onCancel() { cancelled++; } });
        const writes = [], reads = [], controls = [];
        let reader;
        try {
            for (const [index, operation] of operations.entries()) {
                if (operation.delay) await step(operation.delay);
                if (operation.kind === 'write') {
                    const input = Buffer.concat([Buffer.from([index >> 8, index & 255]), operation.payload]);
                    const expected = Buffer.from(input);
                    const write = tracked(request.write(input, operation.noCompress));
                    Object.assign(write, { expected, noCompress: operation.noCompress }); writes.push(write);
                    input.fill(0xbb);
                } else if (operation.kind === 'pull') {
                    reader ??= request.body.getReader();
                    reads.push(tracked(reader.read()));
                } else if (operation.kind === 'end') request.end();
                else if (operation.kind === 'abort') request.abort();
                else controls.push(tracked(reader ? reader.cancel() : request.body.cancel()));
                // The bound holds even during asynchronous zlib work; delivered
                // buffers belong to the consumer and are checked separately.
                assert.ok(request.bufferedBytes() <= 1029);
            }
            request.abort();
            await bounded(Promise.all([...writes, ...reads, ...controls].map(item => item.promise)));
            const accepted = writes.filter(item => item.ok);
            const delivered = reads.filter(item => item.ok && !item.value.done);
            assert.equal(delivered.length, accepted.length, 'Each accepted write needs exactly one downstream record');
            for (let index = 0; index < accepted.length; index++) {
                assert.deepEqual(payloadOf(delivered[index].value.value, compression, accepted[index].noCompress), accepted[index].expected);
            }
            for (const item of writes.filter(item => !item.ok)) assert.ok([1, 8, 13].includes(item.value.code));
            assert.ok(cancelled <= 1, 'Repeated terminal operations notified cancellation twice');
            const late = tracked(request.write(Buffer.from([0xff]))); writes.push(late);
            await late.promise;
            assert.equal(late.ok, false, 'A terminal stream accepted a late write');
            request.end(); request.abort();
            await settledClean(request, reader, writes, reads);
            // Reacquiring is possible after every terminal path; a reader cannot
            // observe a stale codec completion after the terminal result.
            const after = request.body.getReader();
            const result = tracked(after.read()); await bounded(result.promise);
            if (result.ok) assert.equal(result.value.done, true);
            after.releaseLock();
            assert.equal(request.body.locked, false);
            assert.equal(request.bufferedBytes(), 0);
        } finally {
            request.abort();
            if (reader && request.body.locked) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
    }), { numRuns: 120 });
});

test('FUZZ property decoded and encoded request limits agree with an independent zlib oracle', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(codec, fc.uint8Array({ maxLength: 256 }), fc.boolean(),
        fc.constantFrom(-1, 0, 1), fc.constantFrom(-1, 0, 1),
        async (compression, input, noCompress, decodedOffset, wireOffset) => {
            const identity = compression === 'identity' || noCompress;
            const encoded = identity ? Buffer.from(input) : compression === 'gzip' ? zlib.gzipSync(input) : zlib.deflateSync(input);
            // Probe immediately below, at and above each independent boundary.
            const maxMessageBytes = Math.max(0, input.length + decodedOffset);
            const maxWireBytes = Math.max(1, encoded.length + wireOffset);
            const expectedSuccess = input.length <= maxMessageBytes && encoded.length <= maxWireBytes;
            const request = new RequestStreamBody({ maxMessageBytes, maxWireBytes, compression });
            const reader = request.body.getReader();
            const read = tracked(reader.read()), write = tracked(request.write(input, noCompress));
            request.end();
            try {
                await bounded(Promise.all([read.promise, write.promise]));
                assert.equal(write.ok, expectedSuccess);
                assert.equal(read.ok, expectedSuccess);
                if (expectedSuccess) {
                    assert.equal(read.value.done, false);
                    assert.deepEqual(payloadOf(read.value.value, compression, noCompress), Buffer.from(input));
                    assert.deepEqual(await bounded(reader.read()), { done: true, value: undefined });
                } else {
                    assert.equal(write.value.code, 8);
                    assert.equal(read.value.code, 8);
                }
                request.abort();
                await settledClean(request, reader, [write], [read]);
            } finally {
                request.abort();
                if (request.body.locked) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            }
        }), { numRuns: 80, examples: [
            ['identity', Uint8Array.of(1), false, -1, 0],
            ['identity', Uint8Array.of(1, 2), false, 0, -1],
            ['gzip', new Uint8Array(256).fill(0x41), false, -1, 1],
            ['deflate', new Uint8Array(256).fill(0x41), false, -1, 1],
            ['gzip', new Uint8Array(0), false, 0, 0],
            ['deflate', new Uint8Array(0), false, 0, 0],
        ] });
});
