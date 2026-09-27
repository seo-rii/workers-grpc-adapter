'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { fc, check } = require('./property-helpers.cjs');
const { createGrpcWebHandler } = require('../dist/server.js');
const { Metadata } = require('../dist/index.js');

const turn = () => new Promise(resolve => setImmediate(resolve));
const codec = fc.constantFrom('identity', 'deflate', 'gzip');
const payload = fc.uint8Array({ maxLength: 256 });
const fragmentation = fc.record({
    sizes: fc.array(fc.integer({ min: 1, max: 41 }), { minLength: 1, maxLength: 7 }),
    empty: fc.boolean(), padding: fc.integer({ min: 1, max: 7 }),
});
const oneByte = { sizes: [1], empty: true, padding: 3 };
const definition = { echo: { path: '/fixture.Property/Echo', requestStream: false, responseStream: false,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes } };
function compress(bytes, encoding) {
    return encoding === 'gzip' ? zlib.gzipSync(bytes) : encoding === 'deflate' ? zlib.deflateSync(bytes) : Buffer.from(bytes);
}
// Independent protocol construction and whole-buffer response oracle. No adapter
// framing, compression, metadata or trailer decoder participates in the oracle.
function frame(bytes, flag = 0) {
    const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}
function responseRecords(bytes, encoding = 'identity') {
    const messages = [], trailers = [];
    for (let offset = 0; offset < bytes.length;) {
        assert.equal(trailers.length, 0, 'No record may follow terminal status');
        assert.ok(bytes.length - offset >= 5, 'Complete response frame header');
        const flag = bytes[offset], length = bytes.readUInt32BE(offset + 1);
        offset += 5;
        assert.ok(length <= bytes.length - offset, 'Complete response frame payload');
        const value = bytes.subarray(offset, offset + length); offset += length;
        assert.ok([0, 1, 128].includes(flag), 'Only message and uncompressed trailer flags are valid');
        if (flag === 128) {
            const fields = new Map();
            for (const line of value.toString('utf8').split('\r\n').filter(Boolean)) {
                const colon = line.indexOf(':'); assert.ok(colon > 0);
                const key = line.slice(0, colon), entry = line.slice(colon + 1).trim();
                const values = fields.get(key) ?? []; values.push(entry); fields.set(key, values);
            }
            assert.equal(fields.get('grpc-status')?.length, 1, 'Exactly one status field');
            assert.match(fields.get('grpc-status')[0], /^(?:[0-9]|1[0-6])$/);
            assert.equal(fields.get('grpc-message')?.length, 1, 'Exactly one message field');
            trailers.push({ code: Number(fields.get('grpc-status')[0]), details: decodeURIComponent(fields.get('grpc-message')[0]), fields });
        } else {
            assert.equal(flag, encoding === 'identity' ? 0 : 1, 'Response compression agrees with negotiated header');
            messages.push(flag === 0 ? value : encoding === 'gzip' ? zlib.gunzipSync(value) : zlib.inflateSync(value));
        }
    }
    assert.equal(trailers.length, 1, 'Exactly one terminal frame');
    return { messages, terminal: trailers[0] };
}
function source(bytes, plan, signal) {
    const chunks = [];
    for (let offset = 0, index = 0; offset < bytes.length; index++) {
        const end = Math.min(bytes.length, offset + plan.sizes[index % plan.sizes.length]);
        if (plan.empty) chunks.push(new Uint8Array(0));
        const storage = new Uint8Array(plan.padding + end - offset + 5).fill(0xfd);
        storage.set(bytes.subarray(offset, end), plan.padding);
        chunks.push(storage.subarray(plan.padding, plan.padding + end - offset)); offset = end;
    }
    const state = { pulled: 0, closed: false, cancelled: 0 };
    const body = new ReadableStream({ pull(controller) {
        state.pulled++;
        if (chunks.length) controller.enqueue(chunks.shift());
        else { state.closed = true; controller.close(); }
    }, cancel() { state.cancelled++; } }, { highWaterMark: 0 });
    return { body, state, request: headers => new Request('https://server.test/fixture.Property/Echo', {
        method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', ...headers }, body, duplex: 'half', signal,
    }) };
}
async function observed(response) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/grpc-web(?:\+proto)?$/);
    const result = responseRecords(Buffer.from(await response.arrayBuffer()), response.headers.get('grpc-encoding') ?? 'identity');
    return result;
}
function released(input) {
    assert.equal(input.body.locked, false, 'Request reader is released');
    assert.equal(input.state.cancelled, input.state.closed ? 0 : 1, 'Rejected unfinished body is cancelled exactly once');
}
async function bounded(promise) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Server operation did not settle')), 5000);
    })]); } finally { clearTimeout(timer); }
}

