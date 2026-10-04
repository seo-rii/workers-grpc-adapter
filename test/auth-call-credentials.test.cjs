'use strict';
const { test } = require('node:test');
const { createRequire } = require('node:module');
const path = require('node:path');
const { assert, grpc, Echo, response, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

for (const mode of ['cloudflare', 'grpc-web']) {
    for (const variant of ['replace-with-empty', 'replace-with-pending']) {
        test(`AUTH foreign per-call compose cannot replace credentials ${mode} ${variant}`, { timeout: 2000 }, async () => {
            const counts = { compose: 0, channelAuth: 0, pendingAuth: 0, fetch: 0, callback: 0 };
            const transport = createWorkersGrpcTransport({ mode,
                ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
                fetcher: { async fetch() { counts.fetch++; return response(); } } });
            const channelAuth = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
                counts.channelAuth++; callback(null, new grpc.Metadata());
            });
            const foreign = { compose() {
                counts.compose++;
                return variant === 'replace-with-empty' ? grpc.credentials.createEmpty()
                    : grpc.credentials.createFromMetadataGenerator(() => { counts.pendingAuth++; });
            } };
            const client = new Echo('echo.test', grpc.credentials.combineChannelCredentials(transport.channelCredentials, channelAuth), transport.grpcOptions());
            const statuses = [];
            let call;
            try {
                const result = await new Promise(resolve => {
                    call = client.unary({ text: 'request' }, { credentials: foreign, deadline: Date.now() + 100 }, (error, value) => {
                        counts.callback++; resolve({ error, value });
                    });
                    call.on('status', value => statuses.push([value.code, value.details]));
                });
                await immediate();
                assert.deepEqual(counts, { compose: 0, channelAuth: 0, pendingAuth: 0, fetch: 0, callback: 1 });
                assert.equal(result.value, undefined);
                assert.equal(result.error?.code, 13);
                assert.equal(result.error?.details, 'WGA_CALL_CREDENTIALS');
                assert.deepEqual(statuses, [[13, 'WGA_CALL_CREDENTIALS']]);
                assert.equal(client.getChannel().activeCallCount(), 0);
                assert.equal(transportCall(call).diagnostics().timerActive, false);
            } finally { client.close(); }
        });
    }
    test(`AUTH direct setCredentials rejects foreign compose without invoking it ${mode}`, () => {
        let composed = 0, fetched = 0;
        const transport = createWorkersGrpcTransport({ mode,
            ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
            fetcher: { async fetch() { fetched++; return response(); } } });
        const client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions());
        const call = client.getChannel().createCallForMethod('/demo.Echo/Unary', false, false, {});
        try {
            assert.throws(() => call.setCredentials({ compose() { composed++; return grpc.credentials.createEmpty(); } }),
                { name: 'TypeError', message: 'Foreign CallCredentials' });
            assert.equal(composed, 0);
            assert.equal(fetched, 0);
        } finally { call.cancelWithStatus(1, 'test cleanup'); client.close(); }
        assert.equal(client.getChannel().activeCallCount(), 0);
    });
}

test('AUTH native CallCredentials subclass compose receiver keeps per-call before channel order', { timeout: 2000 }, async () => {
    const nativeRequire = createRequire(path.join(__dirname, '../fixtures/native/package.json'));
    const native = nativeRequire('@grpc/grpc-js');
    const { LoadBalancingCall } = nativeRequire('@grpc/grpc-js/build/src/load-balancing-call');
    assert.equal(nativeRequire('@grpc/grpc-js/package.json').version, '1.14.0');
    const make = value => native.credentials.createFromMetadataGenerator((_options, callback) => {
        const metadata = new native.Metadata(); metadata.add('x-order', value); callback(null, metadata);
    });
    let composed = 0, received;
    class PerCallCredentials extends native.CallCredentials {
        constructor() { super(); this.delegate = make('per-call'); }
        generateMetadata(options) { return this.delegate.generateMetadata(options); }
        compose(other) { composed++; return this.delegate.compose(other); }
    }
    const finished = new Promise(resolve => { received = resolve; });
    const channelCredentials = make('channel');
    const subchannel = { getChannelzRef: () => ({ id: 1 }), getAddress: () => 'native-composition-control',
        getCallCredentials: () => channelCredentials, getConnectivityState: () => native.connectivityState.READY,
        getRealSubchannel: () => ({ createCall(metadata) { received(metadata.get('x-order')); return { getCallNumber: () => 1 }; } }) };
    const call = new LoadBalancingCall({ doPick: () => ({ pickResultType: 0, subchannel }) }, { pickInformation: {} },
        '/demo.Echo/Unary', 'echo.test', new PerCallCredentials(), Infinity, 1);
    const caller = new native.Metadata(); caller.add('x-order', 'caller');
    call.start(caller, { onReceiveStatus(status) { assert.fail(`Unexpected native composition status ${status.code}`); } });
    assert.deepEqual(await finished, ['caller', 'per-call', 'channel']);
    assert.equal(composed, 1);
});
