'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { grpc, Echo, methods, response, serialize, deserialize, deferred, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

const config = mode => ({ mode, ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}) });
const principal = (metadata, value) => {
    metadata.set('x-principal', value);
    metadata.set('authorization', `Bearer synthetic-${value}`);
};
const headers = init => ['x-principal', 'authorization', 'proof-bin', 'x-repeated', 'x-original'].map(key => init.headers.get(key));
function start(client, text, metadata = new grpc.Metadata()) {
    const record = { call: undefined, callbacks: 0, statuses: [] };
    record.done = new Promise(resolve => {
        record.call = client.unary({ text }, metadata, { deadline: Date.now() + 2000 }, (error, value) => {
            record.callbacks++;
            resolve({ error, value });
        });
        record.call.on('status', value => record.statuses.push(value.code));
    });
    return record;
}
function idle(client, transport) {
    assert.equal(client.getChannel().activeCallCount(), 0);
    const usage = transport.resourceUsage();
    assert.equal(usage.activeCalls, 0);
    assert.equal(usage.queuedCalls, 0);
    assert.equal(usage.bufferedBytes, 0);
}
async function success(calls) {
    for (const call of calls) {
        assert.ifError((await call.done).error);
        assert.equal(call.callbacks, 1);
        assert.deepEqual(call.statuses, [grpc.status.OK]);
    }
}

for (const mode of ['cloudflare', 'grpc-web']) {
    for (const limited of [false, true]) {
        test(`METADATA admission snapshots reused authorization and binary values ${mode} limit=${limited}`, { timeout: 3000 }, async () => {
            const seen = [], calls = [];
            const transport = createWorkersGrpcTransport({ ...config(mode),
                ...(limited ? { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 } } : {}),
                fetcher: { async fetch(_url, init) { seen.push(headers(init)); return response(); } },
            });
            const client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions());
            try {
                const metadata = new grpc.Metadata(), proof = Buffer.from([1]);
                principal(metadata, 'a');
                metadata.set('proof-bin', proof);
                metadata.add('x-repeated', 'one'); metadata.add('x-repeated', 'first');
                metadata.set('x-original', 'retained');
                calls.push(start(client, 'first', metadata));
                principal(metadata, 'b'); proof[0] = 2;
                metadata.get('x-repeated')[0] = 'two'; metadata.add('x-repeated', 'second');
                metadata.remove('x-original');
                calls.push(start(client, 'second', metadata));
                await success(calls); await immediate();
                assert.deepEqual(seen, [
                    ['a', 'Bearer synthetic-a', 'AQ==', 'one, first', 'retained'],
                    ['b', 'Bearer synthetic-b', 'Ag==', 'two, first, second', null],
                ]);
                idle(client, transport);
            } finally { client.close(); await Promise.all(calls.map(call => call.done)); }
        });
    }

    test(`METADATA queued interceptors receive per-call headers and cancellation releases admission ${mode}`, { timeout: 3000 }, async () => {
        const entered = deferred(), held = deferred(), seen = [], started = [], contexts = [], calls = [];
        const transport = createWorkersGrpcTransport({ ...config(mode),
            resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 3 },
            fetcher: { async fetch(_url, init) {
                const value = [init.headers.get('x-principal'), init.headers.get('authorization')];
                seen.push(value);
                if (seen.length === 1) { entered.resolve(); return held.promise; }
                return response();
            } },
        });
        const options = { idempotentRequest: true }, metadata = new grpc.Metadata(options);
        const ownerA = {}, ownerB = {};
        const client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions({
            interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                start(value, listener, next) {
                    const owner = value.get('x-principal')[0];
                    started.push(owner);
                    assert.notStrictEqual(value, metadata);
                    if (owner !== 'blocker') {
                        contexts.push({ owner: value.getOpaque('owner'), retained: value.getOpaque('retained'),
                            later: value.getOpaque('later'), options: { ...value.getOptions() } });
                        value.setOpaque('interceptor', owner);
                        value.getOptions().idempotentRequest = true;
                    }
                    value.set('authorization', `Bearer interceptor-${owner}`);
                    next(value, listener);
                },
            })],
        }));
        try {
            const blocker = new grpc.Metadata(); principal(blocker, 'blocker');
            calls.push(start(client, 'blocker', blocker)); await entered.promise;
            principal(metadata, 'a'); metadata.setOpaque('owner', ownerA); metadata.setOpaque('retained', 'original');
            calls.push(start(client, 'queued-a', metadata));
            options.idempotentRequest = false;
            principal(metadata, 'cancelled'); const cancelled = start(client, 'cancelled', metadata); calls.push(cancelled);
            principal(metadata, 'b'); metadata.setOpaque('owner', ownerB); metadata.setOpaque('retained', 'changed');
            metadata.setOpaque('later', 'b-only'); metadata.setOptions({ cacheableRequest: true });
            calls.push(start(client, 'queued-b', metadata));
            assert.equal(transport.resourceUsage().queuedCalls, 3);
            assert.deepEqual(started, ['blocker']);
            cancelled.call.cancel();
            assert.equal((await cancelled.done).error.code, grpc.status.CANCELLED);
            assert.equal(cancelled.callbacks, 1);
            assert.deepEqual(cancelled.statuses, [grpc.status.CANCELLED]);
            assert.equal(transport.resourceUsage().queuedCalls, 2);
            held.resolve(response());
            await success(calls.filter(call => call !== cancelled)); await immediate();
            assert.deepEqual(started, ['blocker', 'a', 'b']);
            assert.deepEqual(seen, [['blocker', 'Bearer interceptor-blocker'], ['a', 'Bearer interceptor-a'], ['b', 'Bearer interceptor-b']]);
            assert.deepEqual(contexts, [
                { owner: ownerA, retained: 'original', later: undefined, options: { idempotentRequest: true } },
                { owner: ownerB, retained: 'changed', later: 'b-only', options: { cacheableRequest: true } },
            ]);
            assert.strictEqual(contexts[0].owner, ownerA); assert.strictEqual(contexts[1].owner, ownerB);
            assert.equal(metadata.getOpaque('interceptor'), undefined);
            assert.deepEqual(metadata.getOptions(), { cacheableRequest: true });
            assert.deepEqual(metadata.get('authorization'), ['Bearer synthetic-b']);
            idle(client, transport);
        } finally { held.resolve(response()); client.close(); await Promise.all(calls.map(call => call.done)); }
    });

    test(`METADATA admission without concurrency limits retains synchronous requester startup ${mode}`, { timeout: 3000 }, async () => {
        const metadata = new grpc.Metadata(), local = {}, calls = [];
        metadata.setOpaque('local', local);
        let started = false;
        const transport = createWorkersGrpcTransport({ ...config(mode), resourceLimits: { maxBufferedBytes: 4096 },
            fetcher: { async fetch(_url, init) {
                assert.equal(init.headers.get('authorization'), 'Bearer interceptor');
                return response();
            } },
        });
        const client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions({
            interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                start(value, listener, next) {
                    assert.strictEqual(value, metadata);
                    assert.strictEqual(value.getOpaque('local'), local);
                    value.set('authorization', 'Bearer interceptor'); started = true;
                    next(value, listener);
                },
            })],
        }));
        try {
            calls.push(start(client, 'request', metadata));
            assert.equal(started, true);
            assert.deepEqual(metadata.get('authorization'), ['Bearer interceptor']);
            await success(calls); await immediate(); idle(client, transport);
        } finally { client.close(); await Promise.all(calls.map(call => call.done)); }
    });

    test(`METADATA snapshot failure terminates once before admission ${mode}`, { timeout: 3000 }, async () => {
        let starts = 0, fetches = 0;
        class InvalidMetadata extends grpc.Metadata { clone() { throw new Error('synthetic snapshot failure'); } }
        const transport = createWorkersGrpcTransport({ ...config(mode), resourceLimits: { maxConcurrentCalls: 1 },
            fetcher: { async fetch() { fetches++; return response(); } },
        });
        const client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions({
            interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                start(value, listener, next) { starts++; next(value, listener); },
            })],
        }));
        const calls = [];
        try {
            calls.push(start(client, 'invalid', new InvalidMetadata()));
            const result = await calls[0].done; await immediate();
            assert.equal(result.error.code, grpc.status.INTERNAL);
            assert.equal(result.error.details, 'WGA_INTERCEPTOR_START');
            assert.equal(calls[0].callbacks, 1);
            assert.deepEqual(calls[0].statuses, [grpc.status.INTERNAL]);
            assert.equal(starts, 0); assert.equal(fetches, 0);
            idle(client, transport);
        } finally { client.close(); await Promise.all(calls.map(call => call.done)); }
    });
}

