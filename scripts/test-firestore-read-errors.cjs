'use strict';
process.env.GOOGLE_SDK_NODE_LOGGING = '';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { createFirestoreReadErrorServer } = require('./firestore-read-error-server.cjs');
const { startEmulatorEnvoy } = require('./emulator-envoy.cjs');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sharedPath = path.join(root, 'fixtures/google/shared/firestore-read-errors.mjs');
const sharedBytes = fs.readFileSync(sharedPath);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-firestore-read-errors-'));
const profiles = [
  { id: 'google-static-v1', fixture: 'google', native: 'native', version: '8.3.0' },
  { id: 'google-modern-v1', fixture: 'modern', native: 'modern-native', version: '9.2.0' },
];
const scenarios = ['batch-permanent-partial', 'batch-transient-before', 'batch-transient-partial',
  'query-get-permanent-partial', 'query-get-transient-before', 'query-get-transient-partial',
  'query-stream-permanent-partial', 'query-stream-transient-before', 'query-stream-transient-partial', 'query-stream-destroy'];
const nativeOnly = process.argv.includes('--native-only');
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild: false, nativeOnly,
  liveGoogle: false, cloudflareAutomaticConversion: false, officialEmulator: false, realEnvoy: true,
  controlledNativeGrpcServer: true, restFallback: false, adapterRetryEnabled: false,
  testInstrumentation: { method: 'Firestore.snapshot_', versions: ['8.3.0', '9.2.0'], originalInvoked: true, controlDataRpcSeparated: true },
  resourcesCheckedBeforeTerminate: false, sharedSha256: hash(sharedBytes), sources: {}, profiles: [], results: [],
  evidence: {}, installedInputs: {}, nativeInputs: {}, node: process.version,
  workerd: workerRequire('workerd/package.json').version, miniflare: workerRequire('miniflare/package.json').version,
  compatibilityDate: '2026-09-21' };
