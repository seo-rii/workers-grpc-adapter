'use strict';
const { test } = require('node:test');
const { gzipSync } = require('node:zlib');
const { assert, grpc, Echo, serialize, byteStream, trailers, response, immediate, deferred } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');

async function until(predicate) {
    const limit = performance.now() + 3000;
    while (!predicate()) { assert.ok(performance.now() < limit, 'expected observer transition'); await immediate(); }
}
function fixture(config = {}, options = {}, auth) {
    const events = [], clients = [];
    const { observer, ...rest } = config;
    const transport = createWorkersGrpcTransport({
        fetcher: { async fetch() { return response(); } }, ...rest,
        observer(event) { events.push(event); return observer?.(event); },
    });
    const credentials = auth ? grpc.credentials.combineChannelCredentials(transport.channelCredentials,
        grpc.credentials.createFromMetadataGenerator(auth)) : transport.channelCredentials;
    return {
        events, transport,
        make(extra = {}) {
            const client = new Echo('echo.test:443', credentials, transport.grpcOptions({ ...options, ...extra }));
            clients.push(client); return client;
        },
        close() { for (const client of clients) client.close(); },
    };
}
function unary(client, value = { text: 'request' }, ...options) {
    const record = { callbacks: 0, statuses: [], call: null, done: null };
    record.done = new Promise(resolve => {
        record.call = client.unary(value, ...options, (error, result) => { record.callbacks++; resolve({ error, result }); });
        record.call.on('status', result => record.statuses.push(result.code));
    });
    return record;
}
function matching(events, type) { return events.filter(event => event.type === type); }
function single(events, type) {
    const values = matching(events, type); assert.equal(values.length, 1, `one ${type}`); return values[0];
}
function ended(events, expectedCode) {
    const value = single(events, 'call-end');
    assert.equal(value.statusCode, expectedCode);
    assert.equal(events.at(-1), value, 'logical completion is the final observer event');
    assert.equal(new Set(events.map(event => event.logicalCallId)).size, 1);
    for (let i = 0; i < events.length; i++) {
        assert.equal(Object.isFrozen(events[i]), true);
        assert.equal(typeof events[i].logicalCallId, 'string');
        assert.ok(events[i].logicalCallId.length > 0);
        assert.ok(Number.isFinite(events[i].elapsedMs) && events[i].elapsedMs >= 0);
        if (i) assert.ok(events[i].elapsedMs >= events[i - 1].elapsedMs, 'monotonic event timestamps');
    }
    return value;
}
const retryPolicy = { methods: ['/demo.Echo/Unary'], maxAttempts: 3,
    initialBackoffMs: 1, maxBackoffMs: 5, retryableStatusCodes: [grpc.status.UNAVAILABLE] };

test('OBSERVER configuration validates and snapshots observer identity', async () => {
    const { validateConfig, configureWorkersGrpc, getWorkersGrpcConfig } = require('../dist/config-internal.js');
    for (const observer of [null, true, 1, 'callback', {}, []]) {
        assert.throws(() => validateConfig({ observer }), { code: 'WGA_INVALID_CONFIG' });
    }
    const originalEvents = [], changedEvents = [];
    const original = event => { originalEvents.push(event); }, changed = event => { changedEvents.push(event); };
    const input = { observer: original, fetcher: { async fetch() { return response(); } } };
    const transport = createWorkersGrpcTransport(input);
    input.observer = changed;
    const c = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions());
    try {
        assert.equal((await unary(c).done).error, null); await immediate();
        assert.equal(matching(originalEvents, 'call-end').length, 1); assert.deepEqual(changedEvents, []);
        const first = configureWorkersGrpc({ observer: original });
        assert.equal(configureWorkersGrpc({ observer: original }), first, 'identical callback configuration is idempotent');
        assert.throws(() => configureWorkersGrpc({ observer: changed }), { code: 'WGA_CONFIG_ALREADY_SET' });
        assert.equal(getWorkersGrpcConfig().observer, original, 'functions cannot compare equal through JSON omission');
        const global = new grpc.Client('echo.test', grpc.credentials.createSsl());
        try {
            assert.equal(configureWorkersGrpc({ observer: original }), first);
            assert.throws(() => configureWorkersGrpc({ observer: changed }), { code: 'WGA_CONFIG_LOCKED' });
            assert.equal(getWorkersGrpcConfig().observer, original);
        } finally { global.close(); }
    } finally { c.close(); }
});

