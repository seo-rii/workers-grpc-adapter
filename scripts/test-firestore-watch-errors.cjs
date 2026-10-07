'use strict';
// Watch error-versus-EOF ordering against both pinned SDK profiles and real Envoy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createWatchErrorServer } = require('./firestore-watch-error-server.cjs');
const scenarios = ['permission', 'unavailable', 'end'];
const profiles = [
    { id: 'google-static-v1', revision: 5, fixture: 'google', native: 'native', version: '8.3.0' },
    { id: 'google-modern-v1', revision: 2, fixture: 'modern', native: 'modern-native', version: '9.2.0' },
];
const { startEmulatorEnvoy } = require('./emulator-envoy.cjs');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, CoreHeaders, Log, LogLevel } = workerRequire('miniflare');
const sourceBuild = process.argv.includes('--source-build'), nativeOnly = process.argv.includes('--native-only');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const savedFetch = globalThis.fetch;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-firestore-watch-errors-'));
const compatibilityDate = '2026-09-21', projectId = 'demo-wga-local';
const sharedFile = path.join(root, 'fixtures/google/shared/firestore-watch-errors.mjs'), shared = fs.readFileSync(sharedFile);
const report = { startedAt: new Date().toISOString(), status: 'running', sourceBuild, nativeOnly,
    officialFirestoreEmulator: false, controlledProtocolPeer: true, realEnvoy: true, liveGoogle: false, cloudflareAutomaticConversion: false,
    iamOrSecurityRules: false, pollingFallback: false, longLivedWorkerDeployment: false, explicitAnonymousAuth: true,
    projectId, compatibilityDate, sharedSha256: hash(shared), sources: {}, results: [], requests: [], builds: {}, runtime: {} };