let stage = 'startup', controlled, envoy, worker, currentCase;
const boundaryErrors = [], asyncErrors = [];
process.on('unhandledRejection', () => { asyncErrors.push('READ_UNHANDLED_REJECTION'); process.exitCode = 1; });
for (const name of ['FIRESTORE_EMULATOR_HOST', 'DATASTORE_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT']) delete process.env[name];
function check(condition, diagnostic) { if (!condition) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic }); }
function safe(error) { return /^READ_[A-Z_]+$/.test(error?.fixtureDiagnostic) ? error.fixtureDiagnostic : 'READ_HARNESS_FAILURE'; }
async function bounded(promise, milliseconds = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('READ_CASE_TIMEOUT'), { fixtureDiagnostic: 'READ_CASE_TIMEOUT' })), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function untilIdle() {
  for (let turn = 0; turn < 200 && controlled.active.size; turn++) await new Promise(resolve => setTimeout(resolve, 5));
  check(controlled.active.size === 0, 'READ_BACKEND_IDLE');
}
function inspectRequest(input, init, mode) {
  const url = new URL(input), headers = new Headers(init.headers);
  check(url.origin === (mode === 'cloudflare' ? 'https://firestore.googleapis.com' : 'https://firestore-read-gateway.invalid'), 'READ_EXACT_OUTBOUND_ORIGIN');
  check(['/google.firestore.v1.Firestore/BatchGetDocuments', '/google.firestore.v1.Firestore/RunQuery'].includes(url.pathname), 'READ_EXACT_OUTBOUND_METHOD');
  check(init.method === 'POST' && headers.get('content-type') === (mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto'), 'READ_GRPC_WEB_WIRE');
  check(headers.get('authorization') === null, 'READ_EXPLICIT_ANONYMOUS_AUTH');
  headers.set('x-wga-invocation', currentCase);
  return { url, headers };
}
function addResult(profile, runtime, scenario, result, observer, fetchCount, controlRequests) {
  const caseId = `${profile}/${runtime}/${scenario}`;
  const calls = controlled.arrivals.filter(call => call.caseId === caseId).map(({ caseId: _caseId, ...rest }) => rest);
  const expected = scenario.includes('permanent') || scenario === 'query-stream-destroy' ? 2 : 3;
  check(calls.length === expected && calls.at(-1).request.documents?.[0] === 'marker', 'READ_EXACT_RPC_COUNT');
  check(fetchCount === (runtime === 'native' ? 0 : expected), 'READ_EXACT_FETCH_COUNT');
  check(controlRequests === (scenario.endsWith('partial') || scenario === 'query-stream-destroy' ? 1 : 0), 'READ_CONTROL_COUNT');
  check(controlled.faults.length === 0 && boundaryErrors.length === 0 && asyncErrors.length === 0, 'READ_HARNESS_ASSERTIONS');
  if (observer) {
    check(observer.calls.length === expected && observer.calls.every((call, index) => call.statusCode === calls[index].statusCode), 'READ_OBSERVER_STATUS');
  }
  report.results.push({ profile, runtime, scenario, status: 'passed', rpcCount: calls.length, fetchCount, controlRequests,
    requests: calls, result, observer, backendIdleBeforeNextCase: controlled.active.size === 0 });
}
async function runNode(profile, runtime) {
  const fixture = path.join(root, 'fixtures', runtime === 'native' ? profile.native : profile.fixture);
  const req = createRequire(path.join(fixture, 'package.json'));
  const consumer = fs.mkdtempSync(path.join(fixture, '.read-errors-'));
  try {
    const copied = path.join(consumer, 'firestore-read-errors.mjs'); fs.writeFileSync(copied, sharedBytes);
    report.sources[`${profile.id}/${runtime}`] = hash(fs.readFileSync(copied));
    const { runFirestoreReadErrors, observeReadCalls } = await import(pathToFileURL(copied).href);
    const grpc = req('@grpc/grpc-js');
    for (const scenario of scenarios) {
      stage = currentCase = `${profile.id}/${runtime}/${scenario}`;
      controlled.prepare(scenario, currentCase);
      const events = []; let fetchCount = 0, controlRequests = 0, observer = null;
      const mode = runtime.slice('adapter-'.length);
      const transport = runtime === 'native' ? null : req('@grpc/grpc-js/adapter').createWorkersGrpcTransport({
        observer: event => events.push(event),
        ...(mode === 'cloudflare' ? { mode } : { mode, endpoints: { 'firestore.googleapis.com': 'https://firestore-read-gateway.invalid' } }),
        fetcher: { async fetch(input, init) {
          const { url, headers } = inspectRequest(input, init, mode); fetchCount++;
          return fetch(`http://127.0.0.1:${envoy.ports.replacement}${url.pathname}`, { ...init, headers, cf: undefined });
        } },
      });
      const options = transport ? transport.gaxOptions({ projectId: 'demo-wga-read-errors' })
        : { projectId: 'demo-wga-read-errors', host: `127.0.0.1:${envoy.ports.native}`, sslCreds: grpc.credentials.createInsecure() };
      const result = await bounded(runFirestoreReadErrors({ options, scenario, caseId: currentCase,
        advanceProgress: async () => { controlRequests++; controlled.advanceProgress(currentCase); },
        beforeTerminate: transport ? async () => { observer = await observeReadCalls(events, transport); } : undefined }));
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
  const frozenSource = { name: 'read-errors-shared-source', setup(build) {
    build.onLoad({ filter: /firestore-read-errors\.mjs$/ }, args => args.path === sharedPath
      ? { contents: sharedBytes, loader: 'js', resolveDir: fixtureRoot } : undefined);
    build.onResolve({ filter: /^@grpc\/grpc-js\/adapter$/ }, () => ({ path: req.resolve('@grpc/grpc-js/adapter') }));
  } };
  const built = await workerRequire('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/firestore-read-errors.mjs'],
    bundle: true, platform: 'node', format: 'cjs', target: 'es2022', outfile: path.join(output, 'sdk.cjs'),
    plugins: [frozenSource, preset.plugin], metafile: true });
  const inputs = Object.keys(built.metafile.inputs);
  check(inputs.includes(`fixtures/${profile.fixture}/node_modules/@google-cloud/firestore/build/src/index.js`), 'READ_PINNED_WORKER_SDK');
  check(!inputs.some(file => file.startsWith(`fixtures/${profile.fixture === 'google' ? 'modern' : 'google'}/node_modules/`)), 'READ_WORKER_PROFILE_ISOLATION');
  for (const file of inputs.filter(file => file.includes('/node_modules/') && fs.existsSync(path.join(root, file)))) report.installedInputs[file] = hash(fs.readFileSync(path.join(root, file)));
  report.sources[`${profile.id}/workerd-grpc-web`] = report.sources[`${profile.id}/workerd-cloudflare`] = hash(sharedBytes);
  fs.writeFileSync(path.join(output, 'worker.mjs'), 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const config = path.join(output, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-firestore-read-errors-local', main: path.join(output, 'worker.mjs'),
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
          if (request.url === 'https://firestore-read-control.invalid/progress') {
            check(request.method === 'POST' && request.headers.get('x-wga-case') === currentCase, 'READ_PROGRESS_CONTROL');
            controlRequests++; controlled.advanceProgress(currentCase); return new Response(null, { status: 204 });
          }
          const { url, headers } = inspectRequest(request.url, { method: request.method, headers: request.headers }, mode); fetchCount++;
          for (const name of ['content-length', 'host', 'connection', 'transfer-encoding']) headers.delete(name);
          return await fetch(`http://127.0.0.1:${envoy.ports.workerd}${url.pathname}`, { method: 'POST', headers,
            body: Buffer.from(await request.arrayBuffer()), signal: request.signal });
        } catch (error) {
          boundaryErrors.push(error?.cause?.code === 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH' ? 'READ_FORWARD_LENGTH'
            : error instanceof TypeError ? 'READ_FORWARD_TYPE_ERROR' : safe(error));
          return new Response('Synthetic fixture failure', { status: 500 });
        }
      },
    }));
    try {
      for (const scenario of scenarios) {
        const runtime = `workerd-${mode}`; stage = currentCase = `${profile.id}/${runtime}/${scenario}`;
        controlled.prepare(scenario, currentCase); const before = fetchCount, controlsBefore = controlRequests;
        const { response, body } = await bounded((async () => { const response = await worker.dispatchFetch(`https://fixture.test/${scenario}`); return { response, body: await response.json() }; })());
        check(response.status === 200 && body.status === 'passed', /^READ_[A-Z_]+$/.test(body.diagnostic) ? body.diagnostic : 'READ_WORKER_FAILURE');
        await untilIdle(); addResult(profile.id, runtime, scenario, body.result, body.observer, fetchCount - before, controlRequests - controlsBefore);
      }
    } finally { await bounded(worker.dispose(), 5000); worker = null; }
  }
}
async function main() {
  const sources = ['scripts/test-firestore-read-errors.cjs', 'scripts/firestore-read-error-server.cjs', 'scripts/firestore-read-evidence.cjs',
    'fixtures/google/shared/firestore-read-errors.mjs', 'fixtures/worker/firestore-read-errors.mjs', 'scripts/emulator-envoy.cjs', 'fixtures/envoy/binary.json',
    ...['google', 'native', 'modern', 'modern-native', 'worker'].map(fixture => `fixtures/${fixture}/package-lock.json`),
    ...profiles.map(profile => `src/build/profiles/${profile.id}.json`)];
  report.evidence = Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  controlled = await createFirestoreReadErrorServer();
  envoy = await startEmulatorEnvoy({ firestore: { port: controlled.port }, datastore: { port: controlled.port } });
  for (const profile of profiles) {
    const req = createRequire(path.join(root, 'fixtures', profile.fixture, 'package.json'));
    const native = createRequire(path.join(root, 'fixtures', profile.native, 'package.json'));
    const receipt = { id: profile.id, firestore: req('@google-cloud/firestore/package.json').version,
      nativeFirestore: native('@google-cloud/firestore/package.json').version, nativeGrpc: native('@grpc/grpc-js/package.json').version };
    check(receipt.firestore === profile.version && receipt.nativeFirestore === profile.version && receipt.nativeGrpc === '1.14.5', 'READ_PINNED_SDKS');
    report.profiles.push(receipt); await runNode(profile, 'native');
    if (!nativeOnly) {
      await runNode(profile, 'adapter-grpc-web'); await runNode(profile, 'adapter-cloudflare');
      stage = `${profile.id}/worker-build`; await runWorkers(profile, await buildWorker(profile, receipt));
    }
  }
  for (const [fixture, inputs] of [['google', report.installedInputs], ['modern', report.installedInputs], ['native', report.nativeInputs], ['modern-native', report.nativeInputs]]) {
    const prefix = path.join(root, `fixtures/${fixture}/node_modules/`);
    for (const file of Object.keys(require.cache).filter(file => file.startsWith(prefix))) inputs[path.relative(root, file)] = hash(fs.readFileSync(file));
    for (const name of ['@grpc/grpc-js', '@google-cloud/firestore', 'google-gax', 'google-auth-library', ...fixture.includes('modern') ? ['@google-cloud/firestore-api'] : []]) {
      const file = path.join(prefix, name, 'package.json'); inputs[path.relative(root, file)] = hash(fs.readFileSync(file));
    }
    const schema = path.join(prefix, fixture.includes('modern') ? '@google-cloud/firestore-api/build/protos/protos.json' : '@google-cloud/firestore/build/protos/v1.json');
    inputs[path.relative(root, schema)] = hash(fs.readFileSync(schema));
  }
  for (const row of report.results.filter(row => row.runtime !== 'native')) {
    const baseline = report.results.find(item => item.profile === row.profile && item.runtime === 'native' && item.scenario === row.scenario);
    check(JSON.stringify(row.result) === JSON.stringify(baseline.result) && JSON.stringify(row.requests) === JSON.stringify(baseline.requests), 'READ_NATIVE_PARITY');
  }
  report.nativeBusinessEquivalent = !nativeOnly; report.resourcesCheckedBeforeTerminate = !nativeOnly;
  report.controlRequests = report.results.reduce((sum, row) => sum + row.controlRequests, 0);
  report.caseCount = report.results.length;
  report.rpcCount = report.results.reduce((sum, row) => sum + row.rpcCount, 0); report.fetchCount = report.results.reduce((sum, row) => sum + row.fetchCount, 0);
  check(report.caseCount === (nativeOnly ? 20 : 100) && report.rpcCount === (nativeOnly ? 52 : 260)
    && report.fetchCount === (nativeOnly ? 0 : 208), 'READ_AGGREGATE_COUNTS');
  report.status = nativeOnly ? 'native-development-only' : 'passed';
}
main().catch(error => { report.status = 'failed'; report.diagnostic = safe(error); report.failureStage = stage; process.exitCode = 1; }).finally(async () => {
  const cleanupFailures = [];
  for (const cleanup of [async () => { await worker?.dispose(); },
    async () => { if (envoy) { report.envoy = await envoy.stop(); report.wire = envoy.readAccess(); } },
    async () => { await controlled?.close(); }]) {
    try { await bounded(cleanup(), 5000); } catch { cleanupFailures.push('READ_CLEANUP_FAILURE'); }
  }
  report.peerFaults = controlled?.faults ?? []; report.boundaryErrors = boundaryErrors; report.asyncErrors = asyncErrors;
  report.runtimeDisposed = cleanupFailures.length === 0; report.cleanupFailures = cleanupFailures; report.finishedAt = new Date().toISOString();
  if (cleanupFailures.length) { report.status = 'failed'; report.diagnostic = 'READ_CLEANUP_FAILURE'; process.exitCode = 1; }
  if (report.status === 'passed') {
    try { require('./firestore-read-evidence.cjs').validateFirestoreReadReport(report); }
    catch { report.status = 'failed'; report.diagnostic = 'READ_REPORT_INVALID'; report.failureStage = 'report-validation'; process.exitCode = 1; }
  }
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/firestore-read-errors.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, rpcCount: report.rpcCount,
    ...(report.status === 'failed' ? { diagnostic: report.diagnostic, stage: report.failureStage, peerFaults: report.peerFaults } : {}),
    report: 'verification/firestore-read-errors.json' }));
  // A timed-out SDK operation can retain its own retry timers. All owned
  // processes/listeners above have received cleanup before exiting this failed
  // standalone harness; do not wait forever for abandoned client promises.
  if (report.status === 'failed') process.exit(1);
});