test('FUZZ property Fetch server preserves compressed fragmented calls and negotiates each response', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(payload, codec, fc.boolean(), codec, fc.boolean(), fc.boolean(),
        fc.array(payload, { minLength: 1, maxLength: 4 }), fragmentation, fc.boolean(),
        async (inputBytes, requestCodec, requestCompressed, responseCodec, acceptSelected, streaming, outputs, plan, requestStreaming) => {
            const compressRequest = requestCompressed && requestCodec !== 'identity';
            const requestValues = requestStreaming ? [inputBytes, ...outputs] : [inputBytes];
            const input = source(Buffer.concat(requestValues.map(value =>
                frame(compressRequest ? compress(value, requestCodec) : value, compressRequest ? 1 : 0))), plan);
            let calls = 0, deserialized = 0;
            const method = { ...definition.echo, requestStream: requestStreaming, responseStream: streaming, requestDeserialize(bytes) {
                assert.deepEqual(bytes, Buffer.from(requestValues[deserialized++])); return bytes;
            } };
            const handler = createGrpcWebHandler({ echo: method }, { async echo(value, context) {
                calls++;
                if (requestStreaming) { const received = []; for await (const part of value) received.push(part);
                    assert.deepEqual(received, requestValues.map(bytes => Buffer.from(bytes))); }
                else assert.deepEqual(value, Buffer.from(inputBytes));
                assert.deepEqual(context.metadata.get('trace-bin'), [Buffer.from(inputBytes)]);
                const metadata = new Metadata(); metadata.set('x-fixture', 'property'); context.sendMetadata(metadata);
                const trailing = new Metadata(); trailing.set('trace-bin', Buffer.from(inputBytes)); context.setTrailer(trailing);
                return streaming ? (async function* () { for (const output of outputs) yield output; })() : outputs[0];
            } }, { compression: ['identity', 'deflate', 'gzip'].indexOf(responseCodec) });
            const response = await handler(input.request({ 'grpc-encoding': requestCodec,
                'grpc-accept-encoding': acceptSelected ? ` identity , ${responseCodec} ` : 'identity',
                'trace-bin': Buffer.from(inputBytes).toString('base64') }));
            assert.equal(response.headers.get('grpc-encoding'), acceptSelected ? responseCodec : 'identity');
            assert.equal(response.headers.get('x-fixture'), 'property');
            const result = await observed(response);
            assert.deepEqual(result.messages, (streaming ? outputs : outputs.slice(0, 1)).map(bytes => Buffer.from(bytes)));
            assert.equal(result.terminal.code, 0);
            assert.deepEqual(result.terminal.fields.get('trace-bin'), [Buffer.from(inputBytes).toString('base64')]);
            assert.equal(calls, 1); assert.equal(deserialized, requestValues.length); released(input);
        }), { numRuns: 100, examples: [
            [new Uint8Array(0), 'gzip', true, 'gzip', true, true, [new Uint8Array(0)], oneByte, true],
            [Uint8Array.of(0, 128, 255), 'deflate', true, 'gzip', false, false, [Uint8Array.of(255)], oneByte, false],
        ] });
});

const malformedKinds = ['empty', 'truncated', 'second-message', 'trailer', 'message-trailer', 'partial-suffix',
    'flags', 'compressed-identity', 'unknown-codec', 'compressed-trailer', 'corrupt-gzip', 'corrupt-deflate', 'deserialize'];
