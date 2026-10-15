'use strict';
// Installed-package evidence only: no source aliases, cloud credentials or deploy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const fixtureSource = path.join(root, 'fixtures/sveltekit');
const temporary = fs.mkdtempSync(path.join(process.env.WGA_TEST_TMPDIR || os.tmpdir(), 'wga-sveltekit-'));
fs.chmodSync(temporary, 0o700);
const projectRoot = path.join(temporary, 'fixtures/sveltekit');
const token = `runtime-only-${randomBytes(24).toString('hex')}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const report = { status: 'running', stage: 'prepare', startedAt: new Date().toISOString(), node: process.version,
  liveGoogle: false, cloudflareAutomaticConversion: false, officialEmulator: false, deployment: false,
  sourceAliases: false, restFallback: false, controlledGrpcWebPeer: true, cases: [], phaseLogs: [] };
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC)$/.test(key)));
Object.assign(environment, { CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', GOOGLE_SDK_NODE_LOGGING: '', NODE_OPTIONS: '', NODE_PATH: '' });

function phaseLog(stage) {
  const directory = path.join(os.homedir(), 'logs');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, `wga-sveltekit-${stage}-${Date.now()}-${randomBytes(4).toString('hex')}.log`);
  const record = { stage, log: file, statusFile: file.slice(0, -4) + '.status', pid: null, exitCode: null };
  report.phaseLogs.push(record);
  return { fd: fs.openSync(file, 'wx', 0o600), record };
}
function logTail(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 8192));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.toString('utf8').replaceAll(token, '[REDACTED]');
  } finally { fs.closeSync(fd); }
}

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const log = phaseLog(report.stage);
    const child = spawn(command, args, { cwd: options.cwd || projectRoot, env: { ...environment, ...options.env },
      stdio: ['ignore', options.captureStdout ? 'pipe' : log.fd, log.fd] });
    log.record.pid = child.pid || null;
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout || 180000);
    child.stdout?.on('data', bytes => {
      fs.writeSync(log.fd, bytes);
      stdout += bytes;
      if (stdout.length > 8 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(log.fd);
      Object.assign(log.record, { exitCode: code, signal });
      fs.writeFileSync(log.record.statusFile, JSON.stringify({ pid: log.record.pid, exitCode: code, signal }) + '\n', { mode: 0o600 });
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${logTail(log.record.log)}`));
    });
  });
}

function frame(bytes, flag = 0) {
  const header = Buffer.alloc(5);
  header[0] = flag;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}

