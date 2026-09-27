'use strict';
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, client, response, withFetch, unary, immediate, deferred, transportCall, serialize, deserialize } = require('./helpers.cjs');
const { createGrpcWebHandler, GrpcWebServerError } = require('../dist/server.js');
const { encodeFrame, decodeFrames, parseTrailers } = require('../dist/wire.js');
class Parent extends EventEmitter {
    constructor(deadline = Infinity) { super(); this.deadline = deadline; this.cancelled = false; }
    getDeadline() { return this.deadline; }
    cancel() { this.cancelled = true; this.emit('cancelled'); }
}
function hangingFetch(arrived = deferred()) {
    let aborts = 0;
    return { arrived, get aborts() { return aborts; }, fetch: async (_url, init) => {
        arrived.resolve(init);
        return new Promise((_resolve, reject) => {
            const abort = () => { aborts++; reject(new Error('test aborted')); };
            init.signal.addEventListener('abort', abort, { once: true });
            if (init.signal.aborted) abort();
        });
    } };
}
function clean(c, parent, call) {
    assert.equal(parent.listenerCount('cancelled'), 0);
    assert.equal(c.getChannel().activeCallCount(), 0);
    if (call) assert.equal(transportCall(call).diagnostics().timerActive, false);
}

test('PARENT cancellation flags are independent and default applies in both transport modes', async () => {
    for (const mode of ['grpc-web', 'cloudflare']) for (const flags of [undefined, ...Array.from({ length: 16 }, (_, i) => i), grpc.propagate.DEFAULTS,
        grpc.propagate.DEFAULTS & ~grpc.propagate.DEADLINE, grpc.propagate.DEFAULTS & ~grpc.propagate.CANCELLATION, 16, 32768]) {
        const c = client({}, mode === 'grpc-web' ? { mode, endpoints: { 'echo.test:443': 'https://gateway.test' } } : { mode }); const parent = new Parent(); const fetched = deferred();
        try {
            await withFetch(async () => { fetched.resolve(); return response(); }, async () => {
                const result = unary(c, { text: 'flags' }, { parent, propagate_flags: flags });
                const cancellation = flags === undefined || (flags & grpc.propagate.CANCELLATION) !== 0;
                const observed = cancellation ? assert.rejects(result.promise, { code: 1, details: 'Cancelled by parent call' }) : result.promise;
                parent.cancel();
                const value = await observed;
                if (!cancellation) assert.deepEqual(value, { text: 'ok' });
                clean(c, parent, result.call);
            });
        } finally { c.close(); }
    }
});

test('PARENT deadline takes minimum of call, parent and adapter default; timeout reaches wire', async () => {
    for (const [childMs, parentMs, defaultMs, flags, expected] of [
        [4000, 9000, undefined, undefined, 4000], [9000, 4000, undefined, 1, 4000],
        [undefined, 9000, 4000, undefined, 4000], [undefined, 4000, undefined, undefined, 4000],
        [4000, 1, undefined, 8, 4000], [4000, -1, undefined, grpc.propagate.DEFAULTS & ~grpc.propagate.DEADLINE, 4000],
        [Infinity, Infinity, undefined, 1, Infinity],
    ]) {
        const started = Date.now(); const c = client({}, defaultMs ? { defaultTimeoutMs: defaultMs } : {});
        const parent = new Parent(parentMs === Infinity ? Infinity : new Date(started + parentMs));
        try {
            await withFetch(async (_url, init) => {
                const timeout = init.headers.get('grpc-timeout');
                if (expected === Infinity) assert.equal(timeout, null);
                else {
                    assert.match(timeout, /^\d+m$/);
                    const remaining = Number(timeout.slice(0, -1));
                    assert.ok(remaining <= expected && remaining > expected - 2000, `${remaining} within ${expected}`);
                }
                return response();
            }, async () => {
                await unary(c, undefined, { parent, propagate_flags: flags,
                    ...(childMs === undefined ? {} : { deadline: childMs === Infinity ? Infinity : started + childMs }) }).promise;
                clean(c, parent);
            });
        } finally { c.close(); }
    }
});

test('PARENT expired deadline and already-cancelled parent perform no authentication or Fetch', async () => {
    let auth = 0, fetches = 0;
    const credentials = grpc.credentials.createFromMetadataGenerator((_input, callback) => { auth++; callback(null, new grpc.Metadata()); });
    const c = client();
    try {
        await withFetch(async () => { fetches++; return response(); }, async () => {
            for (const [parent, code] of [[new Parent(Date.now() - 1), 4], [Object.assign(new Parent(), { cancelled: true }), 1]]) {
                const result = unary(c, undefined, { parent, credentials });
                await assert.rejects(result.promise, { code }); clean(c, parent, result.call);
            }
        });
        assert.equal(auth, 0); assert.equal(fetches, 0);
    } finally { c.close(); }
});

