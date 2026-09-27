'use strict';
// Both endpoints execute installed public APIs in separate workerd Workers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const compatibilityDate = '2026-09-21';
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild, liveCloud: false,
  incomingCloudflareTranslation: false, nativeHttp2: false, serviceBindings: true, productionServerHandler: true,
  compatibilityDate, runs: [], externalRequests: 0, cleanupVerifiedBeforeDispose: false,
  backendCleanupLifetime: 'ctx.waitUntil(handler-finalization), bounded by each RPC deadline' };
async function main() {
  const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require');};`;
  const bundles = [];
  report.bundleSha256 = {};
  report.installedInputs = {};
  for (const name of ['client', 'server']) {
    const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: [`fixtures/worker/integration-${name}.mjs`],
      bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
      banner: { js: banner }, ...(sourceBuild ? { alias: { '@grpc/grpc-js/server': path.join(root, 'dist/server.js'),
        '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
    report.bundleSha256[name] = digest(bundle.outputFiles[0].contents);
    const installed = Object.keys(bundle.metafile.inputs).filter(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/'));
    if (!sourceBuild) assert.ok(installed.length > 0, 'PUBLIC_API_MUST_USE_INSTALLED_PACKAGE');
    for (const file of installed) report.installedInputs[file] = digest(fs.readFileSync(path.join(root, file)));
    bundles.push(bundle.outputFiles[0].text);
  }
  report.miniflare = req('miniflare/package.json').version;
  report.workerd = req('workerd/package.json').version;
  const packageFile = 'fixtures/worker/node_modules/@grpc/grpc-js/package.json';
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, packageFile), 'utf8'));
  report.installedPackage = { name: packageMetadata.name, version: packageMetadata.version,
    packageJsonSha256: digest(fs.readFileSync(path.join(root, packageFile))) };
  report.evidence = Object.fromEntries(['scripts/test-workerd-integration.cjs', 'fixtures/worker/integration-client.mjs',
    'fixtures/worker/integration-server.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const outboundService = () => { report.externalRequests++; throw new Error('INTEGRATION_EXTERNAL_REQUEST'); };
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), workers: [
    { name: 'integration-client', modules: true, script: bundles[0], compatibilityDate, compatibilityFlags: ['nodejs_compat'],
      serviceBindings: { BACKEND: 'integration-server' }, outboundService },
    { name: 'integration-server', modules: true, script: bundles[1], compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService },
  ] }));
  try {
    for (const invocation of ['cold', 'warm']) {
      const response = await runtime.dispatchFetch(`https://entry.fixture.invalid/${invocation}`, { signal: AbortSignal.timeout(20000) });
      const body = await response.text();
      let result;
      try { result = JSON.parse(body); }
      catch {
        const backend = await runtime.getWorker('integration-server');
        report.failureSnapshot = await (await backend.fetch('https://control.fixture.invalid/control')).json();
        throw new Error(`INVALID_WORKER_RESPONSE:${response.status}:${body.slice(0, 300)}`);
      }
      report.runs.push(result);
      assert.equal(response.status, 200, result.diagnostic);
      assert.equal(result.status, 'passed');
      assert.equal(result.results.length, 36);
      assert.equal(result.rpcCount, 48);
      assert.equal(result.backend.receipts.length, invocation === 'cold' ? 48 : 96);
      assert.equal(result.activeClientCalls, 0);
      assert.equal(result.backend.active, 0);
    }
    assert.equal(report.externalRequests, 0);
    report.caseCount = report.runs.reduce((sum, value) => sum + value.results.length, 0);
    report.rpcCount = report.runs.reduce((sum, value) => sum + value.rpcCount, 0);
    report.backendAbortCount = report.runs.at(-1).backend.receipts.filter(value => value.aborted).length;
    assert.equal(report.backendAbortCount, 12);
    const cancellations = report.runs.flatMap(value => value.cancellations);
    report.cancellation = { localTerminals: cancellations.length,
      immediateBackendCleanup: cancellations.filter(value => value.backendCleanup === 'transport-cancellation').length,
      deadlineBoundedBackendCleanup: cancellations.filter(value => value.backendCleanup === 'grpc-timeout').length,
      limitation: 'A local terminal does not prove service-binding cancellation reaches an idle backend iterator; every held RPC has a server deadline and its cleanup receipt is required before disposal.' };
    report.cleanupVerifiedBeforeDispose = true;
    report.status = 'passed';
  } finally { await runtime.dispose(); report.runtimeDisposed = true; }
}
main().catch(error => {
  report.status = 'failed'; report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERD_INTEGRATION_FAILURE';
  report.errorClass = error.constructor?.name || 'Error';
  report.errorMessage = String(error.message).slice(0, 500);
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workerd-integration.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, rpcCount: report.rpcCount,
    ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/workerd-integration.json' }));
});
