'use strict';
// Observable native grpc-js Lookup replies. This is a controlled protocol peer,
// not an emulator, Google service, or Cloudflare edge translation test.
process.env.GOOGLE_SDK_NODE_LOGGING = '';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { buildGoogleWorker } = require('./build-google-worker.cjs');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const loader = nativeRequire('@grpc/proto-loader');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', startedAt: new Date().toISOString(), liveGoogle: false,
  cloudflareTranslation: false, officialEmulator: false, controlledNativeGrpcServer: true,
  scope: 'Pinned SDK finite deferred Lookup, get overloads and explicit error/stop behavior; no production consistency or automatic conversion certification',
  sameSharedSource: false, sourceHashes: {}, runtime: process.version,
  nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version,
  sdkVersion: nativeRequire('@google-cloud/datastore/package.json').version, results: [], checks: [] };
const failures = [];
const rounds = { 'mixed-promise': 3, 'mixed-callback': 3, 'mixed-stream': 3, 'single-deferred': 2,
  'single-missing': 1, 'all-missing': 1, 'denied-promise': 1, 'denied-callback': 1,
  'unavailable-no-retry': 1, 'unavailable-retry': 3, 'partial-stream-error': 2,
  'partial-get-error': 2, 'deferred-deadline': 2, 'end-first': 1, 'end-held': 2, 'invalid-options': 0 };

