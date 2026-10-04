'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { validateTransportBenchmarkReport, validateTransportBenchmarkArtifacts } = require('../scripts/transport-benchmark-evidence.cjs');
const prefix = 'fixtures/worker/node_modules/@grpc/grpc-js/';
const output = 'verification/transport-benchmark/client.mjs';
const manifest = 'verification/transport-benchmark/esbuild-metafile.json';
const version = '0.0.0-fixture', toolVersion = '0.25.0';
const tarballPath = `artifacts/workers-grpc-adapter-${version}.tgz`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = 'a'.repeat(64);

// Independent synthetic evidence for validator unit tests, never a benchmark
// execution result. No checked-in verification report or installed fixture is
// read, and none of these module/tool bytes is executed.
function fixture() {
  const files = new Map();
  const put = (file, value) => files.set(file, Buffer.isBuffer(value) ? value : Buffer.from(value));
  put(prefix + 'package.json', JSON.stringify({ name: 'workers-grpc-adapter', version }));
  put(prefix + 'dist/index.js', 'module.exports={Client:class{},Metadata:class{},makeGenericClientConstructor(){}};\n');
  put(prefix + 'dist/index.mjs', 'import grpc from "./index.js";export const {Client,Metadata,makeGenericClientConstructor}=grpc;\n');
  put(prefix + 'dist/adapter.js', 'exports.syntheticAdapterFixture = true;\n');
  put(prefix + 'dist/wire.js', 'exports.syntheticWireFixture = true;\n');
  const installedPaths = [...files.keys()].sort();
  const archive = [];
  for (const file of installedPaths) {
    const bytes = files.get(file), header = Buffer.alloc(512);
    header.write(`package/${file.slice(prefix.length)}`, 0, 100);
    header.write('0000644\0', 100, 8); header.write('0000000\0', 108, 8); header.write('0000000\0', 116, 8);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12);
    header.write('00000000000\0', 136, 12); header.fill(32, 148, 156); header[156] = 48;
    header.write('ustar\0', 257, 6); header.write('00', 263, 2);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    archive.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  archive.push(Buffer.alloc(1024));
  const tarball = zlib.gzipSync(Buffer.concat(archive), { level: 9 }); put(tarballPath, tarball);
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const resolved = `file:../../artifacts/workers-grpc-adapter-${version}.tgz`;
  put('fixtures/worker/package.json', JSON.stringify({ dependencies: { '@grpc/grpc-js': resolved } }));
  put('fixtures/worker/package-lock.json', JSON.stringify({ packages: {
    'node_modules/@grpc/grpc-js': { name: 'workers-grpc-adapter', version, resolved, integrity },
    'node_modules/esbuild': { version: toolVersion }, 'node_modules/@esbuild/linux-x64': { version: toolVersion },
  } }));
  put('scripts/benchmark.cjs', '// Synthetic benchmark source bytes for artifact validation only.\n');
  put('scripts/transport-benchmark-evidence.cjs', '// Synthetic validator source bytes for artifact validation only.\n');
  put('fixtures/worker/node_modules/esbuild/package.json', JSON.stringify({ name: 'esbuild', version: toolVersion }));
  put('fixtures/worker/node_modules/esbuild/lib/main.js', 'exports.syntheticToolFixture = true;\n');
  put('fixtures/worker/node_modules/@esbuild/linux-x64/package.json', JSON.stringify({ name: '@esbuild/linux-x64', version: toolVersion }));
  put('fixtures/worker/node_modules/@esbuild/linux-x64/bin/esbuild', 'Synthetic unexecuted binary fixture\n');
  const bytes = Buffer.from(`export const Client=class{},Metadata=class{},makeGenericClientConstructor=()=>Client;const synthetic="${'a'.repeat(1000)}";\n`);
  const gzip = zlib.gzipSync(bytes, { level: 9 }); put(output, bytes); put(output + '.gz', gzip);
  const metafile = { inputs: {
    [prefix + 'dist/index.js']: { bytes: files.get(prefix + 'dist/index.js').length, imports: [] },
    [prefix + 'dist/index.mjs']: { bytes: files.get(prefix + 'dist/index.mjs').length,
      imports: [{ path: prefix + 'dist/index.js', kind: 'import-statement' }] },
  }, outputs: { [output]: { entryPoint: prefix + 'dist/index.mjs', bytes: bytes.length,
    inputs: { [prefix + 'dist/index.js']: { bytesInOutput: 80 }, [prefix + 'dist/index.mjs']: { bytesInOutput: 80 } },
    exports: ['Client', 'Metadata', 'makeGenericClientConstructor'], imports: [{ path: 'node:buffer', external: true, kind: 'import-statement' }],
  } } };
  put(manifest, JSON.stringify(metafile, null, 2) + '\n');
  const inputHashes = names => Object.fromEntries(names.map(file => [file, digest(files.get(file))]));
  const toolInputs = ['fixtures/worker/node_modules/esbuild/package.json', 'fixtures/worker/node_modules/esbuild/lib/main.js',
    'fixtures/worker/node_modules/@esbuild/linux-x64/package.json', 'fixtures/worker/node_modules/@esbuild/linux-x64/bin/esbuild'];
  const report = { schemaVersion: 1, status: 'passed', createdAt: '2026-10-04T00:00:00.000Z', runtimeExecuted: true,
    sourceBuild: false, realGoogleSDK: false, workerdExecuted: false, liveGoogle: false, liveCloud: false, budgetsChosen: false,
    controlledFetch: true, mode: 'grpc-web', responseChunkBytes: 16384, timingSource: 'node:perf_hooks.performance.now',
    timingIncludes: 'RPC, controlled peer, payload assertions, diagnostics, and configured consumer delay; cleanup checkpoint excluded',
    scope: 'Installed adapter in local Node with a controlled Fetch peer; no network, SDK, workerd, deployed Workers, speedup, or SLO claim',
    runtime: { node: 'v22.0.0', v8: 'synthetic-v8', platform: 'linux', arch: 'x64', kernel: 'synthetic-kernel', cpuModel: 'synthetic-cpu',
      logicalCpus: 2, totalMemoryBytes: 1073741824, nodeExecutableSha256: hash },
    evidence: inputHashes(['scripts/benchmark.cjs', 'scripts/transport-benchmark-evidence.cjs',
      'fixtures/worker/package.json', 'fixtures/worker/package-lock.json']),
    installedPackage: { path: prefix + 'package.json', name: 'workers-grpc-adapter', version, alias: '@grpc/grpc-js',
      lockfile: 'fixtures/worker/package-lock.json', lockEntry: 'node_modules/@grpc/grpc-js', resolved, integrity,
      tarball: { path: tarballPath, bytes: tarball.length, sha256: digest(tarball) } },
    installedInputs: inputHashes(installedPaths),
    executionInputs: ['dist/adapter.js', 'dist/index.js', 'dist/wire.js'].map(file => prefix + file),
    coldRequireMs: { entry: prefix + 'dist/index.js', scope: 'Fresh Node process require only; process startup excluded; not workerd cold start',
      measurements: [7, 6, 5, 4, 3, 2, 1].map((elapsedMs, sample) => ({ elapsedMs, sample, node: 'v22.0.0' })),
      samples: 7, min: 1, p50: 4, p95: 7, max: 7 },
    bundle: { status: 'measured', name: 'transport-only', esbuild: toolVersion,
      config: { absWorkingDir: '.', entryPoints: [prefix + 'dist/index.mjs'], outfile: output, bundle: true, write: false,
        format: 'esm', platform: 'neutral', target: ['es2022'], external: ['node:*'], minify: true, metafile: true, sourcemap: false, legalComments: 'none' },
      scope: 'Installed client root ESM entry; Node builtins external; no Google SDK or Workers CJS require bridge; bundle not executed.',
      path: output, gzipPath: output + '.gz', metafilePath: manifest, minifiedBytes: bytes.length, gzipBytes: gzip.length, gzipLevel: 9,
      sha256: digest(bytes), gzipSha256: digest(gzip), metafileSha256: digest(files.get(manifest)), metafile,
      inputSha256: inputHashes(Object.keys(metafile.inputs)), toolInputs: inputHashes(toolInputs) },
    generatedArtifacts: inputHashes([output, output + '.gz', manifest]),
    scenarios: [], caseCount: 4, logicalCalls: 154, fetches: 154, resourcesCheckedBeforeClose: true,
  };
  const workloads = [
    { name: 'large-unary', requestBytes: 524288, messageBytes: 524288, messages: 1, concurrency: 1, delayMs: 0, stream: false },
    { name: 'many-small', requestBytes: 32, messageBytes: 1024, messages: 256, concurrency: 1, delayMs: 0, stream: true },
    { name: 'slow-consumer', requestBytes: 32, messageBytes: 1024, messages: 64, concurrency: 1, delayMs: 1, stream: true },
    { name: 'concurrent-unary', requestBytes: 65536, messageBytes: 65536, messages: 1, concurrency: 8, delayMs: 0, stream: false },
  ];
  for (const [rowIndex, config] of workloads.entries()) {
    const factor = rowIndex + 1;
    const raw = [99, 100, 12, 1, 11, 2, 10, 3, 9, 4, 8, 5, 7, 6].map(value => value * factor);
    const row = { ...config, status: 'passed', repetitions: 12, warmups: 2, fetches: 14 * config.concurrency,
      cleanAfterEveryIteration: true, iterations: [], latencyMs: { samples: 12, min: factor, p50: 6 * factor, p95: 12 * factor, max: 12 * factor },
      payloadMiBPerSecondAtP50: config.concurrency * config.messages * config.messageBytes / 1048576 / (6 * factor / 1000),
      buffering: { readableHighWaterMark: config.stream ? 16 : 0, peakObservedReadableBytes: config.stream ? 2 * config.messageBytes : 0,
        peakObservedTransportRequestBytes: config.requestBytes * config.concurrency,
        peakObservedTransportResponseBytes: config.messageBytes * config.concurrency,
        scope: 'Sampled adapter diagnostics and Readable Buffer queue bytes; not a total memory bound.' },
      processMemoryDeltaBytes: { peakHeapUsed: 14000, peakArrayBuffers: 7000, peakRss: 3500,
        scope: 'Process-wide sampled deltas relative to each iteration baseline; includes fixtures and GC, not adapter-owned memory.' } };
    for (const [iteration, elapsedMs] of raw.entries()) {
      const calls = Array.from({ length: config.concurrency }, (_, index) => {
        const id = `${config.name}/${iteration}/${index}`;
        return { id, statusCodes: [0], callbackCount: config.stream ? 0 : 1,
          responseMessages: config.messages, responsePayloadBytes: config.messages * config.messageBytes,
          delays: config.delayMs ? config.messages : 0,
          receipt: { id, method: '/benchmark.Bytes/Run', requestWireBytes: config.requestBytes + 5,
            requestPayloadBytes: config.requestBytes, requestPayloadVerified: true, messages: config.messages, trailers: 1,
            responseWireBytes: config.messages * (config.messageBytes + 5) + 21,
            chunks: config.messages * Math.ceil((config.messageBytes + 5) / 16384) + 1,
            bodyLocked: false, ended: true, cancellations: 0 },
          diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
          execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
            parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 } };
      });
      row.iterations.push({ iteration, phase: iteration < 2 ? 'warmup' : 'measured', elapsedMs, fetches: config.concurrency,
        activeCalls: 0, resourcesCheckedBeforeClose: true, calls,
        resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: config.concurrency,
          peakQueuedCalls: 0, peakBufferedBytes: config.requestBytes * config.concurrency },
        measurements: { samples: config.concurrency * (config.messages + 1) + 1,
          bufferPeaks: { readableBytes: config.stream ? 2 * config.messageBytes : 0,
            requestBytes: config.requestBytes * config.concurrency, responseBytes: config.messageBytes * config.concurrency },
          processBaseline: { heapUsed: 100000, arrayBuffers: 50000, rss: 1000000 },
          processPeak: { heapUsed: 100000 + 1000 * (iteration + 1), arrayBuffers: 50000 + 500 * (iteration + 1), rss: 1000000 + 250 * (iteration + 1) } } });
    }
    report.scenarios.push(row);
  }
  return { report, files };
}
function rejectMutations(mutations) {
  for (const [index, mutate] of mutations.entries()) {
    const { report } = fixture(); mutate(report);
    assert.throws(() => validateTransportBenchmarkReport(report), /WGA_EVIDENCE_INVALID/, `mutation ${index}`);
  }
}

