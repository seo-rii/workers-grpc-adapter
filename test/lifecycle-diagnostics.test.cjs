'use strict';
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const { assert, grpc, client, deferred, immediate, trailers, response } = require('./helpers.cjs');
const { decodeFrames, encodeFrame } = require('../dist/wire.js');

const empty = Object.freeze({ activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
    pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 });
const emptyParser = Object.freeze({ parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 });
function harness(fetch, { streaming = false, channelOptions = {} } = {}) {
    const c = client(channelOptions, { fetcher: { fetch }, ...(streaming ? {
        mode: 'grpc-web', endpoints: { 'echo.test:443': 'https://gateway.test' }, experimentalRequestStreaming: true,
    } : {}) });
    return { c, start() {
        const statuses = [], messages = [], done = deferred();
        const call = c.getChannel().createCallForMethod('/demo.Echo/Stream', streaming, true, {});
        call.start(new grpc.Metadata(), { onReceiveMetadata() {}, onReceiveMessage(message) { messages.push(message); },
            onReceiveStatus(result) { statuses.push(result.code); done.resolve(result); },
        });
        return { call, statuses, messages, done: done.promise };
    } };
}
async function until(predicate, description) {
    for (let turn = 0; turn < 30; turn++) {
        if (predicate()) return;
        await immediate();
    }
    assert.ok(predicate(), description);
}
async function drained(call) {
    await until(() => Object.entries(empty).every(([key, value]) => call.executionDiagnostics()[key] === value), 'execution owners must unwind');
    assert.deepEqual(call.executionDiagnostics(), empty);
}
function beginRequest(call) {
    call.sendMessageWithContext({}, Buffer.from('request'));
    call.halfClose();
}

test('EXECUTION cancellation retains the active Fetch owner until a late resolve or reject', async t => {
    for (const outcome of ['resolve', 'reject']) {
        const entered = deferred(), fetchGate = deferred();
        let aborts = 0, bodyCancels = 0;
        const h = harness((_url, init) => {
            init.signal.addEventListener('abort', () => { aborts++; }, { once: true });
            entered.resolve(); return fetchGate.promise;
        });
        t.after(() => { h.c.close(); fetchGate.resolve(response()); });
        const { call, statuses, messages, done } = h.start();
        beginRequest(call); await entered.promise;
        assert.deepEqual(call.executionDiagnostics(), { ...empty, activePumps: 1 });
        const snapshot = call.executionDiagnostics(); snapshot.activePumps = 99;
        assert.equal(call.executionDiagnostics().activePumps, 1, 'snapshots cannot mutate counters');
        call.cancelWithStatus(grpc.status.CANCELLED, 'cancel late fetch');
        assert.deepEqual(call.executionDiagnostics(), { ...empty, activePumps: 1 });
        assert.equal((await done).code, grpc.status.CANCELLED);
        assert.equal(h.c.getChannel().activeCallCount(), 0);
        assert.equal(call.executionDiagnostics().activePumps, 1, 'logical completion is not owner cleanup');
        assert.deepEqual(call.diagnostics(), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
        if (outcome === 'resolve') fetchGate.resolve(new Response(new ReadableStream({ cancel() { bodyCancels++; } }),
            { headers: { 'content-type': 'application/grpc-web+proto' } }));
        else fetchGate.reject(new Error('late fetch rejection'));
        await drained(call);
        assert.deepEqual(statuses, [grpc.status.CANCELLED]); assert.deepEqual(messages, []);
        assert.equal(aborts, 1); assert.equal(bodyCancels, outcome === 'resolve' ? 1 : 0);
        h.c.close();
    }
});

test('EXECUTION partial header and payload remain counted through cancellation until the read unwinds', async t => {
    for (const kind of ['header', 'payload']) {
        const frame = encodeFrame(Buffer.from('payload'));
        let cancels = 0;
        const body = new ReadableStream({ start(controller) { controller.enqueue(frame.subarray(0, kind === 'header' ? 2 : 7)); },
            cancel() { cancels++; },
        }, { highWaterMark: 0 });
        const h = harness(async () => new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } }));
        t.after(() => h.c.close());
        const { call, statuses, done } = h.start(); beginRequest(call);
        const bytes = kind === 'header' ? 5 : frame.length;
        await until(() => call.executionDiagnostics().parserAssemblyBytes === bytes && call.executionDiagnostics().runtimeChunkBytes === 0,
            'parser must wait for the rest of the allocation');
        const held = { ...empty, activePumps: 1, parserAssemblies: 1, parserAssemblyBytes: bytes };
        assert.deepEqual(call.executionDiagnostics(), held); assert.equal(body.locked, true);
        call.cancelWithStatus(grpc.status.CANCELLED, 'cancel read');
        assert.deepEqual(call.executionDiagnostics(), held, 'cancel cannot erase the suspended reader ownership');
        assert.equal((await done).code, grpc.status.CANCELLED);
        await drained(call);
        assert.equal(body.locked, false); assert.equal(cancels, 1);
        assert.deepEqual(statuses, [grpc.status.CANCELLED]); h.c.close();
    }
});

