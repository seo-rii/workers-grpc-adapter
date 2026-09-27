'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
    const cutoff = performance.now() + 3000;
    while (!predicate()) { assert.ok(performance.now() < cutoff, 'expected asynchronous resource transition'); await turn(); }
}
function reply(value) {
    return new Response(Buffer.concat([encodeFrame(Buffer.from(value)), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]),
        { headers: { 'content-type': 'application/grpc-web+proto' } });
}
function fixture(resourceLimits, extra = {}) {
    const pending = [], serialized = [], clients = [];
    let auth = 0, starts = 0;
    const method = { path: '/fixture.Resources/Echo', requestStream: false, responseStream: false,
        requestSerialize(value) { serialized.push(value); return Buffer.from(value); }, responseDeserialize: value => value.toString() };
    const Client = grpc.makeGenericClientConstructor({ echo: method, stream: { ...method, path: '/fixture.Resources/Stream', responseStream: true } }, 'Resources');
    const transport = createWorkersGrpcTransport({ resourceLimits, fetcher: { fetch(_url, init) {
        return new Promise(resolve => pending.push({ resolve, id: Buffer.from(init.body).subarray(5).toString(), init }));
    } }, ...extra });
    const credentials = grpc.credentials.combineChannelCredentials(transport.channelCredentials,
        grpc.credentials.createFromMetadataGenerator((_options, callback) => { auth++; callback(null, new grpc.Metadata()); }));
    return {
        transport, pending, serialized,
        get auth() { return auth; }, get starts() { return starts; },
        make() {
            const client = new Client('resources.test', credentials, transport.grpcOptions({
                interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                    start(metadata, listener, next) { starts++; next(metadata, listener); },
                })],
            }));
            clients.push(client); return client;
        },
        complete(index, value = pending[index].id) { pending[index].resolve(reply(value)); },
        async close() {
            for (const client of clients) client.close();
            for (const item of pending) item.resolve(reply(item.id));
            await turn();
        },
    };
}
function start(client, value, options = {}) {
    const record = { callbacks: 0, statuses: [], call: null, done: null };
    record.done = new Promise(resolve => {
        record.call = client.echo(value, options, (error, response) => { record.callbacks++; resolve({ error, response }); });
        record.call.on('status', result => record.statuses.push(result.code));
    });
    return record;
}
function idle(transport) {
    const usage = transport.resourceUsage();
    assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
}

test('RESOURCES shared transport admission is FIFO and rejects overflow before interceptors, authentication or serialization', async () => {
    const f = fixture({ maxConcurrentCalls: 1, maxQueuedCalls: 2, maxBufferedBytes: 4096 }), a = f.make(), b = f.make();
    try {
        const first = start(a, 'first'); await until(() => f.pending.length === 1);
        const second = start(b, 'second'), third = start(a, 'third'), overflow = start(b, 'overflow');
        const rejected = await overflow.done;
        assert.equal(rejected.error.code, grpc.status.RESOURCE_EXHAUSTED);
        assert.equal(rejected.error.details, 'WGA_CALL_QUEUE_FULL');
        assert.equal(overflow.callbacks, 1);
        assert.deepEqual(f.serialized, ['first']); assert.equal(f.starts, 1); assert.equal(f.auth, 1);
        const usage = f.transport.resourceUsage();
        assert.equal(usage.activeCalls, 1); assert.equal(usage.queuedCalls, 2);
        assert.equal(usage.peakActiveCalls, 1); assert.equal(usage.peakQueuedCalls, 2);
        f.complete(0); assert.equal((await first.done).response, 'first');
        await until(() => f.pending.length === 2); assert.equal(f.pending[1].id, 'second');
        f.complete(1); assert.equal((await second.done).response, 'second');
        await until(() => f.pending.length === 3); assert.equal(f.pending[2].id, 'third');
        f.complete(2); assert.equal((await third.done).response, 'third');
        await turn(); idle(f.transport);
        assert.deepEqual(f.serialized, ['first', 'second', 'third']);
        assert.equal(f.auth, 3); assert.equal(f.starts, 3);
        assert.deepEqual([first, second, third].map(record => record.statuses), [[0], [0], [0]]);
        assert.equal(a.getChannel().activeCallCount(), 0); assert.equal(b.getChannel().activeCallCount(), 0);
    } finally { await f.close(); }
});

test('RESOURCES factories isolate admission while clients from one factory share it', async () => {
    const first = fixture({ maxConcurrentCalls: 1, maxQueuedCalls: 0 });
    const second = fixture({ maxConcurrentCalls: 1, maxQueuedCalls: 0 });
    try {
        const a = start(first.make(), 'a'), b = start(second.make(), 'b');
        await until(() => first.pending.length === 1 && second.pending.length === 1);
        const blocked = start(first.make(), 'blocked');
        assert.equal((await blocked.done).error.code, grpc.status.RESOURCE_EXHAUSTED);
        assert.equal(second.transport.resourceUsage().activeCalls, 1);
        first.complete(0); second.complete(0);
        assert.equal((await a.done).response, 'a'); assert.equal((await b.done).response, 'b');
        await turn(); idle(first.transport); idle(second.transport);
    } finally { await first.close(); await second.close(); }
});