for (const mode of ['cloudflare', 'grpc-web']) {
    test(`OBSERVER ${mode} unary events preserve phase order and count encoded bytes`, async () => {
        const request = { text: 'outbound-\u03bb' }, answer = { text: 'inbound-\ud83c\udf0f' };
        const wire = Buffer.concat([encodeFrame(serialize(answer)), trailers()]);
        const f = fixture({ mode, ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
            fetcher: { async fetch(_url, init) {
                assert.equal(init.body.byteLength, serialize(request).length + 5);
                return new Response(byteStream(wire, 3), { headers: { 'content-type': 'application/grpc-web+proto' } });
            } },
        });
        const c = f.make();
        try {
            const result = unary(c, request);
            assert.equal(f.events.length, 0, 'observer callbacks run outside the caller stack');
            assert.deepEqual((await result.done).result, answer); await immediate();
            assert.deepEqual(f.events.map(event => event.type), ['call-start', 'call-admitted', 'attempt-start',
                'auth-end', 'fetch-start', 'response-headers', 'first-message', 'attempt-end', 'call-end']);
            const final = ended(f.events, grpc.status.OK);
            assert.equal(final.attemptCount, 1); assert.equal(final.sentBytes, serialize(request).length + 5);
            assert.equal(final.receivedBytes, wire.length); assert.equal(final.responseMessages, 1);
            assert.equal(final.responseMessageBytes, serialize(answer).length); assert.equal(final.fetchCount, 1);
            const attempt = single(f.events, 'attempt-end');
            assert.equal(attempt.attempt, 1); assert.equal(attempt.statusCode, grpc.status.OK);
            assert.equal(attempt.sentBytes, final.sentBytes); assert.equal(attempt.receivedBytes, wire.length);
            assert.equal(attempt.responseMessages, 1);
        } finally { f.close(); }
    });
}

test('OBSERVER emits no targets, metadata, credentials, payloads or remote error details', async () => {
    const secrets = ['Bearer PRIVATE_AUTH', 'PRIVATE_REQUEST', 'PRIVATE_RESPONSE', 'PRIVATE_DETAIL', 'PRIVATE_HEADER', 'PRIVATE_TRAILER'];
    const f = fixture({ fetcher: { async fetch(_url, init) {
        assert.equal(init.headers.get('authorization'), secrets[0]);
        return response([{ text: secrets[2] }], { code: grpc.status.PERMISSION_DENIED, details: secrets[3],
            headers: { 'x-private': secrets[4] }, extra: `x-private: ${secrets[5]}\r\n` });
    } } }, {}, (_options, done) => { const md = new grpc.Metadata(); md.set('authorization', secrets[0]); done(null, md); });
    const c = f.make();
    try {
        const requestMetadata = new grpc.Metadata(); requestMetadata.set('x-private', 'PRIVATE_METADATA');
        assert.equal((await unary(c, { text: secrets[1] }, requestMetadata).done).error.code, grpc.status.PERMISSION_DENIED);
        await immediate(); ended(f.events, grpc.status.PERMISSION_DENIED);
        const encoded = JSON.stringify(f.events);
        for (const secret of [...secrets, 'PRIVATE_METADATA', 'echo.test', '/demo.Echo', 'gateway.test']) assert.equal(encoded.includes(secret), false);
        for (const event of f.events) {
            for (const key of ['metadata', 'headers', 'credentials', 'payload', 'message', 'details', 'path', 'host', 'authority', 'url']) {
                assert.equal(Object.hasOwn(event, key), false, `private field ${key}`);
            }
            for (const value of Object.values(event)) assert.notEqual(typeof value, 'object', 'only scalar observer data');
        }
    } finally { f.close(); }
});

