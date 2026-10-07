'use strict';
process.env.GOOGLE_SDK_NODE_LOGGING = '';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createDatastoreTransactionServer, createTransactionTlsProxy } = require('./datastore-transaction-server.cjs');
const { startEmulatorEnvoy } = require('./emulator-envoy.cjs');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sharedPath = path.join(root, 'fixtures/google/shared/datastore-transactions.mjs');
const sharedBytes = fs.readFileSync(sharedPath);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-datastore-transactions-'));
const profiles = [
  { id: 'google-static-v1', fixture: 'google', native: 'native', version: '10.1.1' },
  { id: 'google-modern-v1', fixture: 'modern', native: 'modern-native', version: '11.1.0' },
];
const scenarios = ['commit-success', 'query-commit', 'rollback-queued', 'readonly-read', 'readonly-write-rejected', 'commit-aborted', 'disconnect-before-apply', 'disconnect-after-apply', 'v1-deadline-commit', 'crossed-transactions'];
const nativeOnly = process.argv.includes('--native-only');
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild: false, nativeOnly,
  liveGoogle: false, cloudflareAutomaticConversion: false, officialEmulator: false, realEnvoy: true,
  controlledNativeGrpcServer: true, restFallback: false, adapterRetryEnabled: false,
  testInstrumentation: { syntheticIdentityHeaders: true, oauthCredentialIsolation: true, syntheticCachedOAuthTokens: true, nativeLoopbackTls: true, targetObservation: 'auth-service-url-and-fetch-origin-or-native-authority', privateSdkHooks: false, privateSdkCleanup: true, controlDataRpcSeparated: true, realHttp2Reset: true },
  resourcesCheckedBeforeClose: false, sharedSha256: hash(sharedBytes), sources: {}, profiles: [], results: [],
  evidence: {}, installedInputs: {}, nativeInputs: {}, node: process.version,
  workerd: workerRequire('workerd/package.json').version, miniflare: workerRequire('miniflare/package.json').version,
  compatibilityDate: '2026-09-21' };
