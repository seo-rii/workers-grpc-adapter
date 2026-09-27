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
const sourceDist = process.env.WGA_LIFECYCLE_SOURCE_DIST || path.join(root, 'dist');
const compatibilityDate = '2026-09-21';
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild, liveCloud: false,
  incomingCloudflareTranslation: false, nativeHttp2: false, serviceBindings: true, productionServerHandler: true, independentUploadPeer: true,
  compatibilityDate, runs: [], externalRequests: 0, cleanupVerifiedBeforeDispose: false,
  backendCleanupLifetime: 'ctx.waitUntil(handler-finalization), bounded by each RPC deadline' };
async function main() {
  const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require');};`;
  const bundles = [];
  report.bundleSha256 = {};
  report.installedInputs = {};
  for (const name of ['client', 'server']) {
    const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: [`fixtures/worker/lifecycle-${name}.mjs`],
      bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
      banner: { js: banner }, ...(sourceBuild ? { alias: { '@grpc/grpc-js/config': path.join(sourceDist, 'config.js'), '@grpc/grpc-js/server': path.join(sourceDist, 'server.js'),
        '@grpc/grpc-js/adapter': path.join(sourceDist, 'adapter.js'), '@grpc/grpc-js': path.join(sourceDist, 'index.js') } } : {}) });
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
  report.evidence = Object.fromEntries(['scripts/test-workerd-lifecycle.cjs', 'fixtures/worker/lifecycle-client.mjs',
    'fixtures/worker/lifecycle-server.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const outboundService = () => { report.externalRequests++; throw new Error('LIFECYCLE_EXTERNAL_REQUEST'); };
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), workers: [
    { name: 'lifecycle-client', modules: true, script: bundles[0], compatibilityDate, compatibilityFlags: ['nodejs_compat'],
      serviceBindings: { BACKEND: 'lifecycle-server' }, outboundService },
    { name: 'lifecycle-server', modules: true, script: bundles[1], compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService },
  ] }));
  try {
    const response = await runtime.dispatchFetch('https://entry.fixture.invalid/review', { signal: AbortSignal.timeout(30000) });
    const result = await response.json();
    report.runs.push(result);
    assert.equal(response.status, 200, result.diagnostic);
    assert.equal(result.status, 'passed');
    assert.equal(result.caseCount, result.results.length);
    assert.equal(result.coreCaseCount, 31);
    assert.ok(result.resourceCaseCount >= 8);
    assert.equal(result.caseCount, result.coreCaseCount + result.resourceCaseCount);
    assert.ok(result.rpcCount >= 70);
    assert.equal(result.rpcCount, result.callReceipts.length);
    assert.equal(result.fetchCount, result.callReceipts.reduce((sum, item) => sum + item.fetchCount, 0));
    assert.equal(result.backend.receipts.length, result.fetchCount);
    const uploads = result.backend.receipts.filter(value => value.uploadEOF);
    assert.equal(uploads.length, 2);
    assert.ok(uploads.every(value => value.readerReleased && value.input.length === 3));
    assert.equal(result.activeClientCalls, 0);
    assert.equal(result.backend.active, 0);
    assert.equal(result.cleanup.length, result.fetchCount);
    assert.ok(result.cleanup.every(value => !value.bodyLocked && !value.sourceLocked && value.released));
    assert.equal(result.cleanup.filter(value => value.cancellations === 1).length, 6);
    const resources = result.results.filter(value => value.kind.startsWith('resource-'));
    for (const mode of ['cloudflare', 'grpc-web']) {
      for (const kind of ['resource-admission', 'resource-send-budget', 'resource-receive-budget', 'resource-slow-compressed']) {
        assert.equal(resources.filter(value => value.mode === mode && value.kind === kind).length, 1);
      }
    }
    assert.ok(resources.every(value => value.usage.activeCalls === 0 && value.usage.queuedCalls === 0
      && value.usage.bufferedBytes === 0 && value.usage.peakBufferedBytes <= value.limits.maxBufferedBytes && value.recovered));
    assert.equal(report.externalRequests, 0);
    report.caseCount = result.caseCount;
    report.rpcCount = result.rpcCount;
    report.fetchCount = result.fetchCount;
    report.coreCaseCount = result.coreCaseCount;
    report.resourceCaseCount = result.resourceCaseCount;
    report.responseReaderCount = result.cleanup.length;
    report.cancelledResponseReaderCount = result.cleanup.filter(value => value.cancellations === 1).length;
    report.backendAbortCount = result.backend.receipts.filter(value => value.aborted).length;
    assert.equal(report.backendAbortCount, 4);
    report.checks = ['async-interceptor-request-preservation', 'message-before-half-close', 'stalled-interceptor-terminal',
      'late-continuation-no-fetch', 'destroy-and-iterator-break', 'metadata-control-field-budget',
      'failed-channel-global-config-recovery', 'deadline-clock-boundary', 'same-client-recovery',
      'gateway-client-and-bidi-upload-eof', 'reader-and-timer-cleanup', 'shared-transport-admission',
      'queued-cancellation-and-deadline', 'send-and-compressed-receive-budget', 'slow-reader-high-water-mark'];
    report.cleanupVerifiedBeforeDispose = true;
    report.status = 'passed';
  } finally { await runtime.dispose(); report.runtimeDisposed = true; }
}
main().catch(error => {
  report.status = 'failed'; report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERD_LIFECYCLE_FAILURE';
  report.errorClass = error.constructor?.name || 'Error';
  report.errorMessage = String(error.message).slice(0, 500);
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workerd-lifecycle.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, rpcCount: report.rpcCount,
    ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/workerd-lifecycle.json' }));
});