for (const action of ['deadline', 'default-timeout', 'cancel', 'parent', 'channel-close']) {
    test(`RESOURCES queued ${action} terminates once without starting downstream work`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
        const f = fixture({ maxConcurrentCalls: 1, maxQueuedCalls: 1 }, { defaultTimeoutMs: 10 });
        const a = f.make(), b = f.make();
        const parent = Object.assign(new EventEmitter(), { cancelled: false, getDeadline: () => Infinity });
        try {
            const active = start(a, 'active', { deadline: Infinity }); await until(() => f.pending.length === 1);
            const options = action === 'default-timeout' ? {} : { deadline: action === 'deadline' ? 1010 : Infinity,
                ...(action === 'parent' ? { parent } : {}) };
            const queued = start(b, 'queued', options); await turn();
            assert.equal(f.transport.resourceUsage().queuedCalls, 1);
            if (action === 'cancel') queued.call.cancel();
            else if (action === 'parent') { parent.cancelled = true; parent.emit('cancelled'); }
            else if (action === 'channel-close') b.close();
            else t.mock.timers.tick(10);
            const expected = ['deadline', 'default-timeout'].includes(action) ? grpc.status.DEADLINE_EXCEEDED
                : action === 'channel-close' ? grpc.status.UNAVAILABLE : grpc.status.CANCELLED;
            assert.equal((await queued.done).error.code, expected);
            await turn();
            assert.equal(queued.callbacks, 1); assert.deepEqual(queued.statuses, [expected]);
            assert.equal(f.transport.resourceUsage().queuedCalls, 0); assert.equal(f.transport.resourceUsage().activeCalls, 1);
            assert.deepEqual(f.serialized, ['active']); assert.equal(f.starts, 1); assert.equal(f.auth, 1);
            assert.equal(parent.listenerCount('cancelled'), 0); assert.equal(b.getChannel().activeCallCount(), 0);
            const recovered = start(a, 'recovered', { deadline: Infinity });
            f.complete(0); assert.equal((await active.done).response, 'active');
            await until(() => f.pending.length === 2); assert.equal(f.pending[1].id, 'recovered');
            f.complete(1); assert.equal((await recovered.done).response, 'recovered');
            await turn(); idle(f.transport); assert.equal(queued.callbacks, 1);
        } finally { await f.close(); }
    });
}

test('RESOURCES cancelled uncooperative Fetch retains its bytes until settlement and later calls recover', async () => {
    const f = fixture({ maxConcurrentCalls: 1, maxQueuedCalls: 1, maxBufferedBytes: 4096 }), c = f.make();
    try {
        const first = start(c, 'first'); await until(() => f.pending.length === 1);
        const before = f.transport.resourceUsage().bufferedBytes;
        assert.ok(before >= f.pending[0].init.body.byteLength);
        first.call.cancel(); assert.equal((await first.done).error.code, grpc.status.CANCELLED);
        await turn();
        assert.equal(f.pending[0].init.signal.aborted, true);
        assert.ok(f.transport.resourceUsage().bufferedBytes >= f.pending[0].init.body.byteLength,
            'aborting a signal cannot free a body still owned by an unsettled Fetch');
        const later = start(c, 'later'); await until(() => f.pending.length === 2);
        f.complete(1); assert.equal((await later.done).response, 'later');
        assert.ok(f.transport.resourceUsage().bufferedBytes > 0);
        f.complete(0); await until(() => f.transport.resourceUsage().bufferedBytes === 0);
        idle(f.transport); assert.equal(first.callbacks, 1); assert.deepEqual(first.statuses, [grpc.status.CANCELLED]);
    } finally { await f.close(); }
});

test('RESOURCES byte overload returns RESOURCE_EXHAUSTED and the same client accepts a smaller call', async () => {
    const f = fixture({ maxBufferedBytes: 128 }), c = f.make();
    try {
        const large = start(c, 'x'.repeat(100));
        const rejected = await large.done;
        assert.equal(rejected.error.code, grpc.status.RESOURCE_EXHAUSTED);
        assert.equal(rejected.error.details, 'WGA_BUFFER_BUDGET');
        assert.equal(f.pending.length, 0, 'input and framed output must be reserved before Fetch');
        await turn(); idle(f.transport);
        const small = start(c, 'ok'); await until(() => f.pending.length === 1);
        f.complete(0); assert.equal((await small.done).response, 'ok');
        await turn(); idle(f.transport);
        assert.ok(f.transport.resourceUsage().peakBufferedBytes <= 128);
    } finally { await f.close(); }
});

