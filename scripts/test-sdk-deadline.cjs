'use strict';
/** Installed pinned SDK + controlled peer only; no Google API or deployment. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { profiles } = require('./sdk-cancellation-evidence.cjs');
const root = path.resolve(__dirname, '..'), req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const hash = data => createHash('sha256').update(data).digest('hex');
const scenarios = ['query-lazy', 'query-budget', 'commit-response-lost'];
const report = { status: 'running', liveCloud: false, cloudflareTranslation: false, controlledFetchPeer: true,
  responseLossInjectedLocally: true, backendCancellationProven: false, profiles: [], results: [] };
function frame(bytes, trailer = false) {
  const head = Buffer.alloc(5); head[0] = trailer ? 128 : 0; head.writeUInt32BE(bytes.length, 1); return Buffer.concat([head, bytes]);
}
function peer(fixtureRequire, profile, mode) {
  const P = fixtureRequire('protobufjs');
  const schema = P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(fixtureRequire.resolve(`${profile.generatedPackage}/package.json`)), 'build/protos/protos.json'))));
  const trace = [], stored = new Map();
  const codecs = Object.fromEntries(['RunQuery', 'Commit', 'Lookup'].map(method => [method, {
    request: schema.lookupType(`google.datastore.v1.${method}Request`), response: schema.lookupType(`google.datastore.v1.${method}Response`),
  }]));
  return { trace, async fetch(request) {
    const url = new URL(request.url), method = url.pathname.split('/').pop();
    assert.equal(url.hostname, mode === 'cloudflare' ? 'datastore.googleapis.com' : 'sdk-deadline-gateway.invalid');
    assert.ok(codecs[method]); assert.equal(request.headers.get('authorization'), 'Bearer sdk-deadline-local-fixture');
    const bytes = Buffer.from(await request.arrayBuffer());
    assert.equal(bytes[0], 0); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
    const decoded = codecs[method].request.toObject(codecs[method].request.decode(bytes.subarray(5)), { longs: String, enums: String, bytes: Buffer, defaults: true });
    assert.equal(decoded.projectId, 'wga-sdk-deadline');
    const primary = request.headers.get('x-wga-deadline-operation') === 'primary';
    const timeout = request.headers.get('grpc-timeout'); assert.match(timeout, /^\d+m$/);
    const receipt = { method, primary, timeoutMs: Number(timeout.slice(0, -1)), kind: null, page: null };
    let response;
    if (method === 'RunQuery') {
      const kind = decoded.query.kind[0].name;
      assert.ok(['Primary', 'Recovery'].includes(kind));
      const page = trace.filter(row => row.kind === kind).length;
      assert.ok(page < 3); assert.equal(decoded.query.startCursor.toString(), page ? `cursor-${page * 2}` : '');
      assert.equal(decoded.query.limit.value, 6 - page * 2);
      Object.assign(receipt, { kind, page });
      response = { batch: { entityResultType: 'FULL', skippedResults: 0,
        entityResults: [page * 2, page * 2 + 1].map(rank => ({ entity: { key: { path: [{ kind, name: `row-${rank}` }] },
          properties: { rank: { integerValue: String(rank) } } } })),
        moreResults: page === 2 ? 'NO_MORE_RESULTS' : 'NOT_FINISHED', endCursor: Buffer.from(`cursor-${page * 2 + 2}`) } };
    } else if (method === 'Commit') {
      assert.equal(decoded.mutations.length, 1);
      const entity = decoded.mutations[0].upsert;
      assert.equal(entity.properties.rank.integerValue, '41'); stored.set(entity.key.path[0].name, entity);
      response = { mutationResults: [{ key: entity.key, version: '101' }], indexUpdates: 1 };
    } else {
      const entity = stored.get(decoded.keys[0].path[0].name); assert.ok(entity, 'Peer accepted mutation before response loss');
      response = { found: [{ entity, version: '101' }] };
    }
    trace.push(receipt);
    const payload = codecs[method].response.encode(codecs[method].response.fromObject(response)).finish();
    return new Response(Buffer.concat([frame(payload), frame(Buffer.from('grpc-status: 0\r\n'), true)]), {
      headers: { 'content-type': mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto' },
    });
  } };
}
async function main() {
  const sources = ['src/sdk.ts', 'scripts/test-sdk-deadline.cjs', 'fixtures/google/shared/sdk-deadline.mjs'];
  report.sourceHashes = Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  fs.mkdirSync(path.join(root, '.wga-build'), { recursive: true });
  for (const profile of profiles) {
    const project = path.join(root, 'fixtures', profile.fixture), fixtureRequire = createRequire(path.join(project, 'package.json'));
    const temporary = fs.mkdtempSync(path.join(project, '.sdk-deadline-'));
    const buildRoot = fs.mkdtempSync(path.join(root, '.wga-build/sdk-deadline-'));
    try {
      const consumer = path.join(temporary, 'consumer.mjs');
      fs.copyFileSync(path.join(root, 'fixtures/google/shared/sdk-deadline.mjs'), consumer);
      assert.equal(hash(fs.readFileSync(consumer)), report.sourceHashes['fixtures/google/shared/sdk-deadline.mjs']);
      assert.equal(fixtureRequire('@google-cloud/datastore/package.json').version, profile.sdkVersion);
      const { createGoogleWorkerBuild } = fixtureRequire('@grpc/grpc-js/build');
      const preset = createGoogleWorkerBuild({ projectRoot: project, profile: profile.id, outdir: path.join(buildRoot, 'preset'), typescript: require('typescript') });
      const bundled = await req('esbuild').build({ entryPoints: [consumer], bundle: true, format: 'cjs', platform: 'node',
        target: 'es2022', outfile: path.join(buildRoot, 'consumer.cjs'), plugins: [preset.plugin], metafile: true, write: false });
      const helper = fixtureRequire.resolve('@grpc/grpc-js/sdk');
      assert.ok(Object.keys(bundled.metafile.inputs).some(file => path.resolve(file) === helper));
      const manifest = preset.manifest();
      const workerScript = `import bundle from './consumer.cjs';
const unhandled = [];
addEventListener('unhandledrejection', event => { unhandled.push(event.reason?.name ?? 'unknown'); });
export default { async fetch(request) {
  const result = await bundle.runSdkDeadline({ ...await request.json(), send: fetch });
  await new Promise(resolve => setTimeout(resolve, 0));
  return Response.json({ result, unhandled });
} };\n`;
      fs.writeFileSync(path.join(buildRoot, 'consumer.cjs'), bundled.outputFiles[0].contents);
      fs.writeFileSync(path.join(buildRoot, 'worker.mjs'), workerScript);
      const config = path.join(buildRoot, 'wrangler.json');
      fs.writeFileSync(config, JSON.stringify({ name: 'wga-sdk-deadline-local', main: path.join(buildRoot, 'worker.mjs'),
        compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'], send_metrics: false }));
      const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
      for (const key of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(key)) delete environment[key];
      // Follow the existing installed-SDK gate: Wrangler supplies the supported
      // nodejs_compat shims. --dry-run writes a local bundle without deploying.
      execFileSync(process.execPath, [path.join(path.dirname(req.resolve('wrangler/package.json')), 'bin/wrangler.js'),
        'deploy', '--dry-run', '--config', config, '--outdir', path.join(buildRoot, 'bundle'), '--no-autoconfig'],
      { cwd: root, env: environment, stdio: 'pipe', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
      const workerBundle = fs.readFileSync(path.join(buildRoot, 'bundle/worker.js'), 'utf8');
      report.profiles.push({ id: profile.id, sdkVersion: profile.sdkVersion, build: manifest,
        installedHelperSha256: hash(fs.readFileSync(helper)), bundleSha256: hash(workerBundle) });
      const consumerModule = await import(pathToFileURL(path.join(buildRoot, 'consumer.cjs')).href);
      for (const runtime of ['node', 'workerd']) for (const mode of ['grpc-web', 'cloudflare']) for (const scenario of scenarios) {
        const controlled = peer(fixtureRequire, profile, mode);
        const worker = runtime === 'workerd' ? new Miniflare(convertV4MiniflareOptions({ modules: true,
          script: workerBundle, compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
          log: new Log(LogLevel.NONE), outboundService: request => controlled.fetch(request) })) : undefined;
        try {
          let result;
          if (worker) {
            const response = await worker.dispatchFetch('https://fixture.invalid/', { method: 'POST', body: JSON.stringify({ scenario, mode }) });
            const output = await response.json(); assert.equal(response.status, 200); assert.deepEqual(output.unhandled, []); result = output.result;
          } else result = await consumerModule.runSdkDeadline({ scenario, mode, send: (input, init) => controlled.fetch(new Request(input, init)) });
          assert.equal(result.errorCode, 4); assert.deepEqual(result.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
          assert.deepEqual(result.recoveryRows, [0, 1, 2, 3, 4, 5]);
          assert.equal(result.fetches, controlled.trace.length); assert.equal(result.held, scenario === 'query-lazy' ? 0 : 1);
          assert.equal(result.aborts, result.held);
          assert.equal(result.authNetworkRequests, 0);
          const primary = controlled.trace.filter(row => row.primary);
          if (scenario === 'query-lazy') { assert.equal(primary.length, 0); assert.deepEqual(result.partialRows, []); }
          else if (scenario === 'query-budget') {
            assert.deepEqual(result.partialRows, [0, 1]); assert.equal(primary.length, 2);
            assert.ok(primary[0].timeoutMs <= 1000 && primary[1].timeoutMs <= primary[0].timeoutMs - 75,
              'Second real SDK page inherits the reduced absolute budget');
          } else { assert.equal(result.persisted, true); assert.deepEqual(primary.map(row => row.method), ['Commit']); }
          report.results.push({ profile: profile.id, runtime, mode, scenario, status: 'passed', result, trace: controlled.trace });
        } finally { if (worker) await worker.dispose(); }
      }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); fs.rmSync(buildRoot, { recursive: true, force: true }); }
  }
  assert.equal(report.results.length, 24); report.status = 'passed';
}
const timeout = setTimeout(() => { console.error('SDK_DEADLINE_RUNNER_TIMEOUT'); process.exit(1); }, 240_000);
main().catch(error => { report.status = 'failed'; report.error = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(timeout); fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/sdk-deadline.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, scenarios: report.results.length, report: 'verification/sdk-deadline.json' }));
});
