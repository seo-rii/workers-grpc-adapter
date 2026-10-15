'use strict';
// Fresh installed tarballs and real SDK code in local workerd. No source alias,
// deployment, live credentials, or Google provider requests are used here.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash, randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { gunzipSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'fixtures/prebundle-sdk');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { syntheticPayload, crc32c } = require('../fixtures/prebundle-sdk/values.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sri = bytes => 'sha512-' + createHash('sha512').update(bytes).digest('base64');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const temporary = fs.mkdtempSync(path.join(process.env.WGA_TEST_TMPDIR || os.tmpdir(), 'wga-prebundle-sdks-'));
fs.chmodSync(temporary, 0o700);
const output = path.join(root, 'verification/google-prebundle-sdks');
fs.mkdirSync(output, { recursive: true });
const token = `runtime-only-${randomBytes(24).toString('hex')}`;
const profiles = [
  { id: 'google-static-v1', fixture: 'google', firestore: '8.3.0', secretManager: '7.1.0' },
  { id: 'google-modern-v1', fixture: 'modern', firestore: '9.2.0', secretManager: '7.1.0' },
];
const expectedCases = {
  'firestore-values': { methods: ['Commit', 'BatchGetDocuments', 'RunQuery'], codes: [0, 0, 0] },
  'firestore-stream-error': { methods: ['RunQuery', 'BatchGetDocuments'], codes: [7, 0] },
  'secret-cancel': { methods: ['AccessSecretVersion', 'AccessSecretVersion'], codes: [1, 0] },
  'secret-access': { methods: ['AccessSecretVersion'], codes: [0] },
  'secret-list': { methods: ['ListSecrets', 'ListSecrets'], codes: [0, 0] },
  'secret-denied': { methods: ['AccessSecretVersion'], codes: [7] },
  'secret-unavailable': { methods: ['AccessSecretVersion'], codes: [14] },
};
const report = { schemaVersion: 1, status: 'running', stage: 'prepare', startedAt: new Date().toISOString(),
  node: process.version, compatibilityDate: '2026-09-21', installedAdapterTarball: true,
  sourceAliases: false, liveGoogle: false, liveAuthentication: false, cloudflareAutomaticConversion: false,
  cloudflareEvidence: 'conversion-intent-and-controlled-grpc-web-wire-only',
  officialEmulator: false, deployment: false, restFallback: false, controlledGrpcWebPeer: true,
  adapterRetryEnabled: false, secretManagerRetryEnabled: false, firestoreReadGaxRetryEnabled: false,
  firestoreWriteRetryPolicy: 'SDK-default-preserved-success-only',
  typedSharedOAuthInjection: false,
  typedSharedOAuthScope: 'public-GAPIC-constructor-authClient-options',
  highLevelFirestoreAuthValidation: 'Settings-index-signature-does-not-enforce-authClient',
  firestoreHighLevelRetryScope: 'permanent-stream-status-only',
  cancellationBoundary: 'synthetic-request-AbortSignal-forwarded-to-cancellableCall-after-observed-RPC',
  profiles: [], cases: [], phaseLogs: [], generatedArtifacts: {}, evidence: {} };
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z_]+|TMPDIR|TEMP|TMP|SYSTEMROOT|COMSPEC)$/.test(key)));
Object.assign(environment, { CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', DO_NOT_TRACK: '1',
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', GOOGLE_SDK_NODE_LOGGING: '', NODE_OPTIONS: '', NODE_PATH: '',
  npm_config_cache: path.join(temporary, 'npm-cache'), npm_config_logs_dir: path.join(temporary, 'npm-logs') });
