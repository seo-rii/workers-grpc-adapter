'use strict';
// Controlled native protocol peer, never a Google write or Cloudflare edge test.
process.env.GOOGLE_SDK_NODE_LOGGING = '';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { validateDatastoreMutationReport, sources } = require('./datastore-mutation-evidence.cjs');
const { createDatastoreMutationServer } = require('./datastore-mutation-server.cjs');
const { buildGoogleWorker } = require('./build-google-worker.cjs');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', startedAt: new Date().toISOString(), liveGoogle: false, cloudflareTranslation: false,
  officialEmulator: false, controlledNativeGrpcServer: true, sourceBuild: false, adapterRetryEnabled: false,
  sdkRetryEnabled: false, resourcesCheckedBeforeClose: false, authNetwork: 'anonymous-pass-through-no-network',
  controlDataRpcSeparated: true, runtimeDisposed: false, sameSharedSource: false, sourceHashes: {}, installedInputs: {}, nativeInputs: {},
  scope: 'Pinned high-level mutation wire/public API contracts against a controlled stateful native peer; no IAM, production atomicity, quota, or index certification',
  runtime: process.version, workerd: workerRequire('workerd/package.json').version, miniflare: workerRequire('miniflare/package.json').version,
  compatibilityDate: '2026-09-21', sdkVersion: nativeRequire('@google-cloud/datastore/package.json').version,
  nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version, results: [], failures: [] };
