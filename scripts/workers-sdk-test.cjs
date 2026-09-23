'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const esbuild = workerRequire('esbuild');
const { createGoogleWorkerBuild } = googleRequire('@grpc/grpc-js/build');
const { encodeFrame } = require('../dist/wire.js');
const compatibilityDate = '2026-09-21';
const digest = value => createHash('sha256').update(value).digest('hex');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-sdk-worker-'));
const report = { startedAt: new Date().toISOString(), status: 'running', cancelBodyObserved: false, runtimeExecuted: false, realGoogleSDK: true, cloudflareTranslation: false, liveGoogle: false, compatibilityDate, miniflare: workerRequire('miniflare/package.json').version, workerd: workerRequire('workerd/package.json').version, wrangler: workerRequire('wrangler/package.json').version, esbuild: esbuild.version, requests: [], checks: [] };
function wranglerBundle(entry, name) {
  const out = path.join(temporary, name);
  fs.mkdirSync(out, { recursive: true });
  const config = path.join(out, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-sdk-fixture', main: entry, compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config, '--outdir', path.join(out, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  return fs.readFileSync(path.join(out, 'bundle', path.basename(entry).replace(/\.[^.]+$/, '.js')), 'utf8');
}
function runtime(script, outboundService) {
  return new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService }));
}
async function main() {
  // The unmodified alias graph must be exercised before the narrowly scoped preset.
  execFileSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', path.join(root, 'fixtures/worker/build-consumer.cts')], { stdio: 'pipe' });
  const baseline = runtime(wranglerBundle(path.join(root, 'fixtures/google/static-worker.mjs'), 'baseline'), () => { throw new Error('Unexpected baseline network request'); });
  try {
    const response = await baseline.dispatchFetch('https://fixture.test/first');
    const result = await response.text();
    report.withoutPreset = { status: response.ok ? 'passed' : 'failed', reason: result.includes('Code generation') ? 'runtime-code-generation' : 'bootstrap' };
  } catch (error) {
    if (!String(error).includes('__dirname')) throw error;
    report.withoutPreset = { status: 'failed', reason: 'GAX cold import requires __dirname' };
  } finally { await baseline.dispose().catch(error => { if (!String(error).includes('__dirname')) throw error; }); }
  assert.equal(report.withoutPreset.status, 'failed');
  assert.throws(() => createGoogleWorkerBuild({ projectRoot: path.join(root, 'fixtures/google'), outdir: temporary, profile: 'unknown' }), { code: 'WGA_UNSUPPORTED_DEPENDENCY' });
  const profileSpec = JSON.parse(fs.readFileSync(path.join(path.dirname(googleRequire.resolve('@grpc/grpc-js/build')), 'profiles/google-static-v1.json'), 'utf8'));
  const shadow = path.join(temporary, 'tampered-graph');
  for (const relative of [...profileSpec.packages.map(item => item.path + '/package.json'), ...[...profileSpec.files, ...profileSpec.schemas, ...profileSpec.codegenInputs].map(item => item.path)]) {
    const destination = path.join(shadow, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, 'fixtures/google', relative), destination);
  }
  fs.appendFileSync(path.join(shadow, profileSpec.schemas[0].path), ' ');
  assert.throws(() => createGoogleWorkerBuild({ projectRoot: shadow, outdir: temporary, typescript: require('typescript') }), { code: 'WGA_SCHEMA_MISMATCH' });
  const preset = createGoogleWorkerBuild({ projectRoot: path.join(root, 'fixtures/google'), outdir: path.join(temporary, 'preset'), typescript: require('typescript') });
  // Execute the transformed descriptor module without an `options` binding.
  // A nested protobuf package also lives below @grpc/proto-loader/; its module
  // scope must never receive the loader function's local options parameter.
  let transform;
  preset.plugin.setup({ onLoad(_filter, callback) { transform = callback; } });
  const descriptorPath = path.join(root, 'fixtures/google/node_modules/@grpc/proto-loader/node_modules/protobufjs/ext/descriptor/index.js');
  const descriptorSource = transform({ path: descriptorPath }).contents;
  const descriptorModule = { exports: {} };
  require('node:vm').runInNewContext(descriptorSource, { require: createRequire(descriptorPath), module: descriptorModule, exports: descriptorModule.exports }, { filename: descriptorPath });
  assert.equal(typeof descriptorModule.exports.FileDescriptorProto.encode, 'function');
  const registry = require(preset.registryFile);
  assert.throws(() => registry.fromJSON(googleRequire('protobufjs'), { nested: { UnexpectedSchema: { fields: {} } } }), { code: 'WGA_SCHEMA_MISMATCH' });
  await esbuild.build({ entryPoints: [path.join(root, 'fixtures/google/static-worker.mjs')], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin] });
  const entry = path.join(temporary, 'worker.mjs');
  fs.writeFileSync(entry, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const script = wranglerBundle(entry, 'prepared');
  const manifest = preset.manifest();
  fs.writeFileSync(path.join(root, 'verification/workers-sdk-build.json'), JSON.stringify(manifest, null, 2) + '\n');
  report.bundleBytes = Buffer.byteLength(script);
  report.gzipBytes = require('node:zlib').gzipSync(script).byteLength;
  report.bundleSha256 = digest(script);
  report.profile = manifest.profile;
  report.sdkVersions = manifest.packages.filter(item => item.name.startsWith('@google-cloud/')).map(({name,version})=>({name,version}));
  report.evidence = Object.fromEntries(['scripts/workers-sdk-test.cjs','fixtures/google/static-worker.mjs','fixtures/google/package-lock.json','fixtures/worker/package-lock.json'].map(file=>[file,digest(fs.readFileSync(path.join(root,file)))]));
  // Node builds expected protobuf replies; SDK request/response codecs run inside workerd.
  const P = googleRequire('protobufjs');
  const schema = (name, relative) => {
    const pkg = path.dirname(googleRequire.resolve(`${name}/package.json`));
    return P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(pkg, relative), 'utf8')));
  };
  const datastore = schema('@google-cloud/datastore', 'build/protos/protos.json');
  const firestore = schema('@google-cloud/firestore', 'build/protos/v1.json');
  const secret = schema('@google-cloud/secret-manager', 'build/protos/protos.json');
  const cases = {
    '/google.datastore.v1.Datastore/Lookup': { request: datastore.lookupType('google.datastore.v1.LookupRequest'), response: datastore.lookupType('google.datastore.v1.LookupResponse'), reply: request => ({ missing: [{ entity: { key: request.keys[0] } }] }) },
    '/google.firestore.v1.Firestore/BatchGetDocuments': { request: firestore.lookupType('google.firestore.v1.BatchGetDocumentsRequest'), response: firestore.lookupType('google.firestore.v1.BatchGetDocumentsResponse'), reply: request => ({ missing: request.documents[0], readTime: { seconds: 1, nanos: 0 } }) },
    '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret': { request: secret.lookupType('google.cloud.secretmanager.v1.GetSecretRequest'), response: secret.lookupType('google.cloud.secretmanager.v1.Secret'), reply: request => ({ name: request.name }) },
  };
  let invocation = 'first';
  const worker = runtime(script, async request => {
    const method = new URL(request.url).pathname;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('content-type'), 'application/grpc-web+proto');
    assert.equal(request.headers.get('authorization'), `Bearer fixture-${invocation}`);
    if (method === '/demo.Echo/Wait') {
      report.requests.push({ invocation, method, authorizationSha256: digest(request.headers.get('authorization')), contentType: request.headers.get('content-type') });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encodeFrame(Buffer.from('first'))); }, cancel() { report.cancelBodyObserved = true; } }), { headers: { 'content-type': 'application/grpc-web+proto' } });
    }
    assert.ok(cases[method], `Unexpected RPC ${method}`);
    const bytes = Buffer.from(await request.arrayBuffer());
    assert.equal(bytes[0], 0);
    assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
    const testCase = cases[method];
    const decoded = testCase.request.decode(bytes.subarray(5));
    const reply = testCase.response.encode(testCase.response.fromObject(testCase.reply(decoded))).finish();
    report.requests.push({ invocation, method, requestSha256: digest(bytes), authorizationSha256: digest(request.headers.get('authorization')), contentType: request.headers.get('content-type') });
    return new Response(Buffer.concat([encodeFrame(reply), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': 'application/grpc-web+proto' } });
  });
  try {
    for (invocation of ['first', 'cancel', 'second']) {
      const response = await worker.dispatchFetch(`https://fixture.test/fixture-${invocation}`);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error(`Worker response ${response.status}: ${text.slice(0,3000)}`); }
      report.runtimeExecuted = true;
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.status, 'passed');
      if (invocation === 'cancel') { assert.equal(data.cancelled, true); assert.equal(data.received, 1); continue; }
      assert.equal(data.entityMissing, true);
      assert.equal(data.secretName, 'projects/wga-fixture/secrets/bootstrap');
      assert.equal(report.requests.filter(item => item.invocation === invocation).length, 3);
    }
    report.runtimeExecuted = true;
    report.status = 'passed';
    report.checks = ['static-import', 'datastore-constructor', 'firestore-constructor', 'secret-manager-constructor', 'static-protobuf-constructor-codecs-reflection', 'google-auth-oauth2', 'datastore-lookup', 'firestore-batchGetDocuments-server-stream', 'secret-manager-getSecret', 'second-request', 'two-credentials', 'mid-stream-cancel-between-requests', 'no-rest', 'no-node-modules-patch', 'unknown-profile-rejected', 'unknown-schema-rejected', 'changed-schema-hash-rejected', 'installed-build-entry-types', 'nested-descriptor-transform-scope'];
  } finally { await worker.dispose(); }
}
main().catch(error => { report.status = 'failed'; report.reason = error.code || 'WORKER_SDK_TEST_FAILED'; console.error(error); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'verification/workers-sdk.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, runtimeExecuted: report.runtimeExecuted, rpcCount: report.requests.length, report: 'verification/workers-sdk.json' }));
});
