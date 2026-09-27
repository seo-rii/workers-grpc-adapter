'use strict';
// Controlled native grpc-js responses; never accesses Google or real secrets.
// Disable SDK response logging before loading any SDK or logging module.
process.env.GOOGLE_SDK_NODE_LOGGING = '';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildGoogleWorker } = require('./build-google-worker.cjs');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const loader = nativeRequire('@grpc/proto-loader');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', startedAt: new Date().toISOString(), liveGoogle: false,
  cloudflareTranslation: false, officialEmulator: false, controlledNativeGrpcServer: true,
  scope: 'Pinned SDK list pagination and synthetic AccessSecretVersion responses; no Google IAM, live secret or edge-conversion certification',
  payloadsRecorded: false, sdkValidatesChecksum: false, consumerChecksumValidationTested: true,
  sameSharedSource: false, sourceHashes: {}, runtime: process.version,
  nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version,
  sdkVersion: nativeRequire('@google-cloud/secret-manager/package.json').version, results: [], checks: [] };
let stage = 'initialization';
const failures = [];
// Some generated SDK initialize() paths rethrow independently of the returned
// call promise. Record only a fixed id if setup fails, never a raw exception.
process.on('unhandledRejection', () => { failures.push('sm-unhandled-rejection'); process.exitCode = 1; });

function invariant(condition, id) {
  if (!condition) throw Object.assign(new Error(`sm-${id}`), { code: 'WGA_FIXTURE_ASSERTION' });
}
function safeError(error) {
  return error?.code === 'WGA_FIXTURE_ASSERTION' && /^sm-[a-z0-9-]+$/.test(error.message)
    ? error.message : 'sm-unexpected-failure';
}
function trailer(headers) {
  const bytes = Buffer.from(Object.entries(headers).filter(([key]) => !key.startsWith(':'))
    .map(([key, value]) => `${key}: ${value}\r\n`).join(''));
  const prefix = Buffer.alloc(5);
  prefix[0] = 128;
  prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}
function bounded(promise, timeoutMs = 15000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('sm-scenario-timeout'), { code: 'WGA_FIXTURE_ASSERTION' })), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

