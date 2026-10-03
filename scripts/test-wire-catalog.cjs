'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..'), req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const sourceBuild = process.argv.includes('--source-build'), development = process.argv.includes('--development');
const digest = value => createHash('sha256').update(value).digest('hex');
const sources = ['scripts/test-wire-catalog.cjs', 'scripts/wire-allocation.cjs', 'scripts/wire-catalog-evidence.cjs',
  'fixtures/shared/wire-vectors.mjs', 'fixtures/shared/wire-harness.mjs', 'fixtures/shared/wire-frames.mjs',
  'fixtures/shared/wire-metadata.mjs', 'fixtures/worker/wire-catalog.mjs', 'fixtures/worker/package-lock.json'];
const report = { status: 'running', sourceBuild, development, startedAt: new Date().toISOString(),
  liveCloud: false, incomingCloudflareTranslation: false, nativeHttp2: false, controlledPeer: true,
  compatibilityDate: '2026-09-21', externalRequests: 0, runs: [], evidence: {}, installedInputs: {} };
function writeReport() {
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/wire-catalog.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
async function main() {
  const { runWireCatalog } = await import('../fixtures/shared/wire-harness.mjs');
  const grpc = sourceBuild ? require('../dist/index.js') : req('@grpc/grpc-js');
  const { createWorkersGrpcTransport } = sourceBuild ? require('../dist/adapter.js') : req('@grpc/grpc-js/adapter');
  if (!development || fs.existsSync(path.join(root, 'scripts/wire-allocation.cjs'))) {
    report.allocation = await require('./wire-allocation.cjs').runAllocationChecks({ sourceBuild });
  }
  for (const mode of ['cloudflare', 'grpc-web']) report.runs.push(await runWireCatalog({ grpc, createWorkersGrpcTransport, runtime: 'node', mode }));
  const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';import * as c from 'node:crypto';const libs={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z,'node:crypto':c};const require=n=>{if(libs[n])return libs[n];throw new Error('unexpected runtime require '+n)};`;
  const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/wire-catalog.mjs'], bundle: true,
    write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
    ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.js'), '@grpc/grpc-js': path.join(root, 'dist/index.js') } } : {}) });
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  for (const file of Object.keys(bundle.metafile.inputs).filter(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/'))) report.installedInputs[file] = digest(fs.readFileSync(path.join(root, file)));
  if (!sourceBuild) assert.ok(Object.keys(report.installedInputs).length > 0);
  report.node = process.version; report.miniflare = req('miniflare/package.json').version; report.workerd = req('workerd/package.json').version;
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    outboundService() { report.externalRequests++; throw new Error('WIRE_EXTERNAL_REQUEST'); } }));
  try {
    for (const mode of ['cloudflare', 'grpc-web']) {
      const response = await runtime.dispatchFetch(`https://wire-entry.test/${mode}`, { signal: AbortSignal.timeout(90000) });
      const run = await response.json(); assert.equal(response.status, 200, JSON.stringify(run)); report.runs.push(run);
    }
    report.cleanupVerifiedBeforeDispose = true;
  } finally { await runtime.dispose(); report.runtimeDisposed = true; }
  report.evidence = Object.fromEntries(sources.filter(file => !development || fs.existsSync(path.join(root, file))).map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.caseCount = report.runs.reduce((sum, run) => sum + run.rows.length, 0);
  report.status = development ? 'development-passed' : 'passed';
  if (!development) {
    const { validateWireCatalogReport, catalogCases } = require('./wire-catalog-evidence.cjs');
    report.catalogCases = catalogCases(report.runs, report.allocation);
    validateWireCatalogReport(report, { allowSourceBuild: sourceBuild });
  }
}
writeReport();
const watchdog = setTimeout(() => { report.status = 'failed'; report.errorMessage = 'WIRE_SUITE_TIMEOUT'; writeReport(); process.exit(1); }, 240000);
main().catch(error => { report.status = 'failed'; report.errorMessage = String(error.stack ?? error).slice(0, 10000); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog); report.finishedAt = new Date().toISOString(); writeReport();
  console.log(JSON.stringify({ status: report.status, caseCount: report.caseCount, errorMessage: report.errorMessage }));
});
