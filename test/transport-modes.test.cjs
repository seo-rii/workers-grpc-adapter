'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, serialize, response, withFetch, unary, immediate, deferred, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { getWorkersGrpcConfig } = require('../dist/config.js');
const { encodeFrame } = require('../dist/wire.js');

const target = 'Echo.Test:8443';
const logicalOrigin = 'https://echo.test:8443';
const gatewayOrigin = 'https://gateway.test:9443';
const modes = [
    { name: 'cloudflare', config: { mode: 'cloudflare' }, origin: logicalOrigin,
        grpcWeb: 'convert', contentType: 'application/grpc-web' },
    { name: 'grpc-web', config: { mode: 'grpc-web', endpoints: { 'echo.test:8443': gatewayOrigin } }, origin: gatewayOrigin,
        grpcWeb: 'passthrough', contentType: 'application/grpc-web+proto' },
];

function modeClient(mode, callCredentials) {
    const transport = createWorkersGrpcTransport(mode.config);
    const credentials = callCredentials
        ? grpc.credentials.combineChannelCredentials(transport.channelCredentials, callCredentials)
        : transport.channelCredentials;
    return new Echo(target, credentials, transport.grpcOptions());
}

test('MODES concurrent Cloudflare and gateway calls select conversion per request and accept both binary response types', async t => {
    const observed = [];
    let responseContentType;
    await withFetch(async (url, init) => {
        observed.push({ url, method: init.method, redirect: init.redirect, cf: init.cf, headers: init.headers, body: Buffer.from(init.body) });
        const streaming = new URL(url).pathname.endsWith('/Stream');
        return response(streaming ? [{ text: 'first' }, { text: 'second' }] : [{ text: 'reply' }],
            { chunkSize: 1, extra: 'x-terminal: complete\r\n', headers: { 'content-type': responseContentType } });
    }, async () => {
        for (const type of ['application/grpc-web', 'application/grpc-web+proto']) {
            responseContentType = type;
            await Promise.all(modes.map(async mode => {
                const client = modeClient(mode);
                t.after(() => client.close());
                const invocation = unary(client, { text: mode.name });
                const unaryStatuses = [];
                invocation.call.on('status', status => unaryStatuses.push(status));
                const stream = client.stream({ text: mode.name });
                const values = [], statuses = [];
                const streamComplete = new Promise((resolve, reject) => {
                    stream.on('data', value => values.push(value));
                    stream.on('status', status => statuses.push(status));
                    stream.on('error', reject);
                    stream.on('end', resolve);
                });
                const [reply] = await Promise.all([invocation.promise, streamComplete]);
                assert.deepEqual(reply, { text: 'reply' });
                assert.equal(unaryStatuses.length, 1);
                assert.equal(unaryStatuses[0].code, grpc.status.OK);
                assert.deepEqual(unaryStatuses[0].metadata.get('x-terminal'), ['complete']);
                assert.deepEqual(values, [{ text: 'first' }, { text: 'second' }]);
                assert.equal(statuses.length, 1);
                assert.equal(statuses[0].code, grpc.status.OK);
                assert.deepEqual(statuses[0].metadata.get('x-terminal'), ['complete']);
                assert.equal(client.getChannel().activeCallCount(), 0);
                client.close();
            }));
        }
    });
    assert.deepEqual(observed.map(item => item.url).sort(), modes.flatMap(mode =>
        ['Unary', 'Stream'].flatMap(method => Array(2).fill(`${mode.origin}/demo.Echo/${method}`))).sort());
    for (const item of observed) {
        const mode = modes.find(candidate => candidate.origin === new URL(item.url).origin);
        assert.equal(item.method, 'POST');
        assert.equal(item.redirect, 'manual');
        assert.deepEqual(item.cf, { grpcWeb: mode.grpcWeb });
        assert.equal(item.headers.get('content-type'), mode.contentType);
        assert.equal(item.headers.get('accept'), mode.contentType);
        assert.equal(item.headers.get('x-grpc-web'), '1');
        assert.equal(item.headers.get('grpc-encoding'), 'identity');
        assert.deepEqual(item.body, encodeFrame(serialize({ text: mode.name })));
    }
});

