'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const googleRoot = path.join(root, 'fixtures/google');
const googleRequire = createRequire(path.join(googleRoot, 'package.json'));
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const esbuild = workerRequire('esbuild');
// The source option permits focused development before replacing the packed fixture.
const { createGoogleWorkerBuild } = process.argv.includes('--source-build') ? require('../src/build/index.cjs') : googleRequire('@grpc/grpc-js/build');
const { encodeFrame } = require('../dist/wire.js');
const digest = value => createHash('sha256').update(value).digest('hex');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-lazy-sdk-'));
const compatibilityDate = '2026-09-21';
const report = { startedAt: new Date().toISOString(), status: 'running', runtimeExecuted: false, realGoogleSDK: true, liveGoogle: false, cloudflareTranslation: false, compatibilityDate, requests: [], runs: [], checks: [] };
async function main() {
  const preset = createGoogleWorkerBuild({ projectRoot: googleRoot, outdir: path.join(temporary, 'preset'), typescript: require('typescript') });
  await esbuild.build({ entryPoints: [path.join(googleRoot, 'lazy-worker.mjs')], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin] });
  const main = path.join(temporary, 'worker.mjs');
  fs.writeFileSync(main, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const config = path.join(temporary, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-lazy-sdk', main, compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config, '--outdir', path.join(temporary, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(temporary, 'bundle/worker.js'), 'utf8');
  const manifest = preset.manifest();
  report.bundleSha256 = digest(script);
  report.profile = manifest.profile;
  report.profileRevision = manifest.revision;
  report.profileSha256 = manifest.profileSha256;
  report.registrySha256 = manifest.registrySha256;
  report.evidence = Object.fromEntries(['scripts/test-workers-lazy-sdk.cjs', 'fixtures/google/lazy-worker.mjs', 'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  // The native SDK's untouched legacy group codecs are the independent oracle.
  const { Datastore } = nativeRequire('@google-cloud/datastore');
  const nativeDatastore = new Datastore({ projectId: 'wga-lazy' });
  const nativeKey = nativeDatastore.key({ namespace: 'lazy-namespace', path: ['Ancestor', '한글', 'LazyBootstrap', 7] });
  const nativeEncoded = await new Promise((resolve, reject) => nativeDatastore.keyToLegacyUrlSafe(nativeKey,
    (error, value) => error ? reject(error) : resolve(value)));
  const nativeDecoded = nativeDatastore.keyFromLegacyUrlsafe(nativeEncoded);
  const expectedLegacyKey = { encoded: nativeEncoded, decoded: { namespace: nativeDecoded.namespace, path: nativeDecoded.path } };
  assert.deepEqual(expectedLegacyKey.decoded, { namespace: 'lazy-namespace', path: ['Ancestor', '한글', 'LazyBootstrap', '7'] });
  await Promise.all([...nativeDatastore.clients_.values()].map(client => client.close()));
  report.nativeLegacyKey = { sdkVersion: nativeRequire('@google-cloud/datastore/package.json').version,
    matchedColdAndWarm: false, encodedSha256: digest(nativeEncoded) };
  const P = googleRequire('protobufjs');
  const schema = (name, file) => P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(googleRequire.resolve(`${name}/package.json`)), file), 'utf8')));
  const datastore = schema('@google-cloud/datastore', 'build/protos/protos.json');
  const firestore = schema('@google-cloud/firestore', 'build/protos/v1.json');
  const secret = schema('@google-cloud/secret-manager', 'build/protos/protos.json');
  // Nested Struct/Value/ListValue exercise Datastore's separate well-known schema,
  // not just the schema already used by the wire serializer.
  const index = { fields: {
    name: { stringValue: '한글 index' }, count: { numberValue: 12.5 }, enabled: { boolValue: true },
    optional: { nullValue: 'NULL_VALUE' },
    nested: { structValue: { fields: { field: { stringValue: 'value' } } } },
    values: { listValue: { values: [{ numberValue: 7 }, { stringValue: 'seven' }, { boolValue: false }] } },
  } };
  const cases = {
    '/google.datastore.v1.Datastore/RunQuery': {
      request: datastore.lookupType('google.datastore.v1.RunQueryRequest'), response: datastore.lookupType('google.datastore.v1.RunQueryResponse'),
      reply: request => {
        assert.equal(request.projectId, 'wga-lazy');
        assert.equal(request.query.kind[0].name, 'LazyBootstrap');
        assert.equal(request.explainOptions.analyze, true);
        return { explainMetrics: { planSummary: { indexesUsed: [index] }, executionStats: { resultsReturned: '0', readOperations: '1', debugStats: index } } };
      },
    },
    '/google.firestore.v1.Firestore/BatchGetDocuments': {
      request: firestore.lookupType('google.firestore.v1.BatchGetDocumentsRequest'), response: firestore.lookupType('google.firestore.v1.BatchGetDocumentsResponse'),
      reply: request => ({ missing: request.documents[0], readTime: { seconds: 1 } }),
    },
    '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret': {
      request: secret.lookupType('google.cloud.secretmanager.v1.GetSecretRequest'), response: secret.lookupType('google.cloud.secretmanager.v1.Secret'), reply: request => ({ name: request.name }),
    },
  };
  let invocation;
  const worker = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService: async request => {
    const method = new URL(request.url).pathname;
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('authorization'), `Bearer lazy-${invocation}`);
    assert.equal(request.headers.get('content-type'), 'application/grpc-web');
    assert.ok(cases[method], `Unexpected RPC ${method}`);
    const bytes = Buffer.from(await request.arrayBuffer());
    assert.equal(bytes[0], 0);
    assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
    const testCase = cases[method];
    const decoded = testCase.request.decode(bytes.subarray(5));
    const reply = testCase.response.encode(testCase.response.fromObject(testCase.reply(decoded))).finish();
    report.requests.push({ invocation, method, requestSha256: digest(bytes) });
    return new Response(Buffer.concat([encodeFrame(reply), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': 'application/grpc-web' } });
  } }));
  try {
    for (invocation of ['cold', 'warm']) {
      const response = await worker.dispatchFetch(`https://fixture.test/lazy-${invocation}`);
      const data = await response.json();
      report.runtimeExecuted = true;
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.status, 'passed');
      assert.deepEqual(data.stages, ['datastore-import', 'firestore-import', 'secret-manager-import', 'sdk-constructors', 'datastore-run-query', 'firestore-batch-get', 'secret-manager-get']);
      assert.deepEqual(data.legacyKey, expectedLegacyKey);
      const expected = { name: '한글 index', count: 12.5, enabled: true, optional: null, nested: { field: 'value' }, values: [7, 'seven', false] };
      assert.deepEqual(data.explainMetrics.planSummary.indexesUsed, [expected]);
      assert.deepEqual(data.explainMetrics.executionStats.debugStats, expected);
      assert.equal(data.explainMetrics.executionStats.readOperations, 1);
      assert.equal(data.secretName, 'projects/wga-lazy/secrets/bootstrap');
      assert.equal(report.requests.filter(item => item.invocation === invocation).length, 3);
      report.runs.push({ invocation, status: 'passed', stages: data.stages, rpcCount: 3 });
    }
    assert.equal(manifest.globalPrototypePatched, false);
    assert.equal(manifest.nodeModulesModified, false);
    report.nativeLegacyKey.matchedColdAndWarm = true;
    report.checks = ['cold-request-dynamic-imports', 'warm-request-dynamic-imports', 'datastore-native-legacy-key-codecs', 'datastore-run-query', 'datastore-struct-explain-metrics', 'nested-struct-and-list-values', 'firestore-server-stream', 'secret-manager-unary', 'request-credential-isolation', 'no-global-prototype-patch', 'no-node-modules-patch'];
    report.status = 'passed';
  } finally { await worker.dispose(); }
}
main().catch(error => { report.status = 'failed'; report.reason = error.code || 'WORKERS_LAZY_SDK_FAILED'; console.error(error); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-lazy-sdk.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, rpcCount: report.requests.length, report: 'verification/workers-lazy-sdk.json' }));
});