test('EXECUTION a message waiting for demand retains its frame and runtime chunk until cancellation unwinds', async t => {
    const payload = Buffer.from('pending'), frame = encodeFrame(payload), bytes = Buffer.concat([frame, trailers()]);
    let cancels = 0;
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancels++; } }, { highWaterMark: 0 });
    const h = harness(async () => new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } }));
    t.after(() => h.c.close());
    const { call, messages, statuses, done } = h.start(); beginRequest(call);
    await until(() => call.executionDiagnostics().pendingMessages === 1, 'message must wait for read demand');
    const held = { ...empty, activePumps: 1, pendingMessages: 1, pendingMessageBytes: payload.length,
        parserAssemblies: 1, parserAssemblyBytes: frame.length, runtimeChunkBytes: bytes.length };
    assert.deepEqual(call.executionDiagnostics(), held);
    call.cancelWithStatus(grpc.status.CANCELLED, 'cancel pending message');
    assert.deepEqual(call.executionDiagnostics(), held);
    assert.equal(call.diagnostics().responseBytes, 0, 'legacy diagnostics keep their existing terminal contract');
    await done; await drained(call);
    assert.deepEqual(messages, []); assert.deepEqual(statuses, [grpc.status.CANCELLED]);
    assert.equal(cancels, 1); assert.equal(body.locked, false);
});

test('EXECUTION queued write acknowledgement survives cancellation and decrements before reentrant writes', async t => {
    const h = harness(async () => { assert.fail('a cancelled pre-Fetch call cannot fetch'); });
    t.after(() => h.c.close());
    const { call, done, statuses } = h.start(), callbacks = [];
    call.sendMessageWithContext({ callback(error) {
        assert.ifError(error); callbacks.push(['first', call.executionDiagnostics().pendingWriteCallbacks]);
        call.sendMessageWithContext({ callback(lateError) {
            assert.match(lateError.message, /WGA_CALL_TERMINATED/);
            callbacks.push(['late', call.executionDiagnostics().pendingWriteCallbacks]);
        } }, Buffer.from('late'));
        assert.equal(call.executionDiagnostics().pendingWriteCallbacks, 1);
    } }, Buffer.from('first'));
    assert.equal(call.executionDiagnostics().pendingWriteCallbacks, 1);
    call.cancelWithStatus(grpc.status.CANCELLED, 'cancel queued write ack');
    assert.equal(call.executionDiagnostics().pendingWriteCallbacks, 1);
    await done; await drained(call);
    assert.deepEqual(callbacks, [['first', 0], ['late', 0]]);
    assert.deepEqual(statuses, [grpc.status.CANCELLED]);
});

test('EXECUTION every unary write error path releases its callback ownership exactly once', async t => {
    for (const kind of ['invalid-flags', 'oversized', 'multiple', 'terminated']) {
        const h = harness(async () => { assert.fail('write failure cannot fetch'); }, { channelOptions: { 'grpc.max_send_message_length': 4 } });
        t.after(() => h.c.close());
        const { call, done } = h.start(), callbacks = [];
        if (kind === 'terminated') call.cancelWithStatus(grpc.status.CANCELLED, 'before write');
        if (kind === 'multiple') call.sendMessageWithContext({ callback(error) {
            assert.ifError(error); callbacks.push(['first', call.executionDiagnostics().pendingWriteCallbacks]);
        } }, Buffer.from('one'));
        call.sendMessageWithContext({ ...(kind === 'invalid-flags' ? { flags: 4 } : {}), callback(error) {
            assert.ok(error instanceof Error); callbacks.push(['error', call.executionDiagnostics().pendingWriteCallbacks]);
        } }, Buffer.from(kind === 'oversized' ? 'large' : 'two'));
        assert.equal(call.executionDiagnostics().pendingWriteCallbacks, kind === 'invalid-flags' ? 0 : kind === 'multiple' ? 2 : 1);
        await done; await drained(call);
        assert.deepEqual(callbacks, kind === 'multiple' ? [['first', 1], ['error', 0]] : [['error', 0]]);
        h.c.close();
    }
});