for (const behavior of ['throw', 'reject', 'then-getter', 'never-settle', 'mutate']) {
    test(`OBSERVER ${behavior} cannot change RPC completion or resource cleanup`, async () => {
        let observed = 0;
        const f = fixture({ resourceLimits: { maxConcurrentCalls: 1, maxBufferedBytes: 4096 }, observer(event) {
            observed++;
            if (behavior === 'throw') throw new Error('observer failure');
            if (behavior === 'reject') return Promise.reject(new Error('observer rejection'));
            if (behavior === 'then-getter') return Object.defineProperty({}, 'then', { get() { throw new Error('observer then getter'); } });
            if (behavior === 'never-settle') return new Promise(() => {});
            if (behavior === 'mutate') event.logicalCallId = 'changed';
        } });
        const c = f.make();
        try {
            for (let i = 0; i < 2; i++) assert.deepEqual((await unary(c).done).result, { text: 'ok' });
            await immediate(); await immediate();
            assert.equal(matching(f.events, 'call-end').length, 2); assert.ok(observed > 0);
            for (const end of matching(f.events, 'call-end')) assert.equal(end.statusCode, grpc.status.OK);
            const usage = f.transport.resourceUsage();
            assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
            assert.equal(c.getChannel().activeCallCount(), 0);
        } finally { f.close(); }
    });
}

test('OBSERVER interceptor startup deadline emits one call end without starting an attempt', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let resume, fetches = 0;
    const f = fixture({ defaultTimeoutMs: 10, fetcher: { async fetch() { fetches++; return response(); } } }, {
        interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
            start(md, listener, next) { resume = () => next(md, listener); },
        })],
    });
    const c = f.make();
    try {
        const result = unary(c); await immediate();
        assert.equal(typeof resume, 'function'); t.mock.timers.tick(10);
        assert.equal((await result.done).error.code, grpc.status.DEADLINE_EXCEEDED); await immediate();
        assert.deepEqual(f.events.map(event => event.type), ['call-start', 'call-admitted', 'call-end']);
        const final = ended(f.events, grpc.status.DEADLINE_EXCEEDED);
        assert.equal(final.attemptCount, 0); assert.equal(final.sentBytes, 0); assert.equal(final.receivedBytes, 0);
        resume(); await immediate(); assert.equal(fetches, 0); assert.equal(result.callbacks, 1);
        assert.equal(single(f.events, 'call-end'), final);
    } finally { f.close(); }
});

for (const action of ['cancel', 'deadline', 'auth-error']) {
    test(`OBSERVER pending credentials ${action} ends the attempt once without a Fetch`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
        let finishAuth, fetches = 0;
        const f = fixture({ defaultTimeoutMs: 10, fetcher: { async fetch() { fetches++; return response(); } } }, {},
            (_options, done) => { finishAuth = done; });
        const c = f.make();
        try {
            const result = unary(c); await until(() => finishAuth);
            if (action === 'cancel') result.call.cancel();
            else if (action === 'deadline') t.mock.timers.tick(10);
            else finishAuth(Object.assign(new Error('PRIVATE_AUTH_ERROR'), { code: grpc.status.UNAUTHENTICATED }));
            const expected = action === 'cancel' ? grpc.status.CANCELLED : action === 'deadline' ? grpc.status.DEADLINE_EXCEEDED : grpc.status.UNAUTHENTICATED;
            assert.equal((await result.done).error.code, expected); await immediate();
            const final = ended(f.events, expected);
            assert.equal(final.attemptCount, 1); assert.equal(final.sentBytes, 0); assert.equal(final.receivedBytes, 0);
            assert.equal(single(f.events, 'attempt-start').attempt, 1);
            assert.equal(single(f.events, 'attempt-end').statusCode, expected);
            assert.equal(single(f.events, 'auth-end').statusCode, expected);
            assert.equal(single(f.events, 'attempt-end').fetchStarted, false);
            assert.equal(matching(f.events, 'fetch-start').length, 0);
            const before = [...f.events]; finishAuth(null, new grpc.Metadata()); await immediate();
            assert.deepEqual(f.events, before); assert.equal(fetches, 0); assert.equal(result.callbacks, 1);
            assert.equal(JSON.stringify(f.events).includes('PRIVATE_AUTH_ERROR'), false);
        } finally { f.close(); }
    });
}