function check(value, diagnostic) {
  if (!value) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic });
}
function safe(error) {
  return /^MATRIX_[A-Z_]+$/.test(error?.fixtureDiagnostic) ? error.fixtureDiagnostic
    : /^WGA_[A-Z_]+$/.test(error?.code) ? error.code : 'MATRIX_HARNESS_FAILURE';
}
function record(name, bytes) {
  const file = path.join(output, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  report.generatedArtifacts[path.relative(root, file)] = hash(bytes);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, timeout = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('MATRIX_TIMEOUT'), { fixtureDiagnostic: 'MATRIX_TIMEOUT' })), timeout);
  })]); } finally { clearTimeout(timer); }
}
async function run(command, args, cwd, options = {}) {
  const directory = path.join(os.homedir(), 'logs', 'wga-prebundle-sdks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  const log = path.join(directory, `wga-prebundle-sdks-${report.stage}-${Date.now()}-${randomBytes(4).toString('hex')}.log`);
  const fd = fs.openSync(log, 'wx', 0o600), statusFile = log.slice(0, -4) + '.status.json';
  const phase = { stage: report.stage, log, statusFile, running: true, pid: null, exitCode: null };
  report.phaseLogs.push(phase);
  const writeStatus = () => fs.writeFileSync(statusFile, JSON.stringify(phase) + '\n', { mode: 0o600 });
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...environment, ...options.env }, stdio: ['ignore', fd, fd] });
    phase.pid = child.pid || null; writeStatus();
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout || 150000);
    let spawnError;
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer); fs.closeSync(fd);
      Object.assign(phase, { running: false, exitCode: code, signal }); writeStatus();
      if (!spawnError && code === 0) resolve();
      else reject(Object.assign(new Error('MATRIX_CHILD_FAILURE'), { fixtureDiagnostic: 'MATRIX_CHILD_FAILURE' }));
    });
  });
  if (options.capture) {
    check(fs.statSync(log).size <= 4 * 1024 * 1024, 'MATRIX_CHILD_OUTPUT_BOUND');
    return fs.readFileSync(log, 'utf8');
  }
}
async function pack(directory, destination) {
  const text = await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], directory, { capture: true });
  return path.join(destination, JSON.parse(text)[0].filename);
}
function members(file) {
  const archive = gunzipSync(fs.readFileSync(file), { maxOutputLength: 64 * 1024 * 1024 }), files = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8);
    check(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= archive.length, 'MATRIX_ARCHIVE_BOUND');
    if ([0, 48].includes(header[156])) files.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
function assertInstalledArchive(archive, installation) {
  const entries = members(archive);
  for (const [name, bytes] of entries) {
    check(name.startsWith('package/') && !name.split('/').includes('..'), 'MATRIX_ARCHIVE_MEMBER');
    const installed = path.join(installation, name.slice(8));
    check(fs.existsSync(installed) && fs.lstatSync(installed).isFile()
      && hash(fs.readFileSync(installed)) === hash(bytes), 'MATRIX_INSTALLED_ARCHIVE_MATCH');
  }
  check(entries.size > 0, 'MATRIX_ARCHIVE_NONEMPTY');
  return entries.size;
}