test('PARENT deadline expires an outstanding Fetch and releases listener, timer and active call', { timeout: 3000 }, async () => {
    const c = client(), parent = new Parent(Date.now() + 100), fake = hangingFetch();
    try {
        await withFetch(fake.fetch, async () => {
            const result = unary(c, undefined, { parent, propagate_flags: 1 });
            await assert.rejects(result.promise, { code: 4 });
            assert.equal(fake.aborts, 1); clean(c, parent, result.call);
        });
    } finally { c.close(); }
});

test('PARENT cancellation during pending authentication blocks late credentials and Fetch', async () => {
    const c = client(), parent = new Parent(), ready = deferred(); let callback, fetches = 0;
    const credentials = grpc.credentials.createFromMetadataGenerator((_input, done) => { callback = done; ready.resolve(); });
    try {
        await withFetch(async () => { fetches++; return response(); }, async () => {
            const result = unary(c, undefined, { parent, credentials });
            const rejected = assert.rejects(result.promise, { code: 1 });
            await ready.promise; parent.cancel(); await rejected;
            callback(null, new grpc.Metadata()); await immediate();
            assert.equal(fetches, 0); clean(c, parent, result.call);
        });
    } finally { c.close(); }
});

test('PARENT cancellation aborts unary, server-stream, client-stream and bidi calls exactly once', async () => {
    for (const kind of ['unary', 'stream', 'clientStream', 'bidi']) {
        const c = client({}, { mode: 'grpc-web', endpoints: { 'echo.test:443': 'https://gateway.test' }, experimentalRequestStreaming: true });
        const parent = new Parent(), fake = hangingFetch(); let call, statuses = 0, errors = 0;
        try {
            await withFetch(fake.fetch, async () => {
                let promise;
                if (kind === 'unary') ({ call, promise } = unary(c, undefined, { parent }));
                else if (kind === 'clientStream') promise = new Promise((resolve, reject) => {
                    call = c.clientStream({ parent }, (error, value) => error ? reject(error) : resolve(value));
                });
                else { call = kind === 'stream' ? c.stream({ text: 'stream' }, { parent }) : c.bidi({ parent });
                    promise = new Promise((_resolve, reject) => call.once('error', reject)); }
                const rejected = assert.rejects(promise, { code: 1 });
                call.on('status', () => statuses++); call.on('error', () => errors++);
                if (kind === 'clientStream' || kind === 'bidi') call.write({ text: 'pending write' }, () => {});
                await fake.arrived.promise; parent.cancel(); parent.cancel(); await rejected; await immediate();
                assert.equal(statuses, 1); assert.equal(fake.aborts, 1);
                if (kind === 'stream' || kind === 'bidi') assert.ok(errors >= 1);
                clean(c, parent, call);
            });
        } finally { c.close(); }
    }
});

test('PARENT child cancellation and channel close never cancel the parent or siblings', async () => {
    const c = client(), parent = new Parent();
    try {
        await withFetch(async () => new Promise(() => {}), async () => {
            const first = unary(c, undefined, { parent }), second = unary(c, undefined, { parent });
            const rejectedFirst = assert.rejects(first.promise, { code: 1 });
            const rejectedSecond = assert.rejects(second.promise, { code: 14 });
            first.call.cancel(); await rejectedFirst;
            assert.equal(parent.cancelled, false); assert.equal(parent.listenerCount('cancelled'), 1);
            assert.equal(c.getChannel().activeCallCount(), 1);
            c.close(); await rejectedSecond;
            assert.equal(parent.cancelled, false); clean(c, parent);
        });
    } finally { c.close(); }
});

test('PARENT detaches on success, server failure, auth failure and invalid child deadline', async () => {
    const c = client();
    try {
        for (const kind of ['success', 'server', 'auth', 'deadline']) {
            const parent = new Parent(); const options = { parent };
            if (kind === 'auth') options.credentials = grpc.credentials.createFromMetadataGenerator((_input, callback) => callback(new Error('secret'), null));
            if (kind === 'deadline') options.deadline = NaN;
            await withFetch(async () => response(kind === 'server' ? [] : undefined, { code: kind === 'server' ? 7 : 0 }), async () => {
                const result = unary(c, undefined, options);
                if (kind === 'success') await result.promise;
                else await assert.rejects(result.promise, { code: { server: 7, auth: 2, deadline: 13 }[kind] });
                clean(c, parent, result.call); parent.cancel(); clean(c, parent);
            });
        }
    } finally { c.close(); }
});

test('PARENT cancellation interrupts retry backoff without a second attempt', async () => {
    const c = client({}, { retryPolicy: { methods: ['/demo.Echo/Unary'], maxAttempts: 3, initialBackoffMs: 1000,
        maxBackoffMs: 1000, backoffMultiplier: 1, retryableStatusCodes: [14] } });
    const parent = new Parent(); let fetches = 0;
    try {
        await withFetch(async () => { fetches++; return response([], { code: 14 }); }, async () => {
            const result = unary(c, undefined, { parent }); const rejected = assert.rejects(result.promise, { code: 1 });
            await immediate(); await immediate(); assert.equal(fetches, 1);
            parent.cancel(); await rejected; await immediate(); assert.equal(fetches, 1); clean(c, parent, result.call);
        });
    } finally { c.close(); }
});

