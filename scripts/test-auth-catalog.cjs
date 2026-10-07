'use strict';
// The upstream credential engine and Google SDK/auth execute locally. All HTTP
// terminates at the controlled Fetch peer; no credential material is persisted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes, generateKeyPairSync, verify } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { setTimeout: realSetTimeout, clearTimeout: realClearTimeout } = require('node:timers');
const { validateAuthCatalogReport, catalogCases, sources } = require('./auth-catalog-evidence.cjs');
const root = path.resolve(__dirname, '..');
const googleRoot = path.join(root, 'fixtures/google');
const googleRequire = createRequire(path.join(googleRoot, 'package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const sourceBuild = process.argv.includes('--source-build');
const digest = value => createHash('sha256').update(value).digest('hex');
const fresh = () => randomBytes(24).toString('hex');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-auth-catalog-'));
const reportFile = path.join(root, 'verification/auth-catalog.json');
const marker = `auth-private-${fresh()}`;
const report = { status: 'running', sourceBuild, startedAt: new Date().toISOString(), liveCloud: false,
  incomingCloudflareTranslation: false, controlledFetchPeer: true, credentialsPersisted: false,
  compatibilityDate: '2026-09-21', unexpectedRequests: 0, runs: [], receipts: [], tokenRequests: [],
  evidence: Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))])) };
