'use strict';
const { test } = require('node:test');
const { fc, check } = require('./property-helpers.cjs');
const { assert, grpc, Echo, deferred, response, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

const modes = ['cloudflare', 'grpc-web'];
const payload = fc.array(fc.integer({ min: 32, max: 126 }), { maxLength: 20 }).map(characters => String.fromCharCode(...characters));
const actions = ['auth', 'deny', 'reply', 'reject', 'cancel', 'close', 'flush'];

async function drain() {
    // Bound every schedule turn. Neither an unresolved gate nor a missing
    // terminal event can hang a property or suppress fast-check shrinking.
    for (let index = 0; index < 64; index++) await Promise.resolve();
    await new Promise(resolve => process.nextTick(resolve));
    for (let index = 0; index < 16; index++) await Promise.resolve();
}

async function withCalls(mode, text, count, work, closeOnSuccess = -1) {
    const saved = { fetch: globalThis.fetch, now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const timers = new Set(), records = [];
    const now = 1700000000000;
    let client, closed = false;
    // Exercise timer creation and disposal without scheduling wall-clock work.
    Date.now = () => now;
    globalThis.setTimeout = () => {
        const timer = { unref() { return this; }, ref() { return this; } };
        timers.add(timer);
        return timer;
    };
    globalThis.clearTimeout = timer => timers.delete(timer);
    function advance(record) {
        if (record.expectedCode !== undefined) return;
        if (record.authOutcome === 'deny') record.expectedCode = grpc.status.UNAUTHENTICATED;
        else if (record.authOutcome === 'auth') {
            record.expectedFetches = 1;
            if (record.replyOutcome === 'reply') record.expectedCode = grpc.status.OK;
            if (record.replyOutcome === 'reject') record.expectedCode = grpc.status.UNAVAILABLE;
        }
    }
    function close() {
        closed = true;
        for (const record of records) record.expectedCode ??= grpc.status.UNAVAILABLE;
        client.close();
    }
    function addCall() {
        const index = records.length;
        const record = { index, authGate: deferred(), replyGate: deferred(), authCalls: 0, fetches: 0,
            callbacks: [], statuses: [], events: [], bodyCancellations: 0, expectedFetches: 0,
            expectedCode: closed ? grpc.status.UNAVAILABLE : undefined, replyText: `reply-${index}:${text}` };
        // A generated rejection can precede authentication/fetch or follow cancel.
        record.authGate.promise.catch(() => {});
        record.replyGate.promise.catch(() => {});
        records.push(record);
        const credentials = grpc.credentials.createFromMetadataGenerator((options, callback) => {
            record.authCalls++;
            assert.equal(options.service_url, 'https://echo.test/demo.Echo');
            return record.authGate.promise.then(() => {
                const metadata = new grpc.Metadata();
                metadata.set('x-property-call', String(index));
                callback(null, metadata);
            }, error => callback(error));
        });
        record.call = client.unary({ text: `request-${index}:${text}` }, { credentials, deadline: now + 10000 }, (error, value) => {
            record.callbacks.push({ code: error?.code ?? grpc.status.OK, value });
            record.events.push('callback');
            if (!error && index === closeOnSuccess) close();
        });
        record.call.on('status', status => { record.statuses.push(status.code); record.events.push('status'); });
        return record;
    }
    function act(kind, index = 0) {
        const record = records[index];
        if ((kind === 'auth' || kind === 'deny') && record.authOutcome === undefined) {
            record.authOutcome = kind;
            if (kind === 'auth') record.authGate.resolve();
            else record.authGate.reject(Object.assign(new Error('controlled authentication failure'), { code: grpc.status.UNAUTHENTICATED }));
        }
        if ((kind === 'reply' || kind === 'reject') && record.replyOutcome === undefined) {
            record.replyOutcome = kind;
            if (kind === 'reply') {
                record.lateBody = record.expectedCode !== undefined && record.expectedFetches === 1;
                record.response = response([{ text: record.replyText }], { onCancel: () => record.bodyCancellations++ });
                record.replyGate.resolve(record.response);
            } else record.replyGate.reject(new Error('controlled fetch failure'));
        }
        if (kind === 'cancel') {
            record.expectedCode ??= grpc.status.CANCELLED;
            record.call.cancel();
        }
        if (kind === 'close') close();
        advance(record);
    }
    function assertState() {
        let active = 0;
        for (const record of records) {
            const terminal = record.expectedCode !== undefined;
            active += Number(!terminal);
            assert.ok(record.authCalls <= 1, 'Authentication starts at most once');
            assert.equal(record.fetches, record.expectedFetches, 'Modelled fetch count');
            assert.ok(record.fetches <= 1, 'A call never retries its fetch');
            assert.equal(record.callbacks.length, Number(terminal), 'Exactly one terminal callback');
            assert.equal(record.statuses.length, Number(terminal), 'Exactly one terminal status');
            const diagnostics = transportCall(record.call).diagnostics();
            assert.equal(diagnostics.terminal, terminal);
            assert.equal(diagnostics.timerActive, !terminal);
            assert.equal(diagnostics.fetchCount, record.expectedFetches);
            if (record.signal) assert.equal(record.signal.aborted, terminal, 'Only a terminal call aborts its own request');
            if (terminal) {
                assert.equal(record.callbacks[0].code, record.expectedCode);
                assert.deepEqual(record.statuses, [record.expectedCode]);
                assert.deepEqual(record.events, ['callback', 'status']);
                assert.equal(diagnostics.requestBytes, 0);
                assert.equal(diagnostics.responseBytes, 0);
                if (record.expectedCode === grpc.status.OK) assert.deepEqual(record.callbacks[0].value, { text: record.replyText });
            }
            if (record.lateBody) assert.equal(record.bodyCancellations, 1, 'Late response body is cancelled exactly once');
        }
        assert.equal(client.getChannel().activeCallCount(), active);
        assert.equal(timers.size, active, 'Each active deadline has one timer; terminals retain none');
    }
    try {
        const config = mode === 'grpc-web' ? { mode, endpoints: { 'echo.test': 'https://gateway.test' } } : { mode };
        const transport = createWorkersGrpcTransport(config);
        client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions());
        globalThis.fetch = async (url, init) => {
            assert.equal(url, `${mode === 'grpc-web' ? 'https://gateway.test' : 'https://echo.test'}/demo.Echo/Unary`);
            const record = records[Number(init.headers.get('x-property-call'))];
            assert.ok(record);
            assert.equal(init.headers.get('x-property-call'), String(record.index));
            record.fetches++;
            record.signal = init.signal;
            // Deliberately ignore AbortSignal so late completion must be handled.
            return record.replyGate.promise;
        };
        for (let index = 0; index < count; index++) addCall();
        await work({ records, act, close, addCall, assertState });
    } finally {
        client?.close();
        for (const record of records) {
            record.authGate.resolve();
            record.replyGate.resolve(response());
        }
        try {
            await drain();
            for (const record of records) if (record.response && record.fetches === 0) await record.response.body.cancel();
        } finally {
            globalThis.fetch = saved.fetch;
            Date.now = saved.now;
            globalThis.setTimeout = saved.setTimeout;
            globalThis.clearTimeout = saved.clearTimeout;
        }
    }
}

test('FUZZ property lifecycle action sequences preserve one terminal and release all resources in both modes', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(fc.array(fc.constantFrom(...actions), { maxLength: 24 }), payload, async (schedule, text) => {
        for (const mode of modes) await withCalls(mode, text, 1, async harness => {
            for (const action of schedule) {
                const terminalBefore = harness.records[0].expectedCode !== undefined;
                const fetchesBefore = harness.records[0].fetches;
                harness.act(action);
                await drain();
                harness.assertState();
                if (terminalBefore) assert.equal(harness.records[0].fetches, fetchesBefore, 'Late auth cannot start network');
            }
            harness.act('cancel');
            harness.act('auth');
            harness.act('reply');
            await drain();
            harness.assertState();
        });
    }), { examples: [
        [['cancel', 'auth', 'reply', 'close'], 'cancel-before-auth'],
        [['auth', 'cancel', 'reply', 'close'], 'late-fetch-body'],
        [['reply', 'auth', 'close', 'cancel'], 'completion-wins'],
        [['deny', 'auth', 'reject', 'close'], 'auth-failure-wins'],
    ] });
});