test('EVIDENCE transport benchmark requires installed Node provenance and exact bundle graph', () => {
  validateTransportBenchmarkReport(fixture().report);
  rejectMutations([
    report => { report.schemaVersion++; }, report => { report.status = 'failed'; }, report => { report.runtimeExecuted = false; },
    ...['sourceBuild', 'realGoogleSDK', 'workerdExecuted', 'liveGoogle', 'liveCloud', 'budgetsChosen'].map(key => report => { report[key] = true; }),
    report => { report.controlledFetch = false; }, report => { report.mode = 'cloudflare'; }, report => { report.responseChunkBytes++; },
    report => { report.timingSource = 'worker-Date.now'; }, report => { report.timingIncludes = 'RPC only'; },
    report => { report.scope = 'Cloudflare cold start'; }, report => { report.createdAt = 'not-a-date'; },
    report => { report.runtime.node = ''; }, report => { report.runtime.logicalCpus = 0; }, report => { report.runtime.nodeExecutableSha256 = ''; },
    report => { delete report.evidence['scripts/benchmark.cjs']; }, report => { report.evidence.extra = hash; },
    report => { report.installedPackage.name = '@grpc/grpc-js'; }, report => { report.installedPackage.alias = 'native-grpc'; },
    report => { report.installedPackage.path = 'dist/package.json'; }, report => { report.installedPackage.resolved = 'file:../..'; },
    report => { report.installedPackage.integrity = hash; }, report => { report.installedPackage.tarball.bytes = 0; },
    report => { report.installedPackage.tarball.path = '../outside.tgz'; },
    report => { report.installedInputs[prefix + '../outside.js'] = hash; }, report => { report.executionInputs.reverse(); },
    report => { report.executionInputs.push(report.executionInputs[0]); }, report => { report.executionInputs.shift(); },
    report => { report.bundle.status = 'skipped'; }, report => { report.bundle.config.minify = false; },
    report => { report.bundle.config.entryPoints = ['dist/index.mjs']; }, report => { report.bundle.scope = 'bundle executed in workerd'; },
    report => { report.bundle.path = '../client.mjs'; }, report => { report.bundle.gzipBytes = report.bundle.minifiedBytes; },
    report => { report.bundle.gzipLevel = 6; }, report => { delete report.generatedArtifacts[output]; },
    report => { report.bundle.inputSha256[prefix + 'dist/index.js'] = hash; },
    report => { report.bundle.metafile.inputs[prefix + 'dist/index.js'].imports.push({ path: 'node_modules/native-grpc/index.js' }); },
    report => { report.bundle.metafile.inputs[prefix + 'dist/index.js'].imports.push({ path: '@grpc/grpc-js', external: true }); },
    report => { report.bundle.metafile.outputs[output].entryPoint = prefix + 'dist/adapter.js'; },
    report => { report.bundle.metafile.outputs[output].bytes++; },
    report => { report.bundle.metafile.outputs[output].inputs[prefix + 'dist/index.js'].bytesInOutput = report.bundle.minifiedBytes + 1; },
    report => { report.bundle.metafile.outputs[output].exports = []; },
    report => { report.bundle.metafile.outputs[output].imports.push({ path: './native.js', external: true }); },
    report => { delete report.bundle.toolInputs['fixtures/worker/node_modules/@esbuild/linux-x64/bin/esbuild']; },
  ]);
});

