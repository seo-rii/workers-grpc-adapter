'use strict';
// Actual installed Google SDK entry graphs, executed locally in workerd.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const zlib = require('node:zlib');
const { validateSdkBenchmarkReport, summarize } = require('./sdk-benchmark-evidence.cjs');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const esbuild = workerRequire('esbuild');
const budgets = require('../fixtures/google/benchmark-budgets.json');
const graphNames = ['datastore', 'firestore', 'secret-manager', 'combined'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-sdk-benchmark-'));
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild: false,
  realGoogleSDK: true, runtimeExecuted: false, liveGoogle: false, liveCloud: false,
  incomingCloudflareTranslation: false, controlledPeer: true, compatibilityDate: '2026-09-21',
  timingSource: 'host-monotonic-wall-clock', heapSource: 'CDP.Runtime.getHeapUsage',
  isolateTotalMemoryMeasured: false, budgets, graphs: [], unexpectedRequests: 0,
  versions: { node: process.version, platform: process.platform, arch: process.arch,
    miniflare: workerRequire('miniflare/package.json').version, workerd: workerRequire('workerd/package.json').version,
    wrangler: workerRequire('wrangler/package.json').version, esbuild: esbuild.version },
};
function frame(bytes, flag = 0) {
  const result = Buffer.alloc(bytes.length + 5);
  result[0] = flag; result.writeUInt32BE(bytes.length, 1); result.set(bytes, 5); return result;
}
async function inspector(runtime) {
  const url = await runtime.getInspectorURL(); url.protocol = 'http:'; url.pathname = '/json/list';
  const targets = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
  const target = targets.find(value => value.id === 'core:user:sdk-benchmark');
  assert.ok(target, 'SDK_WORKER_INSPECTOR_TARGET');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('INSPECTOR_CONNECT_TIMEOUT')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('INSPECTOR_CONNECT')); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(`INSPECTOR_METHOD:${message.error.code}`)); else entry.resolve(message.result);
  });
  const stop = () => { for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('INSPECTOR_CLOSED')); } pending.clear(); };
  socket.addEventListener('close', stop); socket.addEventListener('error', stop);
  return { target: target.id, sample() {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('INSPECTOR_METHOD_TIMEOUT')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'Runtime.getHeapUsage' }));
    });
  }, close() { stop(); socket.close(); } };
}
function schemas(fixtureRequire, modern) {
  const protobuf = fixtureRequire('protobufjs');
  const load = (pkg, relative) => protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(
    path.dirname(fixtureRequire.resolve(`${pkg}/package.json`)), relative), 'utf8')));
  const datastore = load(modern ? '@google-cloud/datastore-api' : '@google-cloud/datastore', 'build/protos/protos.json');
  const firestore = load(modern ? '@google-cloud/firestore-api' : '@google-cloud/firestore', modern ? 'build/protos/protos.json' : 'build/protos/v1.json');
  const secret = load('@google-cloud/secret-manager', 'build/protos/protos.json');
  const method = (schema, request, response, reply) => ({ request: schema.lookupType(request), response: schema.lookupType(response), reply });
  return {
    '/google.datastore.v1.Datastore/Lookup': method(datastore, 'google.datastore.v1.LookupRequest', 'google.datastore.v1.LookupResponse',
      request => ({ missing: [{ entity: { key: request.keys[0] } }] })),
    '/google.firestore.v1.Firestore/BatchGetDocuments': method(firestore, 'google.firestore.v1.BatchGetDocumentsRequest', 'google.firestore.v1.BatchGetDocumentsResponse',
      request => ({ missing: request.documents[0], readTime: { seconds: 1 } })),
    '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret': method(secret, 'google.cloud.secretmanager.v1.GetSecretRequest', 'google.cloud.secretmanager.v1.Secret',
      request => ({ name: request.name })),
    '/google.firestore.v1.Firestore/RunQuery': method(firestore, 'google.firestore.v1.RunQueryRequest', 'google.firestore.v1.RunQueryResponse',
      (request, index) => ({ document: { name: `${request.parent}/benchmark/${String(index).padStart(4, '0')}`,
        fields: { index: { integerValue: index }, payload: { bytesValue: Buffer.alloc(budgets.payloadBytes, 65) } },
        createTime: { seconds: 1 }, updateTime: { seconds: 1 } }, readTime: { seconds: 1 } })),
  };
}
async function build(name, profile, fixtureRoot, fixtureRequire, entries) {
  const directory = path.join(temporary, `${profile}-${name}`); fs.mkdirSync(directory);
  const { createGoogleWorkerBuild } = fixtureRequire('@grpc/grpc-js/build');
  const preset = createGoogleWorkerBuild({ projectRoot: fixtureRoot, profile, outdir: path.join(directory, 'preset'), typescript: require('typescript') });
  const built = await esbuild.build({ absWorkingDir: root, entryPoints: [path.join(entries, `benchmark-${name}.mjs`)],
    bundle: true, metafile: true, minify: true, format: 'cjs', platform: 'node', target: 'es2022',
    outfile: path.join(directory, 'sdk.cjs'), plugins: [preset.plugin] });
  const main = path.join(directory, 'worker.mjs');
  fs.writeFileSync(main, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const config = path.join(directory, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-sdk-benchmark', main, compatibility_date: report.compatibilityDate,
    compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const key of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(key)) delete environment[key];
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
    'deploy', '--dry-run', '--config', config, '--outdir', path.join(directory, 'bundle'), '--minify', '--no-autoconfig'],
  { env: environment, stdio: 'pipe', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(directory, 'bundle/worker.js'), 'utf8'), manifest = preset.manifest();
  assert.equal(manifest.profile, profile);
  const fixture = budgets.profiles[profile].fixture, prefix = `fixtures/${fixture}/`;
  const installed = Object.keys(built.metafile.inputs).filter(file => file.includes('/node_modules/'));
  assert.ok(installed.length > 0 && installed.every(file => file.startsWith(prefix + 'node_modules/')), 'MIXED_DEPENDENCY_GRAPHS');
  assert.ok(installed.includes(prefix + 'node_modules/@grpc/grpc-js/dist/index.js'), 'INSTALLED_GRPC_REQUIRED');
  // Retain the actual pre-transform SDK bytes as well as the installed build
  // implementation and selected profile. Root verification re-hashes all of them.
  const buildEntry = fixtureRequire.resolve('@grpc/grpc-js/build');
  installed.push(path.relative(root, buildEntry), path.relative(root, path.join(path.dirname(buildEntry), 'profiles', `${profile}.json`)),
    ...manifest.packages.map(pkg => prefix + pkg.path + '/package.json'));
  const sourceCopies = Object.fromEntries([name, 'runtime'].map(part => {
    const original = `fixtures/google/benchmark-${part}.mjs`, copied = fs.readFileSync(path.join(entries, `benchmark-${part}.mjs`));
    assert.equal(digest(copied), digest(fs.readFileSync(path.join(root, original))), 'BENCHMARK_SOURCE_COPY_DRIFT');
    return [original, digest(copied)];
  }));
  const topLevelSdks = new Set(Object.keys(fixtureRequire('./package.json').dependencies).filter(name => name.startsWith('@google-cloud/')));
  return { script, data: { name, fixture, sourceCopies, sdkNames: name === 'combined' ? ['datastore', 'firestore', 'secret-manager'] : [name],
    bundleBytes: Buffer.byteLength(script), gzipBytes: zlib.gzipSync(script).byteLength, bundleSha256: digest(script),
    profile: manifest.profile, profileRevision: manifest.revision, profileSha256: manifest.profileSha256,
    profileInputSha256: manifest.inputSha256, profileCacheKey: manifest.cacheKey, transformer: manifest.transformer,
    sdkVersions: manifest.packages.filter(value => topLevelSdks.has(value.name)).map(({ name, version }) => ({ name, version })),
    installedInputs: Object.fromEntries(installed.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])), runs: [] } };
}
async function run(script, graph, sampleIndex, methods) {
  const limits = budgets.profiles[graph.profile];
  const run = { sample: sampleIndex, phases: [], heapSamples: [], peerReceipts: [], oauthRefreshes: [], memoryCheckpoints: 0 };
  graph.runs.push(run);
  let phase = 'ready', devtools, releaseCheckpoint;
  const checkpoint = new Promise(resolve => { releaseCheckpoint = resolve; });
  const bodies = [];
  const sampleHeap = async label => { const usage = await devtools.sample(); run.heapSamples.push({ label, ...usage }); };
  const outboundService = async request => {
    const url = new URL(request.url);
    if (url.hostname === 'benchmark-control.invalid' && url.pathname === '/held' && phase === 'concurrent') {
      run.memoryCheckpoints++; await sampleHeap('concurrent-held'); releaseCheckpoint(); return new Response('sampled');
    }
    if (url.hostname === 'benchmark-oauth.invalid' && url.pathname === '/token') {
      assert.ok(['refresh', 'concurrent'].includes(phase), 'UNEXPECTED_TOKEN_EXCHANGE');
      assert.equal(request.method, 'POST');
      const params = new URLSearchParams(await request.text());
      assert.equal(params.get('grant_type'), 'refresh_token'); assert.equal(params.get('refresh_token'), 'synthetic-refresh');
      run.oauthRefreshes.push({ phase, sequence: run.oauthRefreshes.length + 1 });
      // Keep exchange pending long enough for concurrent SDK metadata requests
      // to share google-auth-library's in-flight refresh Promise.
      await delay(5);
      return Response.json({ access_token: `benchmark-refreshed-${run.oauthRefreshes.length}`, expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.hostname !== 'benchmark-peer.invalid' || !methods[url.pathname]) {
      report.unexpectedRequests++; throw new Error('SDK_BENCHMARK_UNEXPECTED_REQUEST');
    }
    assert.equal(request.method, 'POST'); assert.equal(request.headers.get('content-type'), 'application/grpc-web+proto');
    const expected = phase === 'unauthenticated' ? null : run.oauthRefreshes.length ? `Bearer benchmark-refreshed-${run.oauthRefreshes.length}` : 'Bearer benchmark-initial';
    assert.equal(request.headers.get('authorization'), expected, 'SDK_AUTHORIZATION');
    const bytes = Buffer.from(await request.arrayBuffer()), method = methods[url.pathname];
    assert.equal(bytes[0], 0); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
    const decoded = method.request.decode(bytes.subarray(5));
    const query = url.pathname.endsWith('/RunQuery'), compressed = ['compressed', 'concurrent'].includes(phase);
    const count = query ? budgets.messages : 1;
    const receipt = { phase, method: url.pathname, requestBytes: bytes.length, responseBytes: 0, messages: count,
      compressed, authorization: expected === null ? 'absent' : run.oauthRefreshes.length ? 'refreshed' : 'cached', ended: false, cancellations: 0 };
    run.peerReceipts.push(receipt);
    let index = 0;
    const body = new ReadableStream({ async pull(controller) {
      if (index > count) { receipt.ended = true; controller.close(); return; }
      let output;
      if (index === count) {
        // Keep all query calls live until their slow consumers have reached the
        // shared memory checkpoint, even if an SDK eagerly prefetches messages.
        if (query) await checkpoint;
        output = frame(Buffer.from('grpc-status: 0\r\n'), 128);
      }
      else {
        const message = method.response.encode(method.response.fromObject(method.reply(decoded, index))).finish();
        output = frame(compressed ? zlib.gzipSync(message) : message, compressed ? 1 : 0);
      }
      receipt.responseBytes += output.length; index++; controller.enqueue(output);
    }, cancel() { receipt.cancellations++; } }, { highWaterMark: 0 });
    bodies.push({ body, receipt });
    return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto', ...(compressed ? { 'grpc-encoding': 'gzip' } : {}) } });
  };
  const started = performance.now();
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), name: 'sdk-benchmark', modules: true,
    script, compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'], inspectorPort: 0, outboundService }));
  async function invoke(name, input) {
    phase = name;
    const start = performance.now(), receiptStart = run.peerReceipts.length, refreshStart = run.oauthRefreshes.length;
    const response = await runtime.dispatchFetch(`https://entry.fixture.invalid/${name}`, {
      signal: AbortSignal.timeout(limits.maxScenarioMs), ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}),
    });
    const result = await response.json();
    const elapsedMs = performance.now() - start;
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.status, 'passed');
    const item = { name, elapsedMs, rpcCount: run.peerReceipts.length - receiptStart,
      oauthRefreshes: run.oauthRefreshes.length - refreshStart, ...result };
    if (!['ready', 'close'].includes(name)) run.phases.push(item);
    return item;
  }
  try {
    assert.deepEqual((await invoke('ready')).sdks, graph.sdkNames);
    run.startupAndReadyMs = performance.now() - started;
    devtools = await inspector(runtime); run.inspectorTarget = devtools.target;
    await sampleHeap('ready');
    await invoke('unauthenticated'); await sampleHeap('unauthenticated');
    await invoke('authenticated'); await sampleHeap('authenticated');
    for (let index = 0; index < budgets.warmSamples; index++) await invoke('warm');
    await sampleHeap('warm');
    await invoke('compressed'); await sampleHeap('compressed');
    await invoke('refresh'); await sampleHeap('refresh');
    await invoke('concurrent', budgets); await sampleHeap('concurrent-complete');
    run.close = await invoke('close'); await sampleHeap('closed');
    for (let index = 0; index < 20 && bodies.some(({ body }) => body.locked); index++) await delay(1);
    for (const { body, receipt } of bodies) receipt.bodyLocked = body.locked;
    assert.ok(bodies.every(({ body, receipt }) => !body.locked && (receipt.ended || receipt.cancellations === 1)), 'PEER_BODY_CLEANUP');
    run.cleanupVerifiedBeforeDispose = true;
    run.status = 'passed'; report.runtimeExecuted = true;
  } finally { releaseCheckpoint(); devtools?.close(); await runtime.dispose(); run.runtimeDisposed = true; }
}
async function main() {
  const files = ['scripts/benchmark-sdk.cjs', 'scripts/sdk-benchmark-evidence.cjs', 'fixtures/google/benchmark-runtime.mjs',
    'fixtures/google/benchmark-budgets.json', 'fixtures/google/package.json', 'fixtures/google/package-lock.json',
    'fixtures/modern/package.json', 'fixtures/modern/package-lock.json', 'fixtures/worker/package-lock.json',
    ...graphNames.map(name => `fixtures/google/benchmark-${name}.mjs`)];
  report.evidence = Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  for (const [profile, { fixture }] of Object.entries(budgets.profiles)) {
    const fixtureRoot = path.join(root, 'fixtures', fixture), fixtureRequire = createRequire(path.join(fixtureRoot, 'package.json'));
    const methods = schemas(fixtureRequire, profile === 'google-modern-v1');
    const ignored = path.join(fixtureRoot, '.wga-build'); fs.mkdirSync(ignored, { recursive: true });
    const entries = fs.mkdtempSync(path.join(ignored, 'sdk-benchmark-'));
    try {
      for (const name of [...graphNames, 'runtime']) fs.copyFileSync(path.join(root, `fixtures/google/benchmark-${name}.mjs`),
        path.join(entries, `benchmark-${name}.mjs`));
      for (const name of graphNames) {
        const { script, data } = await build(name, profile, fixtureRoot, fixtureRequire, entries); report.graphs.push(data);
        for (let index = 0; index < budgets.coldSamples; index++) await run(script, data, index, methods);
        const times = name => data.runs.flatMap(run => run.phases.filter(phase => phase.name === name).map(phase => phase.elapsedMs));
        data.timingsMs = { startupAndReady: summarize(data.runs.map(run => run.startupAndReadyMs)),
          firstUnauthenticatedRpc: summarize(times('unauthenticated')), firstAuthenticatedRpc: summarize(times('authenticated')),
          warmRpc: summarize(times('warm')), compressedRpc: summarize(times('compressed')),
          oauthRefreshRpc: summarize(times('refresh')), concurrent: summarize(times('concurrent')) };
        data.sampledPeakHeap = Object.fromEntries(['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'].map(key =>
          [key, Math.max(...data.runs.flatMap(run => run.heapSamples.map(sample => sample[key])))]));
      }
    } finally { fs.rmSync(entries, { recursive: true, force: true }); }
  }
  report.status = 'passed'; validateSdkBenchmarkReport(report);
}
main().catch(error => {
  report.status = 'failed'; report.diagnostic = String(error.message).slice(0, 1000); report.errorClass = error.constructor?.name;
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString(); fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/sdk-benchmark.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, graphs: report.graphs.length, diagnostic: report.diagnostic,
    report: 'verification/sdk-benchmark.json' }));
});