// Reuse original registry archives, never copy or reconstruct node_modules.
// Each SRI is checked even on cache hits. The install itself is offline and
// resolves only absolute file archives; on a cold cache, fetch that pinned URL.
async function prepareArchives(lock, archives, cacheRoot) {
  let cached = 0, downloaded = 0;
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || !entry.resolved || entry.resolved.startsWith('file:')) continue;
    const match = /^(sha512|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(entry.integrity);
    check(match, 'MATRIX_PINNED_INTEGRITY');
    const hex = Buffer.from(match[2], 'base64').toString('hex');
    let archive = path.join(cacheRoot, '_cacache/content-v2', match[1], hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    let bytes = fs.existsSync(archive) && fs.statSync(archive).size < 32 * 1024 * 1024 ? fs.readFileSync(archive) : undefined;
    if (!bytes || createHash(match[1]).update(bytes).digest('base64') !== match[2]) {
      const url = new URL(entry.resolved);
      check(url.origin === 'https://registry.npmjs.org', 'MATRIX_PINNED_REGISTRY');
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
      check(response.status === 200, 'MATRIX_ARCHIVE_DOWNLOAD');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength; check(size < 32 * 1024 * 1024, 'MATRIX_ARCHIVE_DOWNLOAD_BOUND'); chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks, size);
      check(createHash(match[1]).update(bytes).digest('base64') === match[2], 'MATRIX_ARCHIVE_INTEGRITY');
      archive = path.join(archives, `${hash(entry.resolved)}.tgz`); fs.writeFileSync(archive, bytes); downloaded++;
    } else {
      // npm distinguishes a file archive from a directory by its .tgz suffix.
      // Cache blobs have no extension; copy their verified original bytes into
      // our scratch area instead of treating the content-cache path as a pkg.
      archive = path.join(archives, `${match[1]}-${hex}.tgz`);
      if (!fs.existsSync(archive)) fs.writeFileSync(archive, bytes);
      cached++;
    }
    entry.resolved = `file:${archive}`;
  }
  return { cached, downloaded, allPinnedIntegritiesVerified: true, installedOffline: true };
}
function frame(bytes, flag = 0) {
  const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
function controlledPeer(requireInstalled) {
  const protobuf = requireInstalled('protobufjs');
  const firestoreFile = path.resolve(path.dirname(requireInstalled.resolve('@google-cloud/firestore')), '../protos/v1.json');
  const secretFile = path.resolve(path.dirname(requireInstalled.resolve('@google-cloud/secret-manager')), '../protos/protos.json');
  const schemas = { firestore: protobuf.Root.fromJSON(json(firestoreFile)), secret: protobuf.Root.fromJSON(json(secretFile)) };
  const database = 'projects/wga-prebundle-fixture/databases/(default)';
  const documents = `${database}/documents/wga_prebundle`;
  const parent = 'projects/wga-prebundle-fixture/locations/us-central1';
  const timestamp = { seconds: '1700000000', nanos: 123456789 };
  const document = id => ({ name: `${documents}/${id}`, fields: { large: { integerValue: '9007199254740993' },
    time: { timestampValue: timestamp }, bytes: { bytesValue: Buffer.from([0, 255, 128, 7]) } },
  createTime: timestamp, updateTime: timestamp });
  const states = new Map(), responses = [], failures = [];
  const active = new Set();
  function body(chunks, state, held) {
    const receipt = { caseId: state.caseId, closed: false, cancelled: false, body: null }; responses.push(receipt); active.add(receipt);
    let index = 0;
    const finish = () => { active.delete(receipt); receipt.closed = true; };
    receipt.body = new ReadableStream({
      async pull(controller) {
        if (held && index > 0) await state.release.promise;
        if (receipt.cancelled) return;
        if (index < chunks.length) controller.enqueue(chunks[index++]);
        else { finish(); controller.close(); }
      },
      cancel() { receipt.cancelled = true; finish(); state.release.resolve(); },
    }, { highWaterMark: 0 });
    return receipt.body;
  }
  return { states, active, failures, responses,
    releaseHeld() { for (const state of states.values()) { state.started.resolve(); state.release.resolve(); } },
    schemas: { firestore: hash(fs.readFileSync(firestoreFile)), secretManager: hash(fs.readFileSync(secretFile)) },
    prepare(caseId, scenario, mode) {
      const state = { caseId, scenario, mode, trace: [], started: deferred(), release: deferred(), controls: 0 };
      states.set(caseId, state); return state;
    },
    async fetch(request) {
      const url = new URL(request.url), caseId = request.headers.get('x-wga-case'), state = states.get(caseId);
      check(state && request.method === 'POST', 'MATRIX_PEER_CASE');
      if (url.origin === 'https://sdk-control.fixture.invalid') {
        state.controls++;
        if (url.pathname === '/started') await state.started.promise;
        else { check(url.pathname === '/release', 'MATRIX_CONTROL_METHOD'); state.release.resolve(); }
        return new Response(null, { status: 204 });
      }
      const firestore = url.pathname.startsWith('/google.firestore.v1.Firestore/');
      const method = url.pathname.split('/').at(-1), service = firestore ? 'firestore' : 'secret';
      const hostname = firestore ? 'firestore.googleapis.com' : 'secretmanager.googleapis.com';
      check(url.origin === (state.mode === 'cloudflare' ? `https://${hostname}`
        : firestore ? 'https://firestore.fixture.invalid' : 'https://secret-manager.fixture.invalid'), 'MATRIX_CONFIG_OWNERSHIP');
      check(url.pathname === (firestore ? `/google.firestore.v1.Firestore/${method}`
        : `/google.cloud.secretmanager.v1.SecretManagerService/${method}`), 'MATRIX_PEER_METHOD');
      const contentType = state.mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
      check(request.headers.get('content-type') === contentType, 'MATRIX_WIRE_CONTENT_TYPE');
      check(request.headers.get('authorization') === `Bearer ${token}`, 'MATRIX_RUNTIME_AUTH');
      const timeout = /^(\d+)([HMSmun])$/.exec(request.headers.get('grpc-timeout'));
      const millis = timeout && Number(timeout[1]) * { H: 3600000, M: 60000, S: 1000, m: 1, u: .001, n: .000001 }[timeout[2]];
      check(millis > 0 && millis <= (method === 'Commit' ? 60000 : 1500), 'MATRIX_BOUNDED_RPC');
      const bytes = Buffer.from(await request.arrayBuffer());
      check(bytes.length >= 5 && bytes.length <= 65536 && bytes[0] === 0
        && bytes.readUInt32BE(1) === bytes.length - 5, 'MATRIX_SINGLE_PROTOBUF_FRAME');
      const type = name => schemas[service].lookupType(`${firestore ? 'google.firestore.v1' : 'google.cloud.secretmanager.v1'}.${name}`);
      const requestType = type(method + 'Request');
      const value = requestType.toObject(requestType.decode(bytes.subarray(5)), { longs: String, enums: String, bytes: Buffer });
      const record = { method, requestBytes: bytes.length, statusCode: 0, timeoutMs: millis,
        timeoutBounded: true, authorizationVerified: true };
      state.trace.push(record);
      check(state.trace.length <= expectedCases[state.scenario].methods.length, 'MATRIX_RPC_RETRY_BOUND');
      let messages = [], held = false;
      if (method === 'Commit') {
        check(value.database === database && value.writes?.length === 1, 'MATRIX_COMMIT_REQUEST');
        const update = value.writes[0].update;
        check(update?.name === `${documents}/value` && update.fields.large.integerValue === '9007199254740993'
          && update.fields.time.timestampValue.seconds === timestamp.seconds
          && update.fields.time.timestampValue.nanos === timestamp.nanos
          && Buffer.from(update.fields.bytes.bytesValue).equals(Buffer.from([0, 255, 128, 7])), 'MATRIX_WRITE_PROTOBUF_VALUES');
        messages = [{ commitTime: timestamp, writeResults: [{ updateTime: timestamp }] }];
      } else if (method === 'BatchGetDocuments') {
        check(value.database === database && value.documents?.length === 1
          && [`${documents}/value`, `${documents}/marker`].includes(value.documents[0]), 'MATRIX_DOCUMENT_REQUEST');
        messages = [{ found: document(value.documents[0].split('/').at(-1)), readTime: timestamp }];
      } else if (method === 'RunQuery') {
        const query = value.structuredQuery;
        check(value.parent === `${database}/documents` && query.from?.[0]?.collectionId === 'wga_prebundle'
          && query.limit?.value === 2, 'MATRIX_QUERY_REQUEST');
        if (state.scenario === 'firestore-values') check(query.where?.fieldFilter?.value?.integerValue === '9007199254740993', 'MATRIX_QUERY_INT64');
        messages = [{ document: document('value'), readTime: timestamp }];
        if (state.scenario === 'firestore-stream-error') { record.statusCode = 7; held = 'partial'; }
      } else if (method === 'ListSecrets') {
        const page = state.trace.filter(item => item.method === method).length - 1;
        check(value.parent === parent && value.pageSize === 2 && (value.pageToken || '') === (page === 0 ? '' : 'page-1')
          && page < 2, 'MATRIX_LIST_REQUEST');
        record.page = page;
        messages = [{ secrets: [page * 2, page * 2 + 1].map(index => ({ name: `${parent}/secrets/item-${index}`,
          replication: { automatic: {} } })), nextPageToken: page === 0 ? 'page-1' : '', totalSize: 4 }];
      } else {
        check(method === 'AccessSecretVersion' && [`${parent}/secrets/synthetic/versions/latest`,
          `${parent}/secrets/recovery/versions/latest`].includes(value.name), 'MATRIX_ACCESS_REQUEST');
        if (state.scenario === 'secret-denied' || state.scenario === 'secret-unavailable') record.statusCode = state.scenario === 'secret-denied' ? 7 : 14;
        else {
          const data = syntheticPayload(257);
          messages = [{ name: value.name, payload: { data, dataCrc32c: String(crc32c(data)) } }];
          if (state.scenario === 'secret-cancel' && state.trace.length === 1) { record.statusCode = 1; held = 'cancel'; }
        }
      }
      const responseType = type(method + 'Response');
      const chunks = messages.map(value => frame(Buffer.from(responseType.encode(responseType.fromObject(value)).finish())));
      const denied = record.statusCode === 7 || record.statusCode === 14;
      const text = `grpc-status: ${record.statusCode}\r\n` + (denied
        ? `grpc-message: ${encodeURIComponent('synthetic denied: 한글 %')}\r\nx-fixture-result: denied\r\nx-fixture-result: repeated\r\n`
          + 'x-fixture-result-bin: AP+A\r\nx-fixture-result-bin: DQD+\r\n' : '');
      chunks.push(frame(Buffer.from(text), 128));
      const response = new Response(body(chunks, state, held), { headers: { 'content-type': contentType } });
      state.started.resolve(); return response;
    },
  };
}

async function profileRun(profile, adapterArchive, npmCache) {
  const base = path.join(temporary, profile.id); fs.mkdirSync(base);
  try {
    report.stage = `${profile.id}-install`;
    const projectRoot = path.join(base, 'build'), archives = path.join(base, 'archives');
    fs.mkdirSync(projectRoot); fs.mkdirSync(archives);
    const sourcePackage = json(path.join(root, `fixtures/${profile.fixture}/package.json`));
    const sourceLockBytes = fs.readFileSync(path.join(root, `fixtures/${profile.fixture}/package-lock.json`));
    const lock = JSON.parse(sourceLockBytes);
    const dependencies = { ...sourcePackage.dependencies, '@grpc/grpc-js': `file:${adapterArchive}`, 'supports-color': '8.1.1' };
    const pkg = { name: 'wga-prebundle-sdk-build', version: '1.0.0', private: true, type: 'module',
      dependencies, overrides: sourcePackage.overrides };
    lock.name = pkg.name; lock.version = pkg.version;
    lock.packages[''] = { name: pkg.name, version: pkg.version, dependencies };
    Object.assign(lock.packages, json(path.join(fixture, 'optional-dependencies.json')));
    const entry = lock.packages['node_modules/@grpc/grpc-js'];
    entry.resolved = `file:${adapterArchive}`; entry.integrity = sri(fs.readFileSync(adapterArchive));
    const archiveReceipt = await prepareArchives(lock, archives, npmCache);
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
    const executedPackageSha256 = hash(fs.readFileSync(path.join(projectRoot, 'package.json')));
    const executedLockSha256 = hash(fs.readFileSync(path.join(projectRoot, 'package-lock.json')));
    await run('npm', ['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(base, 'npm-cache')], projectRoot);
    check(hash(fs.readFileSync(path.join(projectRoot, 'package-lock.json'))) === executedLockSha256, 'MATRIX_FROZEN_EXECUTED_LOCK');
    const requireInstalled = createRequire(path.join(projectRoot, 'package.json'));
    check(!fs.lstatSync(path.join(projectRoot, 'node_modules')).isSymbolicLink(), 'MATRIX_PHYSICAL_INSTALL');
    const adapterRoot = path.join(projectRoot, 'node_modules/@grpc/grpc-js');
    const adapterMembers = assertInstalledArchive(adapterArchive, adapterRoot);
    check(requireInstalled('@google-cloud/firestore/package.json').version === profile.firestore
      && requireInstalled('@google-cloud/secret-manager/package.json').version === profile.secretManager, 'MATRIX_SDK_PINS');
    for (const name of ['wrapper.mjs', 'wrapper.d.ts']) fs.copyFileSync(path.join(fixture, name), path.join(projectRoot, name));
    report.stage = `${profile.id}-prebundle`;
    const build = requireInstalled('@grpc/grpc-js/build');
    check(fs.realpathSync(requireInstalled.resolve('@grpc/grpc-js/build')).startsWith(adapterRoot + path.sep), 'MATRIX_INSTALLED_BUILD_HELPER');
    const prebundle = await build.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'generated', typescript: require('typescript'),
      esbuild: workerRequire('esbuild'), entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts',
      packageName: '@wga-fixture/google-sdks', profile: profile.id,
      exports: ['Firestore', 'Timestamp', 'firestoreV1', 'SecretManagerServiceClient', 'OAuth2Client', 'createWorkersGrpcTransport', 'cancellableCall'] });
    const manifest = json(prebundle.manifestPath);
    check(manifest.profile === profile.id && manifest.transformCoverage.passed
      && manifest.transformCoverage.required > 0
      && manifest.transformCoverage.applied === manifest.transformCoverage.required, 'MATRIX_ACTUAL_TRANSFORMS');
    check(manifest.runtime.ownership === 'prebundle' && manifest.runtime.physicalInstallations === 1, 'MATRIX_OWNED_RUNTIME');
    for (const sdk of ['@google-cloud/firestore', '@google-cloud/secret-manager']) {
      check(manifest.sources.some(item => item.path.startsWith(sdk + '@')), 'MATRIX_IMPORTED_SDK');
      check(manifest.transformed.some(item => item.path.includes(sdk + '/')), 'MATRIX_TRANSFORMED_SDK');
    }
    const typedEntry = path.join(projectRoot, 'typecheck.mts');
    fs.copyFileSync(path.join(fixture, 'typecheck.mts'), typedEntry);
    const ts = require('typescript');
    const program = ts.createProgram([typedEntry], { strict: true, noEmit: true, skipLibCheck: false,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) report.declarationDiagnostics = diagnostics.slice(0, 10).map(diagnostic => ({
      code: diagnostic.code, file: diagnostic.file && path.basename(diagnostic.file.fileName),
      ...(diagnostic.file && diagnostic.start !== undefined ? { line: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 } : {}),
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
    check(diagnostics.length === 0, 'MATRIX_PREBUNDLE_DECLARATIONS');
    const negativeEntry = path.join(projectRoot, 'typecheck-auth.mts');
    const negativeSource = fs.readFileSync(path.join(fixture, 'typecheck-auth.mts'), 'utf8');
    fs.writeFileSync(negativeEntry, negativeSource);
    const negative = ts.createProgram([negativeEntry], { strict: true, noEmit: true, skipLibCheck: false,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
    const authDiagnostics = ts.getPreEmitDiagnostics(negative);
    const incompatibleSdk = profile.id === 'google-static-v1' ? 'SecretManagerServiceClient' : 'firestoreV1.FirestoreClient';
    const expectedLine = negativeSource.split('\n').findIndex(line => line.startsWith(`new ${incompatibleSdk}(`)) + 1;
    check(authDiagnostics.length === 1 && authDiagnostics[0].code === 2345
      && authDiagnostics[0].file?.fileName === negativeEntry
      && authDiagnostics[0].file.getLineAndCharacterOfPosition(authDiagnostics[0].start).line + 1 === expectedLine
      && /authClient/.test(ts.flattenDiagnosticMessageText(authDiagnostics[0].messageText, '\n'))
      && /OAuth2Client/.test(ts.flattenDiagnosticMessageText(authDiagnostics[0].messageText, '\n')), 'MATRIX_EXPECTED_AUTH_TYPE_BOUNDARY');
    for (const [name, artifact] of Object.entries(manifest.artifacts)) {
      const bytes = fs.readFileSync(path.join(prebundle.outdir, name));
      check(hash(bytes) === artifact.sha256 && bytes.length === artifact.bytes && !bytes.includes(token), 'MATRIX_PREBUNDLE_ARTIFACT');
      record(`${profile.id}/prebundle/${name}`, bytes);
    }
    record(`${profile.id}/prebundle/manifest.json`, fs.readFileSync(prebundle.manifestPath));
    const packed = await pack(prebundle.outdir, base);
    const consumer = path.join(base, 'consumer'); fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'wga-prebundle-sdk-consumer',
      version: '1.0.0', private: true, type: 'module', dependencies: { '@wga-fixture/google-sdks': `file:${packed}` } }));
    report.stage = `${profile.id}-consumer-install`;
    await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(base, 'npm-cache')], consumer);
    const installedArtifact = path.join(consumer, 'node_modules/@wga-fixture/google-sdks');
    const artifactMembers = assertInstalledArchive(packed, installedArtifact);
    check(!fs.existsSync(path.join(consumer, 'node_modules/@google-cloud'))
      && !fs.existsSync(path.join(consumer, 'node_modules/@grpc')), 'MATRIX_NO_ORIGINAL_SDK_FALLBACK');
    for (const name of ['worker.mjs', 'values.cjs']) fs.copyFileSync(path.join(fixture, name), path.join(consumer, name));
    report.stage = `${profile.id}-worker-build`;
    const built = await workerRequire('esbuild').build({ absWorkingDir: consumer, entryPoints: ['worker.mjs'], bundle: true,
      platform: 'node', format: 'cjs', target: 'es2022', outfile: path.join(consumer, 'consumer.cjs'), metafile: true });
    const inputs = Object.keys(built.metafile.inputs);
    check(inputs.some(file => file === 'node_modules/@wga-fixture/google-sdks/index.cjs')
      && inputs.every(file => ['worker.mjs', 'values.cjs', 'node_modules/@wga-fixture/google-sdks/index.cjs',
        'node_modules/@wga-fixture/google-sdks/index.mjs'].includes(file)), 'MATRIX_FINAL_INSTALLED_GRAPH');
    record(`${profile.id}/consumer-metafile.json`, JSON.stringify(built.metafile, null, 2) + '\n');
    fs.writeFileSync(path.join(consumer, 'entry.mjs'), 'import bundled from "./consumer.cjs";export default bundled.default;\n');
    const config = path.join(consumer, 'wrangler.json');
    fs.writeFileSync(config, JSON.stringify({ name: 'wga-google-prebundle-sdk-local', main: './entry.mjs',
      compatibility_date: report.compatibilityDate, compatibility_flags: ['nodejs_compat'], workers_dev: false }));
    await run(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
      'deploy', '--dry-run', '--no-autoconfig', '--config', config, '--outdir', 'final'], consumer);
    const script = fs.readFileSync(path.join(consumer, 'final/entry.js'), 'utf8');
    check(!script.includes(token), 'MATRIX_NO_BUILD_CREDENTIAL');
    record(`${profile.id}/worker.mjs`, script);
    const peer = controlledPeer(requireInstalled);
    const receipt = { id: profile.id, firestore: profile.firestore, secretManager: profile.secretManager,
      sourceLockSha256: hash(sourceLockBytes), executedPackageSha256, executedLockSha256, executedLockUnchanged: true,
      declarations: { entry: 'fixtures/prebundle-sdk/typecheck.mts', strict: true, noEmit: true, skipLibCheck: false,
        moduleResolution: 'NodeNext', typescript: ts.version, diagnostics: 0 },
      authTypeBoundary: { entry: 'fixtures/prebundle-sdk/typecheck-auth.mts', typedSharedOAuthInjection: false,
        incompatibleSdk, expectedDiagnosticCode: 2345, expectedDiagnosticCount: 1,
        rootAuthVersion: profile.id === 'google-static-v1' ? '10.9.1' : '11.1.0',
        sdkAuthVersion: profile.id === 'google-static-v1' ? '11.1.0' : '10.9.1' },
      archives: archiveReceipt, adapterMembers, artifactMembers, artifactTarballSha256: hash(fs.readFileSync(packed)),
      profileSha256: manifest.profileSha256, registrySha256: manifest.registrySha256, artifactSha256: manifest.artifactSha256,
      transformCoverage: manifest.transformCoverage, runtime: manifest.runtime, schemas: peer.schemas,
      workerSha256: hash(script), consumerDependencies: ['@wga-fixture/google-sdks'], sourceFallbackPresent: false,
      consumerPackageSha256: hash(fs.readFileSync(path.join(consumer, 'package.json'))),
      consumerLockSha256: hash(fs.readFileSync(path.join(consumer, 'package-lock.json'))),
      finalInputs: inputs, modes: [] };
    report.profiles.push(receipt);
    const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
    for (const mode of ['grpc-web', 'cloudflare']) {
      const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script, log: new Log(LogLevel.NONE),
        compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'],
        bindings: { PROFILE: profile.id, MODE: mode, RUNTIME_TOKEN: token, NODE_DEBUG: '', GOOGLE_SDK_NODE_LOGGING: '' },
        outboundService: async request => {
          try { return await peer.fetch(request); }
          catch (error) { peer.failures.push(safe(error)); return new Response('Synthetic peer failure', { status: 500 }); }
        },
      }));
      try {
        let previousScenario;
        for (const [scenario, contract] of Object.entries(expectedCases)) {
          report.stage = `${profile.id}-${mode}-${scenario}`;
          const caseId = `${profile.id}/${mode}/${scenario}`, state = peer.prepare(caseId, scenario, mode);
          const response = await bounded(runtime.dispatchFetch(`https://consumer.fixture.invalid/${scenario}`));
          const result = await bounded(response.json());
          if (response.status !== 200 || result.status !== 'passed') report.failedCase = {
            profile: profile.id, mode, scenario, diagnostic: result.diagnostic,
            sdkErrorCode: result.sdkErrorCode, sdkErrorName: result.sdkErrorName,
            requests: state.trace, peerDiagnostics: peer.failures,
          };
          check(response.status === 200 && result.status === 'passed', /^MATRIX_[A-Z_]+$/.test(result.diagnostic)
            ? result.diagnostic : 'MATRIX_WORKER_RESPONSE');
          check(peer.failures.length === 0, peer.failures[0] || 'MATRIX_PEER_FAILURE');
          check(JSON.stringify(state.trace.map(call => call.method)) === JSON.stringify(contract.methods)
            && JSON.stringify(state.trace.map(call => call.statusCode)) === JSON.stringify(contract.codes), 'MATRIX_EXACT_RPC_CONTRACT');
          check(JSON.stringify(result.calls.map(call => call.statusCode)) === JSON.stringify(contract.codes)
            && result.calls.every(call => call.attemptCount === 1 && call.fetchCount === 1), 'MATRIX_NO_RETRY_AMPLIFICATION');
          check(result.fetchIntents.length === contract.methods.length
            && result.fetchIntents.every(intent => intent === (mode === 'cloudflare' ? 'convert' : 'passthrough')), 'MATRIX_ACTUAL_FETCH_INTENT');
          check(result.clientClosed && Object.values(result.resourcesBeforeClose).every(value => value === 0), 'MATRIX_CLIENT_CLEANUP');
          check(result.responseReaders.length === contract.methods.length
            && result.responseReaders.every(reader => reader.released && !reader.sourceLocked && !reader.bodyLocked), 'MATRIX_WORKER_READERS_RELEASED');
          for (let turn = 0; turn < 100 && (peer.active.size || peer.responses.some(item => item.body.locked)); turn++) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
          check(peer.active.size === 0 && peer.responses.every(item => item.closed && !item.body.locked), 'MATRIX_RESPONSE_READER_RELEASED');
          check(state.controls === (scenario === 'secret-cancel' ? 2 : scenario === 'firestore-stream-error' ? 1 : 0), 'MATRIX_CONTROL_COUNT');
          check(result.responseReaders.every((reader, index) => reader.cancellationsStarted
            === (scenario === 'secret-cancel' && index === 0 ? 1 : 0)), 'MATRIX_READER_CANCEL_STARTED');
          check(result.responseReaders.every((reader, index) => reader.cancellationsCompleted
            === (scenario === 'secret-cancel' && index === 0 ? 1 : 0)), 'MATRIX_READER_CANCEL_COMPLETED');
          if (scenario === 'secret-cancel') {
            const beforeRelease = result.result.readerBeforePeerRelease;
            check(result.result.localReaderCancelledBeforePeerRelease === true
              && beforeRelease.cancellationsStarted === 1 && beforeRelease.cancellationsCompleted === 1
              && beforeRelease.released === true && beforeRelease.sourceLocked === false
              && beforeRelease.bodyLocked === false, 'MATRIX_READER_CANCEL_BEFORE_PEER_RELEASE');
          }
          if (scenario === 'secret-access') check(previousScenario === 'secret-cancel', 'MATRIX_NEXT_REQUEST_AFTER_CANCEL');
          report.cases.push({ profile: profile.id, mode, scenario, status: 'passed', rpcCount: state.trace.length,
            requests: state.trace, result: result.result, calls: result.calls, fetchIntents: result.fetchIntents,
            responseReaders: result.responseReaders,
            resourcesBeforeClose: result.resourcesBeforeClose,
            peerReadersReleased: true, clientClosed: true, ...(scenario === 'secret-access' ? { nextRequestAfterCancel: true } : {}) });
          previousScenario = scenario;
        }
      } finally {
        // A Promise timeout does not stop I/O. Release every controlled gate,
        // then dispose workerd and cancel any remaining unlocked host reader.
        peer.releaseHeld();
        await bounded(runtime.dispose(), 5000);
        for (const response of peer.responses.filter(response => !response.closed && !response.body.locked)) {
          await bounded(response.body.cancel(), 1000);
        }
      }
      receipt.modes.push({ mode, disposed: true });
    }
    check(peer.failures.length === 0, 'MATRIX_PEER_ASSERTIONS');
  } finally {
    // Profiles install sequentially and release their physical graph before the
    // next npm ci. No developer fixture node_modules is ever modified or linked.
    fs.rmSync(base, { recursive: true, force: true });
  }
}