test('METADATA pinned native client snapshots reused authorization before asynchronous I/O', { timeout: 3000 }, async () => {
    const nativeRequire = createRequire(path.join(__dirname, '../fixtures/native/package.json'));
    const native = nativeRequire('@grpc/grpc-js'), seen = [], server = new native.Server();
    const definitions = Object.fromEntries(Object.entries(methods).map(([key, value]) => [key, {
        ...value, requestDeserialize: deserialize, responseSerialize: serialize,
    }]));
    server.addService(definitions, { unary(call, callback) {
        seen.push([call.metadata.get('x-principal')[0], call.metadata.get('authorization')[0], call.metadata.get('proof-bin')[0][0]]);
        callback(null, { text: 'ok' });
    } });
    let client;
    try {
        const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(),
            (error, value) => error ? reject(error) : resolve(value)));
        const NativeEcho = native.makeGenericClientConstructor(methods, 'demo.Echo');
        client = new NativeEcho(`127.0.0.1:${port}`, native.credentials.createInsecure());
        const metadata = new native.Metadata(), proof = Buffer.from([1]);
        principal(metadata, 'a'); metadata.set('proof-bin', proof);
        const first = start(client, 'first', metadata);
        principal(metadata, 'b'); proof[0] = 2;
        const second = start(client, 'second', metadata);
        await success([first, second]);
        assert.deepEqual(seen, [['a', 'Bearer synthetic-a', 1], ['b', 'Bearer synthetic-b', 2]]);
    } finally { client?.close(); server.forceShutdown(); }
});
