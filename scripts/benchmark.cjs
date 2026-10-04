'use strict';
// Installed transport microbenchmarks with a controlled Fetch peer. Timing
// includes fixture validation/diagnostics and is not a network or Workers SLO.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const zlib = require('node:zlib');
const { validateTransportBenchmarkReport, validateTransportBenchmarkArtifacts, sources } = require('./transport-benchmark-evidence.cjs');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const grpc = workerRequire('@grpc/grpc-js');
const { createWorkersGrpcTransport } = workerRequire('@grpc/grpc-js/adapter');
const installedRoot = 'fixtures/worker/node_modules/@grpc/grpc-js/';
const repetitions = 12, warmups = 2, chunkBytes = 16 * 1024;
const cases = [
  { name: 'large-unary', requestBytes: 512 * 1024, messageBytes: 512 * 1024, messages: 1, concurrency: 1, delayMs: 0, stream: false },
  { name: 'many-small', requestBytes: 32, messageBytes: 1024, messages: 256, concurrency: 1, delayMs: 0, stream: true },
  { name: 'slow-consumer', requestBytes: 32, messageBytes: 1024, messages: 64, concurrency: 1, delayMs: 1, stream: true },
  { name: 'concurrent-unary', requestBytes: 64 * 1024, messageBytes: 64 * 1024, messages: 1, concurrency: 8, delayMs: 0, stream: false },
];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = file => digest(fs.readFileSync(path.join(root, file)));
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}
// The peer frames bytes independently of the adapter encoder/parser.
function frame(payload, trailer = false) {
  const header = Buffer.alloc(5); header[0] = trailer ? 128 : 0; header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
const trailer = frame(Buffer.from('grpc-status: 0\r\n'), true);
function wireSource(config, receipt) {
  let index = 0, current, offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (!current || offset === current.length) {
        if (index > config.messages) { receipt.ended = true; controller.close(); return; }
        current = index === config.messages ? trailer : frame(Buffer.alloc(config.messageBytes, index & 255));
        if (index === config.messages) receipt.trailers++; else receipt.messages++;
        index++; offset = 0;
      }
      const end = Math.min(current.length, offset + chunkBytes), chunk = current.subarray(offset, end);
      receipt.responseWireBytes += chunk.length; receipt.chunks++;
      controller.enqueue(chunk); offset = end;
    },
    cancel() { receipt.cancellations++; },
  }, { highWaterMark: 0 });
}
function transportCall(surface) {
  let call = surface.call;
  while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
  assert.ok(call, 'missing installed transport diagnostics');
  return call;
}
function memory() {
  const { heapUsed, arrayBuffers, rss } = process.memoryUsage(); return { heapUsed, arrayBuffers, rss };
}
async function scenario(config) {
  const generated = grpc.makeGenericClientConstructor({ run: {
    path: '/benchmark.Bytes/Run', requestStream: false, responseStream: config.stream,
    requestSerialize: value => value, responseDeserialize: value => value,
  } }, 'benchmark.Bytes');
  let current, fetches = 0, readableHighWaterMark = 0;
  const active = new Map(), iterations = [];
  const sample = () => {
    let readableBytes = 0, requestBytes = 0, responseBytes = 0;
    for (const entry of active.values()) {
      readableBytes += (entry.surface.readableLength ?? 0) * config.messageBytes;
      const diagnostics = entry.transport.diagnostics();
      requestBytes += diagnostics.requestBytes; responseBytes += diagnostics.responseBytes;
    }
    const observed = current.measurements;
    observed.samples++;
    for (const [key, value] of Object.entries({ readableBytes, requestBytes, responseBytes }))
      observed.bufferPeaks[key] = Math.max(observed.bufferPeaks[key], value);
    for (const [key, value] of Object.entries(memory())) observed.processPeak[key] = Math.max(observed.processPeak[key], value);
  };
  const factory = createWorkersGrpcTransport({ mode: 'grpc-web',
    endpoints: { 'benchmark.invalid': 'https://benchmark-gateway.invalid' },
    fetcher: { fetch: async (url, init) => {
      assert.equal(url, 'https://benchmark-gateway.invalid/benchmark.Bytes/Run');
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual');
      assert.equal(init.cf.grpcWeb, 'passthrough');
      assert.equal(init.headers.get('content-type'), 'application/grpc-web+proto');
      assert.equal(init.headers.get('authorization'), null);
      const entry = active.get(init.headers.get('x-benchmark-call-id'));
      assert.ok(entry, 'Fetch must identify a started logical call');
      assert.equal(entry.receipt, undefined, 'exactly one Fetch per call');
      const body = Buffer.from(init.body);
      assert.equal(body.length, config.requestBytes + 5); assert.equal(body[0], 0);
      assert.equal(body.readUInt32BE(1), config.requestBytes);
      assert.ok(body.subarray(5).equals(Buffer.alloc(config.requestBytes, 3)), 'request payload');
      entry.receipt = { id: entry.id, method: '/benchmark.Bytes/Run', requestWireBytes: body.length,
        requestPayloadBytes: body.length - 5, requestPayloadVerified: true, messages: 0, trailers: 0,
        responseWireBytes: 0, chunks: 0, ended: false, cancellations: 0 };
      fetches++; sample();
      entry.body = wireSource(config, entry.receipt);
      return new Response(entry.body, { headers: { 'content-type': 'application/grpc-web+proto' } });
    } },
  });
  const client = new generated('benchmark.invalid', factory.channelCredentials, factory.grpcOptions());
  async function single(index) {
    const id = `${config.name}/${current.iteration}/${index}`;
    const entry = { id, statusCodes: [], callbackCount: 0, responseMessages: 0, responsePayloadBytes: 0, delays: 0 };
    const metadata = new grpc.Metadata(); metadata.set('x-benchmark-call-id', id);
    const request = Buffer.alloc(config.requestBytes, 3);
    const accept = value => {
      assert.ok(Buffer.isBuffer(value));
      assert.ok(value.equals(Buffer.alloc(config.messageBytes, entry.responseMessages & 255)), 'complete response payload');
      entry.responseMessages++; entry.responsePayloadBytes += value.length; sample();
    };
    let completed;
    if (config.stream) entry.surface = client.run(request, metadata);
    else completed = new Promise((resolve, reject) => {
      entry.surface = client.run(request, metadata, (error, value) => {
        entry.callbackCount++; error ? reject(error) : resolve(value);
      });
    });
    entry.transport = transportCall(entry.surface); active.set(id, entry);
    entry.surface.on('status', status => entry.statusCodes.push(status.code));
    if (config.stream) {
      readableHighWaterMark = entry.surface.readableHighWaterMark;
      for await (const value of entry.surface) {
        accept(value);
        if (config.delayMs) { entry.delays++; await new Promise(resolve => setTimeout(resolve, config.delayMs)); }
      }
    } else accept(await completed);
    assert.equal(entry.responseMessages, config.messages);
  }
  try {
    for (let iteration = 0; iteration < warmups + repetitions; iteration++) {
      const baseline = memory(), beforeFetches = fetches;
      current = { iteration, phase: iteration < warmups ? 'warmup' : 'measured',
        measurements: { samples: 0, bufferPeaks: { readableBytes: 0, requestBytes: 0, responseBytes: 0 },
          processBaseline: baseline, processPeak: { ...baseline } } };
      const started = performance.now();
      await Promise.all(Array.from({ length: config.concurrency }, (_, index) => single(index)));
      current.elapsedMs = performance.now() - started;
      // Local terminal callbacks precede a pump's final microtask. Sample actual
      // owners after it unwinds, before client.close can mask a leak.
      await new Promise(resolve => setImmediate(resolve));
      sample();
      current.fetches = fetches - beforeFetches;
      current.calls = [...active.values()].map(entry => ({ id: entry.id, statusCodes: entry.statusCodes,
        callbackCount: entry.callbackCount, responseMessages: entry.responseMessages, responsePayloadBytes: entry.responsePayloadBytes,
        delays: entry.delays, receipt: { ...entry.receipt, bodyLocked: entry.body.locked },
        diagnostics: entry.transport.diagnostics(), execution: entry.transport.executionDiagnostics() }));
      current.activeCalls = client.getChannel().activeCallCount(); current.resources = factory.resourceUsage();
      current.resourcesCheckedBeforeClose = true;
      iterations.push(current); active.clear();
    }
    const timings = iterations.filter(iteration => iteration.phase === 'measured').map(iteration => iteration.elapsedMs);
    const latencyMs = summary(timings);
    const peak = key => Math.max(...iterations.map(iteration => iteration.measurements.bufferPeaks[key]));
    const delta = key => Math.max(...iterations.map(iteration => iteration.measurements.processPeak[key] - iteration.measurements.processBaseline[key]));
    return { ...config, status: 'passed', repetitions, warmups, fetches, iterations, latencyMs,
      payloadMiBPerSecondAtP50: config.concurrency * config.messages * config.messageBytes / 1048576 / (latencyMs.p50 / 1000),
      buffering: { readableHighWaterMark, peakObservedReadableBytes: peak('readableBytes'), peakObservedTransportRequestBytes: peak('requestBytes'),
        peakObservedTransportResponseBytes: peak('responseBytes'), scope: 'Sampled adapter diagnostics and Readable Buffer queue bytes; not a total memory bound.' },
      processMemoryDeltaBytes: { peakHeapUsed: delta('heapUsed'), peakArrayBuffers: delta('arrayBuffers'), peakRss: delta('rss'),
        scope: 'Process-wide sampled deltas relative to each iteration baseline; includes fixtures and GC, not adapter-owned memory.' },
      cleanAfterEveryIteration: true };
  } finally { client.close(); }
}
async function bundleSizes() {
  assert.equal(process.env.ESBUILD_BINARY_PATH, undefined, 'benchmark requires the fixture-installed esbuild binary');
  const esbuild = workerRequire('esbuild');
  const config = { absWorkingDir: '.', entryPoints: [`${installedRoot}dist/index.mjs`], outfile: 'verification/transport-benchmark/client.mjs',
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: ['es2022'], external: ['node:*'],
    minify: true, metafile: true, sourcemap: false, legalComments: 'none' };
  const output = await esbuild.build({ ...config, absWorkingDir: root });
  assert.equal(output.outputFiles.length, 1);
  const bytes = output.outputFiles[0].contents, gzip = zlib.gzipSync(bytes, { level: 9 });
  const metafilePath = 'verification/transport-benchmark/esbuild-metafile.json';
  const gzipPath = `${config.outfile}.gz`, metafileBytes = Buffer.from(JSON.stringify(output.metafile, null, 2) + '\n');
  fs.mkdirSync(path.dirname(path.join(root, config.outfile)), { recursive: true });
  for (const [file, contents] of [[config.outfile, bytes], [gzipPath, gzip], [metafilePath, metafileBytes]]) fs.writeFileSync(path.join(root, file), contents);
  const relative = file => path.relative(root, file).split(path.sep).join('/');
  const platformPackage = `@esbuild/${process.platform}-${process.arch}`;
  const binary = workerRequire.resolve(`${platformPackage}/${process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`);
  assert.equal(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim(), esbuild.version);
  const toolInputs = [workerRequire.resolve('esbuild/package.json'), workerRequire.resolve('esbuild'),
    workerRequire.resolve(`${platformPackage}/package.json`), binary].map(relative);
  return { status: 'measured', name: 'transport-only', esbuild: esbuild.version, config, minifiedBytes: bytes.length,
    gzipBytes: gzip.length, sha256: digest(bytes), gzipSha256: digest(gzip), path: config.outfile, gzipPath, gzipLevel: 9,
    metafilePath, metafileSha256: digest(metafileBytes), metafile: output.metafile,
    inputSha256: Object.fromEntries(Object.keys(output.metafile.inputs).map(file => [file, fileHash(file)])),
    toolInputs: Object.fromEntries(toolInputs.map(file => [file, fileHash(file)])),
    scope: 'Installed client root ESM entry; Node builtins external; no Google SDK or Workers CJS require bridge; bundle not executed.' };
}
async function main() {
  const packagePath = workerRequire.resolve('@grpc/grpc-js/package.json');
  assert.equal(fs.realpathSync(path.dirname(packagePath)), path.resolve(root, installedRoot), 'a real installed packed fixture is required');
  const installed = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const lockfile = 'fixtures/worker/package-lock.json', lock = JSON.parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
  const lockEntry = lock.packages['node_modules/@grpc/grpc-js'];
  const tarballPath = path.relative(root, path.resolve(root, 'fixtures/worker', lockEntry.resolved.slice('file:'.length))).split(path.sep).join('/');
  const tarball = fs.readFileSync(path.join(root, tarballPath));
  assert.equal(lockEntry.integrity, `sha512-${createHash('sha512').update(tarball).digest('base64')}`);
  const cold = [];
  const entry = `${installedRoot}dist/index.js`;
  for (let sample = 0; sample < 7; sample++) {
    const source = `const {performance}=require('node:perf_hooks');const started=performance.now();require(${JSON.stringify(path.join(root, entry))});` +
      `const elapsedMs=performance.now()-started;process.stdout.write(JSON.stringify({node:process.version,elapsedMs}));`;
    const child = JSON.parse(execFileSync(process.execPath, ['-e', source], { encoding: 'utf8', timeout: 10000 }));
    cold.push({ sample, ...child });
  }
  const results = [];
  for (const config of cases) results.push(await scenario(config));
  const bundle = await bundleSizes();
  const executionInputs = Object.keys(require.cache).filter(file => file.startsWith(path.join(root, installedRoot)))
    .map(file => path.relative(root, file).split(path.sep).join('/')).sort();
  const installedInputs = [...new Set([...executionInputs, ...Object.keys(bundle.inputSha256), `${installedRoot}package.json`])].sort();
  const report = { schemaVersion: 1, status: 'passed', createdAt: new Date().toISOString(), sourceBuild: false,
    runtimeExecuted: true, realGoogleSDK: false, workerdExecuted: false, liveGoogle: false, liveCloud: false,
    controlledFetch: true, mode: 'grpc-web', budgetsChosen: false, responseChunkBytes: chunkBytes,
    timingSource: 'node:perf_hooks.performance.now', timingIncludes: 'RPC, controlled peer, payload assertions, diagnostics, and configured consumer delay; cleanup checkpoint excluded',
    scope: 'Installed adapter in local Node with a controlled Fetch peer; no network, SDK, workerd, deployed Workers, speedup, or SLO claim',
    runtime: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
      kernel: os.release(), cpuModel: os.cpus()[0]?.model ?? 'unknown', logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(), nodeExecutableSha256: digest(fs.readFileSync(process.execPath)) },
    installedPackage: { path: `${installedRoot}package.json`, name: installed.name, version: installed.version,
      alias: '@grpc/grpc-js', lockfile, lockEntry: 'node_modules/@grpc/grpc-js', resolved: lockEntry.resolved,
      integrity: lockEntry.integrity, tarball: { path: tarballPath, bytes: tarball.length, sha256: digest(tarball) } },
    evidence: Object.fromEntries(sources.map(file => [file, fileHash(file)])), executionInputs,
    installedInputs: Object.fromEntries(installedInputs.map(file => [file, fileHash(file)])),
    coldRequireMs: { ...summary(cold.map(value => value.elapsedMs)), measurements: cold, entry,
      scope: 'Fresh Node process require only; process startup excluded; not workerd cold start' },
    bundle, generatedArtifacts: { [bundle.path]: bundle.sha256, [bundle.gzipPath]: bundle.gzipSha256, [bundle.metafilePath]: bundle.metafileSha256 },
    scenarios: results, caseCount: results.length, logicalCalls: results.reduce((sum, value) => sum + value.fetches, 0),
    fetches: results.reduce((sum, value) => sum + value.fetches, 0), resourcesCheckedBeforeClose: true };
  validateTransportBenchmarkReport(report); validateTransportBenchmarkArtifacts(report, root);
  fs.writeFileSync(path.join(root, 'verification/benchmark.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, report: 'verification/benchmark.json', minifiedBytes: bundle.minifiedBytes,
    gzipBytes: bundle.gzipBytes, logicalCalls: report.logicalCalls,
    scenarios: results.map(result => ({ name: result.name, p50Ms: result.latencyMs.p50, p95Ms: result.latencyMs.p95 })) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
