'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = require('node:timers');
const { validateCallLifecycleReport, catalogCases } = require('./call-lifecycle-evidence.cjs');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const sourceBuild = process.argv.includes('--source-build');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['scripts/test-call-lifecycle.cjs', 'scripts/call-lifecycle-evidence.cjs',
  'fixtures/shared/call-lifecycle.mjs', 'fixtures/shared/lifecycle-deadlines.mjs',
  'fixtures/shared/lifecycle-terminals.mjs', 'fixtures/worker/call-lifecycle.mjs', 'fixtures/worker/package-lock.json',
  'fixtures/native/package.json', 'fixtures/native/package-lock.json'];
const report = { status: 'running', sourceBuild, startedAt: new Date().toISOString(),
  liveCloud: false, incomingCloudflareTranslation: false, nativeHttp2: false, controlledPeer: true,
  compatibilityDate: '2026-09-21', externalRequests: 0, runs: [],
  evidence: Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])) };
async function withNodeWatchdog(run, timeoutMs = 60000) {
  let timer;
  try {
    // Keep a real event-loop handle even when a broken terminal callback leaves
    // only an unresolved promise. Shared deadline schedules replace globals.
    return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
      timer = realSetTimeout(() => reject(new Error('LIFECYCLE_NODE_TIMEOUT')), timeoutMs);
    })]);
  } finally { realClearTimeout(timer); }
}
async function main() {
  // Record the actual pinned native boundary separately from the adapter's
  // INVALID_ARGUMENT policy. This preflight never starts an HTTP/2 request.
  const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
  const traceEnvironment = Object.fromEntries(['GRPC_TRACE', 'GRPC_NODE_TRACE'].map(key => [key, process.env[key]]));
  let native;
  try {
    // Native 1.14.5 formats invalid dates only when tracing is enabled.
    for (const key of Object.keys(traceEnvironment)) process.env[key] = '';
    native = nativeRequire('@grpc/grpc-js');
  } finally {
    for (const [key, value] of Object.entries(traceEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const nativeLogging = nativeRequire('@grpc/grpc-js/build/src/logging');
  for (const tracer of ['channel', 'resolving_call']) assert.equal(nativeLogging.isTracerEnabled(tracer), false);
  const nativeVersion = nativeRequire('@grpc/grpc-js/package.json').version;
  assert.equal(nativeVersion, '1.14.5');
  let authCalls = 0, callbacks = 0, callReturned = false, caught, nativeCall, callbackCode;
  const statuses = [];
  const credentials = native.credentials.createFromMetadataGenerator((_options, done) => {
    authCalls++; done(null, new native.Metadata());
  });
  const nativeClient = new native.Client('127.0.0.1:1', native.credentials.createSsl());
  try {
    try {
      nativeCall = nativeClient.makeUnaryRequest('/catalog.lifecycle.Echo/Unary', value => value, value => value,
        Buffer.from([8, 1]), { deadline: new Date(NaN), credentials }, error => { callbacks++; callbackCode = error?.code; });
      callReturned = true;
    } catch (error) { caught = error; }
    assert.equal(caught, undefined, 'tracing-disabled native returns an invalid-Date call');
    assert.equal(callReturned, true); assert.equal(callbacks, 0); assert.equal(authCalls, 0);
    nativeCall.on('status', status => statuses.push(status.code));
    // Stop before resolution/transport and avoid racing native's NaN deadline
    // timer against a connection error. This records acceptance, not a natural
    // invalid-Date terminal status.
    nativeCall.cancel();
    assert.equal(callbacks, 0, 'native cancellation callback must be asynchronous');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callbacks, 1); assert.equal(callbackCode, native.status.CANCELLED);
    assert.deepEqual(statuses, [native.status.CANCELLED]); assert.equal(authCalls, 0);
    report.nativeDeadline = { grpc: nativeVersion, variant: 'invalid-date', tracing: 'disabled', threwSynchronously: false,
      errorName: null, callReturned, callbacksBeforeCancel: 0, cancelledByProbe: true,
      callbacks, callbackCode, statuses, authCalls, nativeParity: false,
      adapterPolicy: 'asynchronous-invalid-argument' };
  } finally { nativeClient.close(); }
  report.nativeInputs = Object.fromEntries(Object.keys(require.cache)
    .filter(file => file.startsWith(path.join(root, 'fixtures/native/node_modules/@grpc/grpc-js/')))
    .map(file => [path.relative(root, file), digest(fs.readFileSync(file))]));
  const { runLifecycleSuite } = await import(pathToFileURL(path.join(root, 'fixtures/shared/call-lifecycle.mjs')).href);
  const grpc = require('../dist/index.js'), { createWorkersGrpcTransport } = require('../dist/adapter.js');
  const expected = new Error('LIFECYCLE_REJECTION_SENSOR'); let unexpected = 0, sensor = 0;
  const rejected = reason => { if (reason === expected) sensor++; else unexpected++; };
  process.on('unhandledRejection', rejected);
  try {
    void Promise.reject(expected);
    for (let i = 0; i < 10 && sensor === 0; i++) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(sensor, 1, 'Node rejection monitor must detect its positive control');
    const result = await withNodeWatchdog(() => runLifecycleSuite({ grpc, createWorkersGrpcTransport, unhandled: () => unexpected }, 'node'));
    report.runs.push({ ...result, rejectionSensorCount: sensor });
  } finally { process.off('unhandledRejection', rejected); }
  const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const libs={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(libs[n])return libs[n];throw new Error('unexpected runtime require '+n)};`;
  const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/call-lifecycle.mjs'],
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
    banner: { js: banner }, ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.js'),
      '@grpc/grpc-js': path.join(root, 'dist/index.js') } } : {}) });
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  const installed = Object.keys(bundle.metafile.inputs).filter(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/'));
  if (!sourceBuild) assert.ok(installed.length > 0, 'Worker must use the actual installed package');
  report.installedInputs = Object.fromEntries(installed.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.miniflare = req('miniflare/package.json').version; report.workerd = req('workerd/package.json').version;
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    outboundService() { report.externalRequests++; throw new Error('LIFECYCLE_EXTERNAL_REQUEST'); },
  }));
  try {
    const response = await runtime.dispatchFetch('https://lifecycle.fixture.invalid/', { signal: AbortSignal.timeout(60000) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    report.runs.push(result); assert.equal(result.status, 'passed');
    report.cleanupVerifiedBeforeDispose = true;
  } finally { await runtime.dispose(); report.runtimeDisposed = true; }
  report.caseCount = report.runs.reduce((n, run) => n + run.rows.length, 0);
  report.catalogCases = catalogCases(report.runs);
  report.status = 'passed';
  validateCallLifecycleReport(report, { allowSourceBuild: sourceBuild });
}
function writeReport() {
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/call-lifecycle.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
if (require.main === module) {
  // Replace any earlier success before execution, including before abnormal exits.
  writeReport();
  main().catch(error => {
    report.status = 'failed'; report.errorMessage = String(error.stack ?? error).slice(0, 4000); process.exitCode = 1;
  }).finally(() => {
    report.finishedAt = new Date().toISOString(); writeReport();
    console.log(JSON.stringify({ status: report.status, caseCount: report.caseCount, catalogCases: report.catalogCases,
      ...(report.errorMessage ? { errorMessage: report.errorMessage } : {}) }));
  });
}
module.exports = { withNodeWatchdog };