// A bounded wire peer, not an SDK mock or an emulator. It accepts the SDK's real
// protobuf bytes and supports exactly the RPC shapes exercised by this fixture.
function controlledDatastore(requireInstalled) {
  const P = requireInstalled('protobufjs');
  const sdkEntry = requireInstalled.resolve('@google-cloud/datastore');
  const schemaFile = path.resolve(path.dirname(sdkEntry), '../protos/protos.json');
  const schema = P.Root.fromJSON(json(schemaFile));
  const entities = new Map(), transactions = new Map(), receipts = [];
  const keyString = key => JSON.stringify(key);
  const type = name => schema.lookupType(`google.datastore.v1.${name}`);
  const methods = new Set(['Commit', 'Lookup', 'RunQuery', 'BeginTransaction']);
  return { receipts, schemaSha256: hash(fs.readFileSync(schemaFile)),
    async fetch(request) {
      const url = new URL(request.url);
      assert.ok(url.origin === 'https://datastore.fixture.invalid' || url.hostname === '127.0.0.1', 'SK_PEER_ORIGIN');
      const method = url.pathname.split('/').at(-1);
      assert.equal(url.pathname, `/google.datastore.v1.Datastore/${method}`);
      assert.ok(methods.has(method), `SK_PEER_METHOD:${method}`);
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('content-type'), 'application/grpc-web+proto');
      assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
      assert.ok(request.headers.get('grpc-timeout'), 'SK_RPC_TIMEOUT');
      const bytes = Buffer.from(await request.arrayBuffer());
      assert.ok(bytes.length >= 5 && bytes.length <= 16384, 'SK_REQUEST_BOUND');
      assert.equal(bytes[0], 0, 'SK_UNCOMPRESSED_REQUEST');
      assert.equal(bytes.readUInt32BE(1), bytes.length - 5, 'SK_SINGLE_REQUEST_FRAME');
      const requestType = type(method + 'Request');
      const value = requestType.toObject(requestType.decode(bytes.subarray(5)), { longs: String, enums: String, bytes: Buffer });
      assert.equal(value.projectId, 'wga-sveltekit-fixture');
      const mutation = value.mutations?.[0];
      const key = mutation?.upsert?.key || value.keys?.[0];
      const namespace = key?.partitionId?.namespaceId || value.partitionId?.namespaceId
        || transactions.get(Buffer.from(value.transaction || []).toString('hex'));
      const receipt = { method, namespace: namespace || null, requestBytes: bytes.length,
        transactional: !!value.transaction?.length || !!value.readOptions?.transaction?.length, status: 0 };
      receipts.push(receipt);
      assert.ok(receipts.length <= 64, 'SK_RPC_BOUND');
      if (namespace === 'denied') {
        receipt.status = 7;
        return new Response(frame(Buffer.from('grpc-status: 7\r\ngrpc-message: fixture%20denied\r\nx-fixture-status: denied\r\n'), 128),
          { headers: { 'content-type': 'application/grpc-web+proto' } });
      }
      let response;
      if (method === 'Commit') {
        assert.equal(value.mutations.length, 1);
        assert.ok(mutation.upsert, 'SK_ONLY_UPSERT');
        assert.equal(mutation.upsert.key.path[1].id, '9007199254740993');
        entities.set(keyString(mutation.upsert.key), mutation.upsert);
        response = { mutationResults: [{ key: mutation.upsert.key, version: '1' }], indexUpdates: 0 };
      } else if (method === 'Lookup') {
        assert.equal(value.keys.length, 1);
        const entity = entities.get(keyString(value.keys[0]));
        assert.ok(entity, 'SK_LOOKUP_AFTER_COMMIT');
        response = { found: [{ entity, version: '1' }], missing: [], deferred: [] };
      } else if (method === 'RunQuery') {
        assert.equal(value.query.kind[0].name, 'FixtureValue');
        response = { batch: { entityResults: [...entities.values()]
          .filter(entity => entity.key.partitionId.namespaceId === namespace).map(entity => ({ entity })),
        entityResultType: 'FULL', moreResults: 'NO_MORE_RESULTS', endCursor: Buffer.from('fixture-end') } };
      } else {
        const transaction = Buffer.from(`fixture-transaction-${transactions.size}`);
        // BeginTransaction has no namespace; the subsequent transaction Lookup
        // carries the key, and Commit carries both the transaction and its key.
        transactions.set(transaction.toString('hex'), namespace || null);
        response = { transaction };
      }
      const responseType = type(method + 'Response');
      const payload = responseType.encode(responseType.fromObject(response)).finish();
      return new Response(Buffer.concat([frame(payload), frame(Buffer.from('grpc-status: 0\r\nx-fixture-status: ok\r\n'), 128)]),
        { headers: { 'content-type': 'application/grpc-web+proto' } });
    },
  };
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function probe(fetch, invocation, runtime) {
  const response = await fetch(`/probe?run=${invocation}`);
  const result = await response.json();
  if (invocation === 'denied') {
    assert.equal(response.status, 502, JSON.stringify(result));
    assert.equal(result.code, 7);
    assert.deepEqual(result.trailingStatus, ['denied']);
    assert.deepEqual(result.terminalStatuses, [7]);
  } else {
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, 'passed');
    assert.deepEqual(result.key, { id: '9007199254740993', parent: 'parent', namespace: invocation });
    assert.equal(result.queryRows, 1);
    assert.equal(result.count, 2);
    assert.equal(result.commitMutations, 1);
    assert.deepEqual(result.terminalStatuses, Array(7).fill(0));
  }
  assert.equal(result.resources.activeCalls, 0);
  assert.equal(result.resources.queuedCalls, 0);
  assert.equal(result.resources.bufferedBytes, 0);
  report.cases.push({ runtime, invocation, ...result, responseStatus: result.status, status: 'passed' });
}

