'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { createFlowPeer } = require('./flow-control-peer.cjs');
const root = path.resolve(__dirname, '..'), req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const nativeReq = createRequire(path.join(root, 'fixtures/native/package.json'));
const sourceBuild = process.argv.includes('--source-build');
const development = process.argv.includes('--development');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = ['scripts/test-flow-control.cjs', 'scripts/flow-control-peer.cjs', 'scripts/flow-control-unary.cjs',
  'scripts/flow-control-evidence.cjs', 'fixtures/shared/flow-control.mjs', 'fixtures/shared/flow-wire.mjs',
  'fixtures/worker/flow-control.mjs', 'fixtures/worker/package-lock.json', 'fixtures/native/package-lock.json'];
const report = { status: 'running', sourceBuild, development, startedAt: new Date().toISOString(),
  liveCloud: false, incomingCloudflareTranslation: false, nativeHttp2: true,
  compatibilityDate: '2026-09-21', externalRequests: 0, runs: [], peerCheckpoints: [],
  evidence: {}, installedInputs: {}, nativeInputs: {} };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeReport() {
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/flow-control.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
async function chunkOracle(peer) {
  const client = new peer.nativeGrpc.Client(peer.nativeTarget, peer.nativeGrpc.credentials.createInsecure(), { 'grpc.enable_retries': 0 });
  let count = 0, bytes = 0; const codes = [], errors = [], requestId = 'native:native:chunk';
  try {
    await new Promise((resolve, reject) => {
      const call = client.makeServerStreamRequest('/flow.Test/Stream', value => Buffer.from(JSON.stringify(value)), value => value,
        { scenario: 'chunk', id: requestId, catalogId: 'FLOW-007', count: 128, size: 256 }, { deadline: Date.now() + 5000 });
      call.on('data', value => {
        try {
          assert.equal(value.length, 256); assert.equal(value.readUInt32BE(0), count);
          for (let i = 4; i < 256; i++) assert.equal(value[i], count % 251);
          count++; bytes += value.length;
        } catch (error) { call.cancel(); reject(error); }
      });
      call.on('error', error => { errors.push(error.code); reject(error); }); call.on('status', value => codes.push(value.code));
      call.on('end', resolve);
    });
    assert.equal(count, 128); assert.equal(bytes, 32768); assert.deepEqual(codes, [0]); assert.deepEqual(errors, []);
    return { id: 'FLOW-007', scenario: 'coalesced-native-stream', requestId, count, bytes, codes, errors,
      nativeChunkBoundaryClaimed: false };
  } finally { client.close(); }
}
async function main() {
  const { runPublicFlowSuite } = await import('../fixtures/shared/flow-control.mjs');
  const { runWireFlowSuite } = await import('../fixtures/shared/flow-wire.mjs');
  const grpc = sourceBuild ? require('../dist/index.js') : req('@grpc/grpc-js');
  const { createWorkersGrpcTransport } = sourceBuild ? require('../dist/adapter.js') : req('@grpc/grpc-js/adapter');
  const peer = await createFlowPeer(); let runtime;
  async function settlePeer(label) {
    for (let i = 0; i < 100; i++) {
      const value = peer.snapshot();
      if (['activeSessions', 'activeBridges', 'activeBackendCalls', 'pendingDrainWaiters', 'pendingPulls'].every(key => value[key] === 0)) break;
      await sleep(5);
    }
    const before = peer.snapshot(), explicitCancelled = [];
    // Service binding response cancellation does not promise backend generator
    // cleanup. Record any explicit fixture cleanup rather than counting it as
    // transport cancellation propagation.
    for (const receipt of peer.receipts) if (!receipt.sessionClosed) {
      const count = peer.cancel(receipt.id); if (count) explicitCancelled.push(receipt.id);
    }
    for (let i = 0; i < 100; i++) {
      const value = peer.snapshot();
      if (['activeSessions', 'activeBridges', 'activeBackendCalls', 'pendingDrainWaiters', 'pendingPulls'].every(key => value[key] === 0)) break;
      await sleep(5);
    }
    const after = peer.snapshot();
    for (const key of ['activeSessions', 'activeBridges', 'activeBackendCalls', 'pendingDrainWaiters', 'pendingPulls']) assert.equal(after[key], 0, `${label}/${key}`);
    report.peerCheckpoints.push({ label, before, explicitCancelled, after });
  }
  try {
    report.native = await runPublicFlowSuite({ grpc: peer.nativeGrpc, target: peer.nativeTarget, runtime: 'native' });
    report.native.chunk = await chunkOracle(peer);
    report.native.wire = await require('./flow-control-unary.cjs')(peer.nativeGrpc);
    report.native.version = nativeReq('@grpc/grpc-js/package.json').version;
    await settlePeer('native');
    for (const mode of ['cloudflare', 'grpc-web']) {
      const bindings = { grpc, createWorkersGrpcTransport, target: 'flow.test', runtime: 'node', mode, fetcher: peer };
      const run = await runPublicFlowSuite(bindings); run.rows.push(...await runWireFlowSuite(bindings));
      report.runs.push(run); await settlePeer(`node:${mode}`);
    }
    const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const libs={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(libs[n])return libs[n];throw new Error('unexpected runtime require '+n)};`;
    const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/flow-control.mjs'],
      bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
      ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.js'), '@grpc/grpc-js': path.join(root, 'dist/index.js') } } : {}) });
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    for (const file of Object.keys(bundle.metafile.inputs).filter(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/'))) report.installedInputs[file] = digest(fs.readFileSync(path.join(root, file)));
    if (!sourceBuild) assert.ok(Object.keys(report.installedInputs).length > 0);
    report.workerd = req('workerd/package.json').version; report.miniflare = req('miniflare/package.json').version;
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
    runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'],
      serviceBindings: { PEER: request => peer.fetch(request) },
      outboundService() { report.externalRequests++; throw new Error('FLOW_EXTERNAL_REQUEST'); } }));
    for (const mode of ['cloudflare', 'grpc-web']) {
      const response = await runtime.dispatchFetch(`https://flow-entry.test/${mode}`, { signal: AbortSignal.timeout(90000) });
      const run = await response.json(); assert.equal(response.status, 200, JSON.stringify(run));
      report.runs.push(run); await settlePeer(`workerd:${mode}`);
    }
    report.cleanupVerifiedBeforeDispose = true;
    report.peer = { receipts: peer.receipts, serverCalls: peer.serverCalls, beforeClose: peer.snapshot() };
  } finally {
    try { if (runtime) { await runtime.dispose(); report.runtimeDisposed = true; } }
    finally { await peer.close(); report.peerAfterClose = peer.snapshot(); }
  }
  for (const file of Object.keys(require.cache).filter(file => file.startsWith(path.join(root, 'fixtures/native/node_modules/')))) report.nativeInputs[path.relative(root, file)] = digest(fs.readFileSync(file));
  report.nativeInputs['fixtures/native/node_modules/@grpc/grpc-js/package.json'] = digest(fs.readFileSync(nativeReq.resolve('@grpc/grpc-js/package.json')));
  report.evidence = Object.fromEntries(sources.filter(file => !development || fs.existsSync(path.join(root, file))).map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.caseCount = report.runs.reduce((sum, run) => sum + run.rows.length, 0);
  for (const run of report.runs) for (const row of run.rows.filter(value => value.id <= 'FLOW-005')) {
    const native = report.native.rows.find(value => value.id === row.id); assert.ok(native);
    for (const key of ['deliveredCount', 'deliveredBytes', 'payloadByteSum', 'codes', 'errorCodes']) assert.deepEqual(row[key], native[key], `${run.runtime}/${run.mode}/${row.id}/${key}`);
  }
  report.nativeBusinessCompared = true;
  report.status = development ? 'development-passed' : 'passed';
  if (!development) {
    const { validateFlowControlReport, catalogCases } = require('./flow-control-evidence.cjs');
    report.catalogCases = catalogCases(report.runs, report.native);
    validateFlowControlReport(report, { allowSourceBuild: sourceBuild });
  }
}
writeReport();
const watchdog = setTimeout(() => { report.status = 'failed'; report.errorMessage = 'FLOW_SUITE_TIMEOUT'; writeReport(); process.exit(1); }, 180000);
main().catch(error => { report.status = 'failed'; report.errorMessage = String(error.stack ?? error).slice(0, 8000); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog); report.finishedAt = new Date().toISOString(); writeReport();
  console.log(JSON.stringify({ status: report.status, caseCount: report.caseCount, errorMessage: report.errorMessage }));
});