let stage = 'startup', currentCase, worker, controlled, envoy, startingEnvoy;
const forwards = new Set(), boundaryErrors = [], asyncErrors = [];
process.on('unhandledRejection', () => { asyncErrors.push('WATCH_UNHANDLED_REJECTION'); process.exitCode = 1; });
for (const name of ['FIRESTORE_EMULATOR_HOST', 'DATASTORE_EMULATOR_HOST', 'DATASTORE_DATASET', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) delete process.env[name];
function fixedError(error) {
    const diagnostic = error.fixtureDiagnostic ?? (error.code === 'ERR_ASSERTION' ? error.message.split('\n')[0] : 'WATCH_HARNESS_FAILURE');
    return { diagnostic: /^WATCH_[A-Z_]+$/.test(diagnostic) ? diagnostic : 'WATCH_HARNESS_FAILURE',
        errorClass: error.constructor?.name ?? 'Error', code: error.code ?? null };
}
async function until(predicate, diagnostic, milliseconds = 7000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, diagnostic);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
async function bounded(promise, diagnostic, milliseconds = 45000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic })), milliseconds); })]); }
    finally { clearTimeout(timer); }
}
function inspectRequest(url, headers, method, port, runtime) {
    assert.equal(url.origin, `http://127.0.0.1:${port}`, 'WATCH_ONLY_EXPLICIT_LOOPBACK');
    assert.equal(url.pathname, '/google.firestore.v1.Firestore/Listen', 'WATCH_LISTEN_ONLY');
    assert.equal(method, 'POST', 'WATCH_POST_ONLY');
    assert.equal(headers.get('authorization'), null, 'WATCH_NO_CREDENTIALS_ON_LOOPBACK');
    assert.equal(headers.get('content-type'), 'application/grpc-web+proto', 'WATCH_GRPC_WEB_MIME');
    const record = { runtime, profile: currentCase.profile.id, scenario: currentCase.scenario, invocation: currentCase.invocation, method: url.pathname,
        streaming: url.pathname.endsWith('/Listen'), responseStatus: null, responseMime: null };
    report.requests.push(record); return record;
}
async function nodeConsumer(profile, runtime, port, adapterDirectory) {
    const fixture = path.join(root, 'fixtures', runtime === 'native' ? profile.native : profile.fixture);
    const req = createRequire(path.join(fixture, 'package.json'));
    const grpc = runtime === 'adapter' && sourceBuild ? require(path.join(adapterDirectory, 'index.js')) : req('@grpc/grpc-js');
    const endpoint = `127.0.0.1:${port}`;
    const consumer = fs.mkdtempSync(path.join(fixture, '.watch-errors-consumer-'));
    try {
        const copied = path.join(consumer, 'firestore-watch-errors.mjs'); fs.writeFileSync(copied, shared);
        report.sources[`${profile.id}/${runtime}`] = hash(fs.readFileSync(copied));
        const { runFirestoreWatchErrors } = await import(pathToFileURL(copied).href);
        for (const scenario of scenarios) {
            stage = `${profile.id}/${runtime}/${scenario}`; currentCase = { profile, scenario, invocation: runtime };
            controlled.prepare(scenario, stage);
            let options = { projectId, host: endpoint };
            if (runtime === 'adapter') {
                const factory = sourceBuild ? require(path.join(adapterDirectory, 'adapter.js')) : req('@grpc/grpc-js/adapter');
                const transport = factory.createWorkersGrpcTransport({ mode: 'grpc-web', experimentalRequestStreaming: true,
                    allowInsecureLocalhost: true, endpoints: { [endpoint]: `http://${endpoint}` } });
                options = transport.gaxOptions(options);
                globalThis.fetch = async (input, init) => {
                    const headers = new Headers(init.headers), url = new URL(input);
                    const record = inspectRequest(url, headers, init.method, port, runtime);
                    headers.set('x-wga-invocation', runtime);
                    const response = await savedFetch(input, { ...init, headers });
                    record.responseStatus = response.status; record.responseMime = response.headers.get('content-type');
                    return response;
                };
            }
            options.sslCreds = grpc.credentials.createInsecure();
            const checks = await bounded(runFirestoreWatchErrors({ options, scenario, patched: false,
                control: action => controlled.control(action) }), 'WATCH_NODE_TIMEOUT');
            await until(() => controlled.active.size === 0, 'WATCH_NATIVE_STREAM_RELEASED');
            report.results.push({ id: stage, profile: profile.id, runtime, invocation: runtime, status: 'passed', ...checks, clientTerminated: true });
        }
    } finally { globalThis.fetch = savedFetch; fs.rmSync(consumer, { recursive: true, force: true }); }
}
async function buildWorker(profile, adapterDirectory) {
    const projectRoot = path.join(root, 'fixtures', profile.fixture);
    const profileRequire = createRequire(path.join(projectRoot, 'package.json'));
    const { createGoogleWorkerBuild } = sourceBuild ? require('../src/build/index.cjs') : profileRequire('@grpc/grpc-js/build');
    const outdir = path.join(scratch, profile.id); fs.mkdirSync(outdir);
    const preset = createGoogleWorkerBuild({ projectRoot, profile: profile.id, outdir: path.join(outdir, 'preset'), typescript: require('typescript') });
    const frozenBusiness = { name: 'watch-errors-frozen-business', setup(build) {
        build.onLoad({ filter: /firestore-watch-errors\.mjs$/ }, args => args.path === sharedFile ? { contents: shared, loader: 'js', resolveDir: projectRoot } : undefined);
    } };
    const built = await workerRequire('esbuild').build({ absWorkingDir: root, entryPoints: [path.join(root, 'fixtures/worker/firestore-watch-errors.mjs')],
        bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(outdir, 'sdk.cjs'), plugins: [frozenBusiness, preset.plugin], metafile: true,
        ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(adapterDirectory, 'adapter.js'),
            '@grpc/grpc-js/package.json': path.join(root, 'package.json'), '@grpc/grpc-js': path.join(adapterDirectory, 'index.js') } } : {}) });
    const inputs = Object.keys(built.metafile.inputs);
    assert.ok(inputs.includes('fixtures/google/shared/firestore-watch-errors.mjs'), 'WATCH_SHARED_WORKER_INPUT');
    assert.ok(inputs.includes(`fixtures/${profile.fixture}/node_modules/@google-cloud/firestore/build/src/index.js`), 'WATCH_PROFILE_SDK_INPUT');
    const otherFixture = profile.fixture === 'modern' ? 'google' : 'modern';
    assert.ok(!inputs.some(file => file.startsWith(`fixtures/${otherFixture}/node_modules/`)), 'WATCH_NO_OTHER_PROFILE_DEPENDENCIES');
    if (profile.fixture === 'modern') assert.ok(inputs.some(file => file.startsWith('fixtures/modern/node_modules/@google-cloud/firestore-api/')), 'WATCH_MODERN_API_INPUT');
    report.sources[`${profile.id}/workerd`] = hash(shared);
    fs.writeFileSync(path.join(outdir, 'worker.mjs'), 'import bundle from "./sdk.cjs";export default bundle.default;\n');
    const config = path.join(outdir, 'wrangler.json');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-firestore-watch-errors-local', main: path.join(outdir, 'worker.mjs'), compatibility_date: compatibilityDate,
        compatibility_flags: ['nodejs_compat'], send_metrics: false }));
    execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config,
        '--outdir', path.join(outdir, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
    const script = fs.readFileSync(path.join(outdir, 'bundle/worker.js'), 'utf8');
    const manifest = preset.manifest();
    assert.equal(manifest.revision, profile.revision, 'WATCH_PATCHED_PROFILE_REVISION');
    assert.equal(manifest.transformed.find(item => item.path === 'node_modules/@google-cloud/firestore/build/src/index.js')?.firestoreWatchEndDeferrals,
        1, 'WATCH_EXACTLY_ONE_END_DEFERRAL');
    report.builds[profile.id] = { manifest, bundleSha256: hash(script),
        sdkInputs: inputs.filter(file => file.startsWith(`fixtures/${profile.fixture}/node_modules/@google-cloud/firestore`)).sort() };
    return script;
}
function workerForward(port) {
    return { node: async (request, response) => {
        try {
            const incomingHeaders = new Headers(request.headers);
            const url = new URL(incomingHeaders.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `http://${incomingHeaders.get('host')}`);
            if (url.origin === `http://127.0.0.1:${port}` && /^\/__control\/(advance|settle|reuse)$/.test(url.pathname) && request.method === 'POST') {
                await controlled.control(url.pathname.split('/').pop()); response.writeHead(204).end(); return;
            }
            const record = inspectRequest(url, incomingHeaders, request.method, port, 'workerd');
            const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) =>
                !['host', 'connection', 'content-length', 'transfer-encoding'].includes(name) && !name.startsWith('mf-')));
            headers['x-wga-invocation'] = currentCase.invocation;
            const upstream = http.request({ hostname: '127.0.0.1', port, path: url.pathname, method: 'POST', headers });
            forwards.add(upstream); upstream.once('close', () => forwards.delete(upstream));
            upstream.on('response', incoming => {
                record.responseStatus = incoming.statusCode; record.responseMime = incoming.headers['content-type'];
                record.uploadEndedAtResponse = upstream.writableEnded;
                record.responseBytes = 0;
                incoming.on('data', chunk => { record.responseBytes += chunk.length; });
                incoming.once('end', () => { record.responseEnded = true; });
                response.writeHead(incoming.statusCode, incoming.headers); response.flushHeaders();
                incoming.pipe(response); incoming.on('error', () => response.destroy());
            });
            upstream.on('error', () => response.destroy());
            response.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
            request.on('aborted', () => upstream.destroy());
            // Both directions stay streaming: collecting request.arrayBuffer()
            // would deadlock Listen before its first snapshot.
            request.pipe(upstream);
        } catch (error) {
            boundaryErrors.push(fixedError(error));
            if (!response.headersSent) response.writeHead(500); response.end();
        }
    } };
}
let cleaning;
function cleanup() {
    return cleaning ||= (async () => {
        globalThis.fetch = savedFetch;
        const errors = [];
        if (!envoy && startingEnvoy) try { envoy = await startingEnvoy; } catch {}
        for (const forward of forwards) forward.destroy();
        try { await worker?.dispose(); } catch (error) { errors.push(error); }
        if (envoy) {
            try { report.envoy = await envoy.stop(); report.wire = envoy.readAccess(); } catch (error) { errors.push(error); }
        }
        report.arrivals = controlled?.arrivals ?? [];
        report.peerFaults = controlled?.faults ?? [];
        controlled?.close();
        report.cleanup = { workerDisposed: !worker || errors.length === 0, envoyExited: !envoy || !!report.envoy?.exit, nativeServerStopped: true };
        if (errors.length) report.cleanupErrors = errors.map(fixedError);
        return errors;
    })();
}
function writeReport() {
    report.completedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/firestore-watch-errors.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    fs.rmSync(scratch, { recursive: true, force: true });
}
const interrupt = signal => {
    report.status = 'failed'; report.interrupted = signal;
    void cleanup().finally(() => { writeReport(); process.exit(signal === 'SIGINT' ? 130 : 143); });
};
const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
async function main() {
    report.runtime.node = process.version;
    report.runtime.workerd = workerRequire('workerd/package.json').version;
    report.runtime.miniflare = workerRequire('miniflare/package.json').version;
    for (const profile of profiles) {
        const req = createRequire(path.join(root, 'fixtures', profile.fixture, 'package.json'));
        const nativeReq = createRequire(path.join(root, 'fixtures', profile.native, 'package.json'));
        assert.equal(req('@google-cloud/firestore/package.json').version, profile.version, 'WATCH_PINNED_FIRESTORE');
        assert.equal(nativeReq('@google-cloud/firestore/package.json').version, profile.version, 'WATCH_PINNED_NATIVE_FIRESTORE');
        assert.equal(req('@grpc/grpc-js/package.json').name, 'workers-grpc-adapter', 'WATCH_ADAPTER_IDENTITY');
        assert.equal(nativeReq('@grpc/grpc-js/package.json').version, '1.14.5', 'WATCH_NATIVE_GRPC_VERSION');
        report.runtime[profile.id] = { firestore: profile.version, nativeFirestore: profile.version, nativeGrpc: '1.14.5' };
    }
    report.evidence = Object.fromEntries(['scripts/test-firestore-watch-errors.cjs', 'fixtures/google/shared/firestore-watch-errors.mjs', 'fixtures/worker/firestore-watch-errors.mjs',
        'scripts/firestore-watch-error-server.cjs', 'scripts/emulator-envoy.cjs', 'fixtures/envoy/binary.json',
        'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/modern/package-lock.json', 'fixtures/modern-native/package-lock.json',
        'src/build/profiles/google-static-v1.json', 'src/build/profiles/google-modern-v1.json', 'fixtures/worker/package-lock.json'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    let primary;
    try {
        controlled = await createWatchErrorServer();
        envoy = await (startingEnvoy = startEmulatorEnvoy({ firestore: { port: controlled.port }, datastore: { port: controlled.port } }));
        let adapterDirectory;
        if (sourceBuild && !nativeOnly) {
            stage = 'isolated-source-build'; adapterDirectory = path.join(scratch, 'adapter-dist');
            require('./toolchain.cjs').compile({ outDir: adapterDirectory, rootDir: path.join(root, 'src') });
            report.isolatedCallSha256 = hash(fs.readFileSync(path.join(adapterDirectory, 'call.js')));
        }
        for (const profile of profiles) {
            await nodeConsumer(profile, 'native', envoy.ports.native);
            if (nativeOnly) continue;
            await nodeConsumer(profile, 'adapter', envoy.ports.replacement, adapterDirectory);
            stage = `${profile.id}/worker-build`; const script = await buildWorker(profile, adapterDirectory);
            worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'],
                log: new Log(LogLevel.NONE), bindings: { PROJECT_ID: projectId, ENDPOINT: `127.0.0.1:${envoy.ports.workerd}` }, outboundService: workerForward(envoy.ports.workerd) }));
            for (const invocation of ['first', 'second']) for (const scenario of scenarios) {
                stage = `${profile.id}/workerd-${invocation}/${scenario}`; currentCase = { profile, scenario, invocation };
                controlled.prepare(scenario, stage);
                const response = await bounded(worker.dispatchFetch(`https://fixture.test/${scenario}?run=${invocation}`), 'WATCH_WORKER_TIMEOUT');
                const result = await response.json();
                if (response.status !== 200) report.workerFailure = result;
                assert.equal(response.status, 200, result.diagnostic ?? 'WATCH_WORKER_HTTP');
                assert.equal(result.status, 'passed', 'WATCH_WORKER_RESULT');
                await until(() => forwards.size === 0 && controlled.active.size === 0, 'WATCH_STREAMS_RELEASED_BEFORE_NEXT_CASE');
                report.results.push({ id: stage, profile: profile.id, runtime: 'workerd', invocation, ...result,
                    clientTerminated: true, forwardsReleasedBeforeNextCase: true });
            }
            await worker.dispose(); worker = undefined;
        }
        assert.deepEqual(boundaryErrors, [], 'WATCH_BOUNDARY_ERRORS');
        assert.deepEqual(asyncErrors, [], 'WATCH_ASYNC_ERRORS');
        for (const value of Object.values(report.sources)) assert.equal(value, report.sharedSha256, 'WATCH_IDENTICAL_BUSINESS_SOURCE');
    } catch (error) { primary = error; throw error; }
    finally {
        const errors = await cleanup();
        if (errors.length && !primary) throw Object.assign(new Error('WATCH_RESOURCE_CLEANUP'), { fixtureDiagnostic: 'WATCH_RESOURCE_CLEANUP' });
    }
    assert.deepEqual(controlled.faults, [], 'WATCH_CONTROLLED_ASSERTIONS');
    for (const result of report.results) {
        const calls = controlled.arrivals.filter(item => item.caseId === result.id);
        const expectedPrimary = result.runtime === 'workerd' && result.scenario === 'permission' ? 1 : 2;
        assert.equal(calls.filter(item => item.phase === 'primary').length, expectedPrimary, 'WATCH_EXPECTED_PRIMARY_RECONNECT_COUNT');
        assert.equal(calls.filter(item => item.phase === 'reuse').length, 1, 'WATCH_EXACTLY_ONE_REUSE_CALL');
        if (result.scenario === 'permission') {
            assert.equal(result.errors.length, 1, 'WATCH_ONE_PERMISSION_ERROR');
            assert.equal(result.originalErrorPreserved, result.runtime === 'workerd', 'WATCH_BUILD_ONLY_FIX');
            assert.equal(result.rawSdkPermissionReconnectObserved, result.runtime !== 'workerd', 'WATCH_DISTINCT_RAW_BASELINE');
        } else {
            assert.equal(result.errors.length, 0, 'WATCH_TRANSIENT_OR_END_RECONNECTS');
            const expected = report.results.find(item => item.profile === result.profile && item.runtime === 'native' && item.scenario === result.scenario);
            assert.deepEqual(result.snapshots, expected.snapshots, 'WATCH_RECOVERY_NATIVE_EQUIVALENCE');
        }
        if (result.runtime !== 'native') assert.equal(report.requests.filter(item => item.profile === result.profile && item.scenario === result.scenario &&
            item.invocation === result.invocation && item.runtime === result.runtime).length, calls.length, 'WATCH_FETCH_ATTEMPTS');
    }
    assert.deepEqual(asyncErrors, [], 'WATCH_ASYNC_ERRORS');
    if (!nativeOnly) {
        assert.ok(report.requests.every(item => item.responseStatus === 200 && /^application\/grpc-web(?:\+proto)?$/.test(item.responseMime)), 'WATCH_GATEWAY_RESPONSES');
        assert.ok(report.requests.filter(item => item.runtime === 'workerd').every(item => item.uploadEndedAtResponse === false), 'WATCH_RESPONSE_BEFORE_UPLOAD_END');
        report.responsesBeforeRequestCompletion = true;
    }
    report.summary = { cases: report.results.length, listenCalls: controlled.arrivals.length, fetchRequests: report.requests.length,
        callbacks: report.results.reduce((sum, item) => sum + item.callbacks, 0),
        patchedPermissionCases: report.results.filter(item => item.originalErrorPreserved).length,
        rawSdkPermissionBaselines: report.results.filter(item => item.rawSdkPermissionReconnectObserved).length };
    report.status = 'passed';
}
main().catch(error => { report.status = 'failed'; report.stage = stage; report.error = fixedError(error); process.exitCode = 1; }).finally(() => {
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); writeReport();
    console.log(JSON.stringify({ status: report.status, stage: report.stage, error: report.error, cases: report.results.length,
        requests: report.requests.length, report: 'verification/firestore-watch-errors.json' }));
});