function bounded(promise, label, timeoutMs = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`lookup-${label}-timeout`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
function trailer(headers) {
  const bytes = Buffer.from(Object.entries(headers).filter(([key]) => !key.startsWith(':'))
    .map(([key, value]) => `${key}: ${value}\r\n`).join(''));
  const prefix = Buffer.alloc(5);
  prefix[0] = 128;
  prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}
function keyId(key) {
  return key.path.map(part => `${part.kind}/${part.id ? `id:${part.id}` : `name:${part.name}`}`).join('/');
}
const ids = [0, 'missing', 1, 2].map(value => `LookupRoot/name:ancestor/LookupValue/${value === 0
  ? 'id:9007199254740993' : `name:${typeof value === 'number' ? `name-${value}` : value}`}`);
function entity(key) {
  const last = key.path.at(-1);
  const rank = last.id ? 0 : Number(last.name.slice(5));
  return { entity: { key, properties: {
    rank: { doubleValue: rank }, large: { integerValue: '9223372036854775806' },
    when: { timestampValue: { seconds: '1767323045', nanos: 0 } },
    blob: { blobValue: Buffer.from([0, 1, 127, 255]) }, enabled: { booleanValue: true },
    nothing: { nullValue: 'NULL_VALUE' }, label: { stringValue: `value-${rank}` },
  } } };
}

async function main() {
  assert.equal(report.sdkVersion, '10.1.0');
  assert.equal(googleRequire('@google-cloud/datastore/package.json').version, report.sdkVersion);
  report.evidence = Object.fromEntries(['scripts/test-datastore-lookup.cjs', 'fixtures/worker/datastore-lookup.mjs',
    'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json']
    .map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const shared = await import(pathToFileURL(path.join(root, 'fixtures/google/shared/datastore-lookup.mjs')).href);
  const scenarios = shared.lookupScenarios;
  assert.deepEqual(scenarios, Object.keys(rounds));
  const states = new Map();
  const proto = path.join(path.dirname(nativeRequire.resolve('@google-cloud/datastore/package.json')), 'build/protos/protos.json');
  const packages = native.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(proto)),
    { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
  const server = new native.Server();
  const sessions = new Set();
  let bridge, temporary, grpcWebRequests = 0;
  const expectedTrace = scenario => scenario === 'invalid-options' ? []
    : scenario === 'single-deferred' ? [[ids[0]], [ids[0]]]
    : scenario === 'single-missing' ? [[ids[1]]]
    : scenario === 'all-missing' ? [[ids[1], 'LookupRoot/name:ancestor/LookupValue/name:also-missing']]
    : scenario === 'unavailable-retry' ? [ids, ids, ids]
    : [ids, [ids[3], ids[0]], [ids[3]]].slice(0, rounds[scenario]);
  function releasePending() {
    for (const state of states.values()) if (state.held && !state.held.replied) {
      state.held.replied = true;
      state.held.callback({ code: native.status.CANCELLED, details: 'lookup-fixture-cleanup' });
    }
  }
  function setup(runtime, scenario) {
    const namespace = `${runtime}-${scenario}`;
    const state = { scenario, runtime, trace: [], held: null };
    state.arrival = new Promise(resolve => { state.arrived = resolve; });
    state.cancellation = new Promise(resolve => { state.cancelled = resolve; });
    states.set(namespace, state);
    return namespace;
  }
  async function control(namespace, operation) {
    const state = states.get(namespace);
    assert.ok(state, 'Control namespace exists');
    if (operation === 'await-held') { await bounded(state.arrival, 'pending-arrival'); return { arrived: true }; }
    if (operation === 'await-cancelled') {
      await bounded(state.cancellation, 'deadline-cancellation');
      return { cancelled: true };
    }
    assert.ok(state.held, 'Controlled pending lookup exists');
    const pending = !state.held.replied;
    if (operation === 'held-state') return { pending, cancelledBeforeReply: state.held.cancelledBeforeReply };
    assert.equal(operation, 'release');
    assert.ok(pending);
    assert.equal(state.held.cancelledBeforeReply, false, 'SDK end leaves pending unary alive');
    state.held.replied = true;
    state.held.callback(null, state.held.reply);
    return { released: true };
  }
  function verify(runtime, scenario, namespace, result, before) {
    assert.deepEqual(failures, [], 'Controlled peer invariants');
    const state = states.get(namespace);
    const lookups = state.trace.filter(item => !item.marker);
    assert.deepEqual(lookups.map(item => item.keys), expectedTrace(scenario), 'Only deferred keys are reissued, preserving wire key identity');
    assert.equal(state.trace.filter(item => item.marker).length, 1, 'Same SDK client reused');
    assert.equal(state.trace.length, rounds[scenario] + 1, 'Exact total RPC count');
    const requests = grpcWebRequests - before;
    assert.equal(requests, runtime === 'native' ? 0 : state.trace.length);
    if (scenario === 'deferred-deadline') assert.equal(state.held.cancelledBeforeReply, true);
    if (scenario === 'end-held') assert.equal(state.held.cancelledBeforeReply, false);
    report.results.push({ runtime, scenario, status: 'passed', rpcCount: state.trace.length,
      grpcWebRequests: requests, trace: state.trace, result,
      ...(state.held ? { cancelledBeforeReply: state.held.cancelledBeforeReply } : {}) });
  }
  try {
    server.addService(packages.google.datastore.v1.Datastore.service, {
      lookup(call, callback) {
        try {
          const request = call.request;
          assert.ok(request.keys.length > 0 && request.keys.length <= 4, 'Bounded nonempty lookup');
          const namespace = request.keys[0].partitionId.namespaceId;
          const state = states.get(namespace);
          assert.ok(state, 'Known lookup namespace');
          assert.equal(request.projectId, 'wga-lookup');
          assert.equal(request.databaseId, 'lookup-db');
          assert.equal(request.readOptions.readConsistency, 'STRONG');
          assert.equal(call.metadata.get('x-wga-lookup')[0], state.scenario);
          assert.ok(call.metadata.get('x-goog-request-params')[0].includes('project_id=wga-lookup'));
          for (const key of request.keys) {
            assert.equal(key.partitionId.namespaceId, namespace);
            assert.equal(key.partitionId.projectId, '');
          }
          const marker = request.keys[0].path[0].kind === 'LookupMarker';
          if (marker) {
            assert.equal(request.keys.length, 1);
            assert.equal(request.keys[0].path[0].name, 'alive');
            state.trace.push({ marker: true, keys: ['LookupMarker/name:alive'], status: 0 });
            callback(null, { found: [{ entity: { key: request.keys[0], properties: { rank: { integerValue: '99' } } } }] });
            return;
          }
          const round = state.trace.filter(item => !item.marker).length;
          assert.ok(round < rounds[state.scenario], 'No unexpected deferred round or unbounded retry');
          assert.deepEqual(request.keys.map(keyId), expectedTrace(state.scenario)[round]);
          const trace = { marker: false, keys: request.keys.map(keyId), status: 0 };
          state.trace.push(trace);
          if (state.scenario.startsWith('denied-') || (state.scenario.startsWith('partial-') && round === 1)) {
            trace.status = 7; callback({ code: 7, details: 'lookup-fixture-denied' }); return;
          }
          if (state.scenario === 'unavailable-no-retry' || (state.scenario === 'unavailable-retry' && round < 2)) {
            trace.status = 14; callback({ code: 14, details: 'lookup-fixture-unavailable' }); return;
          }
          let reply;
          if (state.scenario.includes('missing')) reply = { missing: request.keys.map(key => ({ entity: { key } })) };
          else if (state.scenario === 'single-deferred') reply = round === 0 ? { deferred: request.keys } : { found: request.keys.map(entity) };
          else if (state.scenario === 'unavailable-retry') reply = {
            found: [request.keys[0], request.keys[2], request.keys[3]].map(entity), missing: [{ entity: { key: request.keys[1] } }],
          };
          else reply = round === 0 ? { found: [entity(request.keys[2])], missing: [{ entity: { key: request.keys[1] } }],
            deferred: [request.keys[3], request.keys[0]] }
            : round === 1 ? { found: [entity(request.keys[1])], deferred: [request.keys[0]] } : { found: request.keys.map(entity) };
          if (round === 1 && ['deferred-deadline', 'end-held'].includes(state.scenario)) {
            state.held = { callback, reply, replied: false, cancelledBeforeReply: false };
            call.on('cancelled', () => {
              if (!state.held.replied) {
                state.held.cancelledBeforeReply = true;
                if (state.scenario === 'deferred-deadline') trace.status = 4;
                state.cancelled();
              }
            });
            state.arrived();
          } else callback(null, reply);
        } catch (error) {
          failures.push(error.message);
          callback({ code: native.status.INTERNAL, details: 'lookup-fixture-invariant-failed' });
        }
      },
    });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(),
      (error, value) => error ? reject(error) : resolve(value)));
    bridge = http.createServer((request, response) => {
      const contentType = request.headers['content-type'];
      if (request.method !== 'POST' || request.url !== '/google.datastore.v1.Datastore/Lookup'
        || !['application/grpc-web', 'application/grpc-web+proto'].includes(contentType)) {
        failures.push('Unexpected lookup bridge request'); response.writeHead(400).end(); return;
      }
      grpcWebRequests++;
      const session = http2.connect(`http://127.0.0.1:${port}`);
      sessions.add(session);
      session.on('close', () => sessions.delete(session));
      session.on('error', () => response.destroy());
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) =>
        !['host', 'connection', 'transfer-encoding', 'content-length', 'content-type'].includes(name)));
      const upstream = session.request({ ...headers, ':method': 'POST', ':path': request.url, 'content-type': 'application/grpc', te: 'trailers' });
      let hasStatus = false, ended = false;
      upstream.on('response', received => {
        response.writeHead(200, { 'content-type': contentType });
        if (received['grpc-status'] !== undefined) { hasStatus = true; response.write(trailer(received)); }
      });
      upstream.on('data', chunk => response.write(chunk));
      upstream.on('trailers', received => { hasStatus = true; response.write(trailer(received)); });
      upstream.on('end', () => {
        ended = true;
        if (!hasStatus) response.destroy();
        else response.end();
        session.close();
      });
      upstream.on('error', () => { ended = true; response.destroy(); session.destroy(); });
      response.on('close', () => { if (!ended) { upstream.close(http2.constants.NGHTTP2_CANCEL); session.destroy(); } });
      request.pipe(upstream);
    });
    bridge.listen(0, '127.0.0.1');
    await once(bridge, 'listening');
    const bridgeOrigin = `http://127.0.0.1:${bridge.address().port}`;
    fs.mkdirSync(path.join(root, '.wga-build'), { recursive: true });
    temporary = fs.mkdtempSync(path.join(root, '.wga-build/lookup-'));
    const helperNames = ['datastore-lookup.mjs', 'assert.mjs'];
    report.sharedSourceHashes = Object.fromEntries(helperNames.map(file => [file,
      digest(fs.readFileSync(path.join(root, 'fixtures/google/shared', file)))]));
    for (const runtime of ['native', 'adapter']) {
      const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
      const req = createRequire(path.join(fixture, 'package.json'));
      const grpc = req('@grpc/grpc-js');
      const consumer = fs.mkdtempSync(path.join(fixture, '.lookup-'));
      try {
        report.sourceHashes[runtime] = {};
        for (const file of helperNames) {
          const source = fs.readFileSync(path.join(root, 'fixtures/google/shared', file));
          fs.writeFileSync(path.join(consumer, file), source);
          report.sourceHashes[runtime][file] = digest(fs.readFileSync(path.join(consumer, file)));
          assert.equal(report.sourceHashes[runtime][file], report.sharedSourceHashes[file]);
        }
        const { runDatastoreLookup, createLookupAuth } = await import(pathToFileURL(path.join(consumer, 'datastore-lookup.mjs')).href);
        const base = { projectId: 'wga-lookup', apiEndpoint: `127.0.0.1:${port}`, sslCreds: grpc.credentials.createInsecure() };
        const options = runtime === 'native' ? base : req('@grpc/grpc-js/adapter').createWorkersGrpcTransport({
          mode: 'grpc-web', allowInsecureLocalhost: true, endpoints: { [`127.0.0.1:${port}`]: bridgeOrigin },
        }).gaxOptions({ projectId: base.projectId, apiEndpoint: base.apiEndpoint, authClient: createLookupAuth() });
        for (const scenario of scenarios) {
          const namespace = setup(runtime, scenario), before = grpcWebRequests;
          const result = await bounded(runDatastoreLookup({ options, scenario, namespace,
            control: operation => control(namespace, operation) }), `${runtime}-${scenario}`, 15000);
          verify(runtime, scenario, namespace, result, before);
        }
      } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
    }
    const bundle = await buildGoogleWorker({ entry: path.join(root, 'fixtures/worker/datastore-lookup.mjs'), outdir: temporary });
    report.buildProfile = { name: bundle.manifest.profile, revision: bundle.manifest.revision,
      sha256: bundle.manifest.profileSha256, registrySha256: bundle.manifest.registrySha256 };
    assert.equal(bundle.manifest.entrySha256, report.evidence['fixtures/worker/datastore-lookup.mjs']);
    report.sourceHashes.workerd = Object.fromEntries(helperNames.map(file => [file,
      bundle.manifest.sourceHashes[`fixtures/google/shared/${file}`]]));
    assert.deepEqual(report.sourceHashes.native, report.sourceHashes.adapter);
    assert.deepEqual(report.sourceHashes.native, report.sourceHashes.workerd);
    report.sameSharedSource = true;
    const config = path.join(temporary, 'wrangler.jsonc');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-lookup-local', main: bundle.main,
      compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'], workers_dev: false }));
    const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
    for (const name of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(name)) delete environment[name];
    const output = path.join(temporary, 'dry-run');
    execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
      'deploy', '--dry-run', '--config', config, '--outdir', output, '--no-autoconfig'],
    { cwd: root, env: environment, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const script = fs.readFileSync(path.join(output, 'worker.js'), 'utf8');
    report.bundleSha256 = digest(script);
    for (const mode of ['grpc-web', 'cloudflare']) {
      const worker = new Miniflare(convertV4MiniflareOptions({
        log: new Log(LogLevel.NONE), modules: true, script, bindings: { MODE: mode },
        compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
        outboundService: async request => {
          try {
            const url = new URL(request.url);
            if (url.hostname === 'lookup-control.invalid') {
              const [namespace, operation] = url.pathname.slice(1).split('/');
              return Response.json(await control(namespace, operation));
            }
            assert.equal(url.hostname, mode === 'cloudflare' ? 'datastore.googleapis.com' : 'lookup-gateway.invalid');
            assert.equal(request.headers.get('content-type'), mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto');
            assert.equal(request.headers.get('authorization'), 'Bearer lookup-local-fixture');
            // Forward the actual unary bytes to the controlled native peer.
            // No request leaves loopback or invokes Cloudflare's translator.
            const headers = new Headers(request.headers);
            for (const name of ['content-length', 'host', 'connection', 'transfer-encoding']) headers.delete(name);
            return await fetch(`${bridgeOrigin}${url.pathname}`, { method: 'POST', headers,
              body: Buffer.from(await request.arrayBuffer()), signal: request.signal });
          } catch (error) {
            if (request.signal.aborted) throw error;
            failures.push(error.message);
            return new Response('Lookup fixture failure', { status: 500 });
          }
        },
      }));
      try {
        for (const scenario of scenarios) {
          const namespace = setup(mode, scenario), before = grpcWebRequests;
          const { response, body } = await bounded((async () => {
            const response = await worker.dispatchFetch(`https://fixture.test/${scenario}`);
            return { response, body: await response.json() };
          })(), `${mode}-${scenario}`, 15000);
          assert.deepEqual(failures, [], 'Worker outbound invariants');
          assert.equal(response.status, 200, JSON.stringify(body));
          assert.equal(body.status, 'passed');
          verify(`workerd-${mode}`, scenario, namespace, body.result, before);
        }
      } finally { releasePending(); await worker.dispose(); }
    }
    const comparable = item => ({ scenario: item.scenario, trace: item.trace, result: item.result,
      ...(item.cancelledBeforeReply !== undefined ? { cancelledBeforeReply: item.cancelledBeforeReply } : {}) });
    for (const runtime of ['adapter', 'workerd-grpc-web', 'workerd-cloudflare']) {
      assert.deepEqual(report.results.filter(item => item.runtime === runtime).map(comparable),
        report.results.filter(item => item.runtime === 'native').map(comparable), `${runtime}: upstream SDK parity`);
    }
    for (const state of states.values()) assert.equal(state.trace.length, rounds[state.scenario] + 1, 'No late deferred calls');
    assert.equal(report.results.length, scenarios.length * 4);
    report.rpcCount = report.results.reduce((total, item) => total + item.rpcCount, 0);
    assert.equal(report.rpcCount, (Object.values(rounds).reduce((a, b) => a + b, 0) + scenarios.length) * 4);
    report.grpcWebRequests = grpcWebRequests;
    report.checks = ['finite-three-round-deferred-lookup', 'only-deferred-keys-reissued', 'missing-keys-omitted',
      'sdk-found-order-not-input-order', 'nested-int64-and-name-key-fidelity', 'wrapped-int64-date-and-binary-values',
      'promise-callback-stream-and-single-overloads', 'local-input-errors-send-no-rpc', 'callback-exactly-once',
      'permanent-remote-error', 'explicit-sdk-retry-versus-disabled-retry', 'partial-stream-then-terminal-error',
      'get-rejects-without-partial-array', 'deferred-unary-deadline', 'end-stops-further-deferred-lookups',
      'end-does-not-cancel-current-unary', 'same-client-reuse', 'exact-rpc-counts-and-native-adapter-workerd-parity'];
    report.status = 'passed';
  } finally {
    releasePending();
    if (bridge) bridge.closeAllConnections();
    for (const session of sessions) session.destroy();
    if (bridge) await new Promise(resolve => bridge.close(resolve));
    server.forceShutdown();
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { report.status = 'failed'; report.error = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  report.failures = failures;
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/datastore-lookup.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.results.length, rpcCount: report.rpcCount,
    report: 'verification/datastore-lookup.json' }));
});
