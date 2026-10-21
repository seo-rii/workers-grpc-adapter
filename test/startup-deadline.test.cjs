'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, response, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { decodeFrames } = require('../dist/wire.js');

const supportedCalls = [
    ['cloudflare', 'unary'], ['cloudflare', 'stream'],
    ['grpc-web', 'unary'], ['grpc-web', 'stream'], ['grpc-web', 'clientStream'], ['grpc-web', 'bidi'],
];
const boundaries = ['client-provider', 'call-provider', 'transformer'];

function clock(t) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1000;
    t.mock.method(Date, 'now', () => now);
    return elapsed => { now += elapsed; };
}
function fixture(mode, defaultTimeoutMs) {
    const requests = [];
    let authentication = 0;
    const factory = createWorkersGrpcTransport({ mode, defaultTimeoutMs,
        ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
        resourceLimits: { maxConcurrentCalls: 1 },
        fetcher: { async fetch(_url, init) {
            requests.push({ timeout: init.headers.get('grpc-timeout') });
            if (!Buffer.isBuffer(init.body)) {
                for await (const frame of decodeFrames(init.body, 1024)) assert.equal(frame.trailer, false);
            }
            return response();
        } },
    });
    const auth = grpc.credentials.createFromMetadataGenerator((_options, done) => {
        authentication++; done(null, new grpc.Metadata());
    });
    const credentials = grpc.credentials.combineChannelCredentials(factory.channelCredentials, auth);
    return { factory, credentials, requests, authCount: () => authentication };
}
function start(client, kind, options) {
    const callbacks = [], values = [], statuses = [];
    const callback = (error, value) => { callbacks.push(error?.code ?? grpc.status.OK); if (value) values.push(value); };
    const call = kind === 'unary' ? client.unary({ text: 'request' }, options, callback)
        : kind === 'stream' ? client.stream({ text: 'request' }, options)
        : kind === 'clientStream' ? client.clientStream(options, callback) : client.bidi(options);
    call.on('error', () => {});
    if (kind === 'stream' || kind === 'bidi') call.on('data', value => values.push(value));
    const done = new Promise(resolve => call.on('status', value => { statuses.push(value.code); resolve(value.code); }));
    if (kind === 'clientStream' || kind === 'bidi') call.end({ text: 'request' });
    return { call, callbacks, values, statuses, done };
}
async function completed(client, transport, result, kind, expected) {
    assert.equal(await result.done, expected);
    await immediate();
    assert.deepEqual(result.statuses, [expected]);
    assert.deepEqual(result.callbacks, kind === 'stream' || kind === 'bidi' ? [] : [expected]);
    assert.deepEqual(result.values, expected === grpc.status.OK ? [{ text: 'ok' }] : []);
    assert.equal(client.getChannel().activeCallCount(), 0);
    assert.equal(transport.resourceUsage().activeCalls, 0);
    assert.equal(transport.resourceUsage().bufferedBytes, 0);
    assert.equal(transportCall(result.call).diagnostics().timerActive, false);
}
const passThrough = (options, nextCall) => new grpc.InterceptingCall(nextCall(options));

for (const [mode, kind] of supportedCalls) for (const boundary of boundaries) for (const elapsed of [99, 100]) {
    test(`LIFETIME ${mode} ${kind} default budget includes ${boundary} elapsed=${elapsed}`, async t => {
        const advance = clock(t), f = fixture(mode, 100);
        const clientOptions = {}, callOptions = {};
        const provider = () => { advance(elapsed); return passThrough; };
        if (boundary === 'client-provider') clientOptions.interceptor_providers = [provider];
        else if (boundary === 'call-provider') callOptions.interceptor_providers = [provider];
        else clientOptions.callInvocationTransformer = properties => { advance(elapsed); return properties; };
        const client = new Echo('echo.test', f.credentials, f.factory.grpcOptions(clientOptions));
        try {
            const expired = elapsed >= 100;
            await completed(client, f.factory, start(client, kind, callOptions), kind,
                expired ? grpc.status.DEADLINE_EXCEEDED : grpc.status.OK);
            assert.equal(f.authCount(), expired ? 0 : 1);
            assert.deepEqual(f.requests, expired ? [] : [{ timeout: '1m' }]);
        } finally { client.close(); }
    });
}