test('RESOURCES rejection status and local cleanup do not wait for an uncooperative response cancellation', async () => {
    for (const failure of ['buffer-budget', 'invalid-headers']) {
        let releaseCancel, cancels = 0, fetches = 0;
        const cleanup = new Promise(resolve => { releaseCancel = resolve; });
        const body = new ReadableStream({
            pull(controller) { controller.enqueue(encodeFrame(Buffer.alloc(60))); },
            cancel() { cancels++; return cleanup; },
        }, { highWaterMark: 0 });
        const f = fixture({ maxBufferedBytes: failure === 'buffer-budget' ? 64 : 4096 }, {
            fetcher: { async fetch() {
                if (++fetches > 1) return reply('ok');
                return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto',
                    ...(failure === 'invalid-headers' ? { 'grpc-status': 'invalid' } : {}) } });
            } },
        });
        const c = f.make();
        let observed;
        try {
            const call = start(c, 'x'); call.done.then(result => { observed = result; });
            await turn(); await turn();
            assert.ok(observed, 'the callback must settle before source cleanup completes');
            assert.equal(observed.error.code, failure === 'buffer-budget' ? grpc.status.RESOURCE_EXHAUSTED : grpc.status.INTERNAL);
            assert.equal(cancels, 1); assert.equal(body.locked, false); idle(f.transport);
            assert.equal(call.callbacks, 1); assert.deepEqual(call.statuses, [observed.error.code]);
            const recovered = start(c, 'x');
            assert.equal((await recovered.done).response, 'ok');
            await turn(); idle(f.transport);
            releaseCancel(); await turn(); assert.equal(call.callbacks, 1);
        } finally { releaseCancel(); await f.close(); }
    }
});

test('RESOURCES a shared byte budget accounts for concurrent response frames and recovers after overflow', async () => {
    let pulls = 0, cancelled = 0;
    const wireFrame = encodeFrame(Buffer.alloc(40, 65));
    const f = fixture({ maxBufferedBytes: 160, readableHighWaterMark: 1 }), c = f.make();
    try {
        const slow = c.stream('stream'), streamStatus = [];
        const streamError = new Promise(resolve => slow.on('error', resolve));
        slow.on('status', result => streamStatus.push(result.code));
        slow.read(0);
        await until(() => f.pending.length === 1);
        f.pending[0].resolve(new Response(new ReadableStream({
            pull(controller) { pulls++; controller.enqueue(wireFrame); }, cancel() { cancelled++; },
        }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/grpc-web+proto' } }));
        await until(() => slow.readableLength === 1 && f.transport.resourceUsage().bufferedBytes >= 90);
        const other = start(c, 'other'); await until(() => f.pending.length === 2);
        f.complete(1, 'B'.repeat(60));
        const rejected = await other.done;
        assert.equal(rejected.error.code, grpc.status.RESOURCE_EXHAUSTED);
        assert.equal(rejected.error.details, 'WGA_BUFFER_BUDGET');
        slow.cancel(); assert.equal((await streamError).code, grpc.status.CANCELLED);
        await until(() => f.transport.resourceUsage().bufferedBytes === 0);
        assert.equal(cancelled, 1); assert.deepEqual(streamStatus, [grpc.status.CANCELLED]);
        assert.ok(pulls <= 2); idle(f.transport);
        const recovered = start(c, 'recovered'); await until(() => f.pending.length === 3);
        f.complete(2); assert.equal((await recovered.done).response, 'recovered');
        await turn(); idle(f.transport);
    } finally { await f.close(); }
});

test('RESOURCES readableHighWaterMark one bounds a slow consumer and resumes one message at a time', async () => {
    let pulls = 0, cancelled = 0;
    const f = fixture({ readableHighWaterMark: 1, maxBufferedBytes: 4096 }), c = f.make();
    try {
        const stream = c.stream('stream');
        const failure = new Promise(resolve => stream.on('error', resolve));
        assert.equal(stream.readableHighWaterMark, 1);
        stream.read(0);
        await until(() => f.pending.length === 1);
        f.pending[0].resolve(new Response(new ReadableStream({
            pull(controller) { controller.enqueue(encodeFrame(Buffer.from(String(pulls++)))); },
            cancel() { cancelled++; },
        }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/grpc-web+proto' } }));
        await until(() => stream.readableLength === 1); await turn();
        assert.ok(pulls <= 2, 'one readable message and at most one parser lookahead');
        for (let index = 0; index < 5; index++) {
            await until(() => stream.readableLength === 1);
            assert.equal(stream.read(), String(index));
            await turn(); assert.ok(stream.readableLength <= 1);
            assert.ok(pulls <= index + 3);
        }
        stream.cancel(); assert.equal((await failure).code, grpc.status.CANCELLED);
        await until(() => f.transport.resourceUsage().bufferedBytes === 0);
        assert.equal(cancelled, 1); idle(f.transport);
    } finally { await f.close(); }
});
