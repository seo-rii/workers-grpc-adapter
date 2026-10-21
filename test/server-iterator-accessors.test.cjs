'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');

const method = { path: '/fixture.Accessor/Stream', responseStream: true,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };

function frame(bytes) {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}
// Independent response oracle: do not use the adapter's encoder or decoder.
function observe(bytes) {
    const messages = [], statuses = [];
    for (let offset = 0; offset < bytes.length;) {
        assert.equal(statuses.length, 0, 'No frame follows terminal status');
        assert.ok(offset + 5 <= bytes.length, 'Complete frame header');
        const flag = bytes[offset], length = bytes.readUInt32BE(offset + 1);
        offset += 5;
        assert.ok(offset + length <= bytes.length, 'Complete frame payload');
        const payload = bytes.subarray(offset, offset + length);
        offset += length;
        if (flag === 0) messages.push(payload.toString());
        else {
            assert.equal(flag, 128);
            const text = payload.toString();
            const code = /(?:^|\r\n)grpc-status: (\d+)\r\n/.exec(text);
            const details = /(?:^|\r\n)grpc-message: ([^\r\n]*)\r\n/.exec(text);
            assert.ok(code); assert.ok(details);
            statuses.push({ code: Number(code[1]), details: decodeURIComponent(details[1]) });
        }
    }
    assert.equal(statuses.length, 1, 'Exactly one terminal status');
    return { messages, status: statuses[0] };
}
async function withClock(work) {
    const saved = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const timers = new Set();
    let now = 1700000000000;
    Date.now = () => now;
    // Withhold the timer callback: an accessor may exhaust the absolute budget
    // before an overdue timer gets an event-loop turn.
    globalThis.setTimeout = callback => { const timer = { callback }; timers.add(timer); return timer; };
    globalThis.clearTimeout = timer => timers.delete(timer);
    try {
        await work({ expire() { now += 1000; } });
        assert.equal(timers.size, 0, 'Completion releases the server timer');
    } finally {
        Date.now = saved.now;
        globalThis.setTimeout = saved.setTimeout;
        globalThis.clearTimeout = saved.clearTimeout;
    }
}

async function exercise({ boundary, termination, position, requestStream, promised = true, callable = false }, clock) {
    const caller = new AbortController();
    const events = [], results = [];
    let context, reads = 0, returned = 0, nextGetters = 0, serialized = 0;
    let nextAfterInterruption = 0, serializedAfterInterruption = 0;
    function interrupt() {
        if (termination === 'none') return;
        events.push('interrupt');
        if (termination === 'abort') caller.abort();
        // Also expire after abort: an already selected cancellation must retain
        // its original code instead of changing to DEADLINE_EXCEEDED.
        clock.expire();
    }
    function next() {
        assert.equal(this, iterator, 'Keep the iterator method receiver');
        events.push('next');
        if (context.signal.aborted || context.deadline <= Date.now()) nextAfterInterruption++;
        const index = reads++;
        const target = index === position;
        const counts = { done: 0, value: 0 };
        results.push(counts);
        const record = callable ? function () {} : {};
        Object.defineProperties(record, {
            done: { get() {
                assert.equal(++counts.done, 1, 'Read each done property once');
                if (target && boundary === 'done') interrupt();
                return index === 2;
            } },
            value: { get() {
                assert.notEqual(index, 2, 'Do not inspect the value after normal EOF');
                assert.equal(++counts.value, 1, 'Read each value property once');
                if (target && boundary === 'value') interrupt();
                return Buffer.from(String(index));
            } },
        });
        return promised ? Promise.resolve(record) : record;
    }
    // Retrieving a method must not invoke its own arbitrary call property.
    next.call = undefined;
    const iterator = {
        get next() {
            nextGetters++;
            events.push('next-getter');
            if (reads === position && boundary === 'next') interrupt();
            return next;
        },
        return() {
            assert.equal(this, iterator, 'Keep the cleanup method receiver');
            events.push('return'); returned++;
            return Promise.resolve({ done: true });
        },
    };
    const handle = createGrpcWebHandler({ call: { ...method, requestStream, responseSerialize(bytes) {
        serialized++;
        if (context.signal.aborted || context.deadline <= Date.now()) serializedAfterInterruption++;
        return bytes;
    } } }, { call(_input, ctx) {
        context = ctx;
        return { [Symbol.asyncIterator]() { return iterator; } };
    } });
    const request = new Request('https://fixture.test' + method.path, { method: 'POST', signal: caller.signal,
        headers: { 'content-type': 'application/grpc-web+proto', 'grpc-timeout': '1000m' }, body: frame(Buffer.alloc(0)) });
    try {
        const response = await handle(request);
        const result = observe(Buffer.from(await response.arrayBuffer()));
        const interrupted = termination !== 'none';
        const expectedMessages = interrupted ? Array.from({ length: position }, (_, index) => String(index)) : ['0', '1'];
        assert.deepEqual(result.messages, expectedMessages, 'Do not emit an item after the interruption');
        assert.deepEqual(result.status, interrupted
            ? { code: termination === 'abort' ? 1 : 4, details: termination === 'abort' ? 'WGA_SERVER_CANCELLED' : 'WGA_SERVER_DEADLINE' }
            : { code: 0, details: '' });
        assert.equal(returned, Number(interrupted), 'Clean up exactly once, except after normal EOF');
        assert.equal(context.signal.aborted, interrupted);
        assert.equal(nextAfterInterruption, 0, 'Do not start next() after cancellation or expiry');
        assert.equal(serializedAfterInterruption, 0, 'Do not start serialization after cancellation or expiry');
        assert.equal(serialized, interrupted ? position : 2);
        assert.equal(reads, interrupted ? position + Number(boundary !== 'next') : 3);
        assert.equal(nextGetters, interrupted ? position + 1 : 3, 'Retrieve next once per attempted read');
        if (interrupted && boundary === 'next') {
            assert.deepEqual(events.slice(-3), ['next-getter', 'interrupt', 'return'], 'No next() after iterator cleanup');
        }
        if (interrupted && boundary === 'done') assert.equal(results[position].value, 0, 'Do not inspect value after done cancels');
        assert.equal(request.body.locked, false, 'Release the input reader');
    } finally { caller.abort(); }
}

for (const termination of ['abort', 'deadline']) for (const requestStream of [false, true]) {
    for (const position of [0, 1]) for (const boundary of ['next', 'done', 'value']) for (const promised of [false, true]) {
        test(`SERVER rechecks ${boundary} accessor: ${termination}, inputStream=${requestStream}, item=${position}, promised=${promised}`,
            () => withClock(clock => exercise({ boundary, termination, position, requestStream, promised }, clock)));
    }
}
for (const requestStream of [false, true]) for (const promised of [false, true]) for (const callable of [false, true]) {
    test(`SERVER normal accessors preserve receivers and EOF: inputStream=${requestStream}, promised=${promised}, callable=${callable}`,
        () => withClock(clock => exercise({ boundary: 'none', termination: 'none', position: 0, requestStream, promised, callable }, clock)));
}