async function main() {
  invariant(report.sdkVersion === '7.1.0' && googleRequire('@google-cloud/secret-manager/package.json').version === report.sdkVersion,
    'pinned-sdk-version');
  report.evidence = Object.fromEntries(['scripts/test-secret-manager-extended.cjs', 'fixtures/google/secret-manager-worker.mjs',
    'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json']
    .map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const shared = await import(pathToFileURL(path.join(root, 'fixtures/google/shared/secret-manager-extended.mjs')).href);
  const { secretManagerScenarios: scenarios, secretManagerParent: parent, secretManagerVersion: version,
    syntheticPayload, crc32c } = shared;
  invariant(crc32c(new TextEncoder().encode('123456789')) === 0xe3069283 && crc32c(new Uint8Array()) === 0, 'backend-checksum-reference-vector');
  const states = new Map();
  const proto = path.join(path.dirname(nativeRequire.resolve('@google-cloud/secret-manager/package.json')), 'build/protos/protos.json');
  const packages = native.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(proto)),
    { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
  const server = new native.Server();
  const sessions = new Set();
  let bridge, temporary;
  function requestState(call, method, key) {
    const state = states.get(call.metadata.get('x-wga-case')[0]);
    invariant(state, 'known-case');
    const resource = call.request[key];
    invariant(call.metadata.get('x-goog-request-params')[0] === `${key}=${encodeURIComponent(resource)}`, 'resource-routing-metadata');
    invariant(call.metadata.get('x-goog-user-project')[0] === 'wga-billing-fixture', 'quota-project-metadata');
    if (!['native', 'adapter'].includes(state.runtime)) invariant(call.metadata.get('authorization')[0] === 'Bearer secret-manager-local-fixture', 'oauth-metadata');
    invariant(String(call.metadata.get('x-goog-api-client')[0]).includes('gapic/7.1.0'), 'sdk-client-metadata');
    state.trace.push({ method, ...(method === 'ListSecrets' ? { pageToken: call.request.pageToken } : {}) });
    return state;
  }
  function fail(callback, error) {
    failures.push(safeError(error));
    callback({ code: native.status.INTERNAL, details: 'synthetic-fixture-invariant-failed' });
  }
  try {
    stage = 'native-service-initialization';
    server.addService(packages.google.cloud.secretmanager.v1.SecretManagerService.service, {
      listSecrets(call, callback) {
        try {
          const state = requestState(call, 'ListSecrets', 'parent');
          invariant(call.request.parent === parent && call.request.pageSize === 2
            && call.request.filter === 'labels.fixture=synthetic', 'list-request-fields');
          const page = state.trace.filter(item => item.method === 'ListSecrets').length - 1;
          invariant(page < 3, 'bounded-list-pages');
          invariant(call.request.pageToken === (page === 0 ? '' : `page-${page}`), 'list-page-token-order');
          callback(null, { secrets: [page * 2, page * 2 + 1].map(index => ({
            name: `${parent}/secrets/item-${index}`, labels: { fixture: 'synthetic' }, replication: { automatic: {} },
          })), nextPageToken: page === 2 ? '' : `page-${page + 1}`, totalSize: 6 });
        } catch (error) { fail(callback, error); }
      },
      getSecret(call, callback) {
        try {
          requestState(call, 'GetSecret', 'name');
          invariant(call.request.name === `${parent}/secrets/marker`, 'marker-resource');
          callback(null, { name: call.request.name, labels: { fixture: 'synthetic' }, replication: { automatic: {} } });
        } catch (error) { fail(callback, error); }
      },
      accessSecretVersion(call, callback) {
        try {
          const state = requestState(call, 'AccessSecretVersion', 'name');
          invariant(call.request.name === version, 'access-resource');
          if (['access-not-found', 'access-denied'].includes(state.scenario)) {
            const metadata = new native.Metadata();
            metadata.set('x-wga-result', 'synthetic-error');
            metadata.set('x-wga-result-bin', Buffer.from([0, 255, 128, 10]));
            callback({ code: state.scenario === 'access-not-found' ? native.status.NOT_FOUND : native.status.PERMISSION_DENIED,
              details: 'synthetic error: 한글 % value', metadata });
            return;
          }
          const size = state.scenario === 'access-callback' ? 65536 : state.scenario === 'access-empty' ? 0
            : state.scenario === 'access-bad-crc' ? 257 : 1024;
          const data = syntheticPayload(size);
          const checksum = crc32c(data);
          callback(null, { name: version, payload: { data: Buffer.from(data),
            dataCrc32c: String(state.scenario === 'access-bad-crc' ? (checksum ^ 1) >>> 0 : checksum) } });
        } catch (error) { fail(callback, error); }
      },
    });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(),
      (error, value) => error ? reject(error) : resolve(value)));
    let grpcWebRequests = 0;
    stage = 'bridge-initialization';
    bridge = http.createServer((request, response) => {
      const contentType = request.headers['content-type'];
      if (request.method !== 'POST' || !['application/grpc-web', 'application/grpc-web+proto'].includes(contentType)) {
        failures.push('sm-bridge-request'); response.writeHead(400).end(); return;
      }
      grpcWebRequests++;
      const session = http2.connect(`http://127.0.0.1:${port}`);
      sessions.add(session);
      session.on('close', () => sessions.delete(session));
      session.on('error', () => response.destroy());
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) =>
        !['host', 'connection', 'transfer-encoding', 'content-length', 'content-type'].includes(key)));
      const upstream = session.request({ ...headers, ':method': 'POST', ':path': request.url, 'content-type': 'application/grpc', te: 'trailers' });
      let hasStatus = false, ended = false;
      upstream.on('response', headers => {
        response.writeHead(200, { 'content-type': contentType });
        if (headers['grpc-status'] !== undefined) { hasStatus = true; response.write(trailer(headers)); }
      });
      upstream.on('data', chunk => response.write(chunk));
      upstream.on('trailers', headers => { hasStatus = true; response.write(trailer(headers)); });
      upstream.on('end', () => {
        ended = true;
        if (!hasStatus) { failures.push('sm-native-status-required'); response.destroy(); }
        else response.end();
        session.close();
      });
      upstream.on('error', () => { ended = true; response.destroy(); session.destroy(); });
      response.on('close', () => { if (!ended) { upstream.close(http2.constants.NGHTTP2_CANCEL); session.destroy(); } });
      request.pipe(upstream);
    });
    bridge.listen(0, '127.0.0.1');
    await once(bridge, 'listening');
    const bridgeOrigin = `http://127.0.0.1:${bridge.address().port}`;
    const buildBase = path.join(root, '.wga-build');
    fs.mkdirSync(buildBase, { recursive: true });
    stage = 'temporary-directory-initialization';
    temporary = fs.mkdtempSync(path.join(buildBase, 'secret-manager-'));
    function setup(runtime, scenario) {
      const caseId = `${runtime}-${scenario}`;
      states.set(caseId, { runtime, scenario, trace: [] });
      return caseId;
    }
    function verify(runtime, scenario, caseId, result, before) {
      invariant(failures.length === 0, 'backend-and-bridge-invariants');
      const state = states.get(caseId);
      const pages = scenario.startsWith('list-') ? scenario === 'list-async-break' ? 1 : 3 : 0;
      invariant(state.trace.filter(item => item.method === 'ListSecrets').length === pages, 'exact-list-rpc-count');
      invariant(state.trace.length === (pages ? pages + 1 : 1), 'exact-total-rpc-count');
      if (pages) {
        invariant(state.trace.at(-1).method === 'GetSecret', 'reuse-after-final-page');
        invariant(state.trace.filter(item => item.method === 'ListSecrets').every((item, index) =>
          item.pageToken === (index === 0 ? '' : `page-${index}`)), 'observed-page-order');
      }
      const requests = grpcWebRequests - before;
      invariant(requests === (runtime === 'native' ? 0 : state.trace.length), 'bridge-rpc-count');
      report.results.push({ runtime, scenario, status: 'passed', rpcCount: state.trace.length,
        grpcWebRequests: requests, trace: state.trace, result });
    }
    const helperNames = ['secret-manager-extended.mjs', 'assert.mjs'];
    report.sharedSourceHashes = Object.fromEntries(helperNames.map(file => [file,
      digest(fs.readFileSync(path.join(root, 'fixtures/google/shared', file)))]));
    for (const runtime of ['native', 'adapter']) {
      const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
      const req = createRequire(path.join(fixture, 'package.json'));
      const grpc = req('@grpc/grpc-js');
      const consumer = fs.mkdtempSync(path.join(fixture, '.secret-manager-'));
      try {
        report.sourceHashes[runtime] = {};
        for (const file of helperNames) {
          const source = fs.readFileSync(path.join(root, 'fixtures/google/shared', file));
          fs.writeFileSync(path.join(consumer, file), source);
          report.sourceHashes[runtime][file] = digest(fs.readFileSync(path.join(consumer, file)));
          invariant(report.sourceHashes[runtime][file] === report.sharedSourceHashes[file], 'node-shared-source');
        }
        const { runSecretManagerExtended } = await import(pathToFileURL(path.join(consumer, 'secret-manager-extended.mjs')).href);
        const authClient = new (req('google-auth-library').OAuth2Client)();
        authClient.setCredentials({ access_token: 'secret-manager-local-fixture' });
        const base = { projectId: 'wga-sm-fixture', apiEndpoint: '127.0.0.1', port, authClient, sslCreds: grpc.credentials.createInsecure() };
        // Plain Node uses explicit loopback credentials with the package alias.
        // Workers below use gaxOptions with normal secure OAuth credentials.
        if (runtime === 'adapter') req('@grpc/grpc-js/config').configureWorkersGrpc({
          mode: 'grpc-web', allowInsecureLocalhost: true, endpoints: { [`127.0.0.1:${port}`]: bridgeOrigin },
        });
        const options = base;
        for (const scenario of scenarios) {
          stage = `${runtime}-${scenario}`;
          const caseId = setup(runtime, scenario), before = grpcWebRequests;
          const result = await bounded(runSecretManagerExtended({ options, scenario, caseId }));
          verify(runtime, scenario, caseId, result, before);
        }
      } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
    }
    stage = 'worker-build';
    const bundle = await buildGoogleWorker({ entry: path.join(root, 'fixtures/google/secret-manager-worker.mjs'), outdir: temporary });
    report.buildProfile = { name: bundle.manifest.profile, revision: bundle.manifest.revision,
      sha256: bundle.manifest.profileSha256, registrySha256: bundle.manifest.registrySha256 };
    report.sourceHashes.workerd = Object.fromEntries(helperNames.map(file => [file,
      bundle.manifest.sourceHashes[`fixtures/google/shared/${file}`]]));
    assert.deepEqual(report.sourceHashes.native, report.sourceHashes.adapter);
    assert.deepEqual(report.sourceHashes.native, report.sourceHashes.workerd);
    report.sameSharedSource = true;
    const config = path.join(temporary, 'wrangler.json');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-secret-manager-local', main: bundle.main,
      compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'], workers_dev: false }));
    const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
    for (const name of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(name)) delete environment[name];
    const output = path.join(temporary, 'dry-run');
    execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
      'deploy', '--dry-run', '--config', config, '--outdir', output, '--no-autoconfig'],
    { cwd: root, env: environment, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const script = fs.readFileSync(path.join(output, 'worker.js'), 'utf8');
    report.bundleSha256 = digest(script);
    for (const mode of ['grpc-web', 'cloudflare']) {
      const worker = new Miniflare(convertV4MiniflareOptions({
        log: new Log(LogLevel.NONE), modules: true, script, bindings: { MODE: mode },
        compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
        outboundService: async request => {
          try {
            const url = new URL(request.url);
            invariant(url.hostname === (mode === 'cloudflare' ? 'secretmanager.googleapis.com' : 'secret-manager-gateway.invalid'), 'worker-endpoint');
            invariant(request.headers.get('content-type') === (mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto'), 'worker-content-type');
            invariant(request.headers.get('authorization') === 'Bearer secret-manager-local-fixture', 'worker-oauth');
            const headers = new Headers(request.headers);
            for (const name of ['content-length', 'host', 'connection', 'transfer-encoding']) headers.delete(name);
            return await fetch(`${bridgeOrigin}${url.pathname}`, { method: 'POST', headers,
              body: Buffer.from(await request.arrayBuffer()), signal: request.signal });
          } catch (error) {
            failures.push(safeError(error));
            return new Response('Synthetic fixture failure', { status: 500 });
          }
        },
      }));
      try {
        for (const scenario of scenarios) {
          stage = `workerd-${mode}-${scenario}`;
          const caseId = setup(mode, scenario), before = grpcWebRequests;
          const { response, body } = await bounded((async () => {
            const response = await worker.dispatchFetch(`https://fixture.test/${scenario}`);
            return { response, body: await response.json() };
          })());
          invariant(failures.length === 0, 'worker-outbound-invariants');
          if (response.status !== 200 || body.status !== 'passed') {
            invariant(false, /^sm-[a-z0-9-]+$/.test(body.error) ? body.error.slice(3) : 'worker-response');
          }
          verify(`workerd-${mode}`, scenario, caseId, body.result, before);
        }
      } finally { await worker.dispose(); }
    }
    stage = 'cross-runtime-parity';
    const comparable = item => ({ scenario: item.scenario, trace: item.trace, result: item.result });
    for (const runtime of ['adapter', 'workerd-grpc-web', 'workerd-cloudflare']) {
      invariant(JSON.stringify(report.results.filter(item => item.runtime === runtime).map(comparable))
        === JSON.stringify(report.results.filter(item => item.runtime === 'native').map(comparable)), 'native-sdk-parity');
    }
    invariant(report.results.length === 44, 'exact-case-count');
    report.rpcCount = report.results.reduce((total, item) => total + item.rpcCount, 0);
    invariant(report.rpcCount === 96, 'aggregate-rpc-count');
    report.grpcWebRequests = grpcWebRequests;
    report.checks = ['manual-promise-and-callback-pages', 'automatic-pagination', 'async-iterator-pagination',
      'async-break-suppresses-following-pages', 'same-client-reuse-after-pagination', 'exact-page-and-rpc-counts',
      'resource-and-quota-routing-metadata', 'binary-empty-and-64k-payload-roundtrip', 'promise-and-callback-access',
      'consumer-checksum-validation', 'sdk-forwards-invalid-checksum', 'not-found-and-permission-denied',
      'unicode-details-and-binary-error-metadata', 'no-payload-or-raw-exception-output', 'native-adapter-workerd-parity'];
    report.status = 'passed';
  } finally {
    // Shut down the native listener first, and attempt every remaining cleanup
    // independently. Partial initialization and cleanup errors must not leave
    // a listening server keeping this standalone verification process alive.
    const cleanupTasks = [
      () => server.forceShutdown(),
      ...[...sessions].map(session => () => session.destroy()),
      () => bridge?.closeAllConnections(),
      async () => {
        if (bridge?.listening) await bounded(new Promise((resolve, reject) =>
          bridge.close(error => error ? reject(error) : resolve())), 5000);
      },
      () => { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); },
    ];
    let cleanupFailed = false;
    for (const cleanup of cleanupTasks) {
      try { await cleanup(); }
      catch { cleanupFailed = true; }
    }
    invariant(!cleanupFailed, 'resource-cleanup-failed');
  }
}
main().catch(error => {
  report.status = 'failed'; report.error = safeError(error); report.failureStage = stage;
  report.fixtureFailures = failures;
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/secret-manager-extended.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.results.length, rpcCount: report.rpcCount,
    ...(report.status === 'failed' ? { stage: report.failureStage, error: report.error, failures } : {}),
    report: 'verification/secret-manager-extended.json' }));
});
