'use strict';
// Firestore 9.2 Listen uses the same business bytes as the legacy emulator gate.
// Dependency resolution is explicitly pinned to the separate modern fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { startEmulators } = require('../fixtures/emulators/launcher.cjs');
const { startEmulatorEnvoy } = require('./emulator-envoy.cjs');
const root = path.resolve(__dirname, '..');
const modernRoot = path.join(root, 'fixtures/modern');
const modernRequire = createRequire(path.join(modernRoot, 'package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, CoreHeaders, Log, LogLevel } = workerRequire('miniflare');
const sourceBuild = process.argv.includes('--source-build'), nativeOnly = process.argv.includes('--native-only');
const { createGoogleWorkerBuild } = sourceBuild ? require('../src/build/index.cjs') : modernRequire('@grpc/grpc-js/build');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const savedFetch = globalThis.fetch;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-modern-firestore-watch-'));
const compatibilityDate = '2026-09-21', projectId = 'demo-wga-local';
const sharedFile = path.join(root, 'fixtures/google/shared/firestore-watch.mjs'), shared = fs.readFileSync(sharedFile);
const report = { startedAt: new Date().toISOString(), status: 'running', sourceBuild, nativeOnly,
    profile: 'google-modern-v1', officialFirestoreEmulator: true, realEnvoy: true, liveGoogle: false, cloudflareAutomaticConversion: false,
    iamOrSecurityRules: false, pollingFallback: false, longLivedWorkerDeployment: false, explicitAnonymousAuth: true,
    projectId, compatibilityDate, sharedSha256: hash(shared), sources: {}, results: [], requests: [] };
let stage = 'startup', currentCase, worker, emulators, envoy, startingEmulators, startingEnvoy;
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
    assert.match(url.pathname, /^\/google\.firestore\.v1\.Firestore\/(Listen|Commit|BatchGetDocuments)$/);
    assert.equal(method, 'POST', 'WATCH_POST_ONLY');
    assert.equal(headers.get('authorization'), null, 'WATCH_NO_CREDENTIALS_ON_LOOPBACK');
    assert.equal(headers.get('content-type'), 'application/grpc-web+proto', 'WATCH_GRPC_WEB_MIME');
    const record = { runtime, scenario: currentCase.scenario, invocation: currentCase.invocation, method: url.pathname,
        streaming: url.pathname.endsWith('/Listen'), responseStatus: null, responseMime: null };
    report.requests.push(record); return record;
}
async function nodeConsumer(runtime, port, adapterDirectory) {
    const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'modern-native' : 'modern');
    const req = createRequire(path.join(fixture, 'package.json'));
    const grpc = runtime === 'adapter' && sourceBuild ? require(path.join(adapterDirectory, 'index.js')) : req('@grpc/grpc-js');
    const endpoint = `127.0.0.1:${port}`;
    const consumer = fs.mkdtempSync(path.join(fixture, '.watch-consumer-'));
    try {
        const copied = path.join(consumer, 'firestore-watch.mjs'); fs.writeFileSync(copied, shared);
        report.sources[runtime] = hash(fs.readFileSync(copied));
        const { runFirestoreWatch } = await import(pathToFileURL(copied).href);
        for (const scenario of ['document', 'query']) {
            stage = `${runtime}-${scenario}`; currentCase = { scenario, invocation: runtime };
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
            const checks = await bounded(runFirestoreWatch({ options, scenario, runId: runtime }), 'WATCH_NODE_TIMEOUT');
            report.results.push({ id: `${runtime}/${scenario}`, runtime, invocation: runtime, status: 'passed', ...checks, dataCleaned: true, clientTerminated: true });
        }
    } finally { globalThis.fetch = savedFetch; fs.rmSync(consumer, { recursive: true, force: true }); }
}
async function buildWorker(adapterDirectory) {
    const preset = createGoogleWorkerBuild({ projectRoot: modernRoot, profile: 'google-modern-v1', outdir: path.join(scratch, 'preset'), typescript: require('typescript') });
    // Reuse the exact legacy business and Worker entrypoint, but resolve SDK/auth
    // imports from the modern graph. Metafile assertions below guard this boundary.
    const frozenBusiness = { name: 'modern-watch-frozen-business', setup(build) {
        build.onLoad({ filter: /firestore-watch\.mjs$/ }, args => args.path === sharedFile ? { contents: shared, loader: 'js', resolveDir: modernRoot } : undefined);
    } };
    const built = await workerRequire('esbuild').build({ absWorkingDir: root, entryPoints: [path.join(root, 'fixtures/worker/firestore-watch.mjs')],
        bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(scratch, 'sdk.cjs'), plugins: [frozenBusiness, preset.plugin], metafile: true,
        ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(adapterDirectory, 'adapter.js'),
            '@grpc/grpc-js/package.json': path.join(root, 'package.json'), '@grpc/grpc-js': path.join(adapterDirectory, 'index.js') } } : {}) });
    assert.ok(Object.keys(built.metafile.inputs).includes('fixtures/google/shared/firestore-watch.mjs'), 'WATCH_SHARED_WORKER_INPUT');
    const inputs = Object.keys(built.metafile.inputs);
    assert.ok(inputs.includes('fixtures/modern/node_modules/@google-cloud/firestore/build/src/index.js'), 'WATCH_MODERN_FIRESTORE_WORKER_INPUT');
    assert.ok(inputs.some(file => file.startsWith('fixtures/modern/node_modules/@google-cloud/firestore-api/')), 'WATCH_MODERN_FIRESTORE_API_WORKER_INPUT');
    assert.ok(!inputs.some(file => file.startsWith('fixtures/google/node_modules/')), 'WATCH_NO_LEGACY_DEPENDENCIES');
    report.workerSdkInputs = inputs.filter(file => /^fixtures\/modern\/node_modules\/@google-cloud\/(firestore|firestore-api)\//.test(file)).sort();
    report.sources.workerd = hash(shared);
    fs.writeFileSync(path.join(scratch, 'worker.mjs'), 'import bundle from "./sdk.cjs";export default bundle.default;\n');
    const config = path.join(scratch, 'wrangler.json');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-modern-firestore-watch-local', main: path.join(scratch, 'worker.mjs'), compatibility_date: compatibilityDate,
        compatibility_flags: ['nodejs_compat'], send_metrics: false }));
    execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config,
        '--outdir', path.join(scratch, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
    const script = fs.readFileSync(path.join(scratch, 'bundle/worker.js'), 'utf8');
    report.build = preset.manifest(); report.bundleSha256 = hash(script); return script;
}
function workerForward(port) {
    return { node: (request, response) => {
        try {
            const incomingHeaders = new Headers(request.headers);
            const url = new URL(incomingHeaders.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `http://${incomingHeaders.get('host')}`);
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
        if (!emulators && startingEmulators) try { emulators = await startingEmulators; } catch {}
        if (!envoy && startingEnvoy) try { envoy = await startingEnvoy; } catch {}
        for (const forward of forwards) forward.destroy();
        try { await worker?.dispose(); } catch (error) { errors.push(error); }
        if (envoy) {
            try { report.envoy = await envoy.stop(); report.wire = envoy.readAccess(); } catch (error) { errors.push(error); }
        }
        if (emulators) {
            try { await emulators.stop(); } catch (error) { errors.push(error); }
            report.emulators = emulators.metadata;
        }
        report.cleanup = { workerDisposed: !worker || errors.length === 0, envoyExited: !envoy || !!report.envoy?.exit,
            emulatorsStopped: !emulators || Object.values(emulators.metadata.instances).every(item => item.status === 'stopped') };
        if (errors.length) report.cleanupErrors = errors.map(fixedError);
        return errors;
    })();
}
function writeReport() {
    report.completedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/modern-firestore-watch.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    fs.rmSync(scratch, { recursive: true, force: true });
}
const interrupt = signal => {
    report.status = 'failed'; report.interrupted = signal;
    void cleanup().finally(() => { writeReport(); process.exit(signal === 'SIGINT' ? 130 : 143); });
};
const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
async function main() {
    report.runtime = { node: process.version, firestore: modernRequire('@google-cloud/firestore/package.json').version,
        nativeFirestore: createRequire(path.join(root, 'fixtures/modern-native/package.json'))('@google-cloud/firestore/package.json').version,
        googleAuth: modernRequire('google-auth-library/package.json').version,
        nativeGrpc: createRequire(path.join(root, 'fixtures/modern-native/package.json'))('@grpc/grpc-js/package.json').version,
        workerd: workerRequire('workerd/package.json').version, miniflare: workerRequire('miniflare/package.json').version };
    assert.equal(report.runtime.firestore, '9.2.0', 'WATCH_PINNED_FIRESTORE');
    assert.equal(report.runtime.nativeFirestore, report.runtime.firestore, 'WATCH_NATIVE_SDK_VERSION');
    assert.equal(report.runtime.nativeGrpc, '1.14.5', 'WATCH_PINNED_NATIVE_GRPC');
    assert.equal(modernRequire('@grpc/grpc-js/package.json').name, 'workers-grpc-adapter', 'WATCH_ADAPTER_IDENTITY');
    report.evidence = Object.fromEntries(['scripts/test-modern-firestore-watch.cjs', 'fixtures/google/shared/firestore-watch.mjs', 'fixtures/worker/firestore-watch.mjs',
        'scripts/emulator-envoy.cjs', 'fixtures/emulators/launcher.cjs', 'fixtures/emulators/toolchain.json', 'fixtures/envoy/binary.json',
        'fixtures/modern/package-lock.json', 'fixtures/modern-native/package-lock.json', 'src/build/profiles/google-modern-v1.json', 'fixtures/worker/package-lock.json'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    let primary;
    try {
        emulators = await (startingEmulators = startEmulators({ projectId }));
        envoy = await (startingEnvoy = startEmulatorEnvoy(emulators));
        await nodeConsumer('native', envoy.ports.native);
        if (!nativeOnly) {
            let adapterDirectory;
            if (sourceBuild) {
                stage = 'isolated-source-build'; adapterDirectory = path.join(scratch, 'adapter-dist');
                require('./toolchain.cjs').compile({ outDir: adapterDirectory, rootDir: path.join(root, 'src') });
                report.isolatedCallSha256 = hash(fs.readFileSync(path.join(adapterDirectory, 'call.js')));
            }
            await nodeConsumer('adapter', envoy.ports.replacement, adapterDirectory);
            stage = 'worker-build'; const script = await buildWorker(adapterDirectory);
            worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'],
                log: new Log(LogLevel.NONE), bindings: { PROJECT_ID: projectId, ENDPOINT: `127.0.0.1:${envoy.ports.workerd}` }, outboundService: workerForward(envoy.ports.workerd) }));
            for (const invocation of ['first', 'second']) for (const scenario of ['document', 'query']) {
                stage = `workerd-${invocation}-${scenario}`; currentCase = { scenario, invocation };
                const response = await bounded(worker.dispatchFetch(`https://fixture.test/${scenario}?run=${invocation}`), 'WATCH_WORKER_TIMEOUT');
                const result = await response.json();
                if (response.status !== 200) report.workerFailure = result;
                assert.equal(response.status, 200, result.diagnostic ?? 'WATCH_WORKER_HTTP');
                assert.equal(result.status, 'passed', 'WATCH_WORKER_RESULT');
                await until(() => forwards.size === 0, 'WATCH_STREAMS_RELEASED_BEFORE_NEXT_CASE');
                report.results.push({ id: `workerd-${invocation}/${scenario}`, runtime: 'workerd', invocation, ...result,
                    dataCleaned: true, clientTerminated: true, forwardsReleasedBeforeNextCase: true });
            }
            assert.deepEqual(boundaryErrors, [], 'WATCH_BOUNDARY_ERRORS');
            assert.deepEqual(asyncErrors, [], 'WATCH_ASYNC_ERRORS');
            for (const value of Object.values(report.sources)) assert.equal(value, report.sharedSha256, 'WATCH_IDENTICAL_BUSINESS_SOURCE');
            for (const result of report.results.filter(item => item.runtime !== 'native')) {
                const expected = report.results.find(item => item.runtime === 'native' && item.scenario === result.scenario);
                for (const key of ['selected', 'changeTypes', 'listeners', 'callbacks', 'unsubscribeVerified', 'reuseVerified'])
                    assert.deepEqual(result[key], expected[key], `WATCH_NATIVE_EQUIVALENT_${key}`);
            }
            report.nativeBusinessEquivalent = true;
        }
    } catch (error) { primary = error; throw error; }
    finally {
        const errors = await cleanup();
        if (errors.length && !primary) throw Object.assign(new Error('WATCH_RESOURCE_CLEANUP'), { fixtureDiagnostic: 'WATCH_RESOURCE_CLEANUP' });
    }
    const consumers = nativeOnly ? ['native'] : ['native', 'adapter', 'workerd-first', 'workerd-second'];
    report.methods = {};
    for (const consumer of consumers) {
        const entries = report.wire.filter(item => consumer === 'native' ? item.runtime === 'native'
            : consumer === 'adapter' ? item.runtime === 'replacement' : item.runtime === 'workerd' && item.invocation === consumer.slice(8));
        const counts = {};
        for (const entry of entries) {
            assert.equal(entry.upstream, 'firestore', 'WATCH_CORRECT_EMULATOR');
            assert.match(entry.method, /^\/google\.firestore\.v1\.Firestore\/(Listen|Commit|BatchGetDocuments)$/);
            counts[entry.method] = (counts[entry.method] ?? 0) + 1;
            assert.equal(Number(entry.grpcStatus), 0, 'WATCH_NATIVE_TERMINAL_STATUS');
            assert.equal(Number(entry.httpStatus), 200, 'WATCH_UPSTREAM_HTTP_STATUS');
            assert.equal(entry.flags, '-', 'WATCH_UPSTREAM_FLAGS');
        }
        assert.equal(counts['/google.firestore.v1.Firestore/Listen'], 4, 'WATCH_FOUR_REAL_LISTEN_CALLS');
        report.methods[consumer] = counts;
        if (consumer !== 'native') assert.deepEqual(counts, report.methods.native, 'WATCH_NATIVE_METHOD_COUNTS');
    }
    if (!nativeOnly) {
        const streamingRequests = report.requests.filter(item => item.runtime === 'workerd' && item.streaming);
        assert.equal(streamingRequests.length, 8, 'WATCH_WORKER_LISTEN_COUNT');
        assert.ok(streamingRequests.every(item => item.uploadEndedAtResponse === false), 'WATCH_RESPONSE_BEFORE_UPLOAD_END');
        assert.ok(report.requests.every(item => item.responseStatus === 200 && /^application\/grpc-web(?:\+proto)?$/.test(item.responseMime)), 'WATCH_GATEWAY_RESPONSES');
        report.nativeWireEquivalent = true;
        report.responsesBeforeRequestCompletion = true;
    }
    assert.deepEqual(asyncErrors, [], 'WATCH_ASYNC_ERRORS');
    report.summary = { cases: report.results.length, rpcArrivals: report.wire.length, fetchRequests: report.requests.length,
        listenCalls: report.wire.filter(item => item.method.endsWith('/Listen')).length,
        callbacks: report.results.reduce((count, item) => count + item.callbacks, 0) };
    report.status = 'passed';
}
main().catch(error => { report.status = 'failed'; report.stage = stage; report.error = fixedError(error); process.exitCode = 1; }).finally(() => {
    process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); writeReport();
    console.log(JSON.stringify({ status: report.status, stage: report.stage, error: report.error, cases: report.results.length,
        requests: report.requests.length, report: 'verification/modern-firestore-watch.json' }));
});
