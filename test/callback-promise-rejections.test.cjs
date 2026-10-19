'use strict';
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const { assert, grpc, Echo, response, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

function rejectedReturn(kind) {
    const error = new Error('private returned rejection');
    if (kind === 'thenable') return { then(_resolve, reject) { queueMicrotask(() => reject(error)); } };
    const value = Promise.reject(error);
    if (kind === 'missing-catch') Object.defineProperty(value, 'catch', { value: undefined });
    if (kind === 'throwing-catch') Object.defineProperty(value, 'catch', { get() { throw new Error('private catch getter'); } });
    if (kind === 'throwing-then') Object.defineProperty(value, 'then', { get() { throw new Error('private then getter'); } });
    return value;
}

async function probe(boundary, kind) {
    let observed = false, fetches = 0, callbacks = 0;
    const transport = createWorkersGrpcTransport({ resourceLimits: { maxConcurrentCalls: 1 },
        fetcher: { async fetch() { fetches++; return response(); } },
        ...(boundary === 'observer' ? { observer() {
            if (observed) return;
            observed = true;
            return rejectedReturn(kind);
        } } : {}),
    });
    let credentials = transport.channelCredentials;
    if (boundary !== 'observer') {
        const successfulCallback = boundary.endsWith('-after');
        const calls = boundary.startsWith('legacy') ? grpc.credentials.createFromGoogleCredential({
            getRequestMetadata(_url, done) {
                if (successfulCallback) done(null, { 'x-auth': 'first callback' });
                return rejectedReturn(kind);
            },
        }) : grpc.credentials.createFromMetadataGenerator((_options, done) => {
            if (successfulCallback) done(null, new grpc.Metadata());
            return rejectedReturn(kind);
        });
        credentials = grpc.credentials.combineChannelCredentials(credentials, calls);
    }
    const client = new Echo('echo.test', credentials, transport.grpcOptions());
    const statuses = [];
    try {
        const result = await new Promise(resolve => {
            const call = client.unary({ text: 'request' }, (error, value) => { callbacks++; resolve({ error, value }); });
            call.on('status', value => statuses.push(value.code));
        });
        await immediate(); await immediate();
        const expected = boundary.endsWith('-before') ? grpc.status.UNKNOWN : grpc.status.OK;
        assert.equal(result.error?.code ?? 0, expected);
        assert.equal(callbacks, 1);
        assert.deepEqual(statuses, [expected]);
        assert.equal(fetches, expected === grpc.status.OK ? 1 : 0);
        if (expected === grpc.status.OK) assert.deepEqual(result.value, { text: 'ok' });
        else assert.equal(result.error.details, 'WGA_AUTH_METADATA');
        assert.equal(transport.resourceUsage().activeCalls, 0);
        assert.equal(transport.resourceUsage().bufferedBytes, 0);
    } finally { client.close(); }
}

if (process.argv[2] === '--probe') {
    probe(process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
} else {
    for (const boundary of ['observer', 'metadata-before', 'metadata-after', 'legacy-before', 'legacy-after']) {
        for (const kind of ['missing-catch', 'throwing-catch', 'throwing-then', 'thenable', 'plain-promise']) {
            test(`CALLBACK returned rejection is contained at ${boundary} with ${kind}`, () => {
                // Fatal rejection policy proves containment independently of the
                // parent test runner's own unhandled-rejection listeners.
                const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', __filename, '--probe', boundary, kind],
                    { encoding: 'utf8', timeout: 5000 });
                assert.ifError(child.error);
                assert.equal(child.status, 0, child.stderr || child.stdout);
            });
        }
    }
}
