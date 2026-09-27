'use strict';
// An additional exact dependency graph. Existing golden fixtures are unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const http2 = require('node:http2');
const { once } = require('node:events');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const modernRoot = path.join(root, 'fixtures/modern');
const modernRequire = createRequire(path.join(modernRoot, 'package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const { inspect } = require('./doctor.cjs');
const { ts, typeRoots } = require('./toolchain.cjs').toolchain();
const sourceBuild = process.argv.includes('--source-build');
const { createGoogleWorkerBuild } = sourceBuild ? require('../src/build/index.cjs') : modernRequire('@grpc/grpc-js/build');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const compatibilityDate = '2026-09-21';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-modern-sdk-'));
const report = { startedAt: new Date().toISOString(), status: 'running', sourceBuild,
  liveGoogle: false, officialEmulator: false, cloudflareTranslation: false, credentialsPersisted: false,
  profile: 'google-modern-v1', compatibilityDate, graphs: [], declarations: [], results: [], sources: {} };
let stage = 'graph';
const asyncFailures = [];
process.on('unhandledRejection', () => { asyncFailures.push('MODERN_UNHANDLED_REJECTION'); process.exitCode = 1; });
function check(value, diagnostic) { assert.ok(value, diagnostic); }
function frame(bytes, trailer = false) {
  const header = Buffer.alloc(5); header[0] = trailer ? 128 : 0; header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
async function bounded(promise, milliseconds = 20000) {
  let timeout;
  try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error(), { fixtureDiagnostic: 'CASE_TIMEOUT' })), milliseconds); })]); }
  finally { clearTimeout(timeout); }
}
function checkGraphsAndDeclarations() {
  const versions = { '@google-cloud/datastore': '11.1.0', '@google-cloud/firestore': '9.2.0', '@google-cloud/secret-manager': '7.1.0' };
  const source = fs.readFileSync(path.join(root, 'fixtures/google/types/consumer.mts'), 'utf8');
  for (const [runtime, fixtureName, expected] of [['native', 'modern-native', '@grpc/grpc-js'], ['adapter', 'modern', 'workers-grpc-adapter']]) {
    const fixture = path.join(root, 'fixtures', fixtureName), graph = inspect(fixture, undefined, expected);
    check(graph.passed && graph.results.every(item => item.version === versions[item.sdk]), 'MODERN_GRAPH');
    const packages = [...new Map(graph.results.flatMap(item => item.graph).map(item => [item.path, item])).values()];
    check(packages.every(item => !!item.integrity), 'LOCKED_PACKAGE_INTEGRITY');
    const auth = packages.filter(item => item.name === 'google-auth-library').map(({ path, version, integrity }) => ({ path, version, integrity })).sort((a, b) => a.path.localeCompare(b.path));
    check(auth.map(item => item.version).sort().join(',') === '10.9.1,11.1.0', 'AUTH_VERSION_PINS');
    report.graphs.push({ runtime, fixture: fixtureName, passed: true, lockfileSha256: graph.lockfileSha256, graphSha256: graph.graphSha256,
      auth, sdks: graph.results.map(({ sdk, version, gax, grpc, grpcImportCount }) => ({ sdk, version, gax, grpc, grpcImportCount })) });
    const consumer = fs.mkdtempSync(path.join(fixture, '.modern-types-'));
    try {
      const files = ['consumer.mts', 'consumer.cts'].map(name => {
        const destination = path.join(consumer, name);
        fs.writeFileSync(destination, name.endsWith('.cts') ? source.replace('@grpc/grpc-js/build/src/client.js', '@grpc/grpc-js/build/src/client') : source);
        return destination;
      });
      for (const [mode, module, moduleResolution] of [['node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], ['nodenext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
        const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
          strict: true, skipLibCheck: false, esModuleInterop: true, noEmit: true, types: ['node'], typeRoots, module, moduleResolution });
        const diagnostics = ts.getPreEmitDiagnostics(program).map(item => ({ code: item.code,
          file: item.file ? path.relative(fixture, item.file.fileName).replace(/\.modern-types-[^/]+\//, 'types/') : null,
          message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }));
        report.declarations.push({ runtime, mode, consumers: ['esm', 'commonjs'], status: diagnostics.length ? 'failed' : 'passed', strict: true, skipLibCheck: false, diagnostics });
      }
    } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
  }
  assert.deepEqual(report.graphs[0].auth, report.graphs[1].auth, 'AUTH_GRAPHS_MATCH');
  check(report.declarations.every(item => item.status === 'passed'), 'STRICT_MODERN_DECLARATIONS');
}
function checkProfileRejections() {
  const options = { projectRoot: modernRoot, outdir: path.join(temporary, 'negative-out'), typescript: ts };
  assert.throws(() => createGoogleWorkerBuild(options), { code: 'WGA_UNSUPPORTED_DEPENDENCY' });
  assert.throws(() => createGoogleWorkerBuild({ ...options, profile: '../google-modern-v1' }), { code: 'WGA_UNSUPPORTED_DEPENDENCY' });
  const profile = JSON.parse(fs.readFileSync(path.join(root, 'src/build/profiles/google-modern-v1.json')));
  const copy = path.join(temporary, 'profile-copy');
  for (const file of [...profile.packages.map(item => `${item.path}/package.json`), ...profile.files.map(item => item.path), ...profile.schemas.map(item => item.path), ...profile.codegenInputs.map(item => item.path)]) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    fs.copyFileSync(path.join(modernRoot, file), path.join(copy, file));
  }
  const selected = profile.schemas[0].path;
  fs.appendFileSync(path.join(copy, selected), '\n// controlled mismatch\n');
  assert.throws(() => createGoogleWorkerBuild({ ...options, projectRoot: copy, profile: 'google-modern-v1' }), { code: 'WGA_SCHEMA_MISMATCH' });
  const packageFile = path.join(copy, profile.packages[0].path, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageFile)); pkg.version = '0.0.0'; fs.writeFileSync(packageFile, JSON.stringify(pkg));
  assert.throws(() => createGoogleWorkerBuild({ ...options, projectRoot: copy, profile: 'google-modern-v1' }), { code: 'WGA_UNSUPPORTED_DEPENDENCY' });
  report.profileRejections = ['old-profile-on-modern-graph', 'unknown-profile', 'modified-schema', 'modified-version'];
}
async function main() {
  checkGraphsAndDeclarations();
  let adapterDirectory;
  if (sourceBuild) {
    // Developer-only mode compiles isolated outputs, never shared dist or an
    // installed dependency. The required gate uses the packed package instead.
    stage = 'isolated-source-build';
    adapterDirectory = path.join(temporary, 'adapter-dist');
    require('./toolchain.cjs').compile({ outDir: adapterDirectory, rootDir: path.join(root, 'src') });
    report.isolatedAdapterSha256 = digest(fs.readFileSync(path.join(adapterDirectory, 'options.js')));
  }
  stage = 'profile';
  checkProfileRejections();
  const sharedFile = path.join(modernRoot, 'shared.mjs'), shared = fs.readFileSync(sharedFile);
  report.sharedSourceSha256 = digest(shared);
  report.evidence = Object.fromEntries(['scripts/test-modern-sdk.cjs', 'scripts/google-controlled-server.cjs', 'fixtures/modern/shared.mjs',
    'fixtures/modern/worker.mjs', 'fixtures/modern/package-lock.json', 'fixtures/modern-native/package-lock.json',
    'fixtures/google/types/consumer.mts', 'fixtures/native/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const controlled = await require('./google-controlled-server.cjs').createControlledServer();
  const sessions = new Set(), requests = [];
  let bridge, runtime, context, boundaryFailure;
  try {
    bridge = http.createServer((request, response) => {
      const mime = request.headers['content-type'];
      if (request.method !== 'POST' || !['application/grpc-web', 'application/grpc-web+proto'].includes(mime)) { response.writeHead(400).end(); return; }
      requests.push({ method: request.url, contentType: mime });
      const session = http2.connect(`http://127.0.0.1:${controlled.nativePort}`);
      sessions.add(session); session.on('close', () => sessions.delete(session)); session.on('error', () => {});
      const upstream = session.request({ ':method': 'POST', ':path': request.url, 'content-type': 'application/grpc', te: 'trailers',
        ...(request.headers['grpc-timeout'] ? { 'grpc-timeout': request.headers['grpc-timeout'] } : {}) });
      let statusSeen = false;
      const trailers = headers => frame(Buffer.from(Object.entries(headers).filter(([key]) => !key.startsWith(':')).map(([key, value]) => `${key}: ${value}\r\n`).join('')), true);
      upstream.on('response', headers => {
        response.writeHead(200, { 'content-type': mime });
        if (headers['grpc-status'] !== undefined) { statusSeen = true; response.write(trailers(headers)); }
      });
      upstream.on('data', bytes => response.write(bytes));
      upstream.on('trailers', headers => { statusSeen = true; response.write(trailers(headers)); });
      upstream.on('end', () => { if (!statusSeen) { boundaryFailure = 'NATIVE_GRPC_STATUS_REQUIRED'; response.destroy(); } else response.end(); session.close(); });
      upstream.on('error', () => { response.destroy(); session.destroy(); });
      response.on('close', () => { upstream.close(http2.constants.NGHTTP2_CANCEL); session.destroy(); });
      request.pipe(upstream);
    });
    bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
    const bridgeOrigin = `http://127.0.0.1:${bridge.address().port}`;
    const record = (runtime, invocation, sdk, checks, before, wireBefore) => {
      check(!boundaryFailure, boundaryFailure || 'BOUNDARY');
      const trace = controlled.arrivals.slice(before).map(({ method, status }) => ({ method, status }));
      check(trace.length === (sdk === 'secret-manager' ? 3 : 4), 'RPC_COUNT');
      check(requests.length - wireBefore === (runtime === 'native' ? 0 : trace.length), 'WIRE_ARRIVAL_COUNT');
      report.results.push({ id: `${runtime}/${invocation}/${sdk}`, runtime, invocation, sdk, status: 'passed', checks, trace,
        rpcCount: trace.length, grpcWebRequests: requests.length - wireBefore });
    };
    for (const name of ['native', 'adapter']) {
      const fixture = path.join(root, 'fixtures', name === 'native' ? 'modern-native' : 'modern');
      const req = createRequire(path.join(fixture, 'package.json'));
      const grpc = name === 'adapter' && sourceBuild ? require(path.join(adapterDirectory, 'index.js')) : req('@grpc/grpc-js');
      if (name === 'adapter' && !sourceBuild) req('@grpc/grpc-js/config').configureWorkersGrpc({ mode: 'grpc-web', allowInsecureLocalhost: true,
        endpoints: { [`127.0.0.1:${controlled.nativePort}`]: bridgeOrigin } });
      const consumer = fs.mkdtempSync(path.join(fixture, '.modern-business-'));
      try {
        const file = path.join(consumer, 'shared.mjs'); fs.writeFileSync(file, shared);
        report.sources[name] = digest(fs.readFileSync(file));
        const { runModernSDK } = await import(pathToFileURL(file).href);
        for (const sdk of ['datastore', 'firestore', 'secret-manager']) {
          stage = `${name}-${sdk}`; controlled.reset();
          let options = { projectId: 'wga-local-test', fallback: false };
          if (sdk === 'datastore') options.apiEndpoint = `127.0.0.1:${controlled.nativePort}`;
          else if (sdk === 'firestore') options.host = `127.0.0.1:${controlled.nativePort}`;
          else Object.assign(options, { apiEndpoint: '127.0.0.1', port: controlled.nativePort });
          if (name === 'adapter' && sourceBuild) {
            const transport = require(path.join(adapterDirectory, 'adapter.js')).createWorkersGrpcTransport({ mode: 'grpc-web', allowInsecureLocalhost: true,
              endpoints: { [`127.0.0.1:${controlled.nativePort}`]: bridgeOrigin } });
            delete options.fallback;
            options = transport.gaxOptions(options);
          }
          options.sslCreds = grpc.credentials.createInsecure();
          const before = controlled.arrivals.length, wireBefore = requests.length;
          const checks = await bounded(runModernSDK({ sdk, options, runId: 'modernfixture' }));
          record(name, 'node', sdk, checks, before, wireBefore);
        }
      } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
    }
    stage = 'worker-build';
    const preset = createGoogleWorkerBuild({ projectRoot: modernRoot, outdir: path.join(temporary, 'preset'), profile: 'google-modern-v1', typescript: ts });
    const build = await workerRequire('esbuild').build({ absWorkingDir: root, entryPoints: [path.join(modernRoot, 'worker.mjs')], bundle: true,
      format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin], metafile: true,
      ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(adapterDirectory, 'adapter.js'),
        '@grpc/grpc-js/package.json': path.join(root, 'package.json'), '@grpc/grpc-js': path.join(adapterDirectory, 'index.js') } } : {}) });
    check(Object.keys(build.metafile.inputs).includes('fixtures/modern/shared.mjs'), 'SHARED_WORKER_INPUT');
    report.sources.workerd = digest(fs.readFileSync(sharedFile));
    const entry = path.join(temporary, 'worker.mjs'); fs.writeFileSync(entry, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
    const config = path.join(temporary, 'wrangler.json');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-modern-local', main: entry, compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
    execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config, '--outdir', path.join(temporary, 'bundle'), '--no-autoconfig'],
      { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
    const script = fs.readFileSync(path.join(temporary, 'bundle/worker.js'), 'utf8');
    report.build = preset.manifest(); report.bundleSha256 = digest(script);
    const runtimeOptions = { modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), outboundService: async request => {
      try {
        const url = new URL(request.url), service = context.sdk === 'secret-manager' ? 'secretmanager' : context.sdk;
        check(url.hostname === (context.mode === 'cloudflare' ? `${service}.googleapis.com` : 'gateway.fixture.invalid'), 'WORKER_DESTINATION');
        check(request.headers.get('authorization') === `Bearer ${context.token}`, 'WORKER_AUTHORIZATION');
        const mime = context.mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
        check(request.method === 'POST' && request.headers.get('content-type') === mime && request.headers.get('accept') === mime, 'WORKER_CONTENT_TYPE');
        const headers = new Headers(request.headers); headers.delete('host'); headers.delete('content-length');
        const response = await fetch(bridgeOrigin + url.pathname, { method: 'POST', headers, body: await request.arrayBuffer(), signal: request.signal });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
      } catch (error) { boundaryFailure = error.code === 'ERR_ASSERTION' ? error.message : 'WORKER_BOUNDARY'; return new Response('Controlled fixture failure', { status: 500 }); }
    } };
    for (const mode of ['cloudflare', 'grpc-web']) {
      runtime = new Miniflare(convertV4MiniflareOptions(runtimeOptions));
      for (const invocation of ['cold', 'warm']) for (const sdk of ['datastore', 'firestore', 'secret-manager']) {
        stage = `${mode}-${invocation}-${sdk}`; controlled.reset();
        context = { mode, sdk, token: randomBytes(24).toString('hex') };
        const before = controlled.arrivals.length, wireBefore = requests.length;
        const response = await runtime.dispatchFetch('https://fixture.test/modern', { method: 'POST', body: JSON.stringify({ ...context, runId: 'modernfixture' }), signal: AbortSignal.timeout(20000) });
        const result = await response.json();
        if (response.status !== 200 || result.status !== 'passed') report.workerFailure = { diagnostic: result.diagnostic, errorClass: result.errorClass, errorCode: result.errorCode };
        check(!boundaryFailure, boundaryFailure || 'WORKER_BOUNDARY');
        check(response.status === 200 && result.status === 'passed', result.diagnostic || 'WORKER_RESULT');
        record(mode, invocation, sdk, result.checks, before, wireBefore);
      }
      await runtime.dispose(); runtime = undefined;
    }
    for (const sdk of ['datastore', 'firestore', 'secret-manager']) {
      const entries = report.results.filter(item => item.sdk === sdk), expected = entries[0];
      for (const entry of entries) {
        assert.deepEqual(entry.checks, expected.checks, 'BUSINESS_RESULT_PARITY');
        assert.deepEqual(entry.trace, expected.trace, 'NATIVE_RPC_PARITY');
      }
    }
    check(Object.values(report.sources).every(value => value === report.sharedSourceSha256), 'SHARED_SOURCE_PARITY');
    check(report.results.length === 18, 'CASE_COUNT');
    report.rpcCount = report.results.reduce((sum, item) => sum + item.rpcCount, 0);
    check(report.rpcCount === 66, 'TOTAL_RPC_COUNT');
    await new Promise(resolve => setImmediate(resolve));
    check(asyncFailures.length === 0, 'MODERN_UNHANDLED_REJECTION');
    report.sameSharedSource = true; report.nativeEquivalent = true; report.status = 'passed';
  } finally {
    controlled.server.forceShutdown();
    for (const session of sessions) session.destroy();
    const cleanup = await Promise.allSettled([
      runtime?.dispose(),
      bridge ? new Promise(resolve => { bridge.closeAllConnections(); bridge.close(resolve); }) : undefined,
    ]);
    check(cleanup.every(item => item.status === 'fulfilled'), 'FIXTURE_CLEANUP');
  }
}
main().catch(error => {
  report.status = 'failed'; report.stage = stage;
  report.diagnostic = error.fixtureDiagnostic || (error.code === 'ERR_ASSERTION' ? error.message : 'MODERN_SDK_FAILED');
  report.errorClass = error.constructor?.name || 'Error';
  console.error(JSON.stringify({ status: report.status, stage, diagnostic: report.diagnostic, errorClass: report.errorClass }));
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/modern-sdk.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, cases: report.results.length, rpcCount: report.rpcCount, report: 'verification/modern-sdk.json' }));
});