test('EXECUTION streaming write remains counted while upload acceptance and response completion are pending', async t => {
    for (const kind of ['accepted', 'cancelled', 'upload-stopped']) {
        const entered = deferred(), fetchGate = deferred();
        let upload, controller;
        const responseBody = new ReadableStream({ start(value) { controller = value; } }, { highWaterMark: 0 });
        const h = harness(async (_url, init) => {
            upload = init.body;
            if (kind === 'upload-stopped') await upload.cancel();
            entered.resolve();
            return kind === 'upload-stopped' ? new Response(responseBody, { headers: { 'content-type': 'application/grpc-web+proto' } }) : fetchGate.promise;
        }, { streaming: true });
        t.after(() => { h.c.close(); fetchGate.resolve(response()); });
        const { call, done } = h.start(), callbacks = [];
        call.sendMessageWithContext({ callback(error) {
            callbacks.push({ error: error?.message, pending: call.executionDiagnostics().pendingWriteCallbacks });
        } }, Buffer.from('streaming'));
        await entered.promise;
        assert.equal(call.executionDiagnostics().pendingWriteCallbacks, 1);
        if (kind === 'accepted') {
            const reader = upload.getReader();
            assert.deepEqual(Buffer.from((await reader.read()).value), encodeFrame(Buffer.from('streaming')));
            reader.releaseLock();
            await until(() => callbacks.length === 1, 'upload acceptance must acknowledge the write');
            assert.deepEqual(callbacks, [{ error: undefined, pending: 0 }]);
            call.cancelWithStatus(grpc.status.CANCELLED, 'after acceptance');
        } else if (kind === 'cancelled') {
            call.cancelWithStatus(grpc.status.CANCELLED, 'pending upload');
            assert.equal(call.executionDiagnostics().pendingWriteCallbacks, 1);
        } else {
            await until(() => call.executionDiagnostics().parserAssemblyBytes === 5, 'response must wait after upload cancellation');
            assert.equal(callbacks.length, 0, 'remote status remains ahead of the stopped upload callback');
            assert.equal(call.executionDiagnostics().pendingWriteCallbacks, 1);
            controller.enqueue(trailers(grpc.status.PERMISSION_DENIED)); controller.close();
        }
        assert.equal((await done).code, kind === 'upload-stopped' ? grpc.status.PERMISSION_DENIED : grpc.status.CANCELLED);
        fetchGate.resolve(response()); await drained(call);
        assert.equal(callbacks.length, 1); assert.equal(callbacks[0].pending, 0);
        if (kind !== 'accepted') assert.equal(typeof callbacks[0].error, 'string');
        h.c.close();
    }
});

test('EXECUTION malformed frames unwind parser ownership and the same client can recover', async t => {
    let fetches = 0, cancels = 0, malformedBody;
    const h = harness(async () => {
        if (fetches++) return response();
        malformedBody = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from([2, 0, 0, 0, 0])); },
            cancel() { cancels++; },
        }, { highWaterMark: 0 });
        return new Response(malformedBody, { headers: { 'content-type': 'application/grpc-web+proto' } });
    });
    t.after(() => h.c.close());
    const failed = h.start(); beginRequest(failed.call); failed.call.startRead();
    assert.equal((await failed.done).code, grpc.status.INTERNAL); await drained(failed.call);
    assert.equal(malformedBody.locked, false); assert.equal(cancels, 1);
    assert.deepEqual(failed.statuses, [grpc.status.INTERNAL]);
    const recovered = h.start(); beginRequest(recovered.call); recovered.call.startRead();
    assert.equal((await recovered.done).code, grpc.status.OK); await drained(recovered.call);
    assert.equal(recovered.messages.length, 1); assert.equal(fetches, 2);
    assert.equal(h.c.getChannel().activeCallCount(), 0);
});

test('EXECUTION parser diagnostics retain a yielded compressed frame until actual iterator cleanup', async () => {
    const payload = Buffer.alloc(1024, 65), packed = gzipSync(payload), frame = encodeFrame(packed); frame[0] = 1;
    let cancels = 0;
    const body = new ReadableStream({ start(controller) { controller.enqueue(frame); }, cancel() { cancels++; } }, { highWaterMark: 0 });
    const aborter = new AbortController(), diagnostics = { ...emptyParser };
    const iterator = decodeFrames(body, payload.length, aborter.signal, { encoding: 'gzip', diagnostics });
    assert.deepEqual((await iterator.next()).value.payload, payload);
    const held = { parserAssemblies: 1, parserAssemblyBytes: frame.length, runtimeChunkBytes: frame.length };
    assert.deepEqual(diagnostics, held, 'codec output is not falsely included in framing-only bytes');
    aborter.abort();
    assert.deepEqual(diagnostics, held, 'abort cannot run a suspended generator finally before resumption');
    await iterator.return();
    assert.deepEqual(diagnostics, emptyParser); assert.equal(body.locked, false); assert.equal(cancels, 1);
});
