'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const prefix = 'fixtures/worker/node_modules/@grpc/grpc-js/';
const sources = ['scripts/benchmark.cjs', 'scripts/transport-benchmark-evidence.cjs',
  'fixtures/worker/package.json', 'fixtures/worker/package-lock.json'];
const artifacts = ['verification/transport-benchmark/client.mjs', 'verification/transport-benchmark/client.mjs.gz',
  'verification/transport-benchmark/esbuild-metafile.json'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0;
const safe = value => text(value) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some(part => ['', '.', '..'].includes(part));
const keys = value => Object.keys(value || {}).sort();
function need(value, message) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: transport benchmark ${message}`); }
function equal(actual, expected, message) { need(isDeepStrictEqual(actual, expected), message); }
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length / 2) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}
// This oracle deliberately declares workloads independently of benchmark.cjs.
const workloads = [
  { name: 'large-unary', requestBytes: 524288, messageBytes: 524288, messages: 1, concurrency: 1, delayMs: 0, stream: false },
  { name: 'many-small', requestBytes: 32, messageBytes: 1024, messages: 256, concurrency: 1, delayMs: 0, stream: true },
  { name: 'slow-consumer', requestBytes: 32, messageBytes: 1024, messages: 64, concurrency: 1, delayMs: 1, stream: true },
  { name: 'concurrent-unary', requestBytes: 65536, messageBytes: 65536, messages: 1, concurrency: 8, delayMs: 0, stream: false },
];
function validateTransportBenchmarkReport(report) {
  need(report?.schemaVersion === 1 && report.status === 'passed' && report.runtimeExecuted === true, 'completed execution');
  for (const flag of ['sourceBuild', 'realGoogleSDK', 'workerdExecuted', 'liveGoogle', 'liveCloud', 'budgetsChosen']) need(report[flag] === false, `${flag} boundary`);
  need(report.controlledFetch === true && report.mode === 'grpc-web' && report.responseChunkBytes === 16384, 'controlled transport');
  need(report.timingSource === 'node:perf_hooks.performance.now'
    && report.timingIncludes === 'RPC, controlled peer, payload assertions, diagnostics, and configured consumer delay; cleanup checkpoint excluded', 'clock/timing boundary');
  need(report.scope === 'Installed adapter in local Node with a controlled Fetch peer; no network, SDK, workerd, deployed Workers, speedup, or SLO claim', 'measurement scope');
  need(text(report.createdAt) && Number.isFinite(Date.parse(report.createdAt)), 'execution date');
  const runtime = report.runtime;
  need(runtime && /^v\d+\.\d+\.\d+/.test(runtime.node) && ['v8', 'platform', 'arch', 'kernel', 'cpuModel'].every(key => text(runtime[key]))
    && integer(runtime.logicalCpus, 1) && integer(runtime.totalMemoryBytes, 1) && hash(runtime.nodeExecutableSha256), 'actual runtime environment');
  equal(keys(report.evidence), [...sources].sort(), 'exact source/lock input set');
  need(Object.values(report.evidence).every(hash), 'source hashes');
  const installed = report.installedPackage;
  need(installed?.path === `${prefix}package.json` && installed.name === 'workers-grpc-adapter'
    && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(installed.version) && installed.alias === '@grpc/grpc-js'
    && installed.lockfile === 'fixtures/worker/package-lock.json' && installed.lockEntry === 'node_modules/@grpc/grpc-js', 'installed alias identity');
  need(installed.resolved === `file:../../artifacts/workers-grpc-adapter-${installed.version}.tgz`
    && /^sha512-[A-Za-z0-9+/]{86}==$/.test(installed.integrity), 'packed fixture lock entry');
  need(installed.tarball?.path === `artifacts/workers-grpc-adapter-${installed.version}.tgz`
    && integer(installed.tarball.bytes, 1) && hash(installed.tarball.sha256), 'packed artifact provenance');
  need(keys(report.installedInputs).length > 2 && keys(report.installedInputs).every(file => safe(file) && file.startsWith(prefix))
    && Object.values(report.installedInputs).every(hash), 'installed input hashes');
  need(Array.isArray(report.executionInputs) && report.executionInputs.length > 2
    && report.executionInputs.every(file => safe(file) && file.startsWith(prefix) && hash(report.installedInputs[file])), 'executed module inputs');
  equal(report.executionInputs, [...new Set(report.executionInputs)].sort(), 'unique sorted execution modules');
  for (const file of ['dist/index.js', 'dist/adapter.js']) need(report.executionInputs.includes(prefix + file), 'executed adapter entry');
  const cold = report.coldRequireMs;
  need(cold?.entry === `${prefix}dist/index.js` && Array.isArray(cold.measurements) && cold.measurements.length === 7
    && cold.scope === 'Fresh Node process require only; process startup excluded; not workerd cold start', 'cold Node require scope/count');
  cold.measurements.forEach((value, index) => need(value.sample === index && value.node === runtime.node && positive(value.elapsedMs), 'fresh Node timing samples'));
  equal(Object.fromEntries(['samples', 'min', 'p50', 'p95', 'max'].map(key => [key, cold[key]])), summary(cold.measurements.map(value => value.elapsedMs)), 'cold summary from raw samples');
  const bundle = report.bundle;
  need(bundle?.status === 'measured' && bundle.name === 'transport-only' && /^\d+\.\d+\.\d+$/.test(bundle.esbuild), 'required bundle build');
  equal(bundle.config, { absWorkingDir: '.', entryPoints: [`${prefix}dist/index.mjs`], outfile: artifacts[0],
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: ['es2022'], external: ['node:*'],
    minify: true, metafile: true, sourcemap: false, legalComments: 'none' }, 'exact bundle build configuration');
  need(bundle.scope === 'Installed client root ESM entry; Node builtins external; no Google SDK or Workers CJS require bridge; bundle not executed.', 'bundle scope');
  need(bundle.path === artifacts[0] && bundle.gzipPath === artifacts[1] && bundle.metafilePath === artifacts[2]
    && integer(bundle.minifiedBytes, 1) && integer(bundle.gzipBytes, 1) && bundle.gzipBytes < bundle.minifiedBytes
    && bundle.gzipLevel === 9 && hash(bundle.sha256) && hash(bundle.gzipSha256) && hash(bundle.metafileSha256), 'bundle artifacts');
  equal(report.generatedArtifacts, { [artifacts[0]]: bundle.sha256, [artifacts[1]]: bundle.gzipSha256,
    [artifacts[2]]: bundle.metafileSha256 }, 'generated artifact manifest');
  const metafile = bundle.metafile;
  need(metafile && keys(metafile.inputs).length > 1 && keys(metafile.inputs).every(file => safe(file) && file.startsWith(prefix)), 'installed transport-only build inputs');
  equal(keys(metafile.outputs), [artifacts[0]], 'one minified client output');
  equal(keys(bundle.inputSha256), keys(metafile.inputs), 'complete build input hashes');
  for (const [file, input] of Object.entries(metafile.inputs)) {
    need(hash(bundle.inputSha256[file]) && bundle.inputSha256[file] === report.installedInputs[file] && integer(input.bytes, 1), 'bundle/installed input identity');
    need(Array.isArray(input.imports), 'input imports');
    for (const item of input.imports) need(item.external ? item.path.startsWith('node:') : Object.hasOwn(metafile.inputs, item.path), 'only installed imports or external Node builtins');
  }
  const output = metafile.outputs[artifacts[0]];
  need(output.entryPoint === `${prefix}dist/index.mjs` && output.bytes === bundle.minifiedBytes, 'output entry/bytes');
  equal(keys(output.inputs), keys(metafile.inputs), 'output attribution');
  need(Object.values(output.inputs).every(value => integer(value.bytesInOutput))
    && Object.values(output.inputs).reduce((sum, value) => sum + value.bytesInOutput, 0) <= output.bytes, 'output byte contributions');
  need(Array.isArray(output.exports) && output.exports.includes('Client') && output.exports.includes('Metadata')
    && output.exports.includes('makeGenericClientConstructor'), 'client bundle surface');
  need(Array.isArray(output.imports) && output.imports.every(item => item.external === true && item.path.startsWith('node:')), 'external Node builtins only');
  const binaryPrefix = `fixtures/worker/node_modules/@esbuild/${runtime.platform}-${runtime.arch}/`;
  equal(keys(bundle.toolInputs), ['fixtures/worker/node_modules/esbuild/package.json', 'fixtures/worker/node_modules/esbuild/lib/main.js',
    `${binaryPrefix}package.json`, `${binaryPrefix}${runtime.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`].sort(), 'actual esbuild/binary inputs');
  need(Object.values(bundle.toolInputs).every(hash), 'esbuild/binary hashes');
  equal(keys(report.installedInputs), [...new Set([...report.executionInputs, ...keys(bundle.inputSha256), `${prefix}package.json`])].sort(), 'complete installed input manifest');
  need(Array.isArray(report.scenarios) && report.scenarios.length === 4 && report.caseCount === 4, 'exact scenario matrix');
  report.scenarios.forEach((row, rowIndex) => {
    const config = workloads[rowIndex];
    equal(Object.fromEntries(Object.keys(config).map(key => [key, row[key]])), config, 'fixed workload');
    need(row.status === 'passed' && row.repetitions === 12 && row.warmups === 2
      && row.fetches === 14 * config.concurrency && row.cleanAfterEveryIteration === true, 'scenario execution');
    need(Array.isArray(row.iterations) && row.iterations.length === 14, 'all raw warmup/measured iterations');
    row.iterations.forEach((iteration, index) => {
      need(iteration.iteration === index && iteration.phase === (index < 2 ? 'warmup' : 'measured') && positive(iteration.elapsedMs), 'iteration order/clock');
      need(iteration.fetches === config.concurrency && iteration.activeCalls === 0
        && iteration.resourcesCheckedBeforeClose === true, 'Fetch accounting/pre-close cleanup');
      const usage = iteration.resources;
      need(usage && usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0
        && usage.peakActiveCalls === config.concurrency && usage.peakQueuedCalls === 0 && integer(usage.peakBufferedBytes, 1), 'released resource budget');
      need(Array.isArray(iteration.calls) && iteration.calls.length === config.concurrency, 'logical call count');
      iteration.calls.forEach((call, callIndex) => {
        need(call.id === `${config.name}/${index}/${callIndex}` && call.receipt?.id === call.id, 'physical Fetch/call identity');
        equal(call.statusCodes, [0], 'one successful terminal status');
        need(call.callbackCount === (config.stream ? 0 : 1) && call.responseMessages === config.messages
          && call.responsePayloadBytes === config.messageBytes * config.messages
          && call.delays === (config.delayMs ? config.messages : 0), 'consumer work/result');
        const receipt = call.receipt;
        need(receipt.method === '/benchmark.Bytes/Run' && receipt.requestWireBytes === config.requestBytes + 5
          && receipt.requestPayloadBytes === config.requestBytes && receipt.requestPayloadVerified === true
          && receipt.messages === config.messages && receipt.trailers === 1
          && receipt.responseWireBytes === config.messages * (config.messageBytes + 5) + 21
          && receipt.chunks === config.messages * Math.ceil((config.messageBytes + 5) / 16384) + 1, 'actual peer payload/frame/chunk counts');
        need(receipt.bodyLocked === false && ((receipt.ended === true && receipt.cancellations === 0)
          || (receipt.ended === false && receipt.cancellations === 1)), 'response body released');
        equal(call.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }, 'terminal buffer/timer cleanup');
        equal(call.execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }, 'actual async owner cleanup');
      });
      const measured = iteration.measurements;
      need(measured?.samples === config.concurrency * (config.messages + 1) + 1, 'sampling checkpoints');
      equal(keys(measured.bufferPeaks), ['readableBytes', 'requestBytes', 'responseBytes'].sort(), 'sampled diagnostic fields');
      need(Object.values(measured.bufferPeaks).every(value => integer(value)) && measured.bufferPeaks.requestBytes >= config.requestBytes, 'observed buffer peaks');
      for (const kind of ['processBaseline', 'processPeak']) {
        equal(keys(measured[kind]), ['heapUsed', 'arrayBuffers', 'rss'].sort(), 'sampled process memory fields');
        need(Object.values(measured[kind]).every(value => integer(value)), 'finite memory measurements');
      }
      need(['heapUsed', 'arrayBuffers', 'rss'].every(key => measured.processPeak[key] >= measured.processBaseline[key]), 'process peak includes baseline');
    });
    const latency = summary(row.iterations.slice(2).map(iteration => iteration.elapsedMs));
    equal(row.latencyMs, latency, 'latency summary from raw measured samples, excluding warmups');
    need(row.payloadMiBPerSecondAtP50 === config.concurrency * config.messages * config.messageBytes / 1048576 / (latency.p50 / 1000), 'derived throughput');
    const peaks = key => Math.max(...row.iterations.map(iteration => iteration.measurements.bufferPeaks[key]));
    const delta = key => Math.max(...row.iterations.map(iteration => iteration.measurements.processPeak[key] - iteration.measurements.processBaseline[key]));
    need(row.buffering && (config.stream ? integer(row.buffering.readableHighWaterMark, 1) : row.buffering.readableHighWaterMark === 0), 'observed Node Readable high water mark');
    equal(row.buffering, { readableHighWaterMark: row.buffering.readableHighWaterMark,
      peakObservedReadableBytes: peaks('readableBytes'), peakObservedTransportRequestBytes: peaks('requestBytes'), peakObservedTransportResponseBytes: peaks('responseBytes'),
      scope: 'Sampled adapter diagnostics and Readable Buffer queue bytes; not a total memory bound.' }, 'sampled buffering scope/summary');
    equal(row.processMemoryDeltaBytes, { peakHeapUsed: delta('heapUsed'), peakArrayBuffers: delta('arrayBuffers'), peakRss: delta('rss'),
      scope: 'Process-wide sampled deltas relative to each iteration baseline; includes fixtures and GC, not adapter-owned memory.' }, 'process memory scope/summary');
  });
  need(report.logicalCalls === 154 && report.fetches === 154 && report.resourcesCheckedBeforeClose === true, 'aggregate call accounting');
  return report;
}
function validateTransportBenchmarkArtifacts(report, root) {
  validateTransportBenchmarkReport(report);
  function read(file) {
    need(safe(file), 'unsafe artifact path');
    const target = path.join(root, file);
    need(fs.existsSync(target) && fs.lstatSync(target).isFile(), `missing regular artifact ${file}`);
    return fs.readFileSync(target);
  }
  for (const [file, expected] of Object.entries({ ...report.evidence, ...report.installedInputs, ...report.bundle.toolInputs, ...report.generatedArtifacts }))
    need(digest(read(file)) === expected, `artifact hash drift ${file}`);
  const pkg = report.installedPackage;
  const installed = JSON.parse(read(pkg.path)), lock = JSON.parse(read(pkg.lockfile)), fixture = JSON.parse(read('fixtures/worker/package.json'));
  const locked = lock.packages?.[pkg.lockEntry];
  need(installed.name === pkg.name && installed.version === pkg.version && locked?.name === pkg.name
    && locked.version === pkg.version && locked.resolved === pkg.resolved && locked.integrity === pkg.integrity
    && fixture.dependencies?.[pkg.alias] === pkg.resolved, 'actual installed package/lock identity');
  const tarball = read(pkg.tarball.path);
  need(tarball.length === pkg.tarball.bytes && digest(tarball) === pkg.tarball.sha256
    && `sha512-${createHash('sha512').update(tarball).digest('base64')}` === pkg.integrity, 'actual packed tarball identity');
  // Read tar members without extracting paths. Every measured installed source
  // must also match the lock-identified packed artifact, not a linked root dist.
  const archive = zlib.gunzipSync(tarball, { maxOutputLength: 64 * 1024 * 1024 }), members = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/s, '').trim();
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/'), sizeField = field(124, 12);
    need(/^[0-7]+$/.test(sizeField), 'packed tar member size');
    const bytes = parseInt(sizeField, 8); need(integer(bytes) && offset + 512 + bytes <= archive.length, 'packed tar member bounds');
    if (header[156] === 0 || header[156] === 48) {
      need(safe(name) && !members.has(name), 'unique safe packed member');
      members.set(name, archive.subarray(offset + 512, offset + 512 + bytes));
    }
    offset += 512 + Math.ceil(bytes / 512) * 512;
  }
  for (const [file, expected] of Object.entries(report.installedInputs)) {
    const member = members.get(`package/${file.slice(prefix.length)}`);
    need(member && digest(member) === expected, `installed input differs from packed member ${file}`);
  }
  const bundle = report.bundle, bytes = read(bundle.path), gzip = read(bundle.gzipPath);
  need(bytes.length === bundle.minifiedBytes && gzip.length === bundle.gzipBytes
    && zlib.gunzipSync(gzip, { maxOutputLength: bytes.length }).equals(bytes)
    && zlib.gzipSync(bytes, { level: 9 }).equals(gzip), 'actual minified/gzip bytes and encoding');
  equal(JSON.parse(read(bundle.metafilePath)), bundle.metafile, 'actual esbuild input/output manifest');
  for (const [file, input] of Object.entries(bundle.metafile.inputs)) need(read(file).length === input.bytes, 'actual esbuild input byte length');
  for (const file of Object.keys(bundle.toolInputs).filter(file => file.endsWith('/package.json'))) {
    const relative = file.slice('fixtures/worker/'.length), installedTool = JSON.parse(read(file));
    need(installedTool.version === bundle.esbuild && lock.packages?.[relative.slice(0, -'/package.json'.length)]?.version === bundle.esbuild,
      'actual installed esbuild version/lock');
  }
  return report;
}
module.exports = { validateTransportBenchmarkReport, validateTransportBenchmarkArtifacts, sources, artifacts };