test('OBSERVER queued cancellation has its own id and no attempt, then admission recovers', async () => {
    const pending = [], f = fixture({ resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 },
        fetcher: { fetch() { const wait = deferred(); pending.push(wait); return wait.promise; } },
    });
    const a = f.make(), b = f.make();
    try {
        const first = unary(a); await until(() => pending.length === 1);
        const queued = unary(b); await immediate();
        queued.call.cancel(); assert.equal((await queued.done).error.code, grpc.status.CANCELLED); await immediate();
        const cancelled = single(f.events, 'call-end');
        const queueEvents = f.events.filter(event => event.logicalCallId === cancelled.logicalCallId);
        assert.deepEqual(queueEvents.map(event => event.type), ['call-start', 'call-end']);
        assert.equal(ended(queueEvents, grpc.status.CANCELLED).attemptCount, 0);
        assert.ok(cancelled.queueMs >= 0); assert.equal(pending.length, 1);
        pending[0].resolve(response()); assert.equal((await first.done).error, null);
        const recovered = unary(b); await until(() => pending.length === 2);
        pending[1].resolve(response()); assert.equal((await recovered.done).error, null); await immediate();
        assert.equal(new Set(matching(f.events, 'call-start').map(event => event.logicalCallId)).size, 3);
        assert.equal(matching(f.events, 'call-end').length, 3);
        assert.equal(f.transport.resourceUsage().queuedCalls, 0);
    } finally { for (const wait of pending) wait.resolve(response()); f.close(); }
});

test('OBSERVER adapter retries share a logical id and separate API retries start new ids', async () => {
    let fetches = 0, auth = 0;
    const retryReply = Buffer.from(trailers(grpc.status.UNAVAILABLE, '', 'grpc-retry-pushback-ms: 0\r\n'));
    const successReply = Buffer.concat([encodeFrame(serialize({ text: 'retried' })), trailers()]);
    const f = fixture({ retryPolicy, fetcher: { async fetch() {
        const body = ++fetches % 3 === 0 ? successReply : retryReply;
        return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
    } } }, {}, (_options, done) => { auth++; done(null, new grpc.Metadata()); });
    const c = f.make();
    try {
        for (let i = 0; i < 2; i++) assert.equal((await unary(c).done).result.text, 'retried');
        await immediate(); assert.equal(fetches, 6); assert.equal(auth, 6);
        const starts = matching(f.events, 'call-start');
        assert.equal(starts.length, 2); assert.notEqual(starts[0].logicalCallId, starts[1].logicalCallId);
        for (const start of starts) {
            const events = f.events.filter(event => event.logicalCallId === start.logicalCallId);
            const end = ended(events, grpc.status.OK);
            assert.equal(end.attemptCount, 3); assert.equal(end.sentBytes, 3 * (serialize({ text: 'request' }).length + 5));
            assert.equal(end.receivedBytes, 2 * retryReply.length + successReply.length); assert.equal(end.responseMessages, 1);
            assert.deepEqual(matching(events, 'attempt-start').map(event => event.attempt), [1, 2, 3]);
            assert.deepEqual(matching(events, 'attempt-end').map(event => event.statusCode), [14, 14, 0]);
            assert.equal(matching(events, 'auth-end').length, 3); assert.equal(matching(events, 'retry-scheduled').length, 2);
            for (const retry of matching(events, 'retry-scheduled')) {
                assert.ok(events.indexOf(retry) > events.indexOf(matching(events, 'attempt-end')[retry.attempt - 1]));
            }
        }
    } finally { f.close(); }
});