async function main() {
  // Anchor the shared implementation to independent published CRC32C vectors;
  // checking only peer/consumer parity would repeat the same possible defect.
  check(crc32c(new Uint8Array()) === 0 && crc32c(Buffer.from('123456789')) === 0xe3069283, 'MATRIX_CRC32C_KNOWN_VECTORS');
  report.crc32cKnownVectors = true;
  report.workerd = workerRequire('workerd/package.json').version;
  report.miniflare = workerRequire('miniflare/package.json').version;
  report.esbuild = workerRequire('esbuild').version;
  report.typescript = require('typescript').version;
  report.wrangler = workerRequire('wrangler/package.json').version;
  const sources = ['fixtures/prebundle-sdk/wrapper.mjs', 'fixtures/prebundle-sdk/wrapper.d.ts',
    'fixtures/prebundle-sdk/typecheck.mts',
    'fixtures/prebundle-sdk/typecheck-auth.mts',
    'fixtures/prebundle-sdk/worker.mjs', 'fixtures/prebundle-sdk/values.cjs', 'fixtures/prebundle-sdk/optional-dependencies.json',
    'scripts/test-google-prebundle-sdks.cjs', 'fixtures/google/package.json', 'fixtures/google/package-lock.json',
    'fixtures/modern/package.json', 'fixtures/modern/package-lock.json', 'package.json'];
  report.evidence = Object.fromEntries(sources.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  report.stage = 'build-adapter'; await run(process.execPath, ['scripts/build.cjs'], root);
  report.stage = 'pack-adapter'; const adapterArchive = await pack(root, temporary);
  report.adapterTarballSha256 = hash(fs.readFileSync(adapterArchive));
  // npm's configured content cache is a read-only optimization. No install can
  // hit the registry because every resolved lock entry becomes a file archive.
  const npmCache = process.env.WGA_NPM_ARCHIVE_CACHE || process.env.npm_config_cache || path.join(os.homedir(), '.npm');
  for (const profile of profiles) await profileRun(profile, adapterArchive, npmCache);
  report.rpcCount = report.cases.reduce((sum, item) => sum + item.rpcCount, 0);
  check(report.cases.length === 28 && report.rpcCount === 48, 'MATRIX_COMPLETE_CASES');
  for (const [file, digest] of Object.entries(report.generatedArtifacts)) {
    const bytes = fs.readFileSync(path.join(root, file));
    check(hash(bytes) === digest && !bytes.includes(token), 'MATRIX_FINAL_ARTIFACT_HASH');
  }
  check(!JSON.stringify(report).includes(token), 'MATRIX_REPORT_REDACTION');
  report.runtimeSharedOAuthInjection = true;
  report.runtimeDisposed = true; report.stage = 'complete'; report.status = 'passed';
}
main().catch(error => {
  report.status = 'failed'; report.diagnostic = safe(error); process.exitCode = 1;
  if (report.diagnostic.startsWith('WGA_')) report.buildDiagnostic = Object.fromEntries(
    ['import', 'path'].filter(key => typeof error.diagnostic?.[key] === 'string')
      .map(key => [key, error.diagnostic[key]]));
}).finally(() => {
  fs.rmSync(temporary, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'verification/google-prebundle-sdks.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, stage: report.stage, diagnostic: report.diagnostic,
    cases: report.cases.length, rpcCount: report.rpcCount, report: 'verification/google-prebundle-sdks.json' }));
});
