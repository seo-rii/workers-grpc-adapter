'use strict';
// A clean installed application, not a source alias or an SDK mock.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { createServer } = require('node:https');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(process.env.WGA_TEST_TMPDIR || os.tmpdir(), 'wga-hono-'));
fs.chmodSync(temporary, 0o700);
const projectRoot = path.join(temporary, 'fixtures/hono');
const token = `runtime-only-${randomBytes(24).toString('hex')}`;
const control = randomBytes(24).toString('hex');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const report = { status: 'running', stage: 'prepare', startedAt: new Date().toISOString(), node: process.version,
  liveGoogle: false, deployment: false, cloudflareAutomaticConversion: false, sourceAliases: false,
  controlledGrpcWebPeer: true, cases: [], phaseLogs: [] };
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC)$/.test(key)));
Object.assign(environment, { CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', GOOGLE_SDK_NODE_LOGGING: '', NODE_OPTIONS: '', NODE_PATH: '' });
Object.assign(environment, { TMPDIR: temporary, npm_config_cache: path.join(temporary, '.npm-cache'),
  XDG_CACHE_HOME: path.join(temporary, '.cache') });
function redacted(value) { return String(value).replaceAll(token, '[REDACTED]').replaceAll(control, '[REDACTED]'); }
async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const directory = process.env.WGA_TEST_LOG_DIR || path.join(os.homedir(), 'logs');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
    const file = path.join(directory, `wga-hono-${report.stage}-${Date.now()}-${randomBytes(4).toString('hex')}.log`);
    const fd = fs.openSync(file, 'wx', 0o600);
    const entry = { stage: report.stage, log: file, statusFile: file.slice(0, -4) + '.status', pid: null, exitCode: null };
    report.phaseLogs.push(entry);
    const child = spawn(command, args, { cwd: options.cwd || projectRoot, env: environment,
      stdio: ['ignore', options.capture ? 'pipe' : fd, fd] });
    entry.pid = child.pid || null;
    let stdout = '';
    child.stdout?.on('data', bytes => { fs.writeSync(fd, bytes); stdout += bytes; if (stdout.length > 8 * 1024 * 1024) child.kill('SIGKILL'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); fs.closeSync(fd); Object.assign(entry, { exitCode: code, signal });
      fs.writeFileSync(entry.statusFile, JSON.stringify({ pid: entry.pid, exitCode: code, signal }) + '\n', { mode: 0o600 });
      if (code === 0) return resolve(stdout);
      const read = fs.openSync(file, 'r');
      let tail;
      try {
        const size = fs.fstatSync(read).size, bytes = Buffer.alloc(Math.min(size, 8192));
        fs.readSync(read, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); tail = redacted(bytes.toString('utf8'));
      } finally { fs.closeSync(read); }
      reject(new Error(`${command} exited ${code}: ${tail}`));
    });
  });
}
function frame(bytes, flag = 0) {
  const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
function controlledPeer(installed) {
  const P = installed('protobufjs');
  const schemaFile = path.resolve(path.dirname(installed.resolve('@google-cloud/datastore')), '../protos/protos.json');
  const schema = P.Root.fromJSON(json(schemaFile));
  const entities = new Map(), receipts = [], held = new Set();
  let arrival;
  const cancelArrived = new Promise(resolve => { arrival = resolve; });
  const type = name => schema.lookupType(`google.datastore.v1.${name}`);
  const keyString = key => JSON.stringify(key);
  const peer = { receipts, cancelArrived, activeHeld: 0, controlRequests: 0, socketDisconnected: false, schemaSha256: hash(fs.readFileSync(schemaFile)),
    dispose() { for (const timer of held) clearInterval(timer); held.clear(); },
    async fetch(request) {
      const url = new URL(request.url), method = url.pathname.split('/').at(-1);
      assert.equal(url.origin, peer.origin);
      if (url.pathname === '/__control/cancel') {
        assert.equal(request.headers.get('x-fixture-control'), control); peer.controlRequests++;
        assert.ok(peer.controlRequests <= 50);
        return Response.json({ activeHeld: peer.activeHeld, socketDisconnected: peer.socketDisconnected,
          readerCancelled: receipts.find(value => value.namespace === 'cancel')?.cancelled === true });
      }
      assert.equal(url.pathname, `/google.datastore.v1.Datastore/${method}`);
      assert.ok(['Commit', 'Lookup', 'RunQuery', 'BeginTransaction'].includes(method));
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('content-type'), 'application/grpc-web+proto');
      assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
      assert.ok(request.headers.get('grpc-timeout'));
      const bytes = Buffer.from(await request.arrayBuffer());
      assert.ok(bytes.length >= 5 && bytes.length < 16384); assert.equal(bytes[0], 0);
      assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
      const requestType = type(method + 'Request');
      const value = requestType.toObject(requestType.decode(bytes.subarray(5)), { longs: String, enums: String, bytes: Buffer });
      assert.equal(value.projectId, 'wga-hono-fixture');
      const mutation = value.mutations?.[0], key = mutation?.upsert?.key || value.keys?.[0];
      const namespace = key?.partitionId?.namespaceId || value.partitionId?.namespaceId || null;
      const receipt = { method, namespace, status: 0, requestBytes: bytes.length, cancelled: false,
        transactional: !!value.transaction?.length || !!value.readOptions?.transaction?.length };
      receipts.push(receipt); assert.ok(receipts.length <= 32);
      if (namespace === 'denied') {
        receipt.status = 7;
        return new Response(frame(Buffer.from('grpc-status: 7\r\ngrpc-message: fixture%20denied\r\nx-fixture-status: denied\r\n'), 128),
          { headers: { 'content-type': 'application/grpc-web+proto' } });
      }
      if (namespace === 'cancel') {
        assert.equal(method, 'Lookup'); peer.activeHeld++;
        const responseType = type('LookupResponse');
        const payload = responseType.encode(responseType.fromObject({ found: [{ entity: { key,
          properties: { count: { integerValue: '1' }, padding: { blobValue: Buffer.alloc(8192) } } } }] })).finish();
        const framed = frame(payload); let timer;
        const response = new Response(new ReadableStream({
          start(controller) {
            let offset = 16; controller.enqueue(framed.subarray(0, offset)); arrival();
            // Continue one valid protobuf frame slowly while the RPC is live.
            timer = setInterval(() => {
              try { controller.enqueue(framed.subarray(offset, ++offset)); }
              catch { clearInterval(timer); held.delete(timer); }
            }, 10);
            held.add(timer);
          },
          cancel() { clearInterval(timer); held.delete(timer); receipt.cancelled = true; peer.activeHeld--; },
        }), { headers: { 'content-type': 'application/grpc-web+proto' } });
        peer.cancelResponse = response;
        return response;
      }
      let response;
      if (method === 'Commit') {
        assert.equal(value.mutations.length, 1); assert.ok(mutation.upsert);
        assert.equal(mutation.upsert.key.path[1].id, '9007199254740993');
        entities.set(keyString(mutation.upsert.key), mutation.upsert);
        response = { mutationResults: [{ key: mutation.upsert.key, version: '1' }], indexUpdates: 0 };
      } else if (method === 'Lookup') {
        assert.equal(value.keys.length, 1);
        const entity = entities.get(keyString(value.keys[0])); assert.ok(entity);
        response = { found: [{ entity, version: '1' }], missing: [], deferred: [] };
      } else if (method === 'RunQuery') {
        assert.equal(value.query.kind[0].name, 'FixtureValue');
        response = { batch: { entityResults: [...entities.values()].filter(entity => entity.key.partitionId.namespaceId === namespace)
          .map(entity => ({ entity })), entityResultType: 'FULL', moreResults: 'NO_MORE_RESULTS', endCursor: Buffer.from('fixture-end') } };
      } else response = { transaction: Buffer.from('fixture-transaction') };
      const responseType = type(method + 'Response');
      const payload = responseType.encode(responseType.fromObject(response)).finish();
      return new Response(Buffer.concat([frame(payload), frame(Buffer.from('grpc-status: 0\r\nx-fixture-status: ok\r\n'), 128)]),
        { headers: { 'content-type': 'application/grpc-web+proto' } });
    },
  };
  return peer;
}
async function servePeer(peer, tls) {
  const sockets = new Set(), operations = new Set(), failures = [];
  const server = createServer(tls, (incoming, outgoing) => {
    const operation = (async () => {
      const chunks = []; let size = 0;
      for await (const bytes of incoming) { size += bytes.length; assert.ok(size <= 16384); chunks.push(bytes); }
      const response = await peer.fetch(new Request(peer.origin + incoming.url, { method: incoming.method,
        headers: incoming.headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      const reader = response.body.getReader();
      let completed = false, cancellation;
      const disconnected = () => {
        if (completed || outgoing.writableEnded) return;
        if (response === peer.cancelResponse) peer.socketDisconnected = true;
        // This is the server reacting to its real HTTP client's socket close,
        // not a test control endpoint releasing the pending RPC.
        cancellation = reader.cancel().catch(error => failures.push(error));
      };
      outgoing.on('close', disconnected);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { completed = true; outgoing.end(); break; }
          if (!outgoing.write(value)) await new Promise(resolve => {
            const ready = () => { outgoing.off('drain', ready); outgoing.off('close', ready); resolve(); };
            outgoing.once('drain', ready); outgoing.once('close', ready);
          });
        }
      } finally { outgoing.off('close', disconnected); await cancellation; reader.releaseLock(); }
    })();
    operations.add(operation);
    void operation.catch(error => { failures.push(error); outgoing.destroy(); }).finally(() => operations.delete(operation));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  peer.origin = `https://127.0.0.1:${server.address().port}`;
  return { origin: peer.origin, failures,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled(operations); } };
}
async function until(start, diagnostic) {
  for (let i = 0; i < 200; i++) { const value = await start(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(diagnostic);
}
function idle(value) {
  assert.equal(value.resources.activeCalls, 0); assert.equal(value.resources.queuedCalls, 0); assert.equal(value.resources.bufferedBytes, 0);
  assert.equal(value.resourcesBeforeClose.activeCalls, 0); assert.equal(value.resourcesBeforeClose.queuedCalls, 0);
  assert.equal(value.resourcesBeforeClose.bufferedBytes, 0); assert.equal(value.closedClientsAtIdle, 0);
  assert.equal(value.cleanupFailure, undefined);
}
async function main() {
  fs.mkdirSync(path.dirname(projectRoot), { recursive: true });
  fs.cpSync(path.join(root, 'fixtures/hono'), projectRoot, { recursive: true,
    filter: file => !['node_modules', 'generated', 'dist'].includes(path.basename(file)) });
  const artifacts = path.join(temporary, 'artifacts'); fs.mkdirSync(artifacts);
  assert.ok(fs.existsSync(path.join(root, 'dist/build/index.cjs')), 'Build the adapter before this installed test');
  const [packed] = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts], { cwd: root, capture: true }));
  report.tarball = { name: packed.name, version: packed.version, integrity: packed.integrity,
    sha256: hash(fs.readFileSync(path.join(artifacts, packed.filename))) };
  const lockFile = path.join(projectRoot, 'pnpm-lock.yaml'), sourceLock = fs.readFileSync(lockFile, 'utf8');
  let count = 0;
  const executableLock = sourceLock.replace(/^(\s+resolution: \{integrity: )sha512-[A-Za-z0-9+/=]+(, tarball: file:\.\.\/\.\.\/artifacts\/workers-grpc-adapter-0\.0\.1\.tgz\})$/m,
    (_, prefix, suffix) => { count++; return prefix + packed.integrity + suffix; });
  assert.equal(count, 1); fs.writeFileSync(lockFile, executableLock);
  report.lock = { sourceSha256: hash(sourceLock), executedSha256: hash(executableLock), localAdapterIntegrityOnly: true };
  report.stage = 'install';
  report.pnpm = (await run('pnpm', ['--version'], { capture: true })).trim(); assert.equal(report.pnpm, '10.30.0');
  const args = ['install', '--frozen-lockfile', '--reporter=append-only'];
  if (process.env.WGA_PNPM_STORE_DIR) args.push('--store-dir', process.env.WGA_PNPM_STORE_DIR);
  await run('pnpm', args); assert.equal(fs.readFileSync(lockFile, 'utf8'), executableLock);
  const installed = createRequire(path.join(projectRoot, 'package.json'));
  const adapterPackage = installed.resolve('@grpc/grpc-js/package.json'), physical = fs.realpathSync(path.dirname(adapterPackage));
  assert.ok(physical.startsWith(path.join(projectRoot, 'node_modules/.pnpm/')));
  assert.equal(json(adapterPackage).name, 'workers-grpc-adapter');
  report.installedAdapter = { logicalPath: path.join(projectRoot, 'node_modules/@grpc/grpc-js'), physicalPath: physical,
    packageJsonSha256: hash(fs.readFileSync(adapterPackage)) };
  report.stage = 'prebundle'; await run('pnpm', ['prebundle']);
  const generated = path.join(projectRoot, 'generated/google-workers');
  const manifest = report.prebundle = json(path.join(generated, 'manifest.json'));
  assert.equal(manifest.kind, 'google-worker-prebundle'); assert.equal(manifest.profile, 'google-static-v1');
  assert.equal(manifest.runtime.physicalInstallations, 1); assert.equal(manifest.runtime.ownership, 'prebundle');
  assert.equal(manifest.runtime.packageJsonSha256, report.installedAdapter.packageJsonSha256);
  assert.equal(manifest.transformCoverage.passed, true); assert.ok(manifest.transformCoverage.applied > 0);
  assert.equal(manifest.transformCoverage.applied, manifest.transformCoverage.required);
  for (const [name, artifact] of Object.entries(manifest.artifacts)) {
    const bytes = fs.readFileSync(path.join(generated, name));
    assert.equal(hash(bytes), artifact.sha256);
    assert.ok(!bytes.includes(Buffer.from(token)) && !bytes.includes(Buffer.from(control)));
  }
  const before = hash(fs.readFileSync(path.join(generated, 'index.cjs')));
  report.stage = 'declarations';
  await run(process.execPath, [path.join(path.dirname(installed.resolve('typescript/package.json')), 'bin/tsc'), '--project', 'tsconfig.json']);
  report.declarations = { strict: true, skipLibCheck: false, resolution: 'NodeNext', typescript: installed('typescript').version };
  report.stage = 'production-build'; await run('pnpm', ['build']);
  assert.equal(hash(fs.readFileSync(path.join(generated, 'index.cjs'))), before);
  report.build = json(path.join(projectRoot, 'dist/build-manifest.json'));
  assert.ok(report.build.inputs.some(input => /node_modules\/\.pnpm\/hono@4\.13\.13\//.test(input)), 'Actual installed Hono must be bundled');
  assert.ok(report.build.inputs.includes('generated/google-workers/index.cjs'));
  assert.ok(!report.build.inputs.some(input => /node_modules\/.*(?:@google-cloud|google-gax|workers-grpc-adapter)/.test(input)), 'Final build must consume the prebundle rather than raw SDK dependencies');
  const worker = fs.readFileSync(path.join(projectRoot, 'dist/worker.mjs'), 'utf8');
  assert.ok(!worker.includes(token) && !worker.includes(control));
  assert.equal(hash(worker), report.build.workerSha256);
  const tooling = createRequire(path.join(root, 'fixtures/worker/package.json'));
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = tooling('miniflare');
  report.hostTooling = { source: 'existing worker fixture; not the system under test', miniflare: tooling('miniflare/package.json').version,
    workerd: createRequire(tooling.resolve('miniflare'))('workerd/package.json').version };
  report.hono = { version: '4.13.13', source: 'installed pnpm package', sourceAliases: false };
  const peer = controlledPeer(installed); report.schemaSha256 = peer.schemaSha256; report.receipts = peer.receipts;
  report.stage = 'controlled-peer-tls';
  const privateKeyPath = path.join(temporary, 'peer-key.pem'), certificatePath = path.join(temporary, 'peer-cert.pem');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
    '-subj', '/CN=wga-hono-fixture', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', privateKeyPath, '-out', certificatePath]);
  fs.chmodSync(privateKeyPath, 0o600);
  const certificate = fs.readFileSync(certificatePath, 'utf8');
  const backend = await servePeer(peer, { key: fs.readFileSync(privateKeyPath), cert: certificate });
  report.backend = { kind: 'native loopback HTTPS server', tlsVerified: true, certificateSha256: hash(certificate),
    bindingNetworkAllow: ['127.0.0.1/32'], trustBrowserCas: false, globalOutboundBlocked: true };
  const config = json(path.join(projectRoot, 'runtime.json')); report.runtime = config;
  report.stage = 'workerd';
  let runtime, unexpectedOutboundRequests = 0;
  try {
    runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script: worker,
      ...config, unsafeDirectSockets: [{ host: '127.0.0.1', port: 0 }],
      bindings: { WGA_FIXTURE_TOKEN: token, WGA_FIXTURE_CONTROL: control, WGA_FIXTURE_PEER: backend.origin },
      serviceBindings: { WGA_FIXTURE_NETWORK: { network: { allow: ['127.0.0.1/32'],
        tlsOptions: { trustBrowserCas: false, trustedCertificates: [certificate] } } } },
      outboundService: () => { unexpectedOutboundRequests++; throw new Error('HONO_UNBOUND_NETWORK_IO'); } }));
    // Bypass Miniflare's older compatibility-date HTTP entry proxy. The native
    // socket connects to this Worker and its actual Request.signal semantics.
    const origin = (await runtime.unsafeGetDirectURL()).origin;
    report.hostTooling.directUserWorkerHttpSocket = true;
    const request = (route, id, options = {}) => fetch(origin + route, { ...options, headers: { 'x-fixture-control': control, 'x-fixture-id': id || '', ...options.headers },
      signal: options.signal || AbortSignal.timeout(10000) });
    assert.equal((await fetch(origin + '/health')).status, 404);
    assert.equal((await request('/health')).status, 200); assert.equal((await request('/missing')).status, 404);
    assert.equal(peer.receipts.length, 0);
    for (const id of ['cold', 'denied']) {
      const response = await request(`/probe/${id === 'denied' ? 'denied' : 'success'}`, id), result = await response.json();
      assert.equal(response.headers.get('x-hono-middleware'), 'before,route,after'); idle(result);
      if (id === 'denied') { assert.equal(response.status, 502); assert.equal(result.code, 7); assert.deepEqual(result.trailingStatus, ['denied']); assert.deepEqual(result.terminalStatuses, [7]); }
      else { assert.equal(response.status, 200, JSON.stringify(result)); assert.deepEqual(result.key, { id: '9007199254740993', parent: 'parent', namespace: id }); assert.equal(result.count, 2); assert.equal(result.commitMutations, 1); assert.deepEqual(result.terminalStatuses, Array(7).fill(0)); }
      report.cases.push({ id, ...result, applicationStatus: result.status, responseStatus: response.status, status: 'passed' });
    }
    const controller = new AbortController();
    const streaming = await request('/probe/cancel', 'cancel', { signal: controller.signal });
    assert.equal(streaming.status, 200);
    const reader = streaming.body.getReader();
    let pending;
    try {
      assert.match(new TextDecoder().decode((await reader.read()).value), /^ready\n/);
      pending = (async () => {
        try { for (;;) { if ((await reader.read()).done) return { aborted: false }; } }
        catch (error) { return { aborted: error.name === 'AbortError' }; }
      })();
      let arrivalTimer;
      try {
        await Promise.race([peer.cancelArrived, new Promise((_, reject) => {
          arrivalTimer = setTimeout(() => reject(new Error('HONO_CANCEL_RPC_ARRIVAL')), 10000);
        })]);
      } finally { clearTimeout(arrivalTimer); }
      controller.abort(); assert.equal((await pending).aborted, true);
    } finally { controller.abort(); await pending; reader.releaseLock(); }
    const cancelled = await until(async () => {
      const value = await (await request('/control/cancel')).json(); report.cancelObservation = value;
      return value.finished && value;
    }, 'HONO_REQUEST_CANCEL_CLEANUP');
    assert.equal(cancelled.incomingAborted, true); assert.equal(cancelled.code, 1); assert.equal(cancelled.closedClients, 1);
    assert.equal(cancelled.backendReaderCancelledBeforeClose, true);
    assert.deepEqual(cancelled.terminalStatuses, [1]); idle(cancelled);
    await until(() => peer.activeHeld === 0, 'HONO_BACKEND_READER_CANCELLED');
    assert.equal(peer.receipts.find(value => value.namespace === 'cancel').cancelled, true);
    assert.equal(peer.socketDisconnected, true);
    report.cases.push({ id: 'cancel', status: 'passed', ...cancelled, responseStatus: streaming.status, httpClientAborted: true, backendReaderCancelled: true });
    const response = await request('/probe/success', 'following'), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.count, 2); idle(result);
    assert.deepEqual(result.terminalStatuses, Array(7).fill(0));
    assert.equal(response.headers.get('x-hono-middleware'), 'before,route,after');
    report.cases.push({ id: 'following', ...result, applicationStatus: result.status, responseStatus: response.status, status: 'passed' });
    assert.equal(peer.receipts.length, 16); assert.equal(peer.receipts.filter(value => value.transactional).length, 4);
    report.receipts = peer.receipts; report.backendIdleBeforeDispose = peer.activeHeld === 0; report.peerControlRequests = peer.controlRequests;
    report.unexpectedOutboundRequests = unexpectedOutboundRequests; assert.equal(unexpectedOutboundRequests, 0);
    assert.deepEqual(backend.failures, []);
  } finally {
    report.backendHeldBeforeDispose = peer.activeHeld;
    try { await runtime?.dispose(); }
    finally { try { await backend.close(); } finally { peer.dispose(); } }
    report.runtimeDisposed = true;
  }
  report.stage = 'complete'; report.status = 'passed';
}
main().catch(error => { report.status = 'failed'; report.diagnostic = redacted(error.message).slice(0, 10000); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString(); fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/hono-prebundle.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, stage: report.stage, cases: report.cases.length,
    ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/hono-prebundle.json' }));
});