test('OBSERVER concurrent factories keep observer callbacks and logical ids isolated', async () => {
    const shared = deferred();
    const first = fixture({ fetcher: { async fetch() { await shared.promise; return response([{ text: 'first' }]); } } });
    const second = fixture({ fetcher: { async fetch() { await shared.promise; return response([{ text: 'second' }]); } } });
    try {
        const a = unary(first.make()), b = unary(second.make());
        await until(() => matching(first.events, 'fetch-start').length && matching(second.events, 'fetch-start').length);
        shared.resolve(); assert.equal((await a.done).result.text, 'first'); assert.equal((await b.done).result.text, 'second');
        await immediate(); const left = ended(first.events, 0), right = ended(second.events, 0);
        assert.notEqual(left.logicalCallId, right.logicalCallId);
        assert.equal(single(first.events, 'first-message').logicalCallId, left.logicalCallId);
        assert.equal(single(second.events, 'first-message').logicalCallId, right.logicalCallId);
    } finally { shared.resolve(); first.close(); second.close(); }
});

test('OBSERVER distinguishes a transport result from the status returned by an interceptor', async () => {
    const f = fixture({}, { interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        start(metadata, listener, next) {
            next(metadata, { onReceiveStatus(value, forward) {
                forward({ ...value, code: grpc.status.PERMISSION_DENIED, details: 'PRIVATE_INTERCEPTOR_STATUS' });
            } });
        },
    })] });
    const c = f.make();
    try {
        assert.equal((await unary(c).done).error.code, grpc.status.PERMISSION_DENIED); await immediate();
        const end = ended(f.events, grpc.status.PERMISSION_DENIED);
        assert.equal(single(f.events, 'attempt-end').statusCode, grpc.status.OK);
        assert.equal(end.attemptCount, 1); assert.equal(end.responseMessages, 1);
        assert.equal(JSON.stringify(f.events).includes('PRIVATE_INTERCEPTOR_STATUS'), false);
    } finally { f.close(); }
});

test('OBSERVER stalled inbound status keeps the logical deadline after a successful attempt', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let resume;
    const f = fixture({ defaultTimeoutMs: 10 }, { interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        start(metadata, listener, next) {
            next(metadata, { onReceiveStatus(value, forward) { resume = () => forward(value); } });
        },
    })] });
    const c = f.make();
    try {
        const call = unary(c); await until(() => resume);
        assert.equal(single(f.events, 'attempt-end').statusCode, grpc.status.OK);
        assert.equal(matching(f.events, 'call-end').length, 0);
        t.mock.timers.tick(10); assert.equal((await call.done).error.code, grpc.status.DEADLINE_EXCEEDED); await immediate();
        ended(f.events, grpc.status.DEADLINE_EXCEEDED);
        const before = [...f.events]; resume(); await immediate();
        assert.deepEqual(f.events, before); assert.equal(call.callbacks, 1);
    } finally { f.close(); }
});

test('OBSERVER compressed server streams count wire bytes and one first-message event', async () => {
    const answers = [{ text: 'A'.repeat(2048) }, { text: 'B'.repeat(1024) }, { text: '\ud83c\udf0d'.repeat(256) }];
    const encoded = answers.map(answer => {
        const payload = gzipSync(serialize(answer)), header = Buffer.alloc(5);
        header[0] = 1; header.writeUInt32BE(payload.length, 1); return Buffer.concat([header, payload]);
    });
    const wire = Buffer.concat([...encoded, trailers()]);
    let requestBytes = 0;
    const f = fixture({ fetcher: { async fetch(_url, init) {
        requestBytes = init.body.length;
        return new Response(byteStream(wire, 7), { headers: { 'content-type': 'application/grpc-web+proto', 'grpc-encoding': 'gzip' } });
    } } }, { 'grpc.default_compression_algorithm': grpc.compressionAlgorithms.gzip });
    const c = f.make();
    try {
        const stream = c.stream({ text: 'request'.repeat(256) }), values = [];
        const terminal = new Promise(resolve => stream.on('status', resolve));
        for await (const value of stream) values.push(value);
        assert.deepEqual(values, answers); assert.equal((await terminal).code, 0); await immediate();
        const end = ended(f.events, 0);
        assert.equal(end.sentBytes, requestBytes); assert.ok(requestBytes < serialize({ text: 'request'.repeat(256) }).length);
        assert.equal(end.receivedBytes, wire.length); assert.equal(end.responseMessages, answers.length);
        assert.equal(end.responseMessageBytes, answers.reduce((n, answer) => n + serialize(answer).length, 0));
        assert.ok(end.receivedBytes < answers.reduce((n, answer) => n + serialize(answer).length, 0));
        assert.equal(single(f.events, 'first-message').attempt, 1);
    } finally { f.close(); }
});

