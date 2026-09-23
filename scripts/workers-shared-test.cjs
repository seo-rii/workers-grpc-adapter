'use strict';
// Exact business sources run through native grpc-js and through the packed alias in workerd.
// The HTTP/2 bridge is controlled test infrastructure; it does not emulate Google's backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http2 = require('node:http2');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const esbuild = workerRequire('esbuild');
const { createGoogleWorkerBuild } = googleRequire('@grpc/grpc-js/build');
const { createControlledServer } = require('./google-controlled-server.cjs');
const { encodeFrame } = require('../dist/wire.js');
const digest = value => createHash('sha256').update(value).digest('hex');
const compatibilityDate = '2026-09-21';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-shared-worker-'));
const report = {
  startedAt: new Date().toISOString(), status: 'running',
  scope: 'same business sources in native Node and alias workerd against controlled native grpc-js loopback server',
  runtimeExecuted: false, liveCloud: false, liveGoogle: false, cloudflareTranslation: false,
  sameSharedFiles: false, equivalent: false, compatibilityDate,
  runtime: { node: process.version, miniflare: workerRequire('miniflare/package.json').version, workerd: workerRequire('workerd/package.json').version, wrangler: workerRequire('wrangler/package.json').version, esbuild: esbuild.version },
  sourceHashes: {}, native: [], workerd: [], requests: [], checks: [], transactionEvidence: [],
};
function wranglerBundle(entry) {
  const config = path.join(temporary, 'wrangler.jsonc');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-shared-fixture', main: entry, compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config, '--outdir', path.join(temporary, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  return fs.readFileSync(path.join(temporary, 'bundle', 'worker.js'), 'utf8');
}
async function bridgeRequest(request, nativePort, sessions, record) {
  // Retain native gRPC framing and convert only terminal HTTP/2 trailers to grpc-web.
  const bytes = Buffer.from(await request.arrayBuffer());
  record.requestSha256 = digest(bytes);
  record.status = null;
  record.statusSource = 'no-upstream-terminal-status-observed';
  return new Promise((resolve, reject) => {
    const session = http2.connect(`http://127.0.0.1:${nativePort}`);
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
    session.on('error', reject);
    const headers = Object.fromEntries([...request.headers].filter(([name]) => !['host', 'content-length', 'connection'].includes(name)));
    const call = session.request({ ...headers, ':method': 'POST', ':path': new URL(request.url).pathname, 'content-type': 'application/grpc', te: 'trailers' });
    const chunks = [];
    let trailers;
    const abort = () => {
      record.cancelled = true;
      call.close(http2.constants.NGHTTP2_CANCEL);
      session.destroy();
      reject(new Error('Worker cancelled its controlled bridge request'));
    };
    const detach = () => request.signal.removeEventListener('abort', abort);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) { abort(); return; }
    call.on('response', headers => {
      record.httpStatus = headers[':status'];
      if (headers['grpc-status'] !== undefined) trailers = headers;
    });
    call.on('data', chunk => chunks.push(chunk));
    call.on('trailers', headers => { trailers = headers; });
    call.on('error', error => { detach(); session.destroy(); reject(error); });
    call.on('end', () => {
      detach();
      try {
        assert.ok(trailers, 'Native response omitted gRPC trailers');
        record.status = Number(trailers['grpc-status']);
        record.statusSource = 'observed-upstream-http2-grpc-status';
        assert.ok(Number.isInteger(record.status));
        const terminal = Object.entries(trailers).filter(([name]) => !name.startsWith(':')).map(([name, value]) => `${name}: ${value}\r\n`).join('');
        chunks.push(encodeFrame(Buffer.from(terminal), true));
        resolve(new Response(Buffer.concat(chunks), { headers: { 'content-type': 'application/grpc-web+proto' } }));
      } catch (error) { reject(error); }
      finally { session.close(); }
    });
    call.end(bytes);
  });
}
function normalizeArrivals(arrivals) {
  return arrivals.map(({ method, status, requestContentType, fault, expectedClientStatus }) => ({
    method,
    // The fixture's withheld-response annotation describes an expected client
    // deadline. Only bridgeRequest records a status actually received on wire.
    ...(fault === 'commit-applied-response-withheld'
      ? { status: null, expectedClientStatus, applicationResponseWithheld: true }
      : { status }),
    requestContentType, ...(fault ? { fault } : {}),
  }));
}
function verifyTransactionTrace(runtime, suite, arrivals, requests) {
  const cases = {
    'datastore-aborted': { commits: 3, requests: 7, fault: 'aborted-before-apply', clientStatus: 10 },
    'datastore-commit-response-lost': { commits: 3, requests: 7, fault: 'commit-applied-response-withheld', clientStatus: 4 },
    'firestore-aborted-retry': { commits: 4, requests: 8, fault: 'aborted-before-apply', clientStatus: 10 },
  };
  const expected = cases[suite];
  if (!expected) return;
  const faults = arrivals.filter(item => item.fault);
  assert.equal(faults.length, 1, `${runtime}/${suite}: exactly one injected fault`);
  assert.equal(faults[0].fault, expected.fault);
  assert.equal(faults[0].expectedClientStatus ?? faults[0].status, expected.clientStatus);
  const commits = arrivals.filter(item => item.method.endsWith('/Commit'));
  assert.equal(commits.length, expected.commits, `${runtime}/${suite}: unexpected Commit retry`);
  assert.equal(arrivals.length, expected.requests, `${runtime}/${suite}: unexpected RPC`);
  assert.equal(arrivals.filter(item => item.method.endsWith('/Rollback')).length, 1, `${runtime}/${suite}: exactly one SDK rollback`);
  assert.equal(arrivals.at(-1).method, commits[0].method, `${runtime}/${suite}: missing cleanup Commit`);
  assert.equal(arrivals.at(-1).status, 0, `${runtime}/${suite}: cleanup failed`);
  if (requests) {
    assert.equal(requests.length, arrivals.length, `${runtime}/${suite}: adapter issued extra requests`);
    assert.deepEqual(requests.map(item => item.method), arrivals.map(item => item.method));
  }
  const wireFault = requests?.[arrivals.findIndex(item => item.fault)];
  report.transactionEvidence.push({
    runtime, suite, injectedFaults: faults.length, commitCount: commits.length, rollbackCount: 1,
    serverArrivals: arrivals.length, grpcWebRequests: requests?.length ?? null,
    fault: expected.fault, expectedClientStatus: expected.clientStatus,
    applicationResponseWithheld: faults[0].applicationResponseWithheld === true,
    observedUpstreamStatus: wireFault?.status ?? null,
    upstreamStatusSource: wireFault?.statusSource ?? 'native-client-only',
  });
}
async function nativeBaseline(controlled, sourceFiles) {
  const consumer = fs.mkdtempSync(path.join(root, 'fixtures/native/.shared-consumer-'));
  const implementation = nativeRequire('@grpc/grpc-js');
  report.nativeGrpcVersion = nativeRequire('@grpc/grpc-js/package.json').version;
  try {
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"type":"module"}\n');
    report.sourceHashes.native = {};
    for (const file of sourceFiles) {
      const bytes = fs.readFileSync(path.join(root, 'fixtures/google/shared', file));
      fs.writeFileSync(path.join(consumer, file), bytes);
      report.sourceHashes.native[file] = digest(fs.readFileSync(path.join(consumer, file)));
    }
    const { controlledSuites } = await import(pathToFileURL(path.join(consumer, 'controlled-suites.mjs')).href);
    controlled.reset();
    const start = controlled.arrivals.length;
    for (const { sdk, suite, run, workerdOnly } of controlledSuites) {
      if (workerdOnly) continue;
      const options = { projectId: 'wga-local-test', sslCreds: implementation.credentials.createInsecure() };
      if (sdk === '@google-cloud/datastore') options.apiEndpoint = `127.0.0.1:${controlled.nativePort}`;
      if (sdk === '@google-cloud/firestore') options.host = `127.0.0.1:${controlled.nativePort}`;
      if (sdk === '@google-cloud/secret-manager') Object.assign(options, { apiEndpoint: '127.0.0.1', port: controlled.nativePort });
      const before = controlled.arrivals.length;
      const checks = await run({ options, allowedProjectId: 'wga-local-test', allowWrites: true, runId: '8577e274-468c-4180-becf-63292be12c29', secretName: 'projects/wga-local-test/secrets/metadata' });
      const serverArrivals = normalizeArrivals(controlled.arrivals.slice(before));
      verifyTransactionTrace('native', suite, serverArrivals);
      report.native.push({ sdk, suite, status: 'passed', checks, serverArrivals });
    }
    report.nativeArrivals = normalizeArrivals(controlled.arrivals.slice(start));
  } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
}
async function main() {
  const preset = createGoogleWorkerBuild({ projectRoot: path.join(root, 'fixtures/google'), outdir: path.join(temporary, 'preset'), typescript: require('typescript') });
  const built = await esbuild.build({ entryPoints: [path.join(root, 'fixtures/google/shared-worker.mjs')], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin], metafile: true });
  const sourceFiles = Object.keys(built.metafile.inputs).map(file => path.resolve(file)).filter(file => path.dirname(file) === path.join(root, 'fixtures/google/shared')).map(file => path.basename(file)).sort();
  for (const required of ['assert.mjs', 'datastore.mjs', 'firestore.mjs', 'secret-manager.mjs', 'local-streams.mjs', 'local-errors.mjs', 'local-transactions.mjs', 'controlled-suites.mjs']) assert.ok(sourceFiles.includes(required), `Shared source missing from Worker bundle: ${required}`);
  report.sourceHashes.workerd = Object.fromEntries(sourceFiles.map(file => [file, digest(fs.readFileSync(path.join(root, 'fixtures/google/shared', file)))]));
  const entry = path.join(temporary, 'worker.mjs');
  fs.writeFileSync(entry, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const script = wranglerBundle(entry);
  report.build = preset.manifest();
  report.dependencyVersions = {};
  const tracked = ['@google-cloud/datastore', '@google-cloud/firestore', '@google-cloud/secret-manager', 'google-gax', 'google-auth-library', 'protobufjs', '@grpc/proto-loader', '@grpc/grpc-js'];
  for (const [runtime, fixture] of [['native', 'native'], ['workerd', 'google']]) {
    const base = path.join(root, 'fixtures', fixture);
    const lock = JSON.parse(fs.readFileSync(path.join(base, 'package-lock.json'), 'utf8'));
    report.dependencyVersions[runtime] = Object.keys(lock.packages).filter(file => tracked.some(name => file.endsWith('node_modules/' + name))).sort().map(file => {
      const { name, version } = JSON.parse(fs.readFileSync(path.join(base, file, 'package.json'), 'utf8'));
      return { path: file, name, version };
    });
  }
  report.bundle = { bytes: Buffer.byteLength(script), gzipBytes: require('node:zlib').gzipSync(script).byteLength, sha256: digest(script) };
  report.evidence = Object.fromEntries(['scripts/workers-shared-test.cjs', 'scripts/google-controlled-server.cjs', 'fixtures/google/shared-worker.mjs', 'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const controlled = await createControlledServer();
  const sessions = new Set();
  let worker;
  try {
    await nativeBaseline(controlled, sourceFiles);
    assert.deepEqual(report.sourceHashes.native, report.sourceHashes.workerd);
    report.sameSharedFiles = true;
    let invocation;
    worker = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService: request => {
      const method = new URL(request.url).pathname;
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('content-type'), 'application/grpc-web+proto');
      assert.equal(request.headers.get('authorization'), `Bearer fixture-shared-${invocation}`);
      const record = { invocation, method, contentType: request.headers.get('content-type'), authorizationSha256: digest(request.headers.get('authorization')) };
      report.requests.push(record);
      return bridgeRequest(request, controlled.nativePort, sessions, record);
    } }));
    for (invocation of ['first', 'second']) {
      controlled.reset();
      const start = controlled.arrivals.length, wireStart = report.requests.length;
      const response = await worker.dispatchFetch(`https://fixture.test/${invocation}`);
      const body = await response.text();
      let result;
      try { result = JSON.parse(body); }
      catch { throw new Error(`Worker response ${response.status}: ${body.slice(0, 1500)}`); }
      report.runtimeExecuted = true;
      report.workerd.push({ invocation, httpStatus: response.status, ...result, serverArrivals: normalizeArrivals(controlled.arrivals.slice(start)), grpcWebRequests: report.requests.length - wireStart });
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.status, 'passed');
      const expected = report.native.map(({ serverArrivals, ...result }) => result);
      const comparable = result.results.filter(item => item.suite !== 'firestore-listen-unsupported');
      assert.deepEqual(comparable, expected, `Business result mismatch in ${invocation}`);
      assert.deepEqual(normalizeArrivals(controlled.arrivals.slice(start)), report.nativeArrivals, `Native RPC sequence/status mismatch in ${invocation}`);
      const workerArrivals = normalizeArrivals(controlled.arrivals.slice(start));
      const workerRequests = report.requests.slice(wireStart);
      assert.equal(workerRequests.length, workerArrivals.length, 'Adapter must issue exactly one outbound request per native arrival');
      assert.equal(workerRequests.length, report.nativeArrivals.length, 'Unsupported Listen must not issue network requests');
      let offset = 0;
      for (const baseline of report.native) {
        const end = offset + baseline.serverArrivals.length;
        verifyTransactionTrace(`workerd-${invocation}`, baseline.suite, workerArrivals.slice(offset, end), workerRequests.slice(offset, end));
        offset = end;
      }
      assert.equal(offset, workerRequests.length, 'Unaccounted outbound requests');
      assert.ok(result.results.find(item => item.suite === 'firestore-listen-unsupported')?.checks.includes('zero-network'));
      assert.ok(!report.requests.some(item => item.method.endsWith('/Listen')));
    }
    assert.equal(new Set(report.requests.map(item => item.authorizationSha256)).size, 2);
    const terminalCodes = [...new Set(report.requests.filter(item => item.status !== null).map(item => item.status))];
    for (const code of [0, 5, 7, 10]) assert.ok(terminalCodes.includes(code), `Missing gRPC terminal status ${code}`);
    assert.ok(report.nativeArrivals.some(item => item.expectedClientStatus === 4 && item.status === null && item.applicationResponseWithheld));
    assert.equal(report.requests.length, report.nativeArrivals.length * report.workerd.length);
    assert.equal(report.requests.length, 104, 'Pinned shared suite must issue exactly 104 outbound RPCs');
    report.equivalent = true;
    report.status = 'passed';
    report.checks = ['exact-shared-source-sha256', 'native-node-baseline', 'actual-workerd-execution', 'all-five-business-suites', 'datastore-stream-events-and-early-destroy', 'firestore-getAll-order-and-missing', 'firestore-listen-unimplemented-zero-network', 'not-found-and-permission-denied-details', 'native-rpc-sequence-and-status-equivalence', 'two-incoming-requests', 'credential-isolation', 'only-grpc-web-protobuf', 'packed-public-build-preset', 'datastore-aborted-no-application-retry', 'datastore-lost-commit-response-retains-applied-state', 'firestore-aborted-exactly-one-sdk-retry', 'exactly-one-fault-per-transaction-suite', 'transaction-commit-counts-3-3-4', 'no-extra-adapter-rpc', 'observed-versus-injected-status-evidence'];
  } finally {
    for (const session of sessions) session.destroy();
    await worker?.dispose();
    controlled.server.forceShutdown();
  }
}
main().catch(error => {
  report.status = 'failed';
  report.error = { code: error.code ?? null, class: error.constructor?.name || 'Error', message: error.message, stack: error.stack };
  process.exitCode = 1;
}).finally(() => {
  report.completedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-shared.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, runtimeExecuted: report.runtimeExecuted, nativeSuites: report.native.length, workerInvocations: report.workerd.length, requests: report.requests.length, error: report.error }));
});
