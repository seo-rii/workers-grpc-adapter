'use strict';
const test = require('node:test');
const zlib = require('node:zlib');
const { assert, grpc, client, response, serialize, deserialize, deferred, immediate, transportCall } = require('./helpers.cjs');

const epoch = 1_700_000_000_000;
function clock(t) {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: epoch });
    return offset => t.mock.timers.setTime(epoch + offset);
}
function invoke(c, direct) {
    let call, callbackCount = 0, statusCount = 0;
    const result = new Promise(resolve => {
        if (direct) {
            call = c.getChannel().createCallForMethod('/demo.Echo/ClientStream', true, false, { deadline: epoch + 500 });
            call.start(new grpc.Metadata(), { onReceiveMetadata() {}, onReceiveMessage() {},
                onReceiveStatus(value) { statusCount++; resolve(value.code); } });
            call.startRead();
        } else {
            call = c.clientStream({ deadline: epoch + 500 }, error => { callbackCount++; resolve(error?.code ?? 0); });
            call.on('error', () => {});
            call.on('status', () => { statusCount++; });
        }
    });
    return { call, result, raw: () => direct ? call : transportCall(call),
        write: value => new Promise(resolve => {
            const done = error => { callbackCount++; resolve(error ?? undefined); };
            if (direct) call.sendMessageWithContext({ callback: done }, serialize(value)); else call.write(value, done);
        }),
        end: () => direct ? call.halfClose() : call.end(),
        counts: () => ({ callbackCount, statusCount }),
    };
}
function config(fetcher, limited) {
    return { mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true,
        ...(limited ? { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 } } : {}), fetcher };
}
async function cleaned(c, operation, expected, writes, direct) {
    assert.equal(await operation.result, expected);
    await immediate();
    assert.deepEqual(operation.counts(), { callbackCount: writes + (direct ? 0 : 1), statusCount: 1 });
    assert.equal(c.getChannel().activeCallCount(), 0);
    assert.equal(operation.raw().diagnostics().timerActive, false);
    assert.equal(operation.raw().diagnostics().requestBytes, 0);
    assert.equal(operation.raw().executionDiagnostics().pendingWriteCallbacks, 0);
}

for (const direct of [false, true]) for (const limited of [false, true]) for (const offset of [499, 500, 501]) {
    test(`REQUEST STREAM rejects new writes after expiry: direct=${direct} limited=${limited} offset=${offset}`, async t => {
        const setTime = clock(t), delivered = [];
        const c = client({}, config({ async fetch(_url, init) {
            try {
                for await (const frame of init.body) delivered.push(deserialize(Buffer.from(frame).subarray(5)));
            } catch { /* Abort ends the owned upload. */ }
            return response();
        } }, limited));
        try {
            const operation = invoke(c, direct);
            assert.equal(await operation.write({ text: 'before' }), undefined);
            setTime(offset); // Expire without allowing the timer callback to run.
            const error = await operation.write({ text: 'boundary' });
            operation.end();
            if (offset >= 500) assert.ok(error); else assert.equal(error, undefined);
            await cleaned(c, operation, offset >= 500 ? 4 : 0, 2, direct);
            assert.deepEqual(delivered, [{ text: 'before' }, ...(offset < 500 ? [{ text: 'boundary' }] : [])]);
        } finally { c.close(); }
    });
}

for (const direct of [false, true]) for (const boundary of ['encoding', 'pull']) for (const compression of ['identity', 'gzip']) {
    test(`REQUEST STREAM expires a pending frame before ${boundary} handoff: direct=${direct} compression=${compression}`, async t => {
        const setTime = clock(t), delivered = [], gate = deferred();
        const c = client(compression === 'gzip' ? { 'grpc.default_compression_algorithm': 2 } : {}, config({ async fetch(_url, init) {
            const reader = init.body.getReader();
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    const frame = Buffer.from(part.value);
                    delivered.push(deserialize(frame[0] ? zlib.gunzipSync(frame.subarray(5)) : frame.subarray(5)));
                    if (boundary === 'pull' && delivered.length === 1) await gate.promise;
                }
            } catch { /* Expiry must reject the read instead of accepting another frame. */ }
            finally { reader.releaseLock(); }
            return response();
        } }, false));
        try {
            const operation = invoke(c, direct);
            assert.equal(await operation.write({ text: 'before' }), undefined);
            const pending = operation.write({ text: 'pending' });
            if (boundary === 'pull') await immediate();
            setTime(500);
            gate.resolve();
            const error = await pending;
            operation.end();
            assert.ok(error);
            await cleaned(c, operation, 4, 2, direct);
            assert.deepEqual(delivered, [{ text: 'before' }]);
        } finally { gate.resolve(); c.close(); }
    });
}

test('REQUEST STREAM preserves earlier cancellation when a pending write resumes after expiry', async t => {
    const setTime = clock(t), gate = deferred(), entered = deferred();
    const c = client({}, config({ async fetch(_url, init) {
        entered.resolve(); await gate.promise;
        try { for await (const _frame of init.body) {} } catch { /* Already cancelled. */ }
        return response();
    } }, false));
    try {
        const operation = invoke(c, false);
        const pending = operation.write({ text: 'held' });
        await entered.promise;
        operation.call.cancel(); setTime(500); gate.resolve();
        assert.ok(await pending);
        await cleaned(c, operation, 1, 1, false);
    } finally { gate.resolve(); c.close(); }
});
