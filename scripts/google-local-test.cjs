'use strict';
// Real SDKs and upstream grpc-js over loopback only. The bridge is test code, not Envoy.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const { inspect } = require('./doctor.cjs');
const frame = (value, trailer = false) => {
    const head = Buffer.alloc(5);
    head[0] = trailer ? 128 : 0;
    head.writeUInt32BE(value.length, 1);
    return Buffer.concat([head, value]);
};
async function main() {
    const controlled = await require('./google-controlled-server.cjs').createControlledServer();
    const { server, nativePort, arrivals } = controlled;
    const contentTypes = [], sessions = new Set();
    const bridge = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.headers['content-type'] !== 'application/grpc-web+proto') { res.writeHead(400).end(); return; }
        contentTypes.push(req.headers['content-type']);
        const session = http2.connect(`http://127.0.0.1:${nativePort}`);
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
        session.on('error', () => {});
        const call = session.request({ ':method': 'POST', ':path': req.url, 'content-type': 'application/grpc', te: 'trailers', ...(req.headers['grpc-timeout'] ? { 'grpc-timeout': req.headers['grpc-timeout'] } : {}) });
        let receivedTrailers = false, ended = false;
        call.on('response', headers => {
            res.writeHead(200, { 'content-type': 'application/grpc-web+proto' });
            if (headers['grpc-status'] !== undefined) {
                receivedTrailers = true;
                res.write(frame(Buffer.from(`grpc-status: ${headers['grpc-status']}\r\ngrpc-message: ${headers['grpc-message'] || ''}\r\n`), true));
            }
        });
        call.on('data', data => res.write(data));
        call.on('trailers', headers => {
            receivedTrailers = true;
            res.write(frame(Buffer.from(Object.entries(headers).filter(([key]) => !key.startsWith(':')).map(([key, value]) => `${key}: ${value}\r\n`).join('')), true));
        });
        call.on('end', () => {
            ended = true;
            if (!receivedTrailers) res.write(frame(Buffer.from('grpc-status: 2\r\n'), true));
            res.end();
            session.close();
        });
        call.on('error', () => { ended = true; res.destroy(); session.destroy(); });
        res.on('close', () => { if (!ended) { call.close(http2.constants.NGHTTP2_CANCEL); session.destroy(); } });
        req.pipe(call);
    });
    bridge.listen(0, '127.0.0.1');
    await once(bridge, 'listening');
    const bridgePort = bridge.address().port;
    const results = [], sourceHashes = {};
    const sourceDir = path.join(root, 'fixtures/google/shared');
    const sourceFiles = fs.readdirSync(sourceDir).filter(file => file.endsWith('.mjs')).sort();
    try {
        for (const runtime of ['native', 'replacement']) {
            controlled.reset();
            const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
            const req = createRequire(path.join(fixture, 'package.json'));
            const implementation = req('@grpc/grpc-js');
            if (runtime === 'replacement') req('@grpc/grpc-js/config').configureWorkersGrpc({ mode: 'grpc-web', allowInsecureLocalhost: true, endpoints: { [`127.0.0.1:${nativePort}`]: `http://127.0.0.1:${bridgePort}` } });
            const temporary = fs.mkdtempSync(path.join(fixture, '.local-consumer-'));
            try {
                fs.writeFileSync(path.join(temporary, 'package.json'), '{"type":"module"}\n');
                sourceHashes[runtime] = {};
                for (const file of sourceFiles) {
                    const source = fs.readFileSync(path.join(sourceDir, file));
                    fs.writeFileSync(path.join(temporary, file), source);
                    sourceHashes[runtime][file] = createHash('sha256').update(source).digest('hex');
                }
                const runId = '8577e274-468c-4180-becf-63292be12c29';
                for (const [sdk, suite, file, method] of [
                    ['@google-cloud/datastore', 'datastore-crud', 'datastore.mjs', 'datastoreCrud'],
                    ['@google-cloud/datastore', 'datastore-transaction', 'datastore.mjs', 'datastoreTransaction'],
                    ['@google-cloud/firestore', 'firestore-crud', 'firestore.mjs', 'firestoreCrud'],
                    ['@google-cloud/firestore', 'firestore-transaction', 'firestore.mjs', 'firestoreTransaction'],
                    ['@google-cloud/secret-manager', 'secret-manager-read', 'secret-manager.mjs', 'secretManagerRead'],
                    ['@google-cloud/datastore', 'datastore-streams', 'local-streams.mjs', 'datastoreStreams'],
                    ['@google-cloud/firestore', 'firestore-batch-get', 'local-streams.mjs', 'firestoreBatchGet'],
                    ['@google-cloud/datastore', 'datastore-aborted', 'local-transactions.mjs', 'datastoreAborted'],
                    ['@google-cloud/datastore', 'datastore-commit-response-lost', 'local-transactions.mjs', 'datastoreCommitResponseLost'],
                    ['@google-cloud/firestore', 'firestore-aborted-retry', 'local-transactions.mjs', 'firestoreAbortedRetry'],
                    ...(runtime === 'replacement' ? [['@google-cloud/firestore', 'firestore-listen-unsupported', 'local-streams.mjs', 'firestoreListenUnsupported']] : []),
                ]) {
                    const options = { projectId: 'wga-local-test', sslCreds: implementation.credentials.createInsecure() };
                    if (suite.startsWith('datastore')) options.apiEndpoint = `127.0.0.1:${nativePort}`;
                    if (suite.startsWith('firestore')) Object.assign(options, { host: `127.0.0.1:${nativePort}` });
                    if (suite.startsWith('secret')) Object.assign(options, { apiEndpoint: '127.0.0.1', port: nativePort });
                    const before = arrivals.length, wireBefore = contentTypes.length;
                    try {
                        const module = await import(pathToFileURL(path.join(temporary, file)).href);
                        const checks = await module[method]({ options, allowedProjectId: 'wga-local-test', allowWrites: true, runId, secretName: 'projects/wga-local-test/secrets/metadata' });
                        if (suite === 'firestore-listen-unsupported') {
                            assert.equal(arrivals.length, before);
                            assert.equal(contentTypes.length, wireBefore);
                        }
                        if (['datastore-aborted', 'datastore-commit-response-lost', 'firestore-aborted-retry'].includes(suite)) {
                            const trace = arrivals.slice(before);
                            assert.equal(trace.filter(item => item.fault).length, 1);
                            assert.equal(trace.filter(item => item.method.endsWith('/Commit')).length, suite === 'firestore-aborted-retry' ? 4 : 3);
                            if (runtime === 'replacement') assert.equal(contentTypes.length - wireBefore, trace.length);
                        }
                        results.push({ runtime, sdk, suite, status: 'passed', checks, serverArrivals: arrivals.slice(before), grpcWebRequests: contentTypes.length - wireBefore });
                    } catch (error) {
                        results.push({ runtime, sdk, suite, status: 'failed', error: { code: error.code || null, class: error.constructor?.name || 'Error' }, serverArrivals: arrivals.slice(before), grpcWebRequests: contentTypes.length - wireBefore });
                    }
                }
                const { SecretManagerServiceClient } = req('@google-cloud/secret-manager');
                const client = new SecretManagerServiceClient({ projectId: 'wga-local-test', apiEndpoint: '127.0.0.1', port: nativePort, sslCreds: implementation.credentials.createInsecure() });
                try {
                    for (const [name, code] of [['missing', 5], ['denied', 7]]) {
                        const before = arrivals.length;
                        await assert.rejects(client.getSecret({ name: `projects/wga-local-test/secrets/${name}` }, { timeout: 3000, retry: null }), error => error.code === code && error.details === `controlled ${name}`);
                        results.push({ runtime, sdk: '@google-cloud/secret-manager', suite: `secret-manager-${name}`, status: 'passed', code, details: `controlled ${name}`, serverArrivals: arrivals.slice(before) });
                    }
                } finally { await client.close(); }
            } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
        }
        assert.deepEqual(sourceHashes.native, sourceHashes.replacement);
        const native = results.filter(item => item.runtime === 'native');
        const replacement = results.filter(item => item.runtime === 'replacement');
        const comparable = items => items.filter(item => item.suite !== 'firestore-listen-unsupported').map(({ runtime, grpcWebRequests, ...item }) => item);
        const equivalent = JSON.stringify(comparable(native)) === JSON.stringify(comparable(replacement));
        const graph = inspect(path.join(root, 'fixtures/google'));
        const report = { scope: 'real SDK shared business functions against controlled native grpc-js loopback service through a test-only grpc-web bridge', liveCloud: false, workerd: false, runtime: process.version, nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version, sameSharedFiles: true, sourceHashes, equivalent, contentTypes: [...new Set(contentTypes)], graphSha256: graph.graphSha256, results, status: equivalent && results.every(item => item.status === 'passed') ? 'passed' : 'failed' };
        fs.writeFileSync(path.join(root, 'compatibility/google-local.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
        if (report.status !== 'passed') process.exitCode = 1;
    } finally {
        bridge.closeAllConnections();
        for (const session of sessions) session.destroy();
        await new Promise(resolve => bridge.close(resolve));
        server.forceShutdown();
    }
}
main().catch(error => { console.error(JSON.stringify({ status: 'failed', code: error.code || null, class: error.constructor?.name || 'Error' })); process.exitCode = 1; });
