'use strict';
// Pinned Google SDK pagination against an observable native grpc-js service.
// The loopback bridge translates framing only; this is not a cloud emulator.
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
const scenarios = ['complete', 'destroy-first', 'destroy-inflight', 'end-first', 'end-inflight'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { status: 'running', startedAt: new Date().toISOString(), liveGoogle: false,
  cloudflareTranslation: false, officialEmulator: false, controlledNativeGrpcServer: true,
  workerAbortPropagationTested: false, perPageTimeoutMs: 5000,
  scope: 'Pinned SDK page progression and public stream stop semantics; no sustained-load or edge-conversion certification',
  sameSharedSource: false, sourceHashes: {}, runtime: process.version, nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version,
  sdkVersion: nativeRequire('@google-cloud/datastore/package.json').version, results: [], checks: [] };
const errors = [];

function trailer(headers) {
  const bytes = Buffer.from(Object.entries(headers).filter(([key]) => !key.startsWith(':'))
    .map(([key, value]) => `${key}: ${value}\r\n`).join(''));
  const prefix = Buffer.alloc(5);
  prefix[0] = 128;
  prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}

function bounded(promise, label, timeoutMs = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pagination-${label}-timeout`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

async function main() {
  assert.equal(googleRequire('@google-cloud/datastore/package.json').version, report.sdkVersion);
  report.evidence = Object.fromEntries(['scripts/test-datastore-pagination.cjs', 'fixtures/google/pagination-worker.mjs',
    'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json']
    .map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const states = new Map();
  const proto = path.join(path.dirname(nativeRequire.resolve('@google-cloud/datastore/package.json')), 'build/protos/protos.json');
  const packages = native.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(proto)),
    { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
  const server = new native.Server();
  server.addService(packages.google.datastore.v1.Datastore.service, {
    runQuery(call, callback) {
      let state;
      try {
        const request = call.request;
        state = states.get(request.partitionId.namespaceId);
        assert.ok(state, 'Known fixture namespace');
        assert.equal(request.projectId, 'wga-pagination');
        const kind = request.query.kind[0].name;
        assert.ok(['Pagination', 'ReusePagination'].includes(kind));
        const cursor = request.query.startCursor.toString();
        const page = state.trace.filter(item => item.kind === kind).length;
        assert.ok(page < 3, 'No fourth query page');
        assert.equal(cursor, page === 0 ? '' : `cursor-${page * 2}`);
        assert.equal(request.query.limit.value, 6 - page * 2, 'SDK decreases page limit');
        assert.equal(request.query.offset, page === 0 ? 3 : 0, 'SDK consumes skipped offset');
        assert.equal(request.query.order[0].property.name, 'rank');
        state.trace.push({ method: 'RunQuery', kind, cursor, limit: request.query.limit.value, offset: request.query.offset });
        const rows = [page * 2, page * 2 + 1];
        const reply = { batch: {
          entityResultType: 'FULL', skippedResults: page === 0 ? 3 : 0,
          entityResults: rows.map(rank => ({ entity: {
            key: { partitionId: request.partitionId, path: [{ kind, name: `row-${rank}` }] },
            properties: { rank: { integerValue: String(rank) } },
          } })),
          moreResults: page === 2 ? 'NO_MORE_RESULTS' : 'NOT_FINISHED',
          endCursor: Buffer.from(`cursor-${page * 2 + 2}`),
        } };
        if (state.scenario.endsWith('-inflight') && kind === 'Pagination' && page === 1) {
          state.held = { call, callback, reply, replied: false, cancelledBeforeReply: false };
          call.on('cancelled', () => {
            if (!state.held.replied) state.held.cancelledBeforeReply = true;
          });
          state.arrived();
        } else callback(null, reply);
      } catch (error) {
        errors.push(error.message);
        callback({ code: native.status.INTERNAL, details: 'pagination-fixture-invariant-failed' });
      }
    },
    lookup(call, callback) {
      try {
        const state = states.get(call.request.keys[0].partitionId.namespaceId);
        assert.ok(state, 'Known lookup namespace');
        assert.equal(call.request.keys.length, 1);
        assert.equal(call.request.keys[0].path[0].kind, 'PaginationMarker');
        assert.equal(call.request.keys[0].path[0].name, 'alive');
        state.trace.push({ method: 'Lookup' });
        callback(null, { found: [{ entity: { key: call.request.keys[0], properties: { rank: { integerValue: '99' } } } }] });
      } catch (error) {
        errors.push(error.message);
        callback({ code: native.status.INTERNAL, details: 'pagination-fixture-lookup-failed' });
      }
    },
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(),
    (error, value) => error ? reject(error) : resolve(value)));
  const sessions = new Set();
  let grpcWebRequests = 0;
  const bridge = http.createServer((request, response) => {
    const contentType = request.headers['content-type'];
    if (request.method !== 'POST' || !['application/grpc-web', 'application/grpc-web+proto'].includes(contentType)) {
      errors.push('Unexpected loopback bridge request');
      response.writeHead(400).end();
      return;
    }
    grpcWebRequests++;
    const session = http2.connect(`http://127.0.0.1:${port}`);
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
    session.on('error', () => response.destroy());
    const upstream = session.request({ ':method': 'POST', ':path': request.url, 'content-type': 'application/grpc', te: 'trailers',
      ...(request.headers['grpc-timeout'] ? { 'grpc-timeout': request.headers['grpc-timeout'] } : {}) });
    let hasStatus = false, ended = false;
    upstream.on('response', headers => {
      response.writeHead(200, { 'content-type': contentType });
      if (headers['grpc-status'] !== undefined) { hasStatus = true; response.write(trailer(headers)); }
    });
    upstream.on('data', chunk => response.write(chunk));
    upstream.on('trailers', headers => { hasStatus = true; response.write(trailer(headers)); });
    upstream.on('end', () => {
      ended = true;
      if (!hasStatus) { errors.push('Native server omitted status'); response.destroy(); }
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
  const buildBase = path.join(root, '.wga-build');
  fs.mkdirSync(buildBase, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(buildBase, 'pagination-'));
  function releasePending() {
    for (const state of states.values()) if (state.held && !state.held.replied) {
      state.held.replied = true;
      state.held.callback({ code: native.status.CANCELLED, details: 'fixture-cleanup' });
    }
  }
  function setup(runtime, scenario) {
    const namespace = `${runtime}-${scenario}`;
    const state = { scenario, trace: [], held: null };
    state.arrival = new Promise(resolve => { state.arrived = resolve; });
    states.set(namespace, state);
    return namespace;
  }
  async function control(namespace, operation) {
    const state = states.get(namespace);
    assert.ok(state);
    if (operation === 'await-held') { await bounded(state.arrival, 'held-page-arrival'); return { arrived: true }; }
    assert.ok(state.held, 'Held page exists');
    const pending = !state.held.replied;
    if (operation === 'held-state') return { pending, cancelledBeforeReply: state.held.cancelledBeforeReply };
    assert.equal(operation, 'release');
    assert.ok(pending);
    assert.equal(state.held.cancelledBeforeReply, false, 'SDK preserves the outstanding unary RPC');
    state.held.replied = true;
    state.held.callback(null, state.held.reply);
    return { released: true };
  }
  function verify(runtime, scenario, namespace, result, before) {
    assert.deepEqual(errors, [], 'Controlled server and bridge invariants');
    const state = states.get(namespace);
    const count = scenario === 'end-first' ? 1 : scenario === 'end-inflight' ? 2 : 3;
    const pages = state.trace.filter(item => item.kind === 'Pagination');
    assert.equal(pages.length, count, 'Observed SDK stop behavior has exact page count');
    assert.deepEqual(pages.map(item => item.cursor), ['', 'cursor-2', 'cursor-4'].slice(0, count));
    assert.deepEqual(state.trace.filter(item => item.kind === 'ReusePagination').map(item => item.cursor), ['', 'cursor-2', 'cursor-4']);
    assert.equal(state.trace.filter(item => item.method === 'Lookup').length, 1);
    assert.equal(state.trace.length, count + 4);
    if (state.held) assert.equal(state.held.cancelledBeforeReply, false);
    const requests = grpcWebRequests - before;
    assert.equal(requests, runtime === 'native' ? 0 : state.trace.length);
    report.results.push({ runtime, scenario, status: 'passed', rpcCount: state.trace.length, grpcWebRequests: requests,
      trace: state.trace, result, ...(state.held ? { cancelledBeforeReply: state.held.cancelledBeforeReply } : {}) });
  }
  try {
    const helperNames = ['datastore-pagination.mjs', 'assert.mjs'];
    report.sharedSourceHashes = Object.fromEntries(helperNames.map(file => [file,
      digest(fs.readFileSync(path.join(root, 'fixtures/google/shared', file)))]));
    for (const runtime of ['native', 'adapter']) {
      const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
      const req = createRequire(path.join(fixture, 'package.json'));
      const grpc = req('@grpc/grpc-js');
      const consumer = fs.mkdtempSync(path.join(fixture, '.pagination-'));
      try {
        report.sourceHashes[runtime] = {};
        for (const file of helperNames) {
          const source = fs.readFileSync(path.join(root, 'fixtures/google/shared', file));
          fs.writeFileSync(path.join(consumer, file), source);
          report.sourceHashes[runtime][file] = digest(fs.readFileSync(path.join(consumer, file)));
          assert.equal(report.sourceHashes[runtime][file], report.sharedSourceHashes[file]);
        }
        const { runDatastorePagination } = await import(pathToFileURL(path.join(consumer, 'datastore-pagination.mjs')).href);
        const authClient = new (req('google-auth-library').OAuth2Client)();
        authClient.setCredentials({ access_token: 'pagination-local-fixture' });
        const base = { projectId: 'wga-pagination', apiEndpoint: `127.0.0.1:${port}`, sslCreds: grpc.credentials.createInsecure() };
        const options = runtime === 'native' ? base : req('@grpc/grpc-js/adapter').createWorkersGrpcTransport({
          mode: 'grpc-web', allowInsecureLocalhost: true, endpoints: { [`127.0.0.1:${port}`]: bridgeOrigin },
        }).gaxOptions({ projectId: base.projectId, apiEndpoint: base.apiEndpoint, authClient });
        for (const scenario of scenarios) {
          const namespace = setup(runtime, scenario), before = grpcWebRequests;
          const result = await bounded(runDatastorePagination({ options, scenario, namespace,
            control: operation => control(namespace, operation) }), 'node-scenario', 20000);
          verify(runtime, scenario, namespace, result, before);
        }
      } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
    }
    const bundle = await buildGoogleWorker({ entry: path.join(root, 'fixtures/google/pagination-worker.mjs'), outdir: temporary });
    report.buildProfile = { name: bundle.manifest.profile, revision: bundle.manifest.revision,
      sha256: bundle.manifest.profileSha256, registrySha256: bundle.manifest.registrySha256 };
    report.sourceHashes.workerd = Object.fromEntries(helperNames.map(file => [file,
      bundle.manifest.sourceHashes[`fixtures/google/shared/${file}`]]));
    assert.deepEqual(report.sourceHashes.native, report.sourceHashes.adapter);
    assert.deepEqual(report.sourceHashes.native, report.sourceHashes.workerd);
    report.sameSharedSource = true;
    const config = path.join(temporary, 'wrangler.json');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-pagination-local', main: bundle.main,
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
            if (url.hostname === 'pagination-control.invalid') {
              const [namespace, operation] = url.pathname.slice(1).split('/');
              return Response.json(await control(namespace, operation));
            }
            assert.equal(url.hostname, mode === 'cloudflare' ? 'datastore.googleapis.com' : 'pagination-gateway.invalid');
            assert.equal(request.headers.get('content-type'), mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto');
            assert.equal(request.headers.get('authorization'), 'Bearer pagination-local-fixture');
            // workerd's local outbound binding forwards to the test bridge.
            // No request reaches Google or Cloudflare's conversion service.
            // Miniflare exposes a placeholder content length; Node Fetch must
            // compute transport framing from the forwarded bytes.
            const headers = new Headers(request.headers);
            for (const name of ['content-length', 'host', 'connection', 'transfer-encoding']) headers.delete(name);
            return await fetch(`${bridgeOrigin}${url.pathname}`, { method: 'POST', headers,
              body: Buffer.from(await request.arrayBuffer()), signal: request.signal });
          } catch (error) {
            errors.push(`${error.message}${error.cause?.message ? `: ${error.cause.message}` : ''}`);
            return new Response('Pagination fixture failure', { status: 500 });
          }
        },
      }));
      try {
        for (const scenario of scenarios) {
          const namespace = setup(mode, scenario), before = grpcWebRequests;
          const { response, body } = await bounded((async () => {
            const response = await worker.dispatchFetch(`https://fixture.test/${scenario}`);
            return { response, body: await response.json() };
          })(), 'worker-scenario', 20000);
          assert.deepEqual(errors, [], 'Worker outbound invariants');
          assert.equal(response.status, 200, JSON.stringify(body));
          assert.equal(body.status, 'passed');
          verify(`workerd-${mode}`, scenario, namespace, body.result, before);
        }
      } finally { releasePending(); await worker.dispose(); }
    }
    // Compare normalized public events and exact server-side cursor traces.
    // Completed Transform streams need not emit close before the helper returns.
    const comparable = item => ({ scenario: item.scenario, trace: [...item.trace].sort((a, b) =>
      `${a.kind || a.method}/${a.cursor || ''}`.localeCompare(`${b.kind || b.method}/${b.cursor || ''}`)),
      result: { ...item.result,
        original: { ...item.result.original, close: item.scenario === 'complete' ? undefined : item.result.original.close },
        reused: { ...item.result.reused, close: undefined },
      } });
    for (const runtime of ['adapter', 'workerd-grpc-web', 'workerd-cloudflare']) {
      assert.deepEqual(report.results.filter(item => item.runtime === runtime).map(comparable),
        report.results.filter(item => item.runtime === 'native').map(comparable), `${runtime}: upstream SDK parity`);
    }
    assert.equal(report.results.length, 20);
    report.rpcCount = report.results.reduce((total, item) => total + item.rpcCount, 0);
    assert.equal(report.rpcCount, 128);
    report.grpcWebRequests = grpcWebRequests;
    report.checks = ['three-observed-unary-pages', 'cursor-limit-and-offset-progression', 'ordered-entity-keys',
      'single-terminal-info', 'bare-destroy-stops-delivery-but-continues-pagination', 'stop-while-second-page-pending',
      'pending-unary-is-not-cancelled-by-sdk', 'no-late-entities-after-release', 'end-suppresses-subsequent-pages',
      'concurrent-lookup-after-destroy', 'same-client-three-page-reuse', 'native-adapter-workerd-parity'];
    report.status = 'passed';
  } finally {
    // Failures must not leave a deliberately withheld RPC alive.
    releasePending();
    bridge.closeAllConnections();
    for (const session of sessions) session.destroy();
    await new Promise(resolve => bridge.close(resolve));
    server.forceShutdown();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { report.status = 'failed'; report.error = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/datastore-pagination.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.results.length, rpcCount: report.rpcCount,
    report: 'verification/datastore-pagination.json' }));
});