function check(value, diagnostic) { assert.ok(value, diagnostic); }
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function watchdog(run) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => {
    timer = realSetTimeout(() => reject(new Error('AUTH_CATALOG_NODE_TIMEOUT')), 60000);
  })]); } finally { realClearTimeout(timer); }
}
function makeInput() {
  const serviceAccounts = [0, 1].map(index => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { project: `wga-project-${index}`, email: `account-${index}@wga-project-${index}.iam.gserviceaccount.com`,
      quota: `wga-quota-${index}`, publicKey: pair.publicKey,
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  });
  const oauth = { clientId: 'wga-auth-catalog', clientSecret: fresh(), refreshToken: fresh(), accessToken: fresh(), nextToken: fresh(),
    quota: 'wga-oauth-quota', project: 'wga-oauth-project' };
  return { marker, oauth, serviceAccounts };
}
async function nativeOracle(shared) {
  const grpc = nativeRequire('@grpc/grpc-js');
  const { LoadBalancingCall } = nativeRequire('@grpc/grpc-js/build/src/load-balancing-call');
  const { restrictControlPlaneStatusCode } = nativeRequire('@grpc/grpc-js/build/src/control-plane-status');
  check(nativeRequire('@grpc/grpc-js/package.json').version === '1.14.5', 'NATIVE_PIN');
  const fixture = shared.compositionFixture(grpc), ready = defer();
  const subchannel = { getChannelzRef: () => ({ id: 1 }), getAddress: () => 'controlled-native-subchannel',
    getCallCredentials: () => fixture.channelCalls, getConnectivityState: () => grpc.connectivityState.READY,
    getRealSubchannel: () => ({ createCall(metadata) {
      ready.resolve(shared.metadataSnapshot(metadata)); return { getCallNumber: () => 1 };
    } }) };
  const call = new LoadBalancingCall({ doPick: () => ({ pickResultType: 0, subchannel }) }, { pickInformation: {} },
    shared.rpcPath, 'logical.fixture.invalid', fixture.perCall, Infinity, 1);
  call.start(fixture.caller, { onReceiveStatus() { throw new Error('NATIVE_ORACLE_STATUS_FAILURE'); } });
  await fixture.release(); const metadata = await ready.promise;
  const codes = Object.fromEntries([undefined, 16, 14, ...shared.forbiddenCodes].map(code =>
    [String(code), restrictControlPlaneStatusCode(code === undefined ? 2 : code, 'controlled').code]));
  return { version: '1.14.5', actualLoadBalancingCall: true, controlledReadySubchannel: true,
    networkUsed: false, composition: { metadata, completed: fixture.completed }, codes,
    inputs: Object.fromEntries(['package.json', 'build/src/load-balancing-call.js', 'build/src/call-credentials.js',
      'build/src/metadata.js', 'build/src/control-plane-status.js'].map(file => {
        const relative = `fixtures/native/node_modules/@grpc/grpc-js/${file}`;
        return [relative, digest(fs.readFileSync(path.join(root, relative)))];
      })) };
}
async function main() {
  const shared = await import(pathToFileURL(path.join(root, 'fixtures/google/shared/auth-catalog.mjs')).href);
  report.native = await watchdog(() => nativeOracle(shared));
  const input = makeInput();
  const P = googleRequire('protobufjs');
  const schema = P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(googleRequire.resolve('@google-cloud/secret-manager/package.json')), 'build/protos/protos.json'), 'utf8')));
  const RequestType = schema.lookupType('google.cloud.secretmanager.v1.GetSecretRequest');
  const ResponseType = schema.lookupType('google.cloud.secretmanager.v1.Secret');
  const { encodeFrame } = require('../dist/wire.js');
  let runtimeName, lastOAuthName, boundaryFailure;
  const seenNames = new Map(), isolationGates = new Map();
  const peer = async request => {
    try {
      const url = new URL(request.url);
      if (url.href === 'https://oauth.fixture.invalid/token') {
        check(request.method === 'POST', 'TOKEN_METHOD');
        check(request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'), 'TOKEN_CONTENT_TYPE');
        const form = new URLSearchParams(await request.text());
        check(form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === input.oauth.refreshToken
          && form.get('client_id') === input.oauth.clientId && form.get('client_secret') === input.oauth.clientSecret, 'TOKEN_FORM');
        check(!request.headers.has('authorization') && !!lastOAuthName, 'TOKEN_METADATA_ISOLATION');
        report.tokenRequests.push({ runtime: runtimeName, owner: lastOAuthName, requestShapeMatched: true });
        return Response.json({ access_token: input.oauth.nextToken, expires_in: 3600, token_type: 'Bearer' });
      }
      check(request.method === 'POST' && url.pathname === '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret', 'SDK_RPC_PATH');
      const wire = Buffer.from(await request.arrayBuffer());
      check(wire[0] === 0 && wire.readUInt32BE(1) === wire.length - 5, 'SDK_RPC_FRAME');
      const name = RequestType.decode(wire.subarray(5)).name;
      const mode = name.includes('-grpc-web-') ? 'grpc-web' : 'cloudflare';
      check(name.includes(`${runtimeName}-${mode}-`), 'SDK_RPC_OWNER');
      check(url.hostname === (mode === 'grpc-web' ? 'gateway.fixture.invalid' : 'secretmanager.googleapis.com'), 'SDK_RPC_ORIGIN');
      const mime = mode === 'grpc-web' ? 'application/grpc-web+proto' : 'application/grpc-web';
      check(request.headers.get('content-type') === mime && request.headers.get('accept') === mime, 'SDK_RPC_MIME');
      const phase = seenNames.get(name) || 0; seenNames.set(name, phase + 1);
      let entry;
      if (name.startsWith(`projects/${input.oauth.project}/`)) {
        const authVersion = name.endsWith('11.1.0') ? '11.1.0' : '10.9.1';
        check(phase <= 2, 'SDK_PHASE_COUNT');
        check(request.headers.get('authorization') === `Bearer ${phase === 0 ? input.oauth.accessToken : input.oauth.nextToken}`, 'SDK_BEARER');
        check(request.headers.get('x-goog-user-project') === input.oauth.quota, 'SDK_QUOTA');
        lastOAuthName = name;
        entry = { kind: 'oauth', runtime: runtimeName, mode, name, authVersion, phase: ['valid', 'refreshed', 'reused'][phase],
          bearerMatched: true, quotaMatched: true };
      } else {
        const index = input.serviceAccounts.findIndex(identity => name.startsWith(`projects/${identity.project}/`));
        check(index >= 0 && phase === 0, 'SERVICE_ACCOUNT_OWNER');
        const identity = input.serviceAccounts[index];
        const bearer = request.headers.get('authorization');
        check(bearer?.startsWith('Bearer '), 'SERVICE_ACCOUNT_BEARER');
        const parts = bearer.slice(7).split('.'); check(parts.length === 3, 'SERVICE_ACCOUNT_JWT');
        const [header, claimsText, signature] = parts;
        const claims = JSON.parse(Buffer.from(claimsText, 'base64url'));
        check(JSON.parse(Buffer.from(header, 'base64url')).alg === 'RS256' && verify('RSA-SHA256', Buffer.from(`${header}.${claimsText}`), identity.publicKey, Buffer.from(signature, 'base64url')), 'SERVICE_ACCOUNT_SIGNATURE');
        check(claims.iss === identity.email && claims.sub === identity.email && claims.exp - claims.iat === 3600, 'SERVICE_ACCOUNT_CLAIMS');
        check(claims.aud === 'https://secretmanager.googleapis.com/'
          && claims.scope === undefined, 'SERVICE_ACCOUNT_LOGICAL_AUDIENCE');
        check(request.headers.get('x-goog-user-project') === identity.quota, 'SERVICE_ACCOUNT_QUOTA');
        const gateKey = `${runtimeName}/${mode}`;
        if (!isolationGates.has(gateKey)) isolationGates.set(gateKey, defer());
        const gate = isolationGates.get(gateKey);
        if (index === 0) await gate.promise;
        else realSetTimeout(gate.resolve, 0);
        entry = { kind: 'service-account', runtime: runtimeName, mode, name, identity: index,
          project: identity.project, clientEmail: identity.email, quota: identity.quota,
          signatureVerified: true, claimsMatched: true, resultNameMatched: true };
      }
      report.receipts.push(entry);
      const body = ResponseType.encode(ResponseType.fromObject({ name })).finish();
      return new Response(Buffer.concat([encodeFrame(body), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': mime } });
    } catch (error) {
      boundaryFailure = error.code === 'ERR_ASSERTION' ? error.message : 'AUTH_BOUNDARY_FAILURE';
      report.boundaryFailure = boundaryFailure;
      report.unexpectedRequests++;
      return new Response('Controlled auth peer rejected request', { status: 500 });
    }
  };
  report.versions = { auth: [googleRequire('google-auth-library/package.json').version,
    googleRequire('@google-cloud/secret-manager/node_modules/google-auth-library/package.json').version],
    gax: googleRequire('@google-cloud/secret-manager/node_modules/google-gax/package.json').version,
    secretManager: googleRequire('@google-cloud/secret-manager/package.json').version,
    miniflare: workerRequire('miniflare/package.json').version, workerd: workerRequire('workerd/package.json').version };
  const grpc = require('../dist/index.js'), { createWorkersGrpcTransport } = require('../dist/adapter.js');
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (url, init) => peer(new Request(url, init)); runtimeName = 'node';
  try {
    const result = await watchdog(() => shared.runAuthCatalog({ grpc, createWorkersGrpcTransport, input, runtime: 'node', native: report.native }));
    report.runs.push(result);
    check(!boundaryFailure, boundaryFailure || 'NODE_PEER');
    check(result.status === 'passed', `NODE_${result.stage || ''}_${result.diagnostic || 'FAILED'}`);
  } finally { globalThis.fetch = fetchOriginal; }
  check(!boundaryFailure, boundaryFailure || 'NODE_PEER');
  const { createGoogleWorkerBuild } = sourceBuild ? require('../src/build/index.cjs') : googleRequire('@grpc/grpc-js/build');
  const preset = createGoogleWorkerBuild({ projectRoot: googleRoot, outdir: path.join(temporary, 'preset'), typescript: require('typescript') });
  const build = await workerRequire('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/auth-catalog.mjs'],
    bundle: true, format: 'cjs', platform: 'node', target: 'es2022', metafile: true, outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin],
    ...(sourceBuild ? { alias: { '@grpc/grpc-js/package.json': path.join(root, 'package.json'),
      '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.js'), '@grpc/grpc-js': path.join(root, 'dist/index.js') } } : {}) });
  const installed = Object.keys(build.metafile.inputs).filter(file => /fixtures\/(google|worker)\/node_modules\/@grpc\/grpc-js\/dist\//.test(file));
  if (!sourceBuild) check(installed.length > 0, 'INSTALLED_ADAPTER_REQUIRED');
  report.installedInputs = Object.fromEntries(installed.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const mainFile = path.join(temporary, 'worker.mjs'); fs.writeFileSync(mainFile, 'import bundle from "./sdk.cjs"; export default bundle.default;\n');
  const config = path.join(temporary, 'wrangler.json'); fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-auth-catalog', main: mainFile,
    compatibility_date: report.compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run',
    '--config', config, '--outdir', path.join(temporary, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(temporary, 'bundle/worker.js'), 'utf8');
  const manifest = preset.manifest();
  Object.assign(report, { bundleSha256: digest(script), profile: manifest.profile, profileSha256: manifest.profileSha256, registrySha256: manifest.registrySha256 });
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
  const runtimeLogs = [];
  class CapturedLog extends Log { log(message) { runtimeLogs.push(String(message)); } }
  const log = new CapturedLog(LogLevel.DEBUG); log.warn('AUTH_RUNTIME_LOG_SENSOR');
  const worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: report.compatibilityDate,
    compatibilityFlags: ['nodejs_compat'], log, outboundService: peer }));
  runtimeName = 'workerd';
  try {
    const transferable = { ...input, serviceAccounts: input.serviceAccounts.map(({ publicKey, ...rest }) => rest) };
    const response = await worker.dispatchFetch('https://auth-catalog.fixture.invalid/', { method: 'POST', body: JSON.stringify({ input: transferable, native: report.native }), signal: AbortSignal.timeout(60000) });
    const body = await response.text(); check(!body.includes(marker), 'WORKER_HTTP_MARKER_SCAN');
    const result = JSON.parse(body); report.runs.push(result);
    check(!boundaryFailure, boundaryFailure || 'WORKER_PEER');
    check(response.status === 200 && result.status === 'passed', `WORKER_${result.stage || ''}_${result.diagnostic || 'FAILED'}`);
    report.workerHttpScanned = true;
  } finally { await worker.dispose(); report.runtimeDisposed = true; }
  check(runtimeLogs.some(value => value.includes('AUTH_RUNTIME_LOG_SENSOR')), 'RUNTIME_LOG_SENSOR');
  check(!runtimeLogs.join('\n').includes(marker), 'RUNTIME_LOG_MARKER_SCAN');
  report.runtimeLogsScanned = runtimeLogs.length; report.runtimeLogSensorCount = 1;
  for (const run of report.runs) for (const row of run.rows) {
    if (row.id === 'AUTH-001' || row.id === 'AUTH-012') {
      const seen = report.receipts.filter(value => value.kind === 'oauth' && value.runtime === row.runtime && value.mode === row.mode && value.authVersion === row.authVersion);
      check(seen.length === 3, 'SDK_PHASE_RECEIPTS');
      row.tokenRequests = report.tokenRequests.filter(value => value.owner === seen[0].name).length;
      row.phasesObserved = seen.map(value => value.phase); row.rpcCount = seen.length;
      check(row.tokenRequests === 1, 'SDK_ONE_REFRESH');
    }
    if (row.id === 'AUTH-013') {
      const seen = report.receipts.filter(value => value.kind === 'service-account' && value.runtime === row.runtime && value.mode === row.mode);
      check(JSON.stringify(seen.map(value => value.identity)) === '[1,0]', 'REVERSE_IDENTITY_COMPLETION');
      row.completionOrder = seen.map(value => value.identity); row.signaturesVerified = seen.length; row.quotaIsolation = true; row.rpcCount = seen.length;
    }
  }
  report.caseCount = report.runs.reduce((sum, run) => sum + run.rows.length, 0);
  report.catalogCases = catalogCases(report.runs);
  report.status = 'passed'; report.markerOccurrences = 0;
  check(!JSON.stringify(report).includes(marker), 'REPORT_MARKER_SCAN'); report.reportMarkerScanned = true;
  validateAuthCatalogReport(report, { allowSourceBuild: sourceBuild });
}
function writeReport() {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  let content = JSON.stringify(report, null, 2) + '\n';
  if (content.includes(marker)) {
    report.status = 'failed'; report.diagnostic = 'AUTH_ARTIFACT_MARKER_LEAK';
    content = (JSON.stringify(report, null, 2) + '\n').split(marker).join('[redacted]'); process.exitCode = 1;
  }
  fs.writeFileSync(reportFile, content, { mode: 0o600 });
}
writeReport();
main().catch(error => {
  report.status = 'failed'; report.diagnostic = error.code === 'ERR_ASSERTION' || error.message?.startsWith('WGA_EVIDENCE_INVALID: auth-catalog ')
    ? error.message : 'AUTH_CATALOG_RUNNER_FAILURE';
  if (report.diagnostic.includes(marker)) report.diagnostic = 'AUTH_CATALOG_REDACTED_FAILURE';
  report.errorClass = error.constructor?.name || 'Error'; process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString(); writeReport(); fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, cases: report.caseCount, catalogCases: report.catalogCases,
    diagnostic: report.diagnostic, report: 'verification/auth-catalog.json' }));
});
