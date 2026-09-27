'use strict';
// Installed public APIs execute in workerd against an in-Worker controlled Fetch peer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { validateWorkerdObserverReport } = require('./test-evidence.cjs');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const sourceDist = process.env.WGA_OBSERVER_SOURCE_DIST || path.join(root, 'dist');
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild, liveCloud: false,
  incomingCloudflareTranslation: false, nativeHttp2: false, serviceBindings: false, controlledPeer: true,
  compatibilityDate: '2026-09-21', runs: [], externalRequests: 0, cleanupVerifiedBeforeDispose: false };
async function main() {
  const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const modules={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(Object.hasOwn(modules,n))return modules[n];throw new Error('Unsupported runtime require');};`;
  const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/observer.mjs'],
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
    banner: { js: banner }, ...(sourceBuild ? { alias: {
      '@grpc/grpc-js/adapter': path.join(sourceDist, 'adapter.js'), '@grpc/grpc-js': path.join(sourceDist, 'index.js'),
    } } : {}) });
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  const installed = Object.keys(bundle.metafile.inputs).filter(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/'));
  if (!sourceBuild) assert.ok(installed.length > 0, 'PUBLIC_API_MUST_USE_INSTALLED_PACKAGE');
  report.installedInputs = Object.fromEntries(installed.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.evidence = Object.fromEntries(['scripts/test-workerd-observer.cjs', 'fixtures/worker/observer.mjs',
    'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.miniflare = req('miniflare/package.json').version;
  report.workerd = req('workerd/package.json').version;
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    outboundService() { report.externalRequests++; throw new Error('OBSERVER_EXTERNAL_REQUEST'); },
  }));
  try {
    const response = await runtime.dispatchFetch('https://entry.fixture.invalid/observer', { signal: AbortSignal.timeout(30000) });
    const result = await response.json(); report.runs.push(result);
    assert.equal(response.status, 200, result.diagnostic);
    assert.equal(result.status, 'passed');
    assert.equal(result.activeClientCalls, 0);
    assert.equal(result.resourcesIdle, true);
    assert.ok(result.cleanup.every(item => item.bodyLocked === false && (item.ended || item.cancellations === 1)));
    assert.equal(report.externalRequests, 0);
    for (const key of ['caseCount', 'rpcCount', 'fetchCount', 'attemptCount', 'eventCount']) report[key] = result[key];
    report.cleanupVerifiedBeforeDispose = true;
    report.status = 'passed';
  } finally { await runtime.dispose(); report.runtimeDisposed = true; }
  if (!sourceBuild) validateWorkerdObserverReport(report);
}
main().catch(error => {
  report.status = 'failed'; report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERD_OBSERVER_FAILURE';
  report.errorClass = error.constructor?.name || 'Error';
  report.errorMessage = String(error.message).slice(0, 500);
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workerd-observer.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, rpcCount: report.rpcCount,
    ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/workerd-observer.json' }));
});