for (const [mode, kind] of supportedCalls) for (const boundary of boundaries) for (const deadline of [1100, 1400, Infinity]) {
    test(`LIFETIME ${mode} ${kind} ${boundary} preserves explicit deadline=${deadline}`, async t => {
        const advance = clock(t), f = fixture(mode, 100);
        const clientOptions = {}, callOptions = { deadline };
        const provider = () => { advance(100); return passThrough; };
        if (boundary === 'client-provider') clientOptions.interceptor_providers = [provider];
        else if (boundary === 'call-provider') callOptions.interceptor_providers = [provider];
        else clientOptions.callInvocationTransformer = properties => { advance(100); return properties; };
        const client = new Echo('echo.test', f.credentials, f.factory.grpcOptions(clientOptions));
        try {
            const expired = deadline === 1100;
            await completed(client, f.factory, start(client, kind, callOptions), kind,
                expired ? grpc.status.DEADLINE_EXCEEDED : grpc.status.OK);
            assert.equal(f.authCount(), expired ? 0 : 1);
            assert.deepEqual(f.requests, expired ? [] : [{ timeout: deadline === Infinity ? null : '300m' }]);
        } finally { client.close(); }
    });
}

for (const kind of ['unary', 'stream', 'clientStream', 'bidi']) {
    for (const scenario of ['short-selected', 'long-selected', 'unbounded-selected', 'final-absolute', 'final-infinity', 'final-default']) {
        test(`LIFETIME ${kind} startup uses selected channel and final options: ${scenario}`, async t => {
            const advance = clock(t);
            const original = fixture('grpc-web', 100);
            const selectedDefault = scenario === 'short-selected' ? 100 : scenario === 'unbounded-selected' ? undefined : 1000;
            const selected = fixture('grpc-web', selectedDefault);
            const channel = new grpc.Channel('echo.test', selected.credentials, selected.factory.grpcOptions());
            const finalDeadline = scenario === 'final-absolute' ? 1400 : scenario === 'final-infinity' ? Infinity : undefined;
            const client = new Echo('echo.test', original.credentials, original.factory.grpcOptions({
                callInvocationTransformer(properties) { advance(100); return { ...properties, channel }; },
                interceptor_providers: [() => {
                    advance(50);
                    return (options, nextCall) => passThrough({ ...options,
                        ...(scenario.startsWith('final-') ? { deadline: finalDeadline } : {}) }, nextCall);
                }],
            }));
            try {
                const options = scenario.startsWith('final-') ? { deadline: 1050 } : {};
                const result = start(client, kind, options);
                const expired = scenario === 'short-selected';
                // The transformer's selected channel, rather than the original
                // client's channel, owns the call and default timeout policy.
                assert.equal(await result.done, expired ? grpc.status.DEADLINE_EXCEEDED : grpc.status.OK);
                await immediate();
                assert.deepEqual(result.statuses, [expired ? grpc.status.DEADLINE_EXCEEDED : grpc.status.OK]);
                assert.equal(channel.activeCallCount(), 0);
                assert.equal(selected.factory.resourceUsage().activeCalls, 0);
                assert.equal(selected.factory.resourceUsage().bufferedBytes, 0);
                assert.equal(original.factory.resourceUsage().peakActiveCalls, 0);
                assert.equal(original.authCount(), 0);
                assert.deepEqual(original.requests, []);
                assert.equal(selected.authCount(), expired ? 0 : 1);
                const timeout = scenario === 'unbounded-selected' || scenario === 'final-infinity' ? null
                    : scenario === 'final-absolute' ? '250m' : '850m';
                assert.deepEqual(selected.requests, expired ? [] : [{ timeout }]);
                assert.equal(transportCall(result.call).diagnostics().timerActive, false);
            } finally { client.close(); channel.close(); }
        });
    }
}

for (const scope of ['client', 'call']) {
    test(`LIFETIME throwing ${scope} provider leaves no registered call or work`, async t => {
        const advance = clock(t), f = fixture('grpc-web', 100), failure = new Error('Controlled provider failure');
        const provider = () => { advance(200); throw failure; };
        const client = new Echo('echo.test', f.credentials, f.factory.grpcOptions(scope === 'client' ? { interceptor_providers: [provider] } : {}));
        try {
            const options = scope === 'call' ? { interceptor_providers: [provider] } : {};
            assert.throws(() => client.unary({ text: 'request' }, options, () => assert.fail('No call was constructed')), error => error === failure);
            await immediate();
            assert.equal(client.getChannel().activeCallCount(), 0);
            assert.equal(f.factory.resourceUsage().activeCalls, 0);
            assert.equal(f.factory.resourceUsage().bufferedBytes, 0);
            assert.equal(f.authCount(), 0);
            assert.deepEqual(f.requests, []);
        } finally { client.close(); }
    });
}