for (const kind of ['trailers-only', 'malformed-frame']) {
    test(`OBSERVER ${kind} still accounts for every received Fetch chunk`, async () => {
        const wire = kind === 'trailers-only' ? Buffer.from(trailers(grpc.status.PERMISSION_DENIED))
            : Buffer.from([0x40, 0, 0, 0, 0, 99, 98, 97]);
        const f = fixture({ fetcher: { async fetch() {
            return new Response(byteStream(wire), { headers: { 'content-type': 'application/grpc-web+proto' } });
        } } });
        const c = f.make();
        try {
            const code = kind === 'trailers-only' ? grpc.status.PERMISSION_DENIED : grpc.status.INTERNAL;
            assert.equal((await unary(c).done).error.code, code); await immediate();
            const end = ended(f.events, code);
            assert.equal(end.receivedBytes, wire.length); assert.equal(end.responseMessages, 0);
            assert.equal(matching(f.events, 'first-message').length, 0);
            assert.equal(single(f.events, 'attempt-end').receivedBytes, wire.length);
        } finally { f.close(); }
    });
}

test('OBSERVER uploaded streaming bytes count frames pulled by Fetch', async () => {
    const request = [{ text: 'first' }, { text: 'second' }, { text: 'third' }];
    let consumedBytes = 0;
    const f = fixture({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true,
        fetcher: { async fetch(_url, init) {
            const reader = init.body.getReader();
            try {
                while (true) { const { done, value } = await reader.read(); if (done) break; consumedBytes += value.byteLength; }
            } finally { reader.releaseLock(); }
            return response([{ text: 'uploaded' }]);
        } },
    });
    const c = f.make();
    try {
        let stream;
        const finished = new Promise(resolve => { stream = c.clientStream((error, result) => resolve({ error, result })); });
        stream.on('error', () => {});
        for (const item of request) stream.write(item);
        stream.end(); assert.equal((await finished).result.text, 'uploaded'); await immediate();
        const end = ended(f.events, 0);
        assert.equal(consumedBytes, request.reduce((n, item) => n + serialize(item).length + 5, 0));
        assert.equal(end.sentBytes, consumedBytes); assert.equal(single(f.events, 'attempt-end').sentBytes, consumedBytes);
    } finally { f.close(); }
});

test('OBSERVER an early streaming response does not count an upload that Fetch never pulled', async () => {
    const f = fixture({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true,
        fetcher: { async fetch() { return response([], { code: grpc.status.PERMISSION_DENIED }); } },
    });
    const c = f.make();
    try {
        let stream;
        const finished = new Promise(resolve => { stream = c.clientStream(error => resolve(error)); });
        stream.on('error', () => {}); stream.write({ text: 'never-pulled' }); stream.end();
        assert.equal((await finished).code, grpc.status.PERMISSION_DENIED); await immediate();
        const end = ended(f.events, grpc.status.PERMISSION_DENIED);
        assert.equal(end.sentBytes, 0); assert.equal(end.fetchCount, 1);
        assert.equal(single(f.events, 'attempt-end').sentBytes, 0);
    } finally { f.close(); }
});