let stage = 'startup', controlled, envoy, worker, currentCase, nativeTls;
const boundaryErrors = [], asyncErrors = [];
process.on('unhandledRejection', () => { asyncErrors.push('TX_UNHANDLED_REJECTION'); process.exitCode = 1; });
for (const name of ['FIRESTORE_EMULATOR_HOST', 'DATASTORE_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) delete process.env[name];
function check(condition, diagnostic) { if (!condition) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic }); }
function safe(error) { return /^TX_[A-Z_]+$/.test(error?.fixtureDiagnostic) ? error.fixtureDiagnostic : 'TX_HARNESS_FAILURE'; }
async function bounded(promise, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('TX_CASE_TIMEOUT'), { fixtureDiagnostic: 'TX_CASE_TIMEOUT' })), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function untilIdle() {
  for (let turn = 0; turn < 200 && controlled.active.size; turn++) await new Promise(resolve => setTimeout(resolve, 5));
  check(controlled.active.size === 0, 'TX_BACKEND_IDLE');
}
function inspectRequest(input, init, mode) {
  const url = new URL(input), headers = new Headers(init.headers);
  const crossed = currentCase.endsWith('/crossed-transactions');
  const targets = mode === 'cloudflare' ? ['https://datastore-a.googleapis.com', 'https://datastore-b.googleapis.com']
    : ['https://datastore-transaction-gateway-a.invalid', 'https://datastore-transaction-gateway-b.invalid'];
  check(crossed ? targets.includes(url.origin) : url.origin === (mode === 'cloudflare' ? 'https://datastore.googleapis.com' : 'https://datastore-transaction-gateway.invalid'), 'TX_EXACT_OUTBOUND_ORIGIN');
  check(['BeginTransaction', 'Lookup', 'RunQuery', 'Commit', 'Rollback'].map(method => '/google.datastore.v1.Datastore/' + method).includes(url.pathname), 'TX_EXACT_OUTBOUND_METHOD');
  check(init.method === 'POST' && headers.get('content-type') === (mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto'), 'TX_GRPC_WEB_WIRE');
  if (crossed) {
    const identity = targets.indexOf(url.origin) === 0 ? 'a' : 'b';
    check(headers.get('authorization') === `Bearer tx-fixture-${identity}`
      && headers.get('x-goog-user-project') === `tx-quota-${identity}`, 'TX_CREDENTIAL_ROUTING');
    controlled.observeFetchTarget(identity);
  } else check(headers.get('authorization') === null, 'TX_EXPLICIT_ANONYMOUS_AUTH');
  headers.set('x-wga-invocation', currentCase);
  return { url, headers };
}
function addResult(profile, runtime, scenario, result, observer, fetchCount, controlRequests) {
  const caseId = `${profile}/${runtime}/${scenario}`;
  const calls = controlled.arrivals.filter(call => call.caseId === caseId).map(({ caseId: _caseId, ...rest }) => rest);
  const expected = scenario === 'crossed-transactions' ? 8 : scenario === 'v1-deadline-commit' ? 3 : ['readonly-write-rejected', 'commit-aborted', 'disconnect-before-apply', 'disconnect-after-apply'].includes(scenario) ? 5 : 4;
  check(calls.length === expected && calls.at(-1).method === 'Lookup' && calls.at(-1).transactionId === null, 'TX_EXACT_RPC_COUNT');
  check(fetchCount === (runtime === 'native' ? 0 : expected), 'TX_EXACT_FETCH_COUNT');
  check(controlRequests === (scenario === 'v1-deadline-commit' ? 1 : 0), 'TX_CONTROL_COUNT');
  check(controlled.faults.length === 0 && boundaryErrors.length === 0 && asyncErrors.length === 0, 'TX_HARNESS_ASSERTIONS');
  if (observer) {
    check(observer.calls.length === expected && observer.calls.every((call, index) => call.statusCode === calls[index].statusCode), 'TX_OBSERVER_STATUS');
  }
  report.results.push({ profile, runtime, scenario, status: 'passed', rpcCount: calls.length, fetchCount, controlRequests,
    requests: calls, result, observer, backendIdleBeforeNextCase: controlled.active.size === 0 });
}
async function runNode(profile, runtime) {
  const fixture = path.join(root, 'fixtures', runtime === 'native' ? profile.native : profile.fixture);
  const req = createRequire(path.join(fixture, 'package.json'));
  const consumer = fs.mkdtempSync(path.join(fixture, '.transaction-errors-'));
  try {
    const copied = path.join(consumer, 'datastore-transactions.mjs'); fs.writeFileSync(copied, sharedBytes);
    report.sources[`${profile.id}/${runtime}`] = hash(fs.readFileSync(copied));
    const { runDatastoreTransactions, observeTransactionCalls } = await import(pathToFileURL(copied).href);
    const grpc = req('@grpc/grpc-js');
    for (const scenario of scenarios) {
      stage = currentCase = `${profile.id}/${runtime}/${scenario}`;
      controlled.prepare(scenario, currentCase);
      const events = []; let fetchCount = 0, controlRequests = 0, observer = null;
      const mode = runtime.slice('adapter-'.length);
      const transport = runtime === 'native' ? null : req('@grpc/grpc-js/adapter').createWorkersGrpcTransport({
        observer: event => events.push(event),
        ...(mode === 'cloudflare' ? { mode } : { mode, endpoints: { 'datastore.googleapis.com': 'https://datastore-transaction-gateway.invalid',
          'datastore-a.googleapis.com': 'https://datastore-transaction-gateway-a.invalid',
          'datastore-b.googleapis.com': 'https://datastore-transaction-gateway-b.invalid' } }),
        fetcher: { async fetch(input, init) {
          const { url, headers } = inspectRequest(input, init, mode); fetchCount++;
          return fetch(`http://127.0.0.1:${envoy.ports.replacement}${url.pathname}`, { ...init, headers, cf: undefined });
        } },
      });
      const options = transport ? transport.gaxOptions({ projectId: 'demo-wga-transactions' })
        : { projectId: 'demo-wga-transactions', apiEndpoint: `127.0.0.1:${envoy.ports.native}`, sslCreds: grpc.credentials.createInsecure() };
      const result = await bounded(runDatastoreTransactions({ options, scenario, caseId: currentCase,
        crossedOptions: runtime !== 'native' ? undefined : (identity, authClient) => ({
          apiEndpoint: `${identity === 'a' ? 'localhost' : '127.0.0.1'}:${nativeTls.port}`,
          sslCreds: grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(nativeTls.cert),
            grpc.credentials.createFromGoogleCredential({ getRequestHeaders: async url => Object.fromEntries(await authClient.getRequestHeaders(url)) })),
        }),
        control: async operation => { controlRequests++; await controlled.control(operation, currentCase); },
        beforeClose: transport ? async () => { observer = await observeTransactionCalls(events, transport); } : undefined }));
      await untilIdle(); addResult(profile.id, runtime, scenario, result, observer, fetchCount, controlRequests);
    }
  } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
}
async function buildWorker(profile, receipt) {
  const fixtureRoot = path.join(root, 'fixtures', profile.fixture);
  const req = createRequire(path.join(fixtureRoot, 'package.json'));
  const output = path.join(scratch, profile.id); fs.mkdirSync(output);
  const preset = req('@grpc/grpc-js/build').createGoogleWorkerBuild({ projectRoot: fixtureRoot, profile: profile.id,
    outdir: path.join(output, 'preset'), typescript: require('typescript') });
  const frozenSource = { name: 'transaction-errors-shared-source', setup(build) {
    build.onLoad({ filter: /datastore-transactions\.mjs$/ }, args => args.path === sharedPath
      ? { contents: sharedBytes, loader: 'js', resolveDir: fixtureRoot } : undefined);
    build.onResolve({ filter: /^@grpc\/grpc-js\/adapter$/ }, () => ({ path: req.resolve('@grpc/grpc-js/adapter') }));
  } };
  const built = await workerRequire('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/datastore-transactions.mjs'],
    bundle: true, platform: 'node', format: 'cjs', target: 'es2022', outfile: path.join(output, 'sdk.cjs'),
    plugins: [frozenSource, preset.plugin], metafile: true });
  const inputs = Object.keys(built.metafile.inputs);
  check(inputs.includes(`fixtures/${profile.fixture}/node_modules/@google-cloud/datastore/build/src/index.js`), 'TX_PINNED_WORKER_SDK');
  check(!inputs.some(file => file.startsWith(`fixtures/${profile.fixture === 'google' ? 'modern' : 'google'}/node_modules/`)), 'TX_WORKER_PROFILE_ISOLATION');
  for (const file of inputs.filter(file => file.includes('/node_modules/') && fs.existsSync(path.join(root, file)))) report.installedInputs[file] = hash(fs.readFileSync(path.join(root, file)));
  report.sources[`${profile.id}/workerd-grpc-web`] = report.sources[`${profile.id}/workerd-cloudflare`] = hash(sharedBytes);
  fs.writeFileSync(path.join(output, 'worker.mjs'), 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const config = path.join(output, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-datastore-transactions-local', main: path.join(output, 'worker.mjs'),
    compatibility_date: report.compatibilityDate, compatibility_flags: ['nodejs_compat'], workers_dev: false }));
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const name of Object.keys(environment)) if (/^(CF_|CLOUDFLARE_|WGA_)/.test(name)) delete environment[name];
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run',
    '--config', config, '--outdir', path.join(output, 'bundle'), '--no-autoconfig'], { env: environment, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(output, 'bundle/worker.js'), 'utf8'), manifest = preset.manifest();
  receipt.buildProfile = { name: manifest.profile, revision: manifest.revision, sha256: manifest.profileSha256, registrySha256: manifest.registrySha256 };
  receipt.bundleSha256 = hash(script); return script;
}
async function runWorkers(profile, script) {
  for (const mode of ['grpc-web', 'cloudflare']) {
    let fetchCount = 0, controlRequests = 0;
    worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script, log: new Log(LogLevel.NONE),
      compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'], bindings: { MODE: mode, PROFILE: profile.id },
      outboundService: async request => {
        try {
          if (request.url === 'https://datastore-transaction-control.invalid/await-commit') {
            check(request.method === 'POST' && request.headers.get('x-wga-case') === currentCase, 'TX_PROGRESS_CONTROL');
            controlRequests++; await controlled.control('await-commit', currentCase); return new Response(null, { status: 204 });
          }
          const { url, headers } = inspectRequest(request.url, { method: request.method, headers: request.headers }, mode); fetchCount++;
          for (const name of ['content-length', 'host', 'connection', 'transfer-encoding']) headers.delete(name);
          return await fetch(`http://127.0.0.1:${envoy.ports.workerd}${url.pathname}`, { method: 'POST', headers,
            body: Buffer.from(await request.arrayBuffer()), signal: request.signal });
        } catch (error) {
          boundaryErrors.push(error?.cause?.code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' ? 'TX_FORWARD_LENGTH'
            : error instanceof TypeError ? 'TX_FORWARD_TYPE_ERROR' : safe(error));
          return new Response('Synthetic fixture failure', { status: 500 });
        }
      },
    }));
    try {
      for (const scenario of scenarios) {
        const runtime = `workerd-${mode}`; stage = currentCase = `${profile.id}/${runtime}/${scenario}`;
        controlled.prepare(scenario, currentCase); const before = fetchCount, controlsBefore = controlRequests;
        const { response, body } = await bounded((async () => { const response = await worker.dispatchFetch(`https://fixture.test/${scenario}`); return { response, body: await response.json() }; })());
        check(response.status === 200 && body.status === 'passed', /^TX_[A-Z_]+$/.test(body.diagnostic) ? body.diagnostic : 'TX_WORKER_FAILURE');
        await untilIdle(); addResult(profile.id, runtime, scenario, body.result, body.observer, fetchCount - before, controlRequests - controlsBefore);
      }
    } finally { await bounded(worker.dispose(), 5000); worker = null; }
  }
}
async function main() {
  const sources = ['scripts/test-datastore-transactions.cjs', 'scripts/datastore-transaction-server.cjs', 'scripts/datastore-transaction-evidence.cjs',
    'fixtures/google/shared/datastore-transactions.mjs', 'fixtures/worker/datastore-transactions.mjs', 'scripts/emulator-envoy.cjs', 'fixtures/envoy/binary.json',
    ...['google', 'native', 'modern', 'modern-native', 'worker'].map(fixture => `fixtures/${fixture}/package-lock.json`),
    ...profiles.map(profile => `src/build/profiles/${profile.id}.json`)];
  report.evidence = Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  controlled = await createDatastoreTransactionServer();
  envoy = await startEmulatorEnvoy({ firestore: { port: controlled.port }, datastore: { port: controlled.port } });
  nativeTls = await createTransactionTlsProxy({ upstreamPort: envoy.ports.native, scratch });
  for (const profile of profiles) {
    const req = createRequire(path.join(root, 'fixtures', profile.fixture, 'package.json'));
    const native = createRequire(path.join(root, 'fixtures', profile.native, 'package.json'));
    const receipt = { id: profile.id, datastore: req('@google-cloud/datastore/package.json').version,
      nativeDatastore: native('@google-cloud/datastore/package.json').version, nativeGrpc: native('@grpc/grpc-js/package.json').version };
    check(receipt.datastore === profile.version && receipt.nativeDatastore === profile.version && receipt.nativeGrpc === '1.14.5', 'TX_PINNED_SDKS');
    report.profiles.push(receipt); await runNode(profile, 'native');
    if (!nativeOnly) {
      await runNode(profile, 'adapter-grpc-web'); await runNode(profile, 'adapter-cloudflare');
      stage = `${profile.id}/worker-build`; await runWorkers(profile, await buildWorker(profile, receipt));
    }
  }
  for (const [fixture, inputs] of [['google', report.installedInputs], ['modern', report.installedInputs], ['native', report.nativeInputs], ['modern-native', report.nativeInputs]]) {
    const prefix = path.join(root, `fixtures/${fixture}/node_modules/`);
    for (const file of Object.keys(require.cache).filter(file => file.startsWith(prefix))) inputs[path.relative(root, file)] = hash(fs.readFileSync(file));
    for (const name of ['@grpc/grpc-js', '@google-cloud/datastore', 'google-gax', 'google-auth-library']) {
      const file = path.join(prefix, name, 'package.json'); inputs[path.relative(root, file)] = hash(fs.readFileSync(file));
    }
    const schema = path.join(prefix, fixture.startsWith('modern') ? '@google-cloud/datastore-api/build/protos/protos.json' : '@google-cloud/datastore/build/protos/protos.json');
    inputs[path.relative(root, schema)] = hash(fs.readFileSync(schema));
  }
  for (const row of report.results.filter(row => row.runtime !== 'native')) {
    const baseline = report.results.find(item => item.profile === row.profile && item.runtime === 'native' && item.scenario === row.scenario);
    const businessRequests = requests => requests.map(({ http2ResetCode, responseSent, termination, cancelled, ...business }) => business);
    check(JSON.stringify(row.result) === JSON.stringify(baseline.result)
      && JSON.stringify(businessRequests(row.requests)) === JSON.stringify(businessRequests(baseline.requests)), 'TX_NATIVE_PARITY');
  }
  check(nativeTls.active.size === 0 && nativeTls.faults.length === 0, 'TX_NATIVE_TLS_IDLE');
  report.nativeTls = { calls: nativeTls.calls,
    temporaryCredentials: true, activeStreams: nativeTls.active.size, faults: [...nativeTls.faults], disposed: false };
  report.nativeBusinessEquivalent = !nativeOnly; report.resourcesCheckedBeforeClose = !nativeOnly;
  report.controlRequests = report.results.reduce((sum, row) => sum + row.controlRequests, 0);
  report.caseCount = report.results.length;
  report.rpcCount = report.results.reduce((sum, row) => sum + row.rpcCount, 0); report.fetchCount = report.results.reduce((sum, row) => sum + row.fetchCount, 0);
  check(report.caseCount === (nativeOnly ? 20 : 100) && report.rpcCount === (nativeOnly ? 94 : 470)
    && report.fetchCount === (nativeOnly ? 0 : 376), 'TX_AGGREGATE_COUNTS');
  report.status = nativeOnly ? 'native-development-only' : 'passed';
}
main().catch(error => { report.status = 'failed'; report.diagnostic = safe(error); report.failureStage = stage; process.exitCode = 1; }).finally(async () => {
  const cleanupFailures = [];
  for (const cleanup of [async () => { await worker?.dispose(); },
    async () => { await nativeTls?.close(); if (report.nativeTls) report.nativeTls.disposed = true; },
    async () => { if (envoy) { report.envoy = await envoy.stop(); report.wire = envoy.readAccess(); } },
    async () => { await controlled?.close(); }]) {
    try { await bounded(cleanup(), 5000); } catch { cleanupFailures.push('TX_CLEANUP_FAILURE'); }
  }
  report.peerFaults = controlled?.faults ?? []; report.boundaryErrors = boundaryErrors; report.asyncErrors = asyncErrors;
  report.runtimeDisposed = cleanupFailures.length === 0; report.cleanupFailures = cleanupFailures; report.finishedAt = new Date().toISOString();
  if (cleanupFailures.length) { report.status = 'failed'; report.diagnostic = 'TX_CLEANUP_FAILURE'; process.exitCode = 1; }
  if (report.status === 'passed') {
    try { require('./datastore-transaction-evidence.cjs').validateDatastoreTransactionReport(report); }
    catch (error) {
      report.status = 'failed'; report.diagnostic = 'TX_REPORT_INVALID'; report.failureStage = 'report-validation'; process.exitCode = 1;
      // This validator emits fixed contract descriptions, never report values
      // or payloads. Preserve that reason without exposing arbitrary exceptions.
      const prefix = 'WGA_EVIDENCE_INVALID: datastore-transactions ';
      if (typeof error?.message === 'string' && error.message.startsWith(prefix)) report.validationFailure = error.message.slice(prefix.length);
    }
  }
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/datastore-transactions.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, rpcCount: report.rpcCount,
    ...(report.status === 'failed' ? { diagnostic: report.diagnostic, stage: report.failureStage, peerFaults: report.peerFaults,
      ...(report.validationFailure ? { validationFailure: report.validationFailure } : {}) } : {}),
    report: 'verification/datastore-transactions.json' }));
  // A timed-out SDK operation can retain its own retry timers. All owned
  // processes/listeners above have received cleanup before exiting this failed
  // standalone harness; do not wait forever for abandoned client promises.
  if (report.status === 'failed') process.exit(1);
});
