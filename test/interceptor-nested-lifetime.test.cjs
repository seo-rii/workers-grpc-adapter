'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, response, deferred, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

const diagnostics = { start: 'WGA_INTERCEPTOR_START', sendMessage: 'WGA_INTERCEPTOR_SEND', halfClose: 'WGA_INTERCEPTOR_HALF_CLOSE' };
async function probe(mode, phase, topology, scenario = 'reject', kind = 'unary') {
    const pending = deferred(), statuses = [], callbacks = [], errors = [], writes = [];
    let listener, hooks = 0, fetches = 0, resume;
    const synthetic = {
        getPeer: () => 'cached', getAuthContext: () => null,
        start(_metadata, value) { listener = value; },
        sendMessageWithContext(context) { queueMicrotask(() => context.callback?.()); },
        sendMessage() {}, startRead() {},
        halfClose() {
            if (scenario === 'terminal-reject') {
                listener.onReceiveMessage({ text: 'cached' });
                listener.onReceiveStatus({ code: grpc.status.OK, details: '', metadata: new grpc.Metadata() });
            }
        },
        // A synthetic transport can deliver cancellation itself, but local
        // completion must also work before start has forwarded a listener.
        cancelWithStatus(code, details) { listener?.onReceiveStatus({ code, details, metadata: new grpc.Metadata() }); },
    };
    const requester = { [phase](...args) {
        hooks++;
        resume = () => args.at(-1)(...args.slice(0, -1));
        if (scenario === 'throw') throw new Error('REQUESTER_FAILURE');
        if (scenario === 'thenable') return { then(_resolve, reject) { reject(new Error('REQUESTER_FAILURE')); } };
        if (scenario === 'reject') return Promise.reject(new Error('REQUESTER_FAILURE'));
        if (scenario === 'next-reject' || scenario === 'terminal-reject') resume();
        return pending.promise;
    } };
    const interceptors = topology === 'registered' ? [
        (options, next) => new grpc.InterceptingCall(next(options)),
        () => new grpc.InterceptingCall(synthetic, requester),
    ] : [(options, next) => {
        let call = new grpc.InterceptingCall(topology === 'real' ? next(options) : synthetic, requester);
        const depth = topology === 'single' ? 1 : topology === 'nested3' ? 3 : 2;
        for (let index = 1; index < depth; index++) call = new grpc.InterceptingCall(call);
        return call;
    }];
    const factory = createWorkersGrpcTransport({ mode,
        ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
        resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 },
        fetcher: { fetch() { fetches++; return response(); } },
    });
    const client = new Echo('echo.test', factory.channelCredentials, factory.grpcOptions({ interceptors }));
    try {
        const options = { deadline: scenario === 'deadline-reject' ? Date.now() + 60000 : Infinity };
        const callback = error => callbacks.push(error?.code ?? grpc.status.OK);
        const call = kind === 'unary' ? client.unary({ text: 'request' }, options, callback)
            : kind === 'stream' ? client.stream({ text: 'request' }, options)
            : kind === 'clientStream' ? client.clientStream(options, callback) : client.bidi(options);
        call.on('status', value => statuses.push(value));
        call.on('error', error => errors.push(error.code));
        if (kind === 'stream' || kind === 'bidi') call.resume();
        if (kind === 'clientStream' || kind === 'bidi') {
            call.write({ text: 'request' }, error => writes.push(error));
            call.end();
        }
        await immediate();
        assert.equal(hooks, 1);
        if (scenario === 'cancel-reject') call.cancel();
        if (scenario === 'deadline-reject') {
            const now = Date.now;
            try {
                Date.now = () => now() + 120000;
                pending.reject(new Error('LATE_FAILURE'));
                await immediate();
            } finally { Date.now = now; }
        } else if (!['reject', 'thenable', 'throw'].includes(scenario)) pending.reject(new Error('LATE_FAILURE'));
        await immediate(); await immediate();
        const expected = scenario === 'terminal-reject' ? grpc.status.OK : scenario === 'cancel-reject' ? grpc.status.CANCELLED
            : scenario === 'deadline-reject' ? grpc.status.DEADLINE_EXCEEDED : grpc.status.INTERNAL;
        assert.deepEqual(statuses.map(value => value.code), [expected]);
        if (expected === grpc.status.INTERNAL) assert.equal(statuses[0].details, diagnostics[phase]);
        assert.deepEqual(callbacks, kind === 'unary' || kind === 'clientStream' ? [expected] : []);
        assert.deepEqual(errors, kind === 'stream' || kind === 'bidi' ? [expected] : []);
        if (kind === 'clientStream' || kind === 'bidi') {
            assert.equal(writes.length, 1);
            if (phase === 'start' || phase === 'sendMessage') assert.ok(writes[0] instanceof Error);
        }
        assert.equal(client.getChannel().activeCallCount(), 0);
        assert.equal(factory.resourceUsage().activeCalls, 0);
        assert.equal(factory.resourceUsage().bufferedBytes, 0);
        assert.equal(fetches, 0);
        resume?.();
        call.cancel();
        await immediate();
        assert.equal(statuses.length, 1, 'Late continuations cannot restart a completed call');
        assert.equal(factory.resourceUsage().activeCalls, 0);
    } finally { client.close(); }
}

for (const mode of ['cloudflare', 'grpc-web']) for (const phase of Object.keys(diagnostics)) {
    for (const topology of ['single', 'nested2', 'nested3', 'registered', 'real']) {
        test(`INTERCEPTOR ${mode}/${phase} rejects through ${topology} lifetime`, () => probe(mode, phase, topology));
    }
    for (const scenario of ['throw', 'thenable', 'next-reject', 'terminal-reject', 'cancel-reject', 'deadline-reject']) {
        test(`INTERCEPTOR nested synthetic ${mode}/${phase} preserves ${scenario}`, () => probe(mode, phase, 'nested3', scenario));
    }
    test(`INTERCEPTOR nested synthetic ${mode}/${phase} completes server streaming`, () => probe(mode, phase, 'nested2', 'reject', 'stream'));
}
for (const kind of ['clientStream', 'bidi']) for (const phase of Object.keys(diagnostics)) {
    test(`INTERCEPTOR nested synthetic ${kind}/${phase} completes pending writes`, () => probe('grpc-web', phase, 'nested2', 'reject', kind));
}
