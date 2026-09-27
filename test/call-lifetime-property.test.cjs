'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fc, check } = require('./property-helpers.cjs');
const dist = process.env.WGA_LIFETIME_TEST_DIST ?? path.join(__dirname, '../dist');
const grpc = require(path.join(dist, 'index.js'));
const { createWorkersGrpcTransport } = require(path.join(dist, 'adapter.js'));

function gate() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
async function drain() {
    for (let turn = 0; turn < 48; turn++) await Promise.resolve();
    await new Promise(resolve => process.nextTick(resolve));
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}
function frame(value, trailer = false) {
    const payload = Buffer.from(value);
    const header = Buffer.alloc(5);
    header[0] = trailer ? 0x80 : 0;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}
function transportOf(surface) {
    let value = surface;
    while (value && typeof value.diagnostics !== 'function') value = value.call ?? value.nextCall;
    assert.ok(value, 'real WorkersCall remains available for resource assertions');
    return value;
}

async function runSchedule(schedule, deadlineKind, mode) {
    const saved = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    let now = 1000, timerId = 0, client;
    const timers = new Map(), auth = gate(), reply = gate();
    const codes = [], statuses = [], events = [], observations = [];
    let start, message, fetches = 0, authCalls = 0, expectedCode, expectedFetches = 0;
    let didStart = false, didMessage = false, didAuth = false, didReply = false, bodyCancels = 0;
    let responseBody, signal;
    const parent = Object.assign(new EventEmitter(), { cancelled: false,
        getDeadline: () => deadlineKind === 'parent' ? 1025 : Infinity });
    Date.now = () => now;
    globalThis.setTimeout = (callback, delay = 0) => {
        const id = { id: ++timerId, unref() { return this; } };
        timers.set(id, { callback, at: now + Number(delay) });
        return id;
    };
    globalThis.clearTimeout = id => { timers.delete(id); };
    const tick = () => {
        now += 50;
        for (const [id, timer] of [...timers]) if (timer.at <= now) {
            timers.delete(id);
            timer.callback();
        }
    };
    try {
        const config = { mode, ...(mode === 'grpc-web' ? { endpoints: { 'lifetime.test': 'https://gateway.test' } } : {}),
            ...(deadlineKind === 'default' ? { defaultTimeoutMs: 40 } : {}),
            observer(event) {
                observations.push(event);
                if (event.type === 'fetch-start') throw new Error('observer throw must not affect schedules');
                if (event.type === 'auth-end') return Promise.reject(new Error('observer rejection must be observed'));
            },
            fetcher: { async fetch(_url, init) {
                fetches++; signal = init.signal;
                assert.deepEqual(JSON.parse(Buffer.from(init.body).subarray(5).toString()), { tenant: 'rewritten' });
                return reply.promise; // Deliberately allow completion after abort.
            } } };
        const transport = createWorkersGrpcTransport(config);
        const Client = grpc.makeGenericClientConstructor({ invoke: {
            path: '/test.Lifetime/Invoke', requestStream: false, responseStream: false,
            requestSerialize: value => Buffer.from(JSON.stringify(value)),
            responseDeserialize: bytes => JSON.parse(bytes.toString()),
        } }, 'test.Lifetime');
        client = new Client('lifetime.test', transport.channelCredentials, transport.grpcOptions({
            interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                start(metadata, listener, next) { start = () => next(metadata, listener); },
                sendMessage(value, next) { message = () => next({ ...value, tenant: 'rewritten' }); },
                cancel(_next) { /* Never yield: cancellation must still terminate locally. */ },
            })],
        }));
        const credentials = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
            authCalls++;
            return auth.promise.then(() => callback(null, new grpc.Metadata()));
        });
        const call = client.invoke({ tenant: 'original' }, { credentials, parent,
            ...(deadlineKind === 'default' ? {} : { deadline: deadlineKind === 'explicit' ? 1040 : Infinity }) },
        (error, value) => {
            codes.push(error?.code ?? grpc.status.OK);
            events.push('callback');
            if (!error) assert.deepEqual(value, { accepted: true });
        });
        call.on('status', value => { statuses.push(value.code); events.push('status'); });
        const wire = transportOf(call);
        const state = () => {
            const terminal = expectedCode !== undefined;
            assert.equal(fetches, expectedFetches, 'only the modeled live request may start Fetch');
            assert.equal(authCalls, Number(didStart), 'late start cannot invoke credentials');
            assert.deepEqual(codes, terminal ? [expectedCode] : []);
            assert.deepEqual(statuses, terminal ? [expectedCode] : []);
            assert.deepEqual(events, terminal ? ['callback', 'status'] : []);
            assert.equal(client.getChannel().activeCallCount(), terminal ? 0 : 1);
            assert.equal(parent.listenerCount('cancelled'), terminal ? 0 : 1);
            assert.equal(timers.size, !terminal && deadlineKind !== 'infinite' ? 1 : 0);
            assert.equal(observations.filter(value => value.type === 'call-start').length, 1);
            assert.equal(new Set(observations.map(value => value.logicalCallId)).size, 1);
            assert.ok(observations.every(Object.isFrozen));
            assert.equal(observations.filter(value => value.type === 'fetch-start').length, fetches);
            const endings = observations.filter(value => value.type === 'call-end');
            assert.equal(endings.length, Number(terminal));
            if (terminal) {
                assert.equal(endings[0], observations.at(-1), 'no observer events may follow local completion');
                assert.equal(endings[0].statusCode, expectedCode);
                assert.equal(endings[0].fetchCount, fetches);
                assert.equal(endings[0].attemptCount, Number(didStart));
                assert.equal(observations.filter(value => value.type === 'attempt-end').length, Number(didStart));
                assert.ok(observations.every((value, index) => index === 0 || value.elapsedMs >= observations[index - 1].elapsedMs));
                const info = wire.diagnostics();
                assert.equal(info.terminal, true);
                assert.equal(info.timerActive, false);
                assert.equal(info.requestBytes, 0);
                assert.equal(info.responseBytes, 0);
                if (signal) assert.equal(signal.aborted, true);
            }
        };
        const act = async action => {
            const alreadyTerminal = expectedCode !== undefined, previousFetches = fetches;
            if (action === 'start') { if (!alreadyTerminal) didStart = true; start(); }
            if (action === 'message') { didMessage = true; message(); }
            if (action === 'auth') { didAuth = true; auth.resolve(); }
            if (action === 'reply' && !didReply) {
                didReply = true;
                responseBody = new ReadableStream({ start(controller) {
                    controller.enqueue(Buffer.concat([frame('{"accepted":true}'), frame('grpc-status: 0\r\n', true)]));
                    controller.close();
                }, cancel() { bodyCancels++; } });
                reply.resolve(new Response(responseBody, { headers: { 'content-type': 'application/grpc-web+proto' } }));
            }
            if (action === 'cancel') { expectedCode ??= grpc.status.CANCELLED; call.cancel(); }
            if (action === 'close') { expectedCode ??= grpc.status.UNAVAILABLE; client.close(); }
            if (action === 'parent') { expectedCode ??= grpc.status.CANCELLED; parent.cancelled = true; parent.emit('cancelled'); }
            if (action === 'deadline') {
                if (deadlineKind !== 'infinite') expectedCode ??= grpc.status.DEADLINE_EXCEEDED;
                tick();
            }
            if (expectedCode === undefined && didStart && didMessage && didAuth) {
                expectedFetches = 1;
                if (didReply) expectedCode = grpc.status.OK;
            }
            await drain();
            state();
            if (alreadyTerminal) assert.equal(fetches, previousFetches, 'late continuations never start Fetch after terminal');
        };
        await drain(); state();
        for (const action of schedule) await act(action);
        // Every generated prefix gets a bounded terminal and late completions.
        for (const action of ['cancel', 'start', 'message', 'auth', 'reply', 'parent', 'close', 'deadline']) await act(action);
        if (fetches && expectedCode !== grpc.status.OK) assert.equal(bodyCancels, 1, 'late body cancelled exactly once');
    } finally {
        client?.close();
        auth.resolve();
        if (!didReply) reply.resolve(new Response(null, { headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': '1' } }));
        try {
            await drain();
            if (responseBody && fetches === 0) await responseBody.cancel();
        } finally {
            Date.now = saved.now;
            globalThis.setTimeout = saved.setTimeout;
            globalThis.clearTimeout = saved.clearTimeout;
        }
    }
}

test('PROPERTY LIFETIME generated interceptor and terminal schedules preserve exactly one result without late Fetch', { timeout: 120000 }, async () => {
    await check(fc.asyncProperty(
        fc.array(fc.constantFrom('start', 'message', 'auth', 'reply', 'cancel', 'close', 'parent', 'deadline', 'flush'), { maxLength: 24 }),
        fc.constantFrom('default', 'explicit', 'parent', 'infinite'),
        async (schedule, deadlineKind) => {
            for (const mode of ['cloudflare', 'grpc-web']) await runSchedule(schedule, deadlineKind, mode);
        }), { numRuns: 150, examples: [
            [['message', 'deadline', 'start', 'auth', 'reply'], 'default'],
            [['start', 'message', 'auth', 'cancel', 'reply'], 'explicit'],
            [['reply', 'message', 'auth', 'start', 'close'], 'infinite'],
            [['start', 'parent', 'message', 'auth', 'reply'], 'parent'],
        ] });
});
