'use strict';
// All I/O terminates at Miniflare's outbound Fetch boundary. No Gaxios adapter,
// token provider replacement, stored key, cloud credential, or live Google call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes, generateKeyPairSync, verify } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const googleRoot = path.join(root, 'fixtures/google');
const googleRequire = createRequire(path.join(googleRoot, 'package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const esbuild = workerRequire('esbuild');
const { createGoogleWorkerBuild } = process.argv.includes('--source-build') ? require('../src/build/index.cjs') : googleRequire('@grpc/grpc-js/build');
const { encodeFrame } = require('../dist/wire.js');
const digest = value => createHash('sha256').update(value).digest('hex');
const fresh = () => randomBytes(24).toString('hex');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-workers-auth-'));
const compatibilityDate = '2026-09-21';
const report = { startedAt: new Date().toISOString(), status: 'running', runtimeExecuted: false, realGoogleAuth: true,
  realGoogleSDK: true, liveGoogle: false, cloudflareTranslation: false, credentialsPersisted: false,
  tokenEndpointBoundary: 'Miniflare outbound Fetch', customGaxiosAdapter: false,
  gaxiosFetchImplementation: 'native Fetch default from pinned build preset', compatibilityDate, runs: [] };
const scenarios = ['valid-cache', 'expired-refresh', 'concurrent-refresh', 'isolated-refresh', 'denied-refresh',
  'cancel-refresh', 'deadline-refresh', 'jwt-exchange', 'sdk-refresh'];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function check(condition, diagnostic) { assert.ok(condition, diagnostic); }
function identity(id, scenario) {
  const item = { id, clientId: `fixture-${id}`, clientSecret: fresh(), accessToken: fresh(), refreshToken: fresh(),
    nextToken: fresh(), quota: 'wga-auth-fixture', expired: scenario !== 'valid-cache', tokenRequests: 0,
    started: deferred(), release: deferred(), gated: ['concurrent-refresh', 'isolated-refresh', 'cancel-refresh', 'deadline-refresh'].includes(scenario) };
  if (scenario === 'jwt-exchange') {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    item.kind = 'jwt';
    item.email = `${id}@wga-auth-fixture.invalid`;
    item.privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' });
    item.publicKey = key.publicKey;
  }
  return item;
}
async function main() {
  const preset = createGoogleWorkerBuild({ projectRoot: googleRoot, outdir: path.join(temporary, 'preset'), typescript: require('typescript') });
  await esbuild.build({ entryPoints: [path.join(googleRoot, 'auth-worker.mjs')], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin] });
  const main = path.join(temporary, 'worker.mjs');
  fs.writeFileSync(main, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const config = path.join(temporary, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-auth', main, compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config, '--outdir', path.join(temporary, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(temporary, 'bundle/worker.js'), 'utf8');
  const manifest = preset.manifest();
  Object.assign(report, { bundleSha256: digest(script), profile: manifest.profile, profileRevision: manifest.revision,
    profileSha256: manifest.profileSha256, registrySha256: manifest.registrySha256,
    evidence: Object.fromEntries(['scripts/test-workers-auth.cjs', 'fixtures/google/auth-worker.mjs', 'fixtures/google/package-lock.json', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))])) });
  const P = googleRequire('protobufjs');
  const schema = P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(googleRequire.resolve('@google-cloud/secret-manager/package.json')), 'build/protos/protos.json'), 'utf8')));
  const secretRequest = schema.lookupType('google.cloud.secretmanager.v1.GetSecretRequest');
  const secretResponse = schema.lookupType('google.cloud.secretmanager.v1.Secret');
  let current;
  const worker = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService: async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'control.fixture.invalid') {
        const [, action, id] = url.pathname.split('/');
        const item = current.identities.find(value => value.id === id);
        check(!!item, 'CONTROL_ID');
        if (action === 'started') await item.started.promise;
        else { check(action === 'release', 'CONTROL_ACTION'); item.release.resolve(); }
        return new Response('ready');
      }
      if (url.hostname === 'oauth.fixture.invalid' || url.hostname === 'oauth2.googleapis.com') {
        const item = url.hostname === 'oauth2.googleapis.com' ? current.identities[0] : current.identities.find(value => `/token/${value.id}` === url.pathname);
        check(!!item && request.method === 'POST', 'TOKEN_ENDPOINT');
        check(request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'), 'TOKEN_CONTENT_TYPE');
        const form = new URLSearchParams(await request.text());
        if (item.kind === 'jwt') {
          check(url.href === 'https://oauth2.googleapis.com/token', 'JWT_ENDPOINT');
          check(form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer', 'JWT_GRANT');
          const parts = (form.get('assertion') || '').split('.');
          check(parts.length === 3, 'JWT_FORMAT');
          const [header64, claims64, signature64] = parts;
          const header = JSON.parse(Buffer.from(header64, 'base64url'));
          const claims = JSON.parse(Buffer.from(claims64, 'base64url'));
          check(header.alg === 'RS256' && verify('RSA-SHA256', Buffer.from(`${header64}.${claims64}`), item.publicKey, Buffer.from(signature64, 'base64url')), 'JWT_SIGNATURE');
          check(claims.iss === item.email && claims.scope === 'https://www.googleapis.com/auth/cloud-platform' && claims.aud === url.href, 'JWT_CLAIMS');
          check(Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 60 && claims.exp - claims.iat === 3600, 'JWT_LIFETIME');
          current.signedAssertionVerified = true;
        } else {
          check(form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === item.refreshToken
            && form.get('client_id') === item.clientId && form.get('client_secret') === item.clientSecret, 'REFRESH_FORM');
        }
        item.tokenRequests++;
        item.started.resolve();
        if (item.gated) await item.release.promise;
        if (current.scenario === 'denied-refresh' && item.tokenRequests === 1) {
          return Response.json({ error: 'invalid_grant', error_description: item.refreshToken }, { status: 400 });
        }
        return Response.json({ access_token: item.nextToken, expires_in: 3600, token_type: 'Bearer' });
      }
      check(request.method === 'POST', 'RPC_METHOD');
      const sdk = url.pathname === '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret';
      check(sdk || url.pathname === '/fixture.Auth/Echo', 'RPC_PATH');
      check(url.hostname === (current.mode === 'grpc-web' ? 'gateway.fixture.invalid' : sdk ? 'secretmanager.googleapis.com' : 'logical.fixture.invalid'), 'RPC_TARGET');
      const mime = current.mode === 'grpc-web' ? 'application/grpc-web+proto' : 'application/grpc-web';
      check(request.headers.get('content-type') === mime && request.headers.get('accept') === mime, 'RPC_CONTENT_TYPE');
      const bytes = Buffer.from(await request.arrayBuffer());
      check(bytes[0] === 0 && bytes.readUInt32BE(1) === bytes.length - 5, 'RPC_FRAMING');
      const decoded = sdk ? secretRequest.decode(bytes.subarray(5)).name : bytes.subarray(5).toString();
      const id = sdk ? decoded.split('/').pop() : decoded;
      const item = current.identities.find(value => value.id === id);
      // The stopped invocation must never issue an RPC, even after refresh completes.
      check(!!item, 'RPC_ID_OR_LATE_FETCH');
      check(request.headers.get('authorization') === `Bearer ${item.expired ? item.nextToken : item.accessToken}`, 'RPC_AUTHORIZATION');
      check(request.headers.get('x-goog-user-project') === item.quota, 'RPC_QUOTA');
      current.rpcOwners.push(item.id);
      const reply = sdk ? secretResponse.encode(secretResponse.fromObject({ name: decoded })).finish() : Buffer.from('accepted');
      return new Response(Buffer.concat([encodeFrame(reply), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': mime } });
    } catch (error) {
      current.boundaryFailure = error.code === 'ERR_ASSERTION' ? error.message : 'BOUNDARY_VALIDATION';
      // Do not let Miniflare print a credential-bearing exception.
      return new Response('Fixture boundary rejected request', { status: 500 });
    }
  } }));
  try {
    for (const authVersion of ['10.9.1', '11.1.0']) for (const mode of ['grpc-web', 'cloudflare']) for (const scenario of scenarios) {
      const identities = Array.from({ length: scenario === 'isolated-refresh' ? 2 : 1 }, (_, index) => identity(`${authVersion}-${mode}-${scenario}-${index}`, scenario));
      current = { mode, scenario, identities, rpcOwners: [], signedAssertionVerified: false };
      const input = { mode, scenario, authVersion, identities: identities.map(({ id, clientId, clientSecret, accessToken, refreshToken, quota, expired, kind, email, privateKey }) => ({ id, clientId, clientSecret, accessToken, refreshToken, quota, expired, kind, email, privateKey })) };
      const response = await worker.dispatchFetch('https://fixture.test/auth', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      report.runtimeExecuted = true;
      const run = { mode, scenario, authVersion, status: 'running', tokenRequests: identities.reduce((sum, item) => sum + item.tokenRequests, 0), rpcCount: current.rpcOwners.length };
      report.runs.push(run);
      check(!current.boundaryFailure, current.boundaryFailure || 'BOUNDARY');
      check(response.status === 200 && data.status === 'passed', `${scenario}: ${data.stage || ''}/${data.diagnostic || 'RESPONSE'}`);
      const expectedRPCs = { 'concurrent-refresh': 12, 'isolated-refresh': 4, 'denied-refresh': 1, 'cancel-refresh': 1, 'deadline-refresh': 1 }[scenario] ?? 2;
      const expectedTokens = scenario === 'valid-cache' ? 0 : ['denied-refresh', 'isolated-refresh'].includes(scenario) ? 2 : 1;
      check(run.rpcCount === expectedRPCs, 'RPC_COUNT');
      check(run.tokenRequests === expectedTokens, 'TOKEN_COUNT');
      if (scenario === 'isolated-refresh') check(current.rpcOwners[0] === identities[1].id && identities.every(item => item.tokenRequests === 1), 'REVERSE_REFRESH_ISOLATION');
      if (scenario === 'jwt-exchange') check(current.signedAssertionVerified, 'JWT_SIGNATURE_REQUIRED');
      Object.assign(run, { status: 'passed', authorizationMatched: true, quotaMetadataMatched: true,
        ...(scenario === 'jwt-exchange' ? { signedAssertionVerified: true } : {}) });
    }
    report.status = 'passed';
    report.rpcCount = report.runs.reduce((sum, run) => sum + run.rpcCount, 0);
    report.tokenRequests = report.runs.reduce((sum, run) => sum + run.tokenRequests, 0);
  } finally {
    for (const item of current?.identities || []) { item.started.resolve(); item.release.resolve(); }
    await worker.dispose();
  }
}
main().catch(error => {
  report.status = 'failed';
  // Assertion messages are our fixed diagnostics. Never serialize Gaxios errors.
  report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERS_AUTH_FAILED';
  console.error(JSON.stringify({ status: 'failed', diagnostic: report.diagnostic, errorClass: error.constructor?.name || 'Error' }));
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-auth.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, scenarios: report.runs.length, rpcCount: report.rpcCount, report: 'verification/workers-auth.json' }));
});