test('PARENT subscription reentrancy and throwing registration cannot leak calls or listeners', async () => {
    const c = client();
    try {
        for (const behavior of ['synchronous', 'newListener', 'throw', 'newListener-throw', 'terminal-throw']) {
            const parent = new Parent();
            if (behavior === 'synchronous') parent.on = function(event, listener) { superOn.call(this, event, listener); this.cancel(); return this; };
            if (behavior.startsWith('newListener')) parent.once('newListener', () => parent.cancel());
            if (behavior.endsWith('throw')) parent.on = function(event, listener) {
                if (behavior === 'terminal-throw') listener();
                superOn.call(this, event, listener); throw new Error('sensitive detail');
            };
            await withFetch(async () => { assert.fail('invalid/cancelled parent must not Fetch'); }, async () => {
                const result = unary(c, undefined, { parent });
                await assert.rejects(result.promise, { code: ['throw', 'newListener-throw'].includes(behavior) ? 13 : 1 });
                clean(c, parent, result.call);
            });
        }
    } finally { c.close(); }
});
const superOn = Parent.prototype.on;

test('PARENT malformed shapes, deadlines and unsupported flags fail without network or leaking details', async () => {
    const c = client();
    const badParents = [{}, false, 42, { cancelled: false, getDeadline: () => Infinity, on() {} },
        new Parent(NaN), new Parent(-Infinity), new Parent(new Date(NaN)), new Parent('2030-01-01'),
        Object.defineProperty(new Parent(), 'cancelled', { get() { throw new Error('sensitive'); } })];
    try {
        await withFetch(async () => { assert.fail('invalid options must not Fetch'); }, async () => {
            for (const parent of badParents) await assert.rejects(unary(c, undefined, { parent }).promise, { code: 13, details: 'WGA_INVALID_PARENT' });
            for (const propagate_flags of [-1, 65536, 0.5, NaN, Infinity, '8', null]) {
                await assert.rejects(unary(c, undefined, { propagate_flags }).promise, { code: 12, details: 'WGA_CALL_OPTION' });
            }
            assert.equal(c.getChannel().activeCallCount(), 0);
        });
    } finally { c.close(); }
});

async function terminal(response) {
    let result;
    for await (const frame of decodeFrames(response.body, 1024)) if (frame.trailer) result = parseTrailers(frame.payload);
    return result;
}
const definition = { forward: { path: '/demo.Parent/Forward', requestStream: false, responseStream: false,
    requestDeserialize: deserialize, responseSerialize: serialize } };
function request(signal, headers = {}) {
    return new Request('https://parent.test/demo.Parent/Forward', { method: 'POST', signal,
        headers: { 'content-type': 'application/grpc-web', ...headers }, body: encodeFrame(serialize({ text: 'forward' })) });
}

test('PARENT actual Fetch handler forwards caller abort and deadline to a child call', { timeout: 5000 }, async () => {
    for (const scenario of ['abort', 'deadline']) {
        const c = client(), aborter = new AbortController(), fake = hangingFetch(); let context, childResult;
        const handler = createGrpcWebHandler(definition, { async forward(input, parent) {
            context = parent;
            childResult = unary(c, input, { parent });
            try { return await childResult.promise; }
            catch (error) { assert.ok([1, 4].includes(error.code)); throw new GrpcWebServerError(error.code, 'Forwarded child failure'); }
        } });
        try {
            await withFetch(fake.fetch, async () => {
                const pending = handler(request(aborter.signal, scenario === 'deadline' ? { 'grpc-timeout': '100m' } : {}));
                const init = await fake.arrived.promise;
                assert.equal(context.cancelled, false);
                assert.equal(context.getDeadline(), context.deadline);
                if (scenario === 'abort') aborter.abort();
                else assert.match(init.headers.get('grpc-timeout'), /^\d+m$/);
                assert.equal((await terminal(await pending)).code, scenario === 'abort' ? 1 : 4);
                await immediate(); assert.equal(context.cancelled, true); assert.equal(fake.aborts, 1);
                assert.equal(c.getChannel().activeCallCount(), 0);
            });
        } finally { c.close(); }
    }
});

test('PARENT Fetch context preserves successful completion without cancelling detached child work', async () => {
    const c = client(), childResponse = deferred(); let parent, child;
    const handler = createGrpcWebHandler(definition, { forward(input, context) {
        parent = context; child = unary(c, input, { parent: context });
        return { text: 'parent complete' };
    } });
    try {
        await withFetch(async () => childResponse.promise, async () => {
            assert.equal((await terminal(await handler(request()))).code, 0);
            assert.equal(parent.cancelled, false);
            assert.equal(c.getChannel().activeCallCount(), 1);
            childResponse.resolve(response()); await child.promise;
            assert.equal(c.getChannel().activeCallCount(), 0);
        });
    } finally { c.close(); }
});