test('FUZZ property Fetch server rejects malformed complete requests before application invocation', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(fc.constantFrom(...malformedKinds), payload, payload, fragmentation, fc.nat({ max: 65535 }),
        async (kind, first, second, plan, position) => {
            let bytes = frame(first), encoding = 'identity', expected = 3;
            if (kind === 'empty') bytes = Buffer.alloc(0);
            else if (kind === 'truncated') { bytes = bytes.subarray(0, 1 + position % (bytes.length - 1)); expected = 13; }
            else if (kind === 'second-message') bytes = Buffer.concat([bytes, frame(second)]);
            else if (kind === 'trailer') bytes = frame(second, 128);
            else if (kind === 'message-trailer') bytes = Buffer.concat([bytes, frame(second, 128)]);
            else if (kind === 'partial-suffix') { bytes = Buffer.concat([bytes, frame(second).subarray(0, 1 + position % 4)]); expected = 13; }
            else if (kind === 'flags') { bytes[0] = 2 + position % 126; expected = 13; }
            else if (kind === 'compressed-identity') { bytes[0] = 1; expected = 13; }
            else if (kind === 'unknown-codec') { bytes[0] = 1; encoding = 'unknown'; expected = 12; }
            else if (kind === 'compressed-trailer') { bytes[0] = 129; expected = 12; }
            else if (kind.startsWith('corrupt-')) {
                encoding = kind.slice(8); const encoded = compress(first, encoding);
                // Corrupt the checksum, not a decoder-dependent optional header.
                encoded[encoded.length - (encoding === 'gzip' ? 8 : 1)] ^= 1;
                bytes = frame(encoded, 1); expected = 13;
            }
            const input = source(bytes, plan); let calls = 0, deserialized = 0;
            const handler = createGrpcWebHandler({ echo: { ...definition.echo, requestDeserialize(value) {
                deserialized++; if (kind === 'deserialize') throw new Error('private decoder detail'); return value;
            } } }, { echo(value) { calls++; return value; } });
            const result = await observed(await handler(input.request({ 'grpc-encoding': encoding })));
            assert.equal(result.terminal.code, expected);
            assert.deepEqual(result.messages, []);
            assert.equal(calls, 0, 'Malformed request must not enter application handler');
            assert.equal(deserialized, kind === 'deserialize' ? 1 : 0, 'Framing validation precedes deserialization');
            assert.ok(!result.terminal.details.includes('private decoder detail'));
            released(input);
        }), { numRuns: 120, examples: malformedKinds.map(kind => [kind, new Uint8Array(0), Uint8Array.of(1), oneByte, 0]) });
});

test('FUZZ property Fetch server receive ceilings reject before deserialization across codecs', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(payload, codec, fc.constantFrom(-1, 0, 1), fc.constantFrom(-1, 0, 1), fragmentation,
        async (bytes, encoding, decodedOffset, wireOffset, plan) => {
            const encoded = compress(bytes, encoding);
            // The server also caps decoded limits by its wire ceiling. Keep
            // that ceiling high enough to isolate decompression expansion.
            const receive = Math.max(0, bytes.length + decodedOffset), wire = Math.max(0, Math.max(bytes.length, encoded.length) + wireOffset);
            const success = bytes.length <= receive && bytes.length <= wire && encoded.length <= wire;
            const input = source(frame(encoded, encoding === 'identity' ? 0 : 1), plan);
            let deserialized = 0, calls = 0;
            const handler = createGrpcWebHandler({ echo: { ...definition.echo, requestDeserialize(value) { deserialized++; return value; } } },
                { echo(value) { calls++; return value; } }, { maxReceiveMessageBytes: receive, maxWireMessageBytes: wire });
            const result = await observed(await handler(input.request({ 'grpc-encoding': encoding })));
            assert.equal(result.terminal.code, success ? 0 : 8);
            assert.deepEqual(result.messages, success ? [Buffer.from(bytes)] : []);
            assert.equal(calls, Number(success)); assert.equal(deserialized, Number(success)); released(input);
        }), { numRuns: 80, examples: [
            [new Uint8Array(0), 'gzip', 0, -1, oneByte],
            [new Uint8Array(256).fill(65), 'gzip', -1, 0, oneByte],
            [new Uint8Array(256).fill(65), 'deflate', 1, 1, oneByte],
            [Uint8Array.of(1), 'identity', 0, 0, oneByte],
        ] });
});