test('EVIDENCE transport benchmark recomputes cold and iteration summaries without counting warmups', () => {
  const { report } = fixture(); validateTransportBenchmarkReport(report);
  assert.deepEqual(report.coldRequireMs.measurements.map(item => item.elapsedMs), [7, 6, 5, 4, 3, 2, 1]);
  assert.equal(report.scenarios[0].iterations[1].elapsedMs, 100);
  assert.equal(report.scenarios[0].latencyMs.p95, 12);
  rejectMutations([
    report => { report.coldRequireMs.entry = 'dist/index.js'; }, report => { report.coldRequireMs.scope = 'workerd startup'; },
    report => { report.coldRequireMs.measurements.pop(); }, report => { report.coldRequireMs.measurements[0].sample++; },
    report => { report.coldRequireMs.measurements[0].node = 'v18.0.0'; }, report => { report.coldRequireMs.measurements[0].elapsedMs = 0; },
    report => { report.coldRequireMs.p50++; }, report => { report.coldRequireMs.p95 = 99; },
    report => { report.scenarios[0].iterations[0].phase = 'measured'; }, report => { report.scenarios[0].iterations[0].iteration++; },
    report => { report.scenarios[0].iterations[2].elapsedMs = NaN; }, report => { report.scenarios[0].iterations[2].elapsedMs = Infinity; },
    report => { report.scenarios[0].latencyMs.samples = 14; }, report => { report.scenarios[0].latencyMs.p95 = 100; },
    report => { report.scenarios[0].payloadMiBPerSecondAtP50++; },
    report => { report.scenarios[0].buffering.peakObservedTransportRequestBytes++; },
    report => { report.scenarios[0].processMemoryDeltaBytes.peakRss++; },
    report => { report.scenarios[0].processMemoryDeltaBytes.scope = 'adapter-owned bytes'; },
    report => { report.scenarios[0].iterations[0].measurements.samples--; },
    report => { report.scenarios[0].iterations[0].measurements.bufferPeaks.requestBytes = 0; },
    report => { report.scenarios[0].iterations[0].measurements.processPeak.heapUsed = 0; },
    report => { report.scenarios[0].iterations[0].measurements.processBaseline.rss = Infinity; },
  ]);
});