test('MODES default Cloudflare and gateway clients isolate concurrent routes and logical Google auth audiences', async t => {
    const before = getWorkersGrpcConfig();
    const audiences = [], arrivals = [];
    const authReady = [deferred(), deferred()], replies = [deferred(), deferred()];
    const clients = modes.map((mode, index) => {
        const auth = grpc.credentials.createFromGoogleCredential({ async getRequestHeaders(url) {
            audiences.push({ mode: mode.name, url });
            await authReady[index].promise;
            return { authorization: `Bearer mode-${index}` };
        } });
        // Exercise the default mode as well as the explicit mode above.
        const client = modeClient(index === 0 ? { ...mode, config: undefined } : mode, auth);
        t.after(() => client.close());
        return client;
    });
    await withFetch(async (url, init) => {
        const index = new URL(url).origin === logicalOrigin ? 0 : 1;
        arrivals.push({ url, authorization: init.headers.get('authorization'), cf: init.cf,
            contentType: init.headers.get('content-type'), accept: init.headers.get('accept') });
        return replies[index].promise;
    }, async () => {
        const calls = clients.map((client, index) => unary(client, { text: `request-${index}` }));
        const completed = Promise.all(calls.map(call => call.promise));
        // Keep both promises observed even if an assertion interrupts the gates.
        completed.catch(() => {});
        try {
            await immediate();
            assert.deepEqual(audiences, modes.map(mode => ({ mode: mode.name, url: `${logicalOrigin}/demo.Echo` })));
            assert.equal(arrivals.length, 0);
            authReady[1].resolve();
            await immediate();
            const expectedArrival = index => ({ url: `${modes[index].origin}/demo.Echo/Unary`,
                authorization: `Bearer mode-${index}`, cf: { grpcWeb: modes[index].grpcWeb },
                contentType: modes[index].contentType, accept: modes[index].contentType });
            assert.deepEqual(arrivals, [expectedArrival(1)]);
            authReady[0].resolve();
            await immediate();
            assert.deepEqual(arrivals, [
                expectedArrival(1),
                expectedArrival(0),
            ]);
            assert.deepEqual(clients.map(client => client.getChannel().activeCallCount()), [1, 1]);
            replies[0].resolve(response([{ text: 'direct-reply' }]));
            assert.deepEqual(await calls[0].promise, { text: 'direct-reply' });
            assert.equal(clients[1].getChannel().activeCallCount(), 1);
            replies[1].resolve(response([{ text: 'gateway-reply' }]));
            assert.deepEqual(await completed, [{ text: 'direct-reply' }, { text: 'gateway-reply' }]);
            assert.deepEqual(calls.map(call => transportCall(call.call).diagnostics().fetchCount), [1, 1]);
        } finally {
            clients.forEach(client => client.close());
            authReady.forEach(gate => gate.resolve());
            replies.forEach(gate => gate.resolve(response()));
            await completed.catch(() => {});
        }
    });
    assert.strictEqual(getWorkersGrpcConfig(), before);
});

test('MODES callers and credentials cannot replace conversion content negotiation through metadata', async t => {
    let fetches = 0;
    await withFetch(async () => { fetches++; return response(); }, async () => {
        for (const mode of modes) {
            for (const key of ['content-type', 'accept']) {
                for (const source of ['call', 'credentials']) {
                    const metadata = new grpc.Metadata();
                    metadata.set(key, 'application/grpc');
                    const auth = source === 'credentials'
                        ? grpc.credentials.createFromMetadataGenerator((_options, callback) => callback(null, metadata))
                        : undefined;
                    const client = modeClient(mode, auth);
                    t.after(() => client.close());
                    const call = unary(client, { text: source }, source === 'call' ? metadata : new grpc.Metadata());
                    await assert.rejects(call.promise, { code: grpc.status.INTERNAL, details: 'WGA_RESERVED_METADATA' });
                    assert.equal(transportCall(call.call).diagnostics().fetchCount, 0);
                    client.close();
                }
            }
        }
    });
    assert.equal(fetches, 0);
});

test('MODES native gRPC responses fail without trying another destination', async t => {
    for (const mode of modes) {
        const client = modeClient(mode);
        t.after(() => client.close());
        const destinations = [];
        let cancelled = 0;
        await withFetch(async url => {
            destinations.push(url);
            // Native HTTP/2 trailers are not available through this Fetch response.
            const body = new ReadableStream({
                start(controller) { controller.enqueue(encodeFrame(serialize({ text: 'native-only' }))); },
                cancel() { cancelled++; },
            });
            return new Response(body, { headers: { 'content-type': 'application/grpc' } });
        }, async () => {
            const call = unary(client);
            await assert.rejects(call.promise, { code: grpc.status.UNKNOWN, details: 'WGA_NOT_GRPC_WEB' });
            await immediate();
            assert.deepEqual(destinations, [`${mode.origin}/demo.Echo/Unary`]);
            assert.equal(transportCall(call.call).diagnostics().fetchCount, 1);
            assert.equal(cancelled, 1);
            assert.equal(client.getChannel().activeCallCount(), 0);
        });
        client.close();
    }
});

test('MODES gateway fallback rejects unmapped authorities before authentication or fetch', async () => {
    let authentications = 0, fetches = 0;
    const transport = createWorkersGrpcTransport(modes[1].config);
    const credentials = grpc.credentials.combineChannelCredentials(transport.channelCredentials,
        grpc.credentials.createFromMetadataGenerator((_options, callback) => {
            authentications++;
            callback(null, new grpc.Metadata());
        }));
    await withFetch(async () => { fetches++; return response(); }, async () => {
        // A different hostname and an omitted non-default port are both unmapped.
        for (const unmapped of ['other.test:8443', 'echo.test']) {
            assert.throws(() => new Echo(unmapped, credentials, transport.grpcOptions()), { code: 'WGA_UNMAPPED_TARGET' });
        }
        await immediate();
        assert.equal(authentications, 0);
        assert.equal(fetches, 0);
    });
});