async function main() {
  report.evidence = Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  for (const [mapName, fixture, grpcEntry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
    for (const file of ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/datastore/package.json',
      '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js', '@google-cloud/datastore/build/src/entity.js',
      '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json', 'google-gax/package.json', 'google-auth-library/package.json']) {
      const relative = `fixtures/${fixture}/node_modules/${file}`; report[mapName][relative] = digest(fs.readFileSync(path.join(root, relative)));
    }
  }
  const { mutationScenarios: scenarios } = await import(pathToFileURL(path.join(root, 'fixtures/google/shared/datastore-mutations.mjs')).href);
  const peer = await createDatastoreMutationServer(); let temporary;
  const helpers = ['datastore-mutations.mjs', 'sdk-call-accounting.mjs'];
  report.sharedSourceHashes = Object.fromEntries(helpers.map(file => [file, digest(fs.readFileSync(path.join(root, 'fixtures/google/shared', file)))]));
  function verify(runtime, scenario, state, before, body) {
    assert.deepEqual(peer.failures, []); assert.equal(body.status, 'passed', JSON.stringify(body));
    const count = scenario === 'allocate-ids' ? 4 : 3;
    assert.equal(state.trace.length, count);
    assert.equal(body.dataFetches, runtime === 'native' ? 0 : count);
    if (runtime !== 'native') assert.deepEqual(body.accounting.calls.map(call => call.logicalCallId), state.receipts.map(item => item.logicalCallId));
    report.results.push({ runtime, scenario, status: 'passed', rpcCount: count, grpcWebRequests: peer.grpcWebRequests - before,
      trace: state.trace, receipts: state.receipts, result: body.result, accounting: body.accounting,
      dataFetches: body.dataFetches, authFetches: body.authFetches, controlRequests: body.controlRequests });
  }
  try {
    for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare']) {
      const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
      const req = createRequire(path.join(fixture, 'package.json')), grpc = req('@grpc/grpc-js');
      assert.equal(req('@google-cloud/datastore/package.json').version, '10.1.0');
      const consumer = fs.mkdtempSync(path.join(fixture, '.mutations-'));
      try {
        report.sourceHashes[runtime] = {};
        for (const file of helpers) {
          fs.copyFileSync(path.join(root, 'fixtures/google/shared', file), path.join(consumer, file));
          report.sourceHashes[runtime][file] = digest(fs.readFileSync(path.join(consumer, file)));
        }
        const { runDatastoreMutations } = await import(pathToFileURL(path.join(consumer, 'datastore-mutations.mjs')).href);
        const { startSdkCallAccounting } = await import(pathToFileURL(path.join(consumer, 'sdk-call-accounting.mjs')).href);
        for (const scenario of scenarios) {
          const state = peer.setup(runtime, scenario), before = peer.grpcWebRequests;
          const tracker = runtime === 'native' ? null : startSdkCallAccounting(grpc);
          let accounting = null, dataFetches = 0;
          try {
            const mode = runtime.endsWith('cloudflare') ? 'cloudflare' : 'grpc-web';
            const transport = tracker && req('@grpc/grpc-js/adapter').createWorkersGrpcTransport({ mode,
              ...(mode === 'grpc-web' ? { endpoints: { 'datastore.googleapis.com': 'https://mutation-gateway.invalid' } } : {}),
              observer: tracker.observer, fetcher: { fetch: tracker.wrapFetcher(async (url, init) => {
                const target = new URL(url);
                assert.equal(target.hostname, mode === 'cloudflare' ? 'datastore.googleapis.com' : 'mutation-gateway.invalid');
                assert.equal(init.headers.get('authorization'), null);
                assert.equal(init.headers.get('content-type'), mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto');
                dataFetches++; return fetch(`${peer.bridgeOrigin}${target.pathname}`, init);
              }) } });
            const options = runtime === 'native' ? { projectId: 'wga-mutations', apiEndpoint: `127.0.0.1:${peer.port}`, sslCreds: grpc.credentials.createInsecure() }
              : transport.gaxOptions({ projectId: 'wga-mutations' });
            const result = await runDatastoreMutations({ options, scenario, namespace: state.namespace,
              beforeClose: tracker ? async () => { accounting = await tracker.snapshot(transport); } : undefined });
            verify(runtime, scenario, state, before, { status: 'passed', result, accounting, dataFetches, authFetches: 0, controlRequests: 0 });
          } finally { tracker?.restore(); }
        }
      } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
    }
    fs.mkdirSync(path.join(root, '.wga-build'), { recursive: true }); temporary = fs.mkdtempSync(path.join(root, '.wga-build/mutations-'));
    const bundle = await buildGoogleWorker({ entry: path.join(root, 'fixtures/worker/datastore-mutations.mjs'), outdir: temporary });
    report.buildProfile = { name: bundle.manifest.profile, revision: bundle.manifest.revision,
      sha256: bundle.manifest.profileSha256, registrySha256: bundle.manifest.registrySha256 };
    assert.equal(bundle.manifest.entrySha256, report.evidence['fixtures/worker/datastore-mutations.mjs']);
    report.sourceHashes.workerd = Object.fromEntries(helpers.map(file => [file, bundle.manifest.sourceHashes[`fixtures/google/shared/${file}`]]));
    for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd']) assert.deepEqual(report.sourceHashes[runtime], report.sharedSourceHashes);
    report.sameSharedSource = true;
    const config = path.join(temporary, 'wrangler.jsonc');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-mutations-local', main: bundle.main, compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'], workers_dev: false }));
    const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
    for (const name of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(name)) delete environment[name];
    const output = path.join(temporary, 'dry-run');
    execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
      'deploy', '--dry-run', '--config', config, '--outdir', output, '--no-autoconfig'],
    { cwd: root, env: environment, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const script = fs.readFileSync(path.join(output, 'worker.js'), 'utf8'); report.bundleSha256 = digest(script);
    for (const mode of ['grpc-web', 'cloudflare']) {
      const worker = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script, bindings: { MODE: mode },
        compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
        outboundService: async request => {
          try {
            const target = new URL(request.url);
            assert.equal(target.hostname, mode === 'cloudflare' ? 'datastore.googleapis.com' : 'mutation-gateway.invalid');
            assert.equal(request.headers.get('authorization'), null);
            assert.equal(request.headers.get('content-type'), mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto');
            const headers = new Headers(request.headers); for (const name of ['content-length', 'host', 'connection', 'transfer-encoding']) headers.delete(name);
            return await fetch(`${peer.bridgeOrigin}${target.pathname}`, { method: 'POST', headers, body: Buffer.from(await request.arrayBuffer()), signal: request.signal });
          } catch (error) { peer.failures.push(error.message); return new Response('Mutation fixture failure', { status: 500 }); }
        } }));
      try {
        for (const scenario of scenarios) {
          const runtime = `workerd-${mode}`, state = peer.setup(runtime, scenario), before = peer.grpcWebRequests;
          const response = await worker.dispatchFetch(`https://fixture.test/${scenario}`), body = await response.json();
          assert.equal(response.status, 200, JSON.stringify(body)); verify(runtime, scenario, state, before, body);
        }
      } finally { await worker.dispose(); }
    }
    const comparable = item => ({ scenario: item.scenario, trace: item.trace, result: item.result });
    for (const runtime of ['adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare']) {
      assert.deepEqual(report.results.filter(item => item.runtime === runtime).map(comparable), report.results.filter(item => item.runtime === 'native').map(comparable));
    }
    report.nativeBusinessEquivalent = true; report.resourcesCheckedBeforeClose = true;
    report.caseCount = report.results.length; report.rpcCount = report.results.reduce((sum, row) => sum + row.rpcCount, 0);
    report.grpcWebRequests = peer.grpcWebRequests; report.dataFetches = report.results.reduce((sum, row) => sum + row.dataFetches, 0);
    report.authFetches = 0; report.controlRequests = 0; report.status = 'passed';
  } finally { await peer.close(); if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); report.runtimeDisposed = true; report.failures = peer.failures; }
  validateDatastoreMutationReport(report);
}
main().catch(error => { report.status = 'failed'; report.error = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString(); fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/datastore-mutations.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.results.length, rpcCount: report.rpcCount, report: 'verification/datastore-mutations.json' }));
});