test('EVIDENCE transport benchmark preserves four workloads, actual payload receipts and pre-close cleanup', () => {
  rejectMutations([
    report => { report.scenarios.pop(); }, report => { report.scenarios.reverse(); }, report => { report.caseCount--; },
    report => { report.scenarios[0].messageBytes--; }, report => { report.scenarios[1].messages--; },
    report => { report.scenarios[2].delayMs = 0; }, report => { report.scenarios[3].concurrency = 4; },
    report => { report.scenarios[0].repetitions = 10; }, report => { report.scenarios[0].warmups = 0; },
    report => { report.scenarios[0].fetches++; }, report => { report.scenarios[0].cleanAfterEveryIteration = false; },
    report => { report.scenarios[0].iterations.pop(); }, report => { report.scenarios[0].iterations[0].fetches++; },
    report => { report.scenarios[0].iterations[0].activeCalls = 1; }, report => { report.scenarios[0].iterations[0].resourcesCheckedBeforeClose = false; },
    report => { report.scenarios[0].iterations[0].resources.queuedCalls = 1; }, report => { report.scenarios[0].iterations[0].resources.bufferedBytes = 1; },
    report => { report.scenarios[3].iterations[0].resources.peakActiveCalls = 1; }, report => { report.scenarios[3].iterations[0].calls.pop(); },
    ...[
      call => { call.id = 'synthetic-other-call'; }, call => { call.receipt.id = 'synthetic-other-fetch'; },
      call => { call.statusCodes.push(0); }, call => { call.statusCodes[0] = 14; }, call => { call.callbackCount++; },
      call => { call.responseMessages++; }, call => { call.responsePayloadBytes--; },
      call => { call.receipt.requestPayloadVerified = false; }, call => { call.receipt.requestWireBytes--; },
      call => { call.receipt.requestPayloadBytes--; }, call => { call.receipt.method = '/other.Service/Call'; },
      call => { call.receipt.messages++; }, call => { call.receipt.trailers = 0; }, call => { call.receipt.responseWireBytes--; },
      call => { call.receipt.chunks--; }, call => { call.receipt.bodyLocked = true; },
      call => { call.receipt.ended = false; }, call => { call.receipt.cancellations = 2; },
      call => { call.diagnostics.terminal = false; }, call => { call.diagnostics.fetchCount = 2; },
      call => { call.diagnostics.responseBytes = 1; }, call => { call.diagnostics.timerActive = true; },
      call => { call.execution.activePumps = 1; }, call => { call.execution.pendingWriteCallbacks = 1; },
      call => { call.execution.parserAssemblyBytes = 1; }, call => { call.execution.runtimeChunkBytes = 1; },
    ].map(mutate => report => mutate(report.scenarios[0].iterations[0].calls[0])),
    report => { report.scenarios[1].buffering.readableHighWaterMark = 0; },
    report => { report.scenarios[2].iterations[0].calls[0].delays--; },
    report => { report.resourcesCheckedBeforeClose = false; }, report => { report.logicalCalls--; }, report => { report.fetches--; },
  ]);
  const { report } = fixture();
  Object.assign(report.scenarios[0].iterations[0].calls[0].receipt, { ended: false, cancellations: 1 });
  validateTransportBenchmarkReport(report);
});

