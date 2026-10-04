'use strict';
// Installed Google SDKs with optional cancellation extensions. Every byte stays
// in this process or local workerd; the controlled peer is not a Google emulator.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { validateSdkCancellationReport, sources, profiles, scenarios, installedForProfile, extensionCases } = require('./sdk-cancellation-evidence.cjs');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const compatibilityDate = '2026-09-21';
const report = { status: 'running', startedAt: new Date().toISOString(), runtime: process.version,
  liveCloud: false, cloudflareTranslation: false, officialEmulator: false, controlledFetchPeer: true,
  backendCancellationProven: false, optionalExtensions: true, upstreamSdkBehaviorChanged: false,
  compatibilityDate, versions: { workerd: workerRequire('workerd/package.json').version,
    miniflare: workerRequire('miniflare/package.json').version },
  instrumentation: { channelDiagnostics: true, observer: true, localAbortSignal: true,
    projectIdResolutionBarrier: true, resourcesBeforeSdkClose: true },
  evidence: Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])),
  installedInputs: {}, profiles: [], results: [], unhandledRejections: [], unexpectedRequests: [] };
const onUnhandled = error => report.unhandledRejections.push(error?.name ?? 'unknown');
process.on('unhandledRejection', onUnhandled);
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, label, timeout = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SDK_CANCEL_RUNNER_TIMEOUT:${label}`)), timeout);
  })]); } finally { clearTimeout(timer); }
}
function frame(bytes, trailer = false) {
  const prefix = Buffer.alloc(5); prefix[0] = trailer ? 128 : 0; prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}

function controlledPeer(req, mode, profile) {
  const P = req('protobufjs');
  const schema = P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(req.resolve(`${profile.generatedPackage}/package.json`)), 'build/protos/protos.json'))));
  const states = new Map();
  const codecs = Object.fromEntries(['RunQuery', 'Lookup', 'BeginTransaction', 'Commit', 'Rollback'].map(method => [method,
    { request: schema.lookupType(`google.datastore.v1.${method}Request`), response: schema.lookupType(`google.datastore.v1.${method}Response`) }]));
  function setup(namespace, scenario) {
    const state = { namespace, scenario, trace: [], stored: new Map(), held: null, siblingHeld: null,
      arrived: defer(), siblingArrived: defer(), rollbackArrived: defer(), released: false, controlCount: 0 };
    states.set(namespace, state); return state;
  }
  async function control(namespace, operation) {
    const state = states.get(namespace); assert.ok(state, 'Known scenario namespace'); state.controlCount++;
    if (operation === 'await-held') { await bounded(state.arrived.promise, 'peer-held'); return { held: true }; }
    if (operation === 'await-sibling') {
      await bounded(state.siblingArrived.promise, 'peer-sibling');
      assert.ok(state.held && state.siblingHeld && !state.released && !state.siblingReleased);
      return { pendingResponses: 2 };
    }
    if (operation === 'release-sibling') {
      assert.ok(state.siblingHeld && !state.siblingReleased);
      state.siblingReleased = true; state.siblingHeld.resolve(); return { released: true };
    }
    if (operation === 'await-rollback') { await bounded(state.rollbackArrived.promise, 'peer-rollback'); return { rollback: true }; }
    assert.equal(operation, 'release');
    state.released = true; state.held?.resolve(); return { released: true };
  }
  async function fetchPeer(request) {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'sdk-cancellation-control.invalid') {
        const [namespace, operation] = url.pathname.slice(1).split('/');
        return Response.json(await control(namespace, operation));
      }
      assert.equal(url.hostname, mode === 'cloudflare' ? 'datastore.googleapis.com' : 'sdk-cancellation-gateway.invalid');
      assert.equal(request.method, 'POST');
      const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
      assert.equal(request.headers.get('content-type'), mime);
      assert.equal(request.headers.get('authorization'), 'Bearer sdk-cancellation-local-fixture');
      const logicalCallId = request.headers.get('x-wga-sdk-call-id'); assert.match(logicalCallId, /^wga-[1-9]\d*$/);
      const method = url.pathname.split('/').pop(); assert.ok(codecs[method], 'Known Datastore method');
      const wire = Buffer.from(await request.arrayBuffer());
      assert.equal(wire[0], 0); assert.equal(wire.readUInt32BE(1), wire.length - 5);
      const decoded = codecs[method].request.toObject(codecs[method].request.decode(wire.subarray(5)),
        { longs: String, enums: String, bytes: Buffer, defaults: true });
      assert.equal(decoded.projectId, 'wga-sdk-cancellation');
      // Datastore's own error cleanup deliberately does not forward the caller's
      // GAX options. Its transaction ID still identifies this exact fixture.
      const namespace = request.headers.get('x-wga-cancellation-case')
        ?? (method === 'Rollback' ? decoded.transaction.toString().replace(/^transaction-/, '') : null);
      const state = states.get(namespace); assert.ok(state, 'Known request case');
      const receipt = { method, logicalCallId, requestSha256: digest(wire), contentType: mime,
        afterRelease: state.released, kind: null, cursor: null, limit: null, key: null };
      let body, held = false, cancelTarget = false;
      if (method === 'RunQuery') {
        assert.equal(decoded.partitionId.namespaceId, namespace);
        const kind = decoded.query.kind[0].name;
        assert.ok(['Primary', 'Concurrent', 'Recovery'].includes(kind));
        const page = state.trace.filter(item => item.kind === kind).length;
        assert.ok(page < 3, 'No fourth query page');
        assert.equal(decoded.query.startCursor.toString(), page ? `cursor-${page * 2}` : '');
        assert.equal(decoded.query.limit.value, 6 - page * 2);
        assert.equal(decoded.query.order[0].property.name, 'rank');
        Object.assign(receipt, { kind, cursor: decoded.query.startCursor.toString(), limit: decoded.query.limit.value });
        body = { batch: { entityResultType: 'FULL', skippedResults: 0,
          entityResults: [page * 2, page * 2 + 1].map(rank => ({ entity: {
            key: { partitionId: decoded.partitionId, path: [{ kind, name: `row-${rank}` }] },
            properties: { rank: { integerValue: String(rank) } },
          } })), moreResults: page === 2 ? 'NO_MORE_RESULTS' : 'NOT_FINISHED', endCursor: Buffer.from(`cursor-${page * 2 + 2}`) } };
        cancelTarget = kind === 'Primary' && page === 1 && (state.scenario.endsWith('-inflight') || state.scenario === 'query-shared-concurrent');
        held = cancelTarget || kind === 'Concurrent' && page === 0 && state.scenario === 'query-shared-concurrent';
      } else if (method === 'BeginTransaction') {
        body = { transaction: Buffer.from(`transaction-${namespace}`) };
      } else if (method === 'Commit') {
        assert.equal(decoded.mutations.length, 1);
        const entity = decoded.mutations[0].upsert, name = entity.key.path[0].name;
        assert.equal(entity.key.partitionId.namespaceId, namespace); assert.equal(entity.properties.rank.integerValue, '41');
        assert.ok(['primary', 'concurrent'].includes(name)); receipt.key = name;
        if (state.scenario.startsWith('transaction-')) {
          assert.equal(decoded.mode, 'TRANSACTIONAL');
          assert.equal(decoded.transaction.toString(), `transaction-${namespace}`);
        } else assert.equal(decoded.mode, 'NON_TRANSACTIONAL');
        // The mutation is durable in this controlled state before response
        // release. Cancellation cannot be mistaken for rollback.
        state.stored.set(name, entity);
        body = { mutationResults: [{ key: entity.key, version: '101' }], indexUpdates: 1 };
        cancelTarget = name === 'primary' && (state.scenario.endsWith('-inflight') || state.scenario === 'commit-shared-concurrent');
        held = cancelTarget || name === 'concurrent' && state.scenario === 'commit-shared-concurrent';
      } else if (method === 'Rollback') {
        assert.equal(state.scenario, 'transaction-cancel-inflight');
        assert.equal(decoded.transaction.toString(), `transaction-${namespace}`);
        assert.equal(request.headers.get('x-wga-cancellation-case'), null);
        body = {}; state.rollbackArrived.resolve();
      } else {
        assert.equal(decoded.keys.length, 1);
        const name = decoded.keys[0].path[0].name; receipt.key = name;
        const entity = state.stored.get(name); assert.ok(entity, 'Accepted write remains readable');
        body = { found: [{ entity, version: '101' }] };
      }
      receipt.held = held; receipt.cancelTarget = cancelTarget;
      const bytes = codecs[method].response.encode(codecs[method].response.fromObject(body)).finish();
      receipt.responseSha256 = digest(bytes); state.trace.push(receipt);
      if (held) {
        if (cancelTarget) {
          assert.equal(state.held, null, 'One withheld primary response');
          state.held = defer(); state.arrived.resolve(); await state.held.promise;
        } else {
          assert.equal(state.siblingHeld, null, 'One withheld sibling response');
          state.siblingHeld = defer(); state.siblingArrived.resolve(); await state.siblingHeld.promise;
        }
      }
      return new Response(Buffer.concat([frame(bytes), frame(Buffer.from('grpc-status: 0\r\n'), true)]),
        { headers: { 'content-type': mime } });
    } catch (error) {
      report.unexpectedRequests.push(error.message); return new Response('SDK cancellation fixture failed', { status: 500 });
    }
  }
  return { setup, control, fetch: fetchPeer,
    cleanup() { for (const state of states.values()) { state.held?.resolve(); state.siblingHeld?.resolve(); } } };
}

async function bundle(req, project, consumer, temporary, profile) {
  const { createGoogleWorkerBuild } = req('@grpc/grpc-js/build');
  const preset = createGoogleWorkerBuild({ projectRoot: project, profile,
    outdir: path.join(temporary, 'preset'), typescript: require('typescript') });
  const result = await workerRequire('esbuild').build({ absWorkingDir: root,
    entryPoints: [path.join(consumer, 'worker.mjs')], bundle: true, format: 'cjs', platform: 'node', target: 'es2022',
    outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin], metafile: true });
  const inputs = Object.keys(result.metafile.inputs).map(file => path.resolve(root, file));
  assert.ok(inputs.includes(path.join(consumer, 'sdk-cancellation-shared.mjs')));
  assert.ok(inputs.includes(req.resolve('@grpc/grpc-js/sdk')), 'Installed optional helper bundled');
  const entry = path.join(temporary, 'worker.mjs'); fs.writeFileSync(entry, 'import bundle from "./sdk.cjs"; export default bundle.default;\n');
  const config = path.join(temporary, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-sdk-cancellation-local', main: entry,
    compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const key of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(key)) delete environment[key];
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
    'deploy', '--dry-run', '--config', config, '--outdir', path.join(temporary, 'bundle'), '--no-autoconfig'],
  { cwd: root, env: environment, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(temporary, 'bundle/worker.js'), 'utf8');
  return { script, manifest: preset.manifest(), sha256: digest(script) };
}

async function main() {
  const buildRoot = path.join(root, '.wga-build'); fs.mkdirSync(buildRoot, { recursive: true });
  for (const expected of profiles) {
    const project = path.join(root, 'fixtures', expected.fixture), req = createRequire(path.join(project, 'package.json'));
    assert.equal(req('@google-cloud/datastore/package.json').version, expected.sdkVersion);
    assert.equal(req(`${expected.generatedPackage}/package.json`).version, expected.generatedVersion);
    const consumer = fs.mkdtempSync(path.join(project, '.sdk-cancellation-'));
    const temporary = fs.mkdtempSync(path.join(buildRoot, 'sdk-cancellation-'));
    try {
      const copies = { 'sdk-cancellation-shared.mjs': 'fixtures/google/shared/sdk-cancellation.mjs',
        'worker.mjs': 'fixtures/worker/sdk-cancellation.mjs' };
      const copiedHashes = {};
      for (const [name, source] of Object.entries(copies)) {
        fs.copyFileSync(path.join(root, source), path.join(consumer, name));
        copiedHashes[source] = digest(fs.readFileSync(path.join(consumer, name)));
        assert.equal(copiedHashes[source], report.evidence[source]);
      }
      const installedInputs = {};
      for (const file of installedForProfile(expected)) {
        installedInputs[file] = digest(fs.readFileSync(path.join(project, 'node_modules', file)));
        report.installedInputs[`fixtures/${expected.fixture}/node_modules/${file}`] = installedInputs[file];
      }
      const row = { ...expected, status: 'running', copiedHashes, installedInputs,
        sharedSourceSha256: copiedHashes['fixtures/google/shared/sdk-cancellation.mjs'] };
      report.profiles.push(row);
      const shared = await import(pathToFileURL(path.join(consumer, 'sdk-cancellation-shared.mjs')).href);
      assert.deepEqual(shared.cancellationScenarios, scenarios);
      const built = await bundle(req, project, consumer, temporary, expected.id);
      row.build = { profile: built.manifest.profile, revision: built.manifest.revision,
        profileSha256: built.manifest.profileSha256, registrySha256: built.manifest.registrySha256 };
      row.bundleSha256 = built.sha256;
      for (const runtime of ['node', 'workerd']) for (const mode of ['grpc-web', 'cloudflare']) {
        const peer = controlledPeer(req, mode, expected);
        const worker = runtime === 'workerd' ? new Miniflare(convertV4MiniflareOptions({
          modules: true, script: built.script, compatibilityDate, compatibilityFlags: ['nodejs_compat'],
          log: new Log(LogLevel.NONE), outboundService: request => peer.fetch(request),
        })) : null;
        try {
          for (const scenario of scenarios) {
            const namespace = `${expected.fixture}-${runtime}-${mode}-${scenario}`;
            const state = peer.setup(namespace, scenario), beforeUnhandled = report.unhandledRejections.length;
            let result, workerUnhandled = [];
            if (worker) {
              const response = await bounded(worker.dispatchFetch('https://fixture.test/run', { method: 'POST',
                body: JSON.stringify({ scenario, namespace, mode }) }), `${namespace}-dispatch`);
              const body = await bounded(response.json(), `${namespace}-body`);
              assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.status, 'passed');
              result = body.result; workerUnhandled = body.unhandledRejections;
            } else result = await bounded(shared.runSdkCancellation({ scenario, namespace, mode,
              send: (url, init) => peer.fetch(new Request(url, init)), control: operation => peer.control(namespace, operation) }), namespace);
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(report.unexpectedRequests, []); assert.deepEqual(workerUnhandled, []);
            report.results.push({ profile: expected.id, runtime, mode, scenario, namespace, status: 'passed',
              trace: state.trace, stored: [...state.stored].map(([name, entity]) => ({ name, rank: Number(entity.properties.rank.integerValue) })),
              controlCount: state.controlCount, heldResponseReleased: state.released,
              unhandledRejections: [...report.unhandledRejections.slice(beforeUnhandled), ...workerUnhandled], result });
          }
        } finally { peer.cleanup(); if (worker) await worker.dispose(); }
      }
      row.status = 'passed';
    } finally { fs.rmSync(consumer, { recursive: true, force: true }); fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  report.status = 'passed'; report.runtimeDisposed = true;
  report.scenarioCount = report.results.length;
  report.extensionCases = extensionCases(report.results);
  report.fetchCount = report.results.reduce((sum, row) => sum + row.trace.length, 0);
  report.signalAbortCount = report.results.reduce((sum, row) => sum + row.result.accounting.signalAborts.length, 0);
  report.finishedAt = new Date().toISOString();
  validateSdkCancellationReport(report);
}
main().catch(error => { report.status = 'failed'; report.error = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  process.removeListener('unhandledRejection', onUnhandled);
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/sdk-cancellation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, scenarios: report.results.length, fetchCount: report.fetchCount,
    report: 'verification/sdk-cancellation.json' }));
});