test('FUZZ property cancelling a generated concurrent call leaves its peer authentication and response independent', { timeout: 120000 }, async () => {
    const step = fc.record({ index: fc.integer({ min: 0, max: 1 }), kind: fc.constantFrom('auth', 'reply', 'cancel-victim', 'flush') });
    await check(fc.asyncProperty(fc.array(step, { maxLength: 20 }), fc.integer({ min: 0, max: 1 }), payload, async (schedule, victim, text) => {
        for (const mode of modes) await withCalls(mode, text, 2, async harness => {
            const survivor = 1 - victim;
            for (const action of schedule) {
                harness.act(action.kind === 'cancel-victim' ? 'cancel' : action.kind, action.kind === 'cancel-victim' ? victim : action.index);
                await drain();
                harness.assertState();
                assert.ok([undefined, grpc.status.OK].includes(harness.records[survivor].expectedCode));
            }
            harness.act('cancel', victim);
            harness.act('auth', victim);
            harness.act('reply', victim);
            await drain();
            harness.assertState();
            harness.act('auth', survivor);
            harness.act('reply', survivor);
            await drain();
            harness.assertState();
            assert.equal(harness.records[survivor].callbacks[0].code, grpc.status.OK);
        });
    }));
});

test('FUZZ property reentrant channel close from a success callback terminates generated peer stages exactly once', { timeout: 120000 }, async () => {
    const step = fc.record({ index: fc.integer({ min: 0, max: 3 }), kind: fc.constantFrom('auth', 'reply', 'flush') });
    await check(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.array(step, { maxLength: 20 }), payload, async (count, schedule, text) => {
        const closer = count - 1;
        for (const mode of modes) await withCalls(mode, text, count, async harness => {
            for (const action of schedule) {
                harness.act(action.kind, action.index % closer);
                await drain();
                harness.assertState();
            }
            harness.act('auth', closer);
            harness.act('reply', closer);
            await drain();
            harness.assertState();
            assert.equal(harness.records[closer].callbacks[0].code, grpc.status.OK);
            const postClose = harness.addCall();
            for (const record of harness.records) {
                harness.act('auth', record.index);
                harness.act('reply', record.index);
                harness.act('cancel', record.index);
            }
            harness.close();
            await drain();
            harness.assertState();
            assert.equal(postClose.authCalls, 0);
            assert.equal(postClose.fetches, 0);
            assert.equal(postClose.callbacks[0].code, grpc.status.UNAVAILABLE);
        }, closer);
    }));
});