async function main() {
  fs.mkdirSync(path.dirname(projectRoot), { recursive: true });
  fs.cpSync(fixtureSource, projectRoot, { recursive: true, filter: file =>
    !['node_modules', '.svelte-kit', '.wrangler', 'generated'].includes(path.basename(file))
      && !path.basename(file).startsWith('.prebundle-') });
  const tarballDir = path.join(temporary, 'artifacts');
  fs.mkdirSync(tarballDir);
  assert.ok(fs.existsSync(path.join(root, 'dist/build/index.cjs')), 'Build the adapter before this installed-package test');
  const [packed] = JSON.parse(await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tarballDir], { cwd: root, captureStdout: true }));
  const tarball = path.join(tarballDir, packed.filename);
  report.tarball = { name: packed.name, version: packed.version, sha256: hash(fs.readFileSync(tarball)), integrity: packed.integrity };
  const lockFile = path.join(projectRoot, 'pnpm-lock.yaml');
  const originalLock = fs.readFileSync(lockFile, 'utf8');
  let replacements = 0;
  const executableLock = originalLock.replace(/^(\s+resolution: \{integrity: )sha512-[A-Za-z0-9+/=]+(, tarball: file:\.\.\/\.\.\/artifacts\/workers-grpc-adapter-0\.0\.1\.tgz\})$/m,
    (_, prefix, suffix) => { replacements++; return prefix + packed.integrity + suffix; });
  assert.equal(replacements, 1, 'Only the adapter archive may change in the fixture lock');
  fs.writeFileSync(lockFile, executableLock);
  report.lock = { sourceSha256: hash(originalLock), executedSha256: hash(executableLock), localAdapterIntegrityOnly: true };
  report.stage = 'install';
  report.pnpm = (await run('pnpm', ['--version'], { captureStdout: true })).trim();
  assert.equal(report.pnpm, '10.30.0');
  const installArgs = ['install', '--frozen-lockfile', '--reporter=append-only'];
  if (process.env.WGA_PNPM_STORE_DIR) installArgs.push('--store-dir', process.env.WGA_PNPM_STORE_DIR);
  await run('pnpm', installArgs);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), executableLock, 'Frozen install must preserve the locked graph');
  const installed = createRequire(path.join(projectRoot, 'package.json'));
  const adapterPath = fs.realpathSync(path.dirname(installed.resolve('@grpc/grpc-js/package.json')));
  assert.ok(adapterPath.startsWith(path.join(projectRoot, 'node_modules/.pnpm/')), 'pnpm physical adapter installation');
  assert.equal(installed('@grpc/grpc-js/package.json').name, 'workers-grpc-adapter');
  report.installedAdapter = { logicalPath: path.join(projectRoot, 'node_modules/@grpc/grpc-js'), physicalPath: adapterPath,
    packageJsonSha256: hash(fs.readFileSync(path.join(adapterPath, 'package.json'))) };
  report.tools = Object.fromEntries(['@sveltejs/kit', '@sveltejs/adapter-cloudflare', 'vite', 'svelte', 'typescript', 'esbuild', 'miniflare']
    .map(name => [name, installed(name + '/package.json').version]));
  report.tools.workerd = createRequire(installed.resolve('miniflare'))('workerd/package.json').version;
  report.stage = 'prebundle';
  await run('pnpm', ['prebundle']);
  const generated = path.join(projectRoot, 'packages/google-workers/generated');
  const artifactHash = () => Object.fromEntries(['index.cjs', 'index.mjs', 'index.d.ts', 'index.d.mts', 'index.d.cts', 'package.json', 'manifest.json']
    .map(file => [file, hash(fs.readFileSync(path.join(generated, file)))]));
  const originalArtifacts = artifactHash();
  await run('pnpm', ['prebundle']);
  assert.deepEqual(artifactHash(), originalArtifacts, 'Repeating the pinned prebundle build must reproduce every artifact');
  report.artifacts = originalArtifacts;
  report.prebundle = json(path.join(generated, 'manifest.json'));
  assert.equal(report.prebundle.kind, 'google-worker-prebundle');
  assert.equal(report.prebundle.serverOnly, true);
  assert.equal(report.prebundle.profile, 'google-static-v1');
  assert.equal(report.prebundle.transformCoverage.passed, true);
  assert.ok(report.prebundle.transformCoverage.applied > 0, 'Loaded SDK code must be transformed');
  assert.equal(report.prebundle.transformCoverage.required, report.prebundle.transformCoverage.applied);
  assert.equal(report.prebundle.runtime.physicalInstallations, 1);
  assert.equal(report.prebundle.runtime.ownership, 'prebundle');
  assert.equal(report.prebundle.runtime.packageJsonSha256, report.installedAdapter.packageJsonSha256);
  assert.equal(report.prebundle.artifacts['index.cjs'].sha256, originalArtifacts['index.cjs']);
  report.stage = 'declaration-types';
  await run(process.execPath, [path.join(path.dirname(installed.resolve('typescript/package.json')), 'bin/tsc'), '--project', 'tsconfig.verify.json']);
  report.declarationsChecked = { compiler: '5.8.3', resolution: 'NodeNext', skipLibCheck: false, sourceAliases: false };
  const peer = controlledDatastore(installed);
  report.schemaSha256 = peer.schemaSha256;
  const peerServer = http.createServer(async (request, response) => {
    try {
      const incoming = new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: request.headers,
        body: request, duplex: 'half' });
      const result = await peer.fetch(incoming);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500); response.end('SK_PEER_FAILURE');
    }
  });
  await new Promise(resolve => peerServer.listen(0, '127.0.0.1', resolve));
  let dev;
  let devLog;
  try {
    report.stage = 'vite-dev';
    const devPort = await unusedPort();
    devLog = phaseLog(report.stage);
    dev = spawn(process.execPath, [path.join(path.dirname(installed.resolve('vite/package.json')), 'bin/vite.js'), '--host', '127.0.0.1', '--port', String(devPort), '--strictPort'],
      { cwd: projectRoot, env: { ...environment, WGA_FIXTURE_TOKEN: token,
        WGA_FIXTURE_GATEWAY: `http://127.0.0.1:${peerServer.address().port}` }, stdio: ['ignore', devLog.fd, devLog.fd] });
    devLog.record.pid = dev.pid;
    const devUrl = `http://127.0.0.1:${devPort}`;
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt++) {
      if (dev.exitCode !== null) throw new Error(`SK_DEV_EXIT: ${devLog.record.log}`);
      try { ready = (await fetch(devUrl, { signal: AbortSignal.timeout(500) })).status === 200; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, `SK_DEV_READY: ${devLog.record.log}`);
    await probe(route => fetch(devUrl + route, { signal: AbortSignal.timeout(15000) }), 'dev', 'vite-dev');
    assert.deepEqual(artifactHash(), originalArtifacts, 'Vite dev must consume the prebundle unchanged');
  } finally {
    if (dev) {
      dev.kill('SIGTERM');
      if (dev.exitCode === null && dev.signalCode === null) await new Promise(resolve => dev.once('close', resolve));
      Object.assign(devLog.record, { exitCode: dev.exitCode, signal: dev.signalCode });
      fs.closeSync(devLog.fd);
      fs.writeFileSync(devLog.record.statusFile, JSON.stringify({ pid: dev.pid, exitCode: dev.exitCode, signal: dev.signalCode }) + '\n', { mode: 0o600 });
    }
    await new Promise(resolve => peerServer.close(resolve));
  }
  const viteCli = path.join(path.dirname(installed.resolve('vite/package.json')), 'bin/vite.js');
  report.stage = 'server-only-negative-control';
  const pageFile = path.join(projectRoot, 'src/routes/+page.svelte');
  const pageSource = fs.readFileSync(pageFile, 'utf8');
  try {
    fs.writeFileSync(pageFile, '<script>import { Datastore } from "$lib/server/google-workers.js"; console.log(Datastore);</script>\n<h1>Must fail</h1>\n');
    await assert.rejects(run(process.execPath, [viteCli, 'build']),
      /Cannot import [\s\S]*(?:\$lib\/server|server\/google-workers)|server.only/i);
    report.serverOnlyNegativeControl = true;
  } finally { fs.writeFileSync(pageFile, pageSource); }
  report.stage = 'production-build';
  await run(process.execPath, [viteCli, 'build']);
  assert.deepEqual(artifactHash(), originalArtifacts, 'Production SSR must consume the same prebundle unchanged');
  const clientDir = path.join(projectRoot, '.svelte-kit/output/client');
  const files = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
  const clientFiles = files(clientDir);
  for (const file of files(path.join(projectRoot, '.svelte-kit/output'))) {
    assert.ok(!fs.readFileSync(file).includes(Buffer.from(token)), 'Runtime token must never be compiled into an artifact or source map');
  }
  for (const file of clientFiles) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const marker of [token, '@google-cloud/datastore', 'google.datastore.v1', 'createWorkersGrpcTransport', 'WGA_FIXTURE_TOKEN', 'private_key']) {
      assert.ok(!contents.includes(marker), `SK_CLIENT_BOUNDARY:${path.relative(clientDir, file)}:${marker === token ? '[runtime token]' : marker}`);
    }
  }
  report.clientBoundary = { filesScannedIncludingSourceMaps: clientFiles.length, sdkAbsent: true, credentialAbsent: true };
  report.stage = 'workerd';
  const config = json(path.join(projectRoot, 'wrangler.json'));
  const deploymentBundle = path.join(temporary, 'worker-bundle');
  await run(process.execPath, [path.join(path.dirname(installed.resolve('wrangler/package.json')), 'bin/wrangler.js'),
    'deploy', '--dry-run', '--outdir', deploymentBundle, '--no-autoconfig', '--config', 'wrangler.json']);
  const workerFile = path.join(deploymentBundle, '_worker.js');
  assert.equal(config.workers_dev, false);
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = installed('miniflare');
  let outbound = 0;
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true,
    scriptPath: workerFile, modulesRoot: path.dirname(workerFile),
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    bindings: { WGA_FIXTURE_TOKEN: token, WGA_FIXTURE_GATEWAY: 'https://datastore.fixture.invalid' },
    serviceBindings: { ASSETS: () => new Response('Not found', { status: 404 }) },
    outboundService: request => { outbound++; return peer.fetch(request); },
  }));
  try {
    for (const invocation of ['cold', 'denied', 'warm']) {
      await probe(route => runtime.dispatchFetch('https://sveltekit.fixture.invalid' + route, { signal: AbortSignal.timeout(15000) }), invocation, 'workerd');
    }
    assert.equal(outbound, 15, 'Seven calls per successful request and one denied call; SDK and adapter retries are disabled');
  } finally { await runtime.dispose(); }
  report.receipts = peer.receipts;
  assert.equal(peer.receipts.length, 22, 'One dev request and three production requests');
  assert.equal(peer.receipts.filter(receipt => receipt.transactional).length, 6);
  report.workerdOutboundRequests = outbound;
  report.productionWorkerSha256 = hash(fs.readFileSync(workerFile));
  report.sameArtifactForDevAndProduction = true;
  report.cleanupVerified = true;
  report.status = 'passed';
  report.stage = 'complete';
}

main().catch(error => {
  report.status = 'failed';
  report.diagnostic = String(error.message).replaceAll(token, '[REDACTED]').slice(0, 5000);
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/sveltekit-prebundle.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, stage: report.stage, cases: report.cases.length,
    ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/sveltekit-prebundle.json' }));
});
