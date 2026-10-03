'use strict';
// Official Google emulator + real Envoy. No SDK RPC response is mocked here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { startEmulators } = require('../fixtures/emulators/launcher.cjs');
const { startEmulatorEnvoy } = require('./emulator-envoy.cjs');
const { validateDatastoreEmulatorReport } = require('./datastore-emulator-evidence.cjs');
const root = path.resolve(__dirname, '..');
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const esbuild = workerRequire('esbuild');
const { createGoogleWorkerBuild } = googleRequire('@grpc/grpc-js/build');
const hash = value => createHash('sha256').update(value).digest('hex');
const projectId = 'demo-wga-local', runId = 'emulator-8577e274-468c-4180';
const compatibilityDate = '2026-09-21';
const report = {
    startedAt: new Date().toISOString(), status: 'running', realGoogleSDK: true, officialEmulators: true,
    liveGoogleApiExecuted: false, deployedCloudflareExecuted: false, releaseEligible: false,
    scope: 'native grpc-js and packed adapter in Node/workerd through real Envoy to official Firestore native and Datastore-mode emulators',
    projectId, compatibilityDate, sourceHashes: {}, results: [], requests: [], checks: [],
    runtime: { node: process.version, workerd: workerRequire('workerd/package.json').version, miniflare: workerRequire('miniflare/package.json').version, wrangler: workerRequire('wrangler/package.json').version, esbuild: esbuild.version },
};
const savedFetch = globalThis.fetch;
function errorDetails(error, depth = 0) {
    return { code: error.code ?? null, class: error.constructor?.name || 'Error', message: error.message,
        ...(depth < 2 && Array.isArray(error.errors) ? { errors: error.errors.map(item => errorDetails(item, depth + 1)) } : {}) };
}
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-google-emulators-'));
// Ignore developer emulator/ADC routing. All fixture endpoints are explicit loopback.
for (const key of ['FIRESTORE_EMULATOR_HOST', 'DATASTORE_EMULATOR_HOST', 'DATASTORE_DATASET', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) delete process.env[key];
function compileWorker() {
    const sharedDirectory = path.join(root, 'fixtures/google/shared');
    const sourceContents = new Map(fs.readdirSync(sharedDirectory).filter(file => file.endsWith('.mjs')).map(file => [file, fs.readFileSync(path.join(sharedDirectory, file))]));
    const frozenBusiness = { name: 'frozen-shared-business', setup(build) {
        build.onLoad({ filter: /\.mjs$/ }, args => {
            if (path.dirname(args.path) !== sharedDirectory) return;
            const source = sourceContents.get(path.basename(args.path));
            assert.ok(source, 'A shared module was added after the build snapshot');
            return { contents: source, loader: 'js', resolveDir: sharedDirectory };
        });
    } };
    const preset = createGoogleWorkerBuild({ projectRoot: path.join(root, 'fixtures/google'), outdir: path.join(scratch, 'preset'), typescript: require('typescript') });
    return esbuild.build({ entryPoints: [path.join(root, 'fixtures/google/emulator-worker.mjs')], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(scratch, 'sdk.cjs'), plugins: [frozenBusiness, preset.plugin], metafile: true }).then(built => {
        const sourceFiles = Object.keys(built.metafile.inputs).map(file => path.resolve(file)).filter(file => path.dirname(file) === path.join(root, 'fixtures/google/shared')).map(file => path.basename(file)).sort();
        report.sourceHashes.workerd = Object.fromEntries(sourceFiles.map(file => [file, hash(sourceContents.get(file))]));
        const entry = path.join(scratch, 'worker.mjs');
        fs.writeFileSync(entry, 'import bundle from "./sdk.cjs"; export default bundle.default;\n');
        const config = path.join(scratch, 'wrangler.jsonc');
        fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-emulators', main: entry, compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
        execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config, '--outdir', path.join(scratch, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
        const script = fs.readFileSync(path.join(scratch, 'bundle/worker.js'), 'utf8');
        report.build = preset.manifest();
        report.bundle = { bytes: Buffer.byteLength(script), sha256: hash(script) };
        return { script, sourceFiles, sourceContents };
    });
}
async function forward(url, init, runtime, suite, invocation, port) {
    const target = new URL(url);
    assert.equal(target.origin, `http://127.0.0.1:${port}`, 'No external network endpoint is permitted');
    assert.match(target.pathname, /^\/google\.(datastore\.v1\.Datastore|firestore\.v1\.Firestore)\/[A-Za-z]+$/);
    assert.equal(init.method, 'POST');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), null, 'Emulator clients must not send credentials over insecure loopback');
    assert.equal(headers.get('content-type'), 'application/grpc-web+proto');
    // Miniflare's host-service Request can expose a placeholder length. The
    // real Fetch client must compute framing from the exact forwarded bytes.
    for (const name of ['content-length', 'host', 'connection', 'transfer-encoding']) headers.delete(name);
    if (invocation) headers.set('x-wga-invocation', invocation);
    if (target.pathname.startsWith('/google.datastore.')) headers.set('x-wga-suite', suite);
    const record = { runtime, suite, invocation: invocation || null, method: target.pathname, logicalCallId: headers.get('x-wga-sdk-call-id'), requestContentType: headers.get('content-type'), requestBytes: init.body.byteLength, responseContentType: null };
    report.requests.push(record);
    let response;
    try { response = await savedFetch(url, { ...init, headers, redirect: 'error' }); }
    catch (error) { record.error = errorDetails(error); throw error; }
    record.responseContentType = response.headers.get('content-type');
    record.httpStatus = response.status;
    assert.match(record.responseContentType || '', /^application\/grpc-web(?:\+proto)?$/);
    return response;
}
async function nodeSuites(runtime, port, sourceFiles, sourceContents) {
    const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
    const req = createRequire(path.join(fixture, 'package.json'));
    const grpc = req('@grpc/grpc-js');
    const endpoint = `127.0.0.1:${port}`;
    if (runtime === 'replacement') req('@grpc/grpc-js/config').configureWorkersGrpc({ mode: 'grpc-web', allowInsecureLocalhost: true, defaultTimeoutMs: 30000, endpoints: { [endpoint]: `http://${endpoint}` } });
    const consumer = fs.mkdtempSync(path.join(fixture, '.emulator-consumer-'));
    try {
        fs.writeFileSync(path.join(consumer, 'package.json'), '{"type":"module"}\n');
        report.sourceHashes[runtime] = {};
        for (const file of sourceFiles) {
            const bytes = sourceContents.get(file);
            fs.writeFileSync(path.join(consumer, file), bytes);
            report.sourceHashes[runtime][file] = hash(fs.readFileSync(path.join(consumer, file)));
        }
        const { emulatorSuites } = await import(pathToFileURL(path.join(consumer, 'emulator-suites.mjs')).href);
        const { startSdkCallAccounting } = await import(pathToFileURL(path.join(consumer, 'sdk-call-accounting.mjs')).href);
        for (const { sdk, suite, run } of emulatorSuites) {
            let options = { projectId, sslCreds: grpc.credentials.createInsecure() };
            const isDatastore = sdk === '@google-cloud/datastore';
            const clients = [], tracker = isDatastore && runtime !== 'native' ? startSdkCallAccounting(grpc) : null;
            let accounting = null, transport, dataFetches = 0, authMetadataRequests = 0, authNetworkRequests = 0;
            if (isDatastore) {
                const authClient = new (req('google-auth-library').OAuth2Client)();
                authClient.getRequestHeaders = async () => { authMetadataRequests++; throw new Error('emulator-auth-disabled'); };
                authClient.transporter.request = async () => { authNetworkRequests++; throw new Error('emulator-auth-network-disabled'); };
                options.authClient = authClient;
            }
            if (sdk === '@google-cloud/datastore') options.apiEndpoint = endpoint;
            else options.host = endpoint;
            globalThis.fetch = (url, init) => forward(url, init, runtime, suite, null, port);
            if (tracker) {
                transport = req('@grpc/grpc-js/adapter').createWorkersGrpcTransport({ mode: 'grpc-web',
                    allowInsecureLocalhost: true, defaultTimeoutMs: 30000, endpoints: { [endpoint]: `http://${endpoint}` },
                    observer: tracker.observer, fetcher: { fetch: tracker.wrapFetcher((url, init) => {
                        dataFetches++; return forward(url, init, runtime, suite, null, port);
                    }) } });
                const { sslCreds, ...gaxOptions } = options;
                // Explicit anonymous loopback credentials are applied only to
                // this emulator fixture after obtaining the transport token.
                options = { ...transport.gaxOptions(gaxOptions), sslCreds };
            }
            const start = report.requests.length;
            try {
                const checks = await run({ options, allowedProjectId: projectId, allowWrites: true, runId,
                    registerDatastoreClient: client => clients.push(client) });
                if (tracker) accounting = await tracker.snapshot(transport);
                if (isDatastore) {
                    assert.equal(authMetadataRequests, 0); assert.equal(authNetworkRequests, 0);
                    assert.ok(clients.length > 0, 'Every Datastore suite must register its clients');
                }
                report.results.push({ runtime, sdk, suite, status: 'passed', checks, grpcWebRequests: report.requests.length - start,
                    ...(isDatastore ? { accounting, dataFetches, authFetches: 0, authMetadataRequests, authNetworkRequests,
                        controlRequests: 0, authMode: 'disabled-insecure-loopback', registeredClients: clients.length } : {}) });
            } catch (error) {
                report.results.push({ runtime, sdk, suite, status: 'failed', error: errorDetails(error) });
                throw error;
            } finally {
                try {
                    const generated = [...new Set(clients.flatMap(client => typeof client.close === 'function' ? [client] : [...client.clients_.values()]))];
                    const closed = await Promise.allSettled(generated.map(client => client.close()));
                    const failures = closed.filter(item => item.status === 'rejected').map(item => item.reason);
                    if (failures.length) throw new AggregateError(failures, 'emulator-sdk-close-failed');
                    const row = report.results.at(-1);
                    if (isDatastore && row?.suite === suite) row.clientsClosed = clients.length;
                } finally { tracker?.restore(); globalThis.fetch = savedFetch; }
            }
        }
        return emulatorSuites.map(({ sdk, suite }) => ({ sdk, suite }));
    } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
}
function summarizeWire(entries) {
    const byMethod = {};
    for (const entry of entries) {
        assert.match(entry.method, /^\/google\.(datastore\.v1\.Datastore|firestore\.v1\.Firestore)\/[A-Za-z]+$/);
        assert.equal(Number(entry.httpStatus), 200, `Unexpected Envoy HTTP status: ${entry.method}`);
        assert.ok(entry.grpcStatus !== null && entry.grpcStatus !== undefined && /^\d+$/.test(String(entry.grpcStatus)) && Number(entry.grpcStatus) <= 16, 'Envoy must observe an actual numeric gRPC status');
        assert.equal(entry.upstream, entry.method.startsWith('/google.datastore.') ? 'datastore' : 'firestore', 'RPC reached the wrong emulator');
        assert.equal(entry.flags, '-', 'Envoy reported a transport failure');
        const key = `${entry.method}#${entry.grpcStatus}`;
        byMethod[key] = (byMethod[key] || 0) + 1;
    }
    return Object.fromEntries(Object.entries(byMethod).sort(([a], [b]) => a.localeCompare(b)));
}
async function main() {
    const { script, sourceFiles, sourceContents } = await compileWorker();
    report.evidence = Object.fromEntries(['scripts/google-emulator-test.cjs', 'scripts/emulator-envoy.cjs', 'scripts/datastore-emulator-evidence.cjs', 'fixtures/google/emulator-worker.mjs', 'fixtures/emulators/toolchain.json', 'fixtures/emulators/launcher.cjs', 'fixtures/emulators/download.cjs', 'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    for (const [name, fixture, entry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
        report[name] = Object.fromEntries(['@grpc/grpc-js/package.json', `@grpc/grpc-js/${entry}`, '@google-cloud/datastore/package.json',
            '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js',
            '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json',
            'google-gax/package.json', 'google-auth-library/package.json'].map(file => {
                const location = `fixtures/${fixture}/node_modules/${file}`;
                return [location, hash(fs.readFileSync(path.join(root, location)))];
            }));
    }
    let emulators, envoy, worker, startingEmulators, startingEnvoy;
    let cleaning, primary;
    const cleanup = () => cleaning ||= (async () => {
        globalThis.fetch = savedFetch;
        const errors = [];
        // A signal can arrive while a helper is still starting its children.
        // Wait for its bounded startup/cleanup before declaring the run stopped.
        if (!emulators && startingEmulators) try { emulators = await startingEmulators; } catch {}
        if (!envoy && startingEnvoy) try { envoy = await startingEnvoy; } catch {}
        try { await worker?.dispose(); } catch (error) { errors.push(error); }
        if (envoy) {
            try { report.envoy = await envoy.stop(); } catch (error) { errors.push(error); }
            try { report.wire = envoy.readAccess(); } catch (error) { errors.push(error); }
        }
        if (emulators) {
            try { await emulators.stop(); } catch (error) { errors.push(error); }
            report.emulators = emulators.metadata;
        }
        if (errors.length) report.cleanupErrors = errors.map(error => ({ class: error.constructor?.name || 'Error', message: error.message }));
        return errors;
    })();
    const interrupt = signal => {
        report.status = 'failed';
        report.interrupted = signal;
        void cleanup().finally(() => {
            report.completedAt = new Date().toISOString();
            fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
            fs.writeFileSync(path.join(root, 'verification/google-emulators.json'), JSON.stringify(report, null, 2) + '\n');
            fs.rmSync(scratch, { recursive: true, force: true });
            process.exit(signal === 'SIGINT' ? 130 : 143);
        });
    };
    const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
    process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
    try {
        emulators = await (startingEmulators = startEmulators({ projectId }));
        report.emulators = emulators.metadata;
        envoy = await (startingEnvoy = startEmulatorEnvoy(emulators));
        report.envoy = envoy.metadata;
        const suites = await nodeSuites('native', envoy.ports.native, sourceFiles, sourceContents);
        await nodeSuites('replacement', envoy.ports.replacement, sourceFiles, sourceContents);
        const endpoint = `127.0.0.1:${envoy.ports.workerd}`;
        let currentSuite, invocation;
        worker = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'], bindings: { PROJECT_ID: projectId, ENDPOINT: endpoint, RUN_ID: runId }, outboundService: async request => forward(request.url, { method: request.method, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()), signal: request.signal }, 'workerd', currentSuite, invocation, envoy.ports.workerd) }));
        for (invocation of ['first', 'second']) {
            for (const { sdk, suite } of suites) {
                currentSuite = suite;
                const start = report.requests.length;
                const response = await worker.dispatchFetch(`https://fixture.test/${suite}`);
                const body = await response.text();
                let result;
                try { result = JSON.parse(body); } catch { throw new Error(`Worker bootstrap failed (${response.status}): ${body.slice(0, 1000)}`); }
                report.results.push({ runtime: `workerd-${invocation}`, ...result, grpcWebRequests: report.requests.length - start });
                assert.equal(response.status, 200, `Worker ${suite}: ${JSON.stringify(result.error)}`);
                assert.equal(result.status, 'passed');
                assert.equal(result.sdk, sdk);
            }
        }
        assert.deepEqual(report.sourceHashes.native, report.sourceHashes.replacement);
        assert.deepEqual(report.sourceHashes.native, report.sourceHashes.workerd);
        const business = runtime => report.results.filter(item => item.runtime === runtime).map(({ sdk, suite, status, checks }) => ({ sdk, suite, status, checks }));
        for (const runtime of ['replacement', 'workerd-first', 'workerd-second']) assert.deepEqual(business(runtime), business('native'), `Business mismatch: ${runtime}`);
        report.sameSharedFiles = true;
        report.businessEquivalent = true;
    } catch (error) { primary = error; throw error; }
    finally {
        const errors = await cleanup();
        process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
        if (errors.length && !primary) throw new AggregateError(errors, 'Emulator harness cleanup failed');
    }
    const nativeWire = summarizeWire(report.wire.filter(item => item.runtime === 'native'));
    report.methodStatusCounts = { native: nativeWire };
    for (const runtime of ['replacement', 'workerd-first', 'workerd-second']) {
        const entries = report.wire.filter(item => runtime.startsWith('workerd') ? item.runtime === 'workerd' && item.invocation === runtime.slice(8) : item.runtime === runtime);
        report.methodStatusCounts[runtime] = summarizeWire(entries);
        assert.deepEqual(report.methodStatusCounts[runtime], nativeWire, `Emulator RPC/status count mismatch: ${runtime}`);
        const outbound = report.requests.filter(item => runtime.startsWith('workerd') ? item.runtime === 'workerd' && item.invocation === runtime.slice(8) : item.runtime === runtime);
        assert.equal(entries.length, outbound.length, `${runtime}: Envoy arrival count differs from adapter fetch count`);
    }
    report.wireEquivalent = true;
    report.status = 'passed';
    report.datastoreAccounting = { status: 'passed', scope: 'anonymous-grpc-web-official-emulator', mode: 'grpc-web',
        adapterRetryEnabled: false, resourcesCheckedBeforeClose: true, physicalEnvoyReceiptsJoined: true,
        authMode: 'disabled-insecure-loopback', authFetches: 0, authNetworkRequests: 0, authMetadataRequests: 0,
        controlRequests: 0, controlScope: 'no-suite-control-requests; emulator and Envoy readiness are harness setup',
        logicalCalls: report.results.filter(row => row.sdk === '@google-cloud/datastore').reduce((sum, row) => sum + (row.accounting?.calls.length || 0), 0),
        dataFetches: report.results.filter(row => row.sdk === '@google-cloud/datastore').reduce((sum, row) => sum + row.dataFetches, 0) };
    validateDatastoreEmulatorReport(report);
    report.checks = ['official-firestore-native-emulator', 'official-firestore-datastore-mode-emulator', 'real-envoy-grpc-web-filter', 'no-mocked-rpc-responses', 'all-network-loopback', 'no-adc-or-real-credentials', 'identical-shared-module-sha256', 'native-node-adapter-and-workerd', 'same-business-assertions', 'same-emulator-rpc-and-status-counts', 'two-workerd-invocations-per-suite', 'created-data-cleaned-before-client-close', 'child-processes-stopped'];
}
main().catch(error => {
    report.status = 'failed';
    report.error = { ...errorDetails(error), stack: error.stack };
    process.exitCode = 1;
}).finally(() => {
    report.completedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/google-emulators.json'), JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(JSON.stringify({ status: report.status, scenarios: report.results.length, grpcWebRequests: report.requests.length, emulatorArrivals: report.wire?.length || 0, error: report.error }));
});
