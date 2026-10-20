'use strict';
const assert = require('node:assert/strict');
const { createGrpcWebHandler } = require('../dist/server.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
const method = { path: '/fixture.Retention/Call', requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };
function request(body, signal) {
    return new Request(`https://server.test${method.path}`, { method: 'POST', signal, body,
        headers: { 'content-type': 'application/grpc-web+proto' },
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
}
async function collectGarbage() {
    // WeakRef targets stay alive until their current job ends. Collect across
    // several event-loop turns so this checks reachability, not heap heuristics.
    for (let index = 0; index < 6; index++) { await turn(); global.gc(); }
    await turn();
}
const alive = refs => refs.filter(ref => ref.deref()).length;

async function responseRetention() {
    const messages = [], frames = [];
    let emitted = 0, returned = 0;
    const handle = createGrpcWebHandler({ call: { ...method, requestStream: false, responseStream: true } }, {
        call() { return { [Symbol.asyncIterator]() { return this; },
            next() {
                const value = Buffer.alloc(8192, emitted++ % 256);
                messages.push(new WeakRef(value));
                return Promise.resolve({ done: false, value });
            },
            return: async () => { returned++; return { done: true }; },
        }; },
    });
    const response = await handle(request(encodeFrame(Buffer.from('input'))));
    const reader = response.body.getReader();
    async function consume() {
        for (let count = 0; count < 1000; count++) {
            const entry = await reader.read();
            assert.equal(entry.done, false);
            assert.equal(entry.value.length, 8197);
            frames.push(new WeakRef(entry.value));
        }
    }
    await consume();
    await collectGarbage();
    const whileOpen = { messages: alive(messages), frames: alive(frames) };
    await reader.cancel();
    reader.releaseLock();
    await collectGarbage();
    return { whileOpen, afterCancel: { messages: alive(messages), frames: alive(frames) }, emitted, returned };
}

async function requestRetention() {
    const messages = [];
    const controller = new AbortController();
    let consumed = 0, produced = 0, cancelled = 0, reached;
    const ready = new Promise(resolve => { reached = resolve; });
    const handle = createGrpcWebHandler({ call: { ...method, requestStream: true, responseStream: false,
        requestDeserialize(bytes) { messages.push(new WeakRef(bytes)); return bytes; } } }, {
        async call(input) {
            for await (const value of input) {
                assert.equal(value.length, 8192);
                if (++consumed === 1000) reached();
            }
            return Buffer.alloc(0);
        },
    });
    const body = new ReadableStream({
        pull(stream) { if (produced++ < 1000) stream.enqueue(encodeFrame(Buffer.alloc(8192, produced % 256))); },
        cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    const pending = handle(request(body, controller.signal));
    await ready;
    await collectGarbage();
    const whileOpen = { messages: alive(messages) };
    controller.abort();
    let code;
    for await (const frame of decodeFrames((await pending).body, 1024)) if (frame.trailer) code = parseTrailers(frame.payload).code;
    await collectGarbage();
    return { whileOpen, afterCancel: { messages: alive(messages) }, consumed, cancelled, code, locked: body.locked };
}

if (process.argv[2] === 'retention-probe') {
    (process.argv[3] === 'response' ? responseRetention() : requestRetention())
        .then(result => console.log(JSON.stringify(result)), error => { console.error(error); process.exitCode = 1; });
} else {
    const test = require('node:test');
    const { spawnSync } = require('node:child_process');
    for (const direction of ['response', 'request']) {
        test(`SERVER releases consumed ${direction} buffers while the RPC remains open`, t => {
            const child = spawnSync(process.execPath, ['--expose-gc', __filename, 'retention-probe', direction],
                { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
            assert.equal(child.status, 0, child.stderr || String(child.error || 'retention probe failed'));
            const result = JSON.parse(child.stdout);
            t.diagnostic(JSON.stringify(result));
            // A currently suspended generator may own one current message;
            // ownership must stay bounded rather than track the stream history.
            for (const [kind, count] of Object.entries(result.whileOpen)) assert.ok(count <= 4, `${count} retained ${kind} while open`);
            for (const [kind, count] of Object.entries(result.afterCancel)) assert.ok(count <= 4, `${count} retained ${kind} after cancellation`);
            if (direction === 'response') { assert.equal(result.emitted, 1000); assert.equal(result.returned, 1); }
            else { assert.equal(result.consumed, 1000); assert.equal(result.cancelled, 1); assert.equal(result.code, 1); assert.equal(result.locked, false); }
        });
    }

    for (const pendingAt of ['handler', 'iterator']) {
        test(`SERVER contains late ${pendingAt} rejection after cancellation`, async () => {
            let rejectPending, entered, returned = 0, reads = 0;
            const ready = new Promise(resolve => { entered = resolve; });
            const pending = new Promise((_resolve, reject) => { rejectPending = reject; });
            const controller = new AbortController();
            const handle = createGrpcWebHandler({ call: { ...method, requestStream: false, responseStream: true } }, {
                call() {
                    if (pendingAt === 'handler') { entered(); return pending; }
                    return { [Symbol.asyncIterator]() { return this; },
                        next() { reads++; entered(); return pending; },
                        return: async () => { returned++; return { done: true }; },
                    };
                },
            });
            const response = handle(request(encodeFrame(Buffer.from('input')), controller.signal));
            await ready;
            controller.abort();
            const trailers = [];
            for await (const frame of decodeFrames((await response).body, 1024)) {
                assert.equal(frame.trailer, true, 'Cancellation cannot publish an application response');
                trailers.push(parseTrailers(frame.payload));
            }
            assert.equal(trailers.length, 1);
            assert.equal(trailers[0].code, 1);
            rejectPending(new Error('late private operation failure'));
            await turn();
            await turn();
            assert.equal(reads, pendingAt === 'iterator' ? 1 : 0);
            assert.equal(returned, pendingAt === 'iterator' ? 1 : 0);
        });
    }
}