test('FUZZ property Fetch server send ceilings produce one terminal status without partial messages', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(payload, codec, fc.constantFrom(-1, 0, 1), fc.constantFrom(-1, 0, 1),
        async (bytes, encoding, decodedOffset, wireOffset) => {
            const encoded = compress(bytes, encoding);
            const send = Math.max(0, bytes.length + decodedOffset), wire = Math.max(0, Math.max(bytes.length, encoded.length) + wireOffset);
            const success = bytes.length <= send && bytes.length <= wire && encoded.length <= wire;
            const input = source(frame(Buffer.alloc(0)), oneByte); let calls = 0, serialized = 0;
            const handler = createGrpcWebHandler({ echo: { ...definition.echo, responseSerialize(value) { serialized++; return value; } } },
                { echo() { calls++; return bytes; } }, { compression: ['identity', 'deflate', 'gzip'].indexOf(encoding),
                    maxSendMessageBytes: send, maxWireMessageBytes: wire });
            const result = await observed(await handler(input.request({ 'grpc-accept-encoding': 'identity,gzip,deflate' })));
            assert.equal(result.terminal.code, success ? 0 : 8);
            assert.deepEqual(result.messages, success ? [Buffer.from(bytes)] : []);
            assert.equal(calls, 1); assert.equal(serialized, 1); released(input);
        }), { numRuns: 80, examples: [
            [new Uint8Array(0), 'gzip', 0, -1], [new Uint8Array(0), 'identity', 0, 0],
            [new Uint8Array(256).fill(65), 'deflate', 0, 0], [Uint8Array.of(1), 'identity', -1, 1],
        ] });
});

test('FUZZ property Fetch server cancellation stops iterator pulls and disposes exactly once', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(fc.array(payload, { minLength: 1, maxLength: 6 }), codec, fc.nat({ max: 65535 }),
        fc.constantFrom('request-abort', 'response-cancel'), async (outputs, encoding, position, kind) => {
            const take = position % (outputs.length + 1), aborter = new AbortController();
            let calls = 0, next = 0, returned = 0, signal, cancelled = 0;
            const input = source(frame(Buffer.alloc(0)), oneByte, aborter.signal);
            const handler = createGrpcWebHandler({ echo: { ...definition.echo, responseStream: true } }, { echo(_value, context) {
                calls++; signal = context.signal; signal.addEventListener('abort', () => { cancelled++; });
                return { [Symbol.asyncIterator]() { return this; },
                    async next() { const index = next++; return index < outputs.length ? { done: false, value: outputs[index] } : { done: true }; },
                    async return() { returned++; return { done: true }; },
                };
            } }, { compression: ['identity', 'deflate', 'gzip'].indexOf(encoding) });
            const response = await handler(input.request({ 'grpc-accept-encoding': 'identity,gzip,deflate' }));
            const reader = response.body.getReader(), chunks = [];
            try {
                assert.equal(next, 1, 'Only the first response is prefetched');
                for (let index = 0; index < take; index++) {
                    const item = await bounded(reader.read()); assert.equal(item.done, false); chunks.push(Buffer.from(item.value));
                }
                await turn(); assert.equal(next, Math.max(1, take), 'No speculative iterator pull without response demand');
                const nextAtStop = next;
                if (kind === 'request-abort') {
                    aborter.abort();
                    for (;;) { const item = await bounded(reader.read()); if (item.done) break; chunks.push(Buffer.from(item.value)); }
                    const result = responseRecords(Buffer.concat(chunks), encoding);
                    assert.equal(result.terminal.code, 1);
                    assert.deepEqual(result.messages, outputs.slice(0, take).map(bytes => Buffer.from(bytes)));
                } else {
                    await reader.cancel(); await reader.cancel();
                    assert.equal((await bounded(reader.read())).done, true);
                }
                aborter.abort(); await turn();
                assert.equal(next, nextAtStop, 'A terminal response must not call iterator.next after disposal');
                assert.equal(returned, 1); assert.equal(cancelled, 1); assert.equal(signal.aborted, true); assert.equal(calls, 1);
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
            released(input);
        }), { numRuns: 100, examples: [
            [[Uint8Array.of(1), Uint8Array.of(2)], 'identity', 1, 'request-abort'],
            [[new Uint8Array(0)], 'gzip', 0, 'response-cancel'],
        ] });
});