test('EVIDENCE transport benchmark checks real artifact bytes and detects self-consistent installed-package tampering', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-transport-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = fixture();
  function reset() {
    fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root);
    for (const [file, bytes] of original.files) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    }
    return structuredClone(original.report);
  }
  validateTransportBenchmarkArtifacts(reset(), root);
  for (const file of [output, output + '.gz', manifest, prefix + 'dist/index.js', prefix + 'dist/adapter.js',
    'scripts/benchmark.cjs', 'fixtures/worker/node_modules/@esbuild/linux-x64/bin/esbuild', tarballPath]) {
    const report = reset(); fs.appendFileSync(path.join(root, file), 'changed');
    assert.throws(() => validateTransportBenchmarkArtifacts(report, root), /WGA_EVIDENCE_INVALID/, file);
  }
  {
    const report = reset(), file = prefix + 'dist/index.js';
    // Updating both installed and bundle-input hashes cannot evade the packed
    // tar member comparison tied to the fixture lock integrity.
    const changed = Buffer.from('module.exports={tampered:true};\n'); fs.writeFileSync(path.join(root, file), changed);
    report.installedInputs[file] = report.bundle.inputSha256[file] = digest(changed);
    assert.throws(() => validateTransportBenchmarkArtifacts(report, root), /installed input differs from packed member/);
  }
  {
    const report = reset(), file = 'fixtures/worker/package-lock.json';
    const lock = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); lock.packages['node_modules/@grpc/grpc-js'].resolved = 'file:../other.tgz';
    const changed = Buffer.from(JSON.stringify(lock)); fs.writeFileSync(path.join(root, file), changed); report.evidence[file] = digest(changed);
    assert.throws(() => validateTransportBenchmarkArtifacts(report, root), /actual installed package\/lock identity/);
  }
  {
    const report = reset(), file = output + '.gz';
    const changed = zlib.gzipSync(Buffer.from('a different compressed output'), { level: 9 }); fs.writeFileSync(path.join(root, file), changed);
    report.bundle.gzipSha256 = report.generatedArtifacts[file] = digest(changed); report.bundle.gzipBytes = changed.length;
    assert.throws(() => validateTransportBenchmarkArtifacts(report, root), /actual minified\/gzip bytes and encoding/);
  }
  {
    const report = reset(); fs.unlinkSync(path.join(root, output));
    assert.throws(() => validateTransportBenchmarkArtifacts(report, root), /missing regular artifact/);
  }
});
