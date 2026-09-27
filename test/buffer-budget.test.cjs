'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { ResourceBudget } = require('../dist/resources.js');
const { encodeFrame, encodeMessageFrame, decodeFrames } = require('../dist/wire.js');
const { transformMessage } = require('../dist/compression.js');
const { RequestStreamBody } = require('../dist/request-stream.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const used = budget => budget.diagnostics().bufferedBytes;
const exhausted = { code: 8, diagnostic: 'WGA_BUFFER_BUDGET' };
function source(chunks, hold = false) {
    let pulls = 0, cancelled = 0;
    const body = new ReadableStream({
        pull(controller) {
            const index = pulls++;
            if (index < chunks.length) controller.enqueue(chunks[index]);
            else if (!hold) controller.close();
        }, cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    return { body, get pulls() { return pulls; }, get cancelled() { return cancelled; } };
}

test('BUFFER encoding reserves output before allocation and releases compression scratch after framing', async t => {
    const input = Buffer.alloc(100, 65), tiny = new ResourceBudget({ maxBufferedBytes: 104 });
    const scope = tiny.scope();
    const allocate = Buffer.allocUnsafe;
    let allocations = 0;
    const mock = t.mock.method(Buffer, 'allocUnsafe', (...args) => { allocations++; return allocate(...args); });
    await assert.rejects(encodeMessageFrame(input, 'identity', 1024, undefined, false, scope), exhausted);
    assert.equal(allocations, 0);
    assert.equal(used(tiny), 0);
    mock.mock.restore(); scope.close();
    for (const encoding of ['identity', 'gzip', 'deflate']) {
        const budget = new ResourceBudget({ maxBufferedBytes: 4096 }), owner = budget.scope();
        const frame = await encodeMessageFrame(input, encoding, 1024, undefined, false, owner);
        assert.equal(used(budget), frame.length, 'only the returned frame remains owned');
        const decoded = encoding === 'identity' ? frame.subarray(5)
            : encoding === 'gzip' ? zlib.gunzipSync(frame.subarray(5)) : zlib.inflateSync(frame.subarray(5));
        assert.deepEqual(decoded, input);
        owner.close(); assert.equal(used(budget), 0);
    }
});

test('BUFFER codec output join reserves the second copy before Buffer.concat', async t => {
    for (const encoding of ['gzip', 'deflate']) {
        const original = Buffer.alloc(1024, 65);
        const packed = encoding === 'gzip' ? zlib.gzipSync(original) : zlib.deflateSync(original);
        const budget = new ResourceBudget({ maxBufferedBytes: original.length * 2 - 1 }), scope = budget.scope();
        const concat = Buffer.concat;
        let copies = 0;
        const mock = t.mock.method(Buffer, 'concat', (...args) => { copies++; return concat(...args); });
        await assert.rejects(transformMessage(packed, encoding, true, original.length, undefined, scope), exhausted);
        assert.equal(copies, 0, 'the refused joined output must never be allocated');
        assert.equal(used(budget), 0, 'retained codec chunks are released on failure');
        mock.mock.restore(); scope.close();
        const recoveredBudget = new ResourceBudget({ maxBufferedBytes: original.length * 2 }), recovered = recoveredBudget.scope();
        const result = await transformMessage(packed, encoding, true, original.length, undefined, recovered);
        assert.deepEqual(result, original);
        assert.equal(used(recoveredBudget), original.length);
        recovered.close(); assert.equal(used(recoveredBudget), 0);
    }
});

test('BUFFER fragmented and coalesced decoding holds one frame and current chunk until transfer', async () => {
    const messages = [Buffer.alloc(12, 1), Buffer.alloc(7, 2)], bytes = Buffer.concat(messages.map(value => encodeFrame(value)));
    for (const kind of ['coalesced', 'one-byte', 'offset-view']) {
        const chunks = kind === 'coalesced' ? [bytes] : Array.from(bytes, value => kind === 'one-byte'
            ? Uint8Array.of(value) : Uint8Array.of(99, value, 99).subarray(1, 2));
        const incoming = source(chunks), budget = new ResourceBudget({ maxBufferedBytes: 64 });
        const frames = decodeFrames(incoming.body, 32, undefined, { budget });
        for (const message of messages) {
            const item = await frames.next(); assert.deepEqual(item.value.payload, message);
            assert.equal(used(budget), 5 + message.length + (kind === 'coalesced' ? bytes.length : 1));
        }
        assert.equal((await frames.next()).done, true);
        assert.equal(used(budget), 0); assert.equal(incoming.body.locked, false); assert.equal(incoming.cancelled, 0);
    }
});

test('BUFFER header and declared payload reservations fail before allocation and cancel the reader', async t => {
    for (const [limit, declared, expectedPulls] of [[4, 32, 0], [20, 32, 1]]) {
        const header = Buffer.from([0, 0, 0, 0, declared]);
        const incoming = source([header], true), budget = new ResourceBudget({ maxBufferedBytes: limit });
        const allocate = Buffer.allocUnsafe, sizes = [];
        const mock = t.mock.method(Buffer, 'allocUnsafe', size => { sizes.push(size); return allocate(size); });
        const frames = decodeFrames(incoming.body, 128, undefined, { budget });
        await assert.rejects(frames.next(), exhausted);
        mock.mock.restore();
        assert.deepEqual(sizes, limit === 4 ? [] : [5]);
        assert.equal(incoming.pulls, expectedPulls); assert.equal(incoming.cancelled, 1);
        assert.equal(incoming.body.locked, false); assert.equal(used(budget), 0);
    }
});

test('BUFFER an oversized coalesced Fetch chunk fails even when each message is within its limit', async () => {
    const bytes = Buffer.concat(Array.from({ length: 4 }, () => encodeFrame(Buffer.alloc(8))));
    const incoming = source([bytes], true), budget = new ResourceBudget({ maxBufferedBytes: 32 });
    await assert.rejects(decodeFrames(incoming.body, 8, undefined, { budget }).next(), exhausted);
    assert.equal(incoming.cancelled, 1); assert.equal(incoming.body.locked, false); assert.equal(used(budget), 0);
    const recovered = source([encodeFrame(Buffer.from('ok'))]);
    const frames = [];
    for await (const frame of decodeFrames(recovered.body, 8, undefined, { budget })) frames.push(frame.payload);
    assert.deepEqual(frames, [Buffer.from('ok')]); assert.equal(used(budget), 0);
});

test('BUFFER compressed decoding accounts for wire and joined output and recovers after rejection', async () => {
    for (const encoding of ['gzip', 'deflate']) {
        const payload = Buffer.alloc(1024, 42);
        const packed = encoding === 'gzip' ? zlib.gzipSync(payload) : zlib.deflateSync(payload);
        const frame = encodeFrame(packed); frame[0] = 1;
        // Header, retained Fetch chunk, copied encoded payload, and two copies
        // of decoded output coexist while Buffer.concat joins codec chunks.
        const maximum = 5 + frame.length + packed.length + payload.length * 2;
        for (const delta of [-1, 0]) {
            const budget = new ResourceBudget({ maxBufferedBytes: maximum + delta });
            const incoming = source([frame], true), iterator = decodeFrames(incoming.body, payload.length, undefined, { encoding, budget });
            if (delta < 0) await assert.rejects(iterator.next(), exhausted);
            else {
                assert.deepEqual((await iterator.next()).value.payload, payload);
                assert.equal(used(budget), 5 + frame.length + packed.length + payload.length);
                await iterator.return();
            }
            assert.equal(incoming.cancelled, 1); assert.equal(incoming.body.locked, false); assert.equal(used(budget), 0);
        }
    }
});

test('BUFFER return and abort release frame/chunk ownership and source locks', async () => {
    for (const action of ['return', 'pending-abort']) {
        const incoming = source([encodeFrame(Buffer.from('first'))], true), budget = new ResourceBudget({ maxBufferedBytes: 128 });
        const controller = new AbortController(), frames = decodeFrames(incoming.body, 32, controller.signal, { budget });
        await frames.next(); assert.ok(used(budget) > 0);
        if (action === 'return') await frames.return();
        else {
            const pending = frames.next(); await turn(); controller.abort();
            await assert.rejects(pending, { code: 1, diagnostic: 'WGA_ABORTED' });
        }
        assert.equal(incoming.cancelled, 1); assert.equal(incoming.body.locked, false); assert.equal(used(budget), 0);
    }
});

test('BUFFER local termination and lock release never wait for an uncooperative source cancellation', async () => {
    for (const action of ['budget-error', 'return', 'pending-abort']) {
        let releaseCancel, cancels = 0, pulls = 0;
        const cleanup = new Promise(resolve => { releaseCancel = resolve; });
        const bytes = encodeFrame(Buffer.alloc(8));
        const body = new ReadableStream({
            pull(controller) { if (pulls++ === 0) controller.enqueue(bytes); },
            cancel() { cancels++; return cleanup; },
        }, { highWaterMark: 0 });
        const budget = new ResourceBudget({ maxBufferedBytes: action === 'budget-error' ? 10 : 256 });
        const controller = new AbortController();
        const frames = decodeFrames(body, 32, controller.signal, { budget });
        let operation, result;
        try {
            if (action === 'budget-error') operation = frames.next();
            else {
                await frames.next();
                operation = action === 'return' ? frames.return() : frames.next();
                if (action === 'pending-abort') { await turn(); controller.abort(); }
            }
            operation = operation.then(value => { result = { value }; }, error => { result = { error }; });
            await turn(); await turn();
            assert.ok(result, 'local completion must precede resolution of the source cancel promise');
            if (action === 'return') assert.equal(result.value.done, true);
            else assert.equal(result.error.code, action === 'budget-error' ? 8 : 1);
            assert.equal(cancels, 1); assert.equal(body.locked, false); assert.equal(used(budget), 0);
        } finally { releaseCancel(); await operation; }
    }
});

test('BUFFER request uploads retain only their frame after compression and release on downstream pull', { timeout: 5000 }, async () => {
    for (const compression of ['identity', 'gzip', 'deflate']) {
        const budget = new ResourceBudget({ maxBufferedBytes: 4096 });
        const request = new RequestStreamBody({ maxMessageBytes: 1024, maxWireBytes: 1024, compression, budget });
        const input = Buffer.alloc(256, 42), write = request.write(input);
        while (request.bufferedBytes() === input.length) await turn();
        assert.equal(used(budget), request.bufferedBytes());
        assert.ok(used(budget) > 0);
        const reader = request.body.getReader(); await reader.read(); await write;
        assert.equal(used(budget), 0);
        request.end(); assert.equal((await reader.read()).done, true); reader.releaseLock();
    }
});

test('BUFFER refused upload snapshot never copies input or retains bytes', async t => {
    const budget = new ResourceBudget({ maxBufferedBytes: 3 });
    const request = new RequestStreamBody({ maxMessageBytes: 1024, maxWireBytes: 1024, compression: 'identity', budget });
    const input = Buffer.alloc(4), from = Buffer.from;
    let copies = 0;
    const mock = t.mock.method(Buffer, 'from', (...args) => { copies++; return from(...args); });
    await assert.rejects(request.write(input), exhausted);
    assert.equal(copies, 0); mock.mock.restore();
    assert.equal(used(budget), 0); assert.equal(request.bufferedBytes(), 0);
    const reader = request.body.getReader(); await assert.rejects(reader.read(), exhausted); reader.releaseLock();
});

test('BUFFER upload framing rejection releases its input and accepted frames release on terminal response or cancellation', async () => {
    const bounded = new ResourceBudget({ maxBufferedBytes: 24 });
    const refused = new RequestStreamBody({ maxMessageBytes: 1024, maxWireBytes: 1024, compression: 'identity', budget: bounded });
    await assert.rejects(refused.write(Buffer.alloc(10)), exhausted); // 10-byte snapshot plus 15-byte frame.
    assert.equal(used(bounded), 0); assert.equal(refused.bufferedBytes(), 0);
    const failedReader = refused.body.getReader(); await assert.rejects(failedReader.read(), exhausted); failedReader.releaseLock();
    for (const action of ['terminal-response', 'downstream-cancel']) {
        const request = new RequestStreamBody({ maxMessageBytes: 1024, maxWireBytes: 1024, compression: 'identity', budget: bounded });
        const rejected = assert.rejects(request.write(Buffer.alloc(4)), { code: 1 });
        await turn(); assert.equal(used(bounded), 9);
        if (action === 'terminal-response') request.closeFromResponse();
        else await request.body.cancel();
        await rejected;
        assert.equal(used(bounded), 0); assert.equal(request.bufferedBytes(), 0);
        const reader = request.body.getReader(); assert.equal((await reader.read()).done, true); reader.releaseLock();
    }
});

test('BUFFER cancel during compression cannot enqueue late frames or reserve after scope closure', async () => {
    const budget = new ResourceBudget({ maxBufferedBytes: 2 * 1024 * 1024 });
    const request = new RequestStreamBody({ maxMessageBytes: 1024 * 1024, maxWireBytes: 1024 * 1024, compression: 'gzip', budget });
    const pending = request.write(Buffer.alloc(1024 * 1024, 5));
    assert.equal(used(budget), 1024 * 1024);
    const rejected = assert.rejects(pending, { code: 1 });
    request.abort(); await rejected; await turn(); await turn();
    assert.equal(used(budget), 0); assert.equal(request.bufferedBytes(), 0);
    const reader = request.body.getReader(); await assert.rejects(reader.read(), { code: 1 }); reader.releaseLock();
    const scope = budget.scope();
    const encoding = transformMessage(Buffer.alloc(100000, 2), 'gzip', false, 200000, undefined, scope);
    scope.close();
    await assert.rejects(encoding, { code: 1, diagnostic: 'WGA_BUFFER_SCOPE_CLOSED' });
    assert.equal(used(budget), 0);
});

test('BUFFER same-turn cancellation cannot reuse bytes still owned by encoding Promise continuations', async t => {
    for (const compression of ['identity', 'gzip', 'deflate']) {
        const budget = new ResourceBudget({ maxBufferedBytes: compression === 'identity' ? 40 : 24 });
        const writes = [], afterAbort = [], input = Buffer.alloc(12, 42);
        const from = Buffer.from, allocate = Buffer.allocUnsafe;
        let copiedInputs = 0, framedBytes = 0;
        const copyMock = t.mock.method(Buffer, 'from', (...args) => {
            if (args[0] === input) copiedInputs++;
            return from(...args);
        });
        const frameMock = t.mock.method(Buffer, 'allocUnsafe', (...args) => {
            if (args[0] === 17) framedBytes += 17;
            return allocate(...args);
        });
        try {
            // No await: fulfilled identity frames and aborted codec operations
            // are still retained by their queued Promise continuations.
            for (let index = 0; index < 3; index++) {
                const request = new RequestStreamBody({ maxMessageBytes: 100, maxWireBytes: 100, compression, budget });
                writes.push(request.write(input).then(() => 0, error => error.code));
                request.abort();
                afterAbort.push(used(budget));
                assert.equal(request.bufferedBytes(), 0, 'local producer cleanup remains immediate');
            }
        } finally { frameMock.mock.restore(); copyMock.mock.restore(); }
        if (compression === 'identity') {
            assert.deepEqual(afterAbort, [29, 29, 29]);
            assert.equal(copiedInputs, 1); assert.equal(framedBytes, 17);
            assert.deepEqual(await Promise.all(writes), [1, 8, 8]);
        } else {
            assert.deepEqual(afterAbort, [12, 24, 24]);
            assert.equal(copiedInputs, 2); assert.equal(framedBytes, 0);
            assert.deepEqual(await Promise.all(writes), [1, 1, 8]);
        }
        await turn();
        assert.equal(used(budget), 0);
        assert.ok(budget.diagnostics().peakBufferedBytes <= budget.limits.maxBufferedBytes);
        const recovered = new RequestStreamBody({ maxMessageBytes: 100, maxWireBytes: 100, compression: 'identity', budget });
        const write = recovered.write(Buffer.from([1])), reader = recovered.body.getReader();
        assert.equal((await reader.read()).value.length, 6); await write;
        recovered.end(); assert.equal((await reader.read()).done, true); reader.releaseLock();
        assert.equal(used(budget), 0);
    }
});
