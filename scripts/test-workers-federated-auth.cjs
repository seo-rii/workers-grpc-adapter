'use strict';
// Real pinned Google auth constructors and SDK credentials JSON run in workerd.
// All I/O terminates at Miniflare outbound Fetch; no live IdP, STS, IAM or ADC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
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
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-federated-auth-'));
const compatibilityDate = '2026-09-21';
const scope = 'https://www.googleapis.com/auth/cloud-platform';
const report = { startedAt: new Date().toISOString(), status: 'running', runtimeExecuted: false,
  realGoogleAuth: true, realGoogleSDK: true, liveGoogle: false, liveIdentityProvider: false,
  fullADCEcosystem: false, cloudflareTranslation: false, credentialsPersisted: false,
  tokenEndpointBoundary: 'Miniflare outbound Fetch', customGaxiosAdapter: false,
  gaxiosFetchImplementation: 'native Fetch default from pinned build preset', compatibilityDate, runs: [] };
const scenarios = ['cache-refresh', 'concurrent-exchange', 'isolated-exchange', 'denied-exchange', 'cancel-exchange', 'deadline-exchange'];
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function check(condition, diagnostic) { assert.ok(condition, diagnostic); }
function identity(id, kind, scenario) {
  const item = { id, kind, email: `${id}@wga-fixture.iam.gserviceaccount.com`, scopes: [scope],
    quota: `quota-${id}`, sourceToken: fresh(), sourceHeader: fresh(), subjectToken: `${fresh()}.${fresh()}.${fresh()}`,
    stsTokens: [], iamTokens: [], subjectRequests: 0, stsRequests: 0, iamRequests: 0,
    started: deferred(), release: deferred(), gated: ['concurrent-exchange', 'isolated-exchange', 'cancel-exchange', 'deadline-exchange'].includes(scenario),
    format: scenario === 'cache-refresh' ? 'text' : 'json',
    delegates: ['projects/-/serviceAccounts/delegate@wga-fixture.iam.gserviceaccount.com'] };
  item.credentials = { type: 'external_account',
    audience: `//iam.googleapis.com/projects/123456789/locations/global/workloadIdentityPools/fixture/providers/${id}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt', token_url: `https://sts.googleapis.com/v1/token?fixture=${id}`,
    quota_project_id: item.quota, scopes: item.scopes,
    credential_source: { url: `https://oidc.fixture.invalid/token/${id}`, headers: { 'x-fixture-source': item.sourceHeader },
      format: item.format === 'text' ? { type: 'text' } : { type: 'json', subject_token_field_name: 'id_token' } },
    ...(kind === 'chained' ? {
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${item.email}:generateAccessToken`,
      service_account_impersonation: { token_lifetime_seconds: 900 },
    } : {}),
  };
  return item;
}
async function main() {
  const authVersions = [googleRequire('google-auth-library/package.json').version,
    googleRequire('@google-cloud/secret-manager/node_modules/google-auth-library/package.json').version];
  check(authVersions.join(',') === '10.9.1,11.1.0', 'PINNED_AUTH_VERSIONS');
  report.authVersions = authVersions;
  const preset = createGoogleWorkerBuild({ projectRoot: googleRoot, outdir: path.join(temporary, 'preset'), typescript: require('typescript') });
  await esbuild.build({ entryPoints: [path.join(googleRoot, 'federated-auth-worker.mjs')], bundle: true, format: 'cjs', platform: 'node', target: 'es2022', outfile: path.join(temporary, 'sdk.cjs'), plugins: [preset.plugin] });
  const main = path.join(temporary, 'worker.mjs');
  fs.writeFileSync(main, 'import bundle from "./sdk.cjs";export default bundle.default;\n');
  const config = path.join(temporary, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-local-federated-auth', main, compatibility_date: compatibilityDate, compatibility_flags: ['nodejs_compat'], send_metrics: false }));
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'), 'deploy', '--dry-run', '--config', config, '--outdir', path.join(temporary, 'bundle'), '--no-autoconfig'], { env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(temporary, 'bundle/worker.js'), 'utf8');
  const manifest = preset.manifest();
  Object.assign(report, { bundleSha256: digest(script), profile: manifest.profile, profileRevision: manifest.revision,
    profileSha256: manifest.profileSha256, registrySha256: manifest.registrySha256,
    evidence: Object.fromEntries(['scripts/test-workers-federated-auth.cjs', 'fixtures/google/federated-auth-worker.mjs', 'fixtures/google/package-lock.json', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))])) });
  const P = googleRequire('protobufjs');
  const schema = P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(googleRequire.resolve('@google-cloud/secret-manager/package.json')), 'build/protos/protos.json'), 'utf8')));
  const secretRequest = schema.lookupType('google.cloud.secretmanager.v1.GetSecretRequest');
  const secretResponse = schema.lookupType('google.cloud.secretmanager.v1.Secret');
  let current;
  const worker = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true, script, compatibilityDate, compatibilityFlags: ['nodejs_compat'], outboundService: async request => {
    const run = current;
    try {
      const url = new URL(request.url);
      if (url.hostname === 'control.fixture.invalid') {
        const [, action, id] = url.pathname.split('/');
        const item = run.identities.find(value => value.id === id);
        check(!!item, 'CONTROL_ID');
        if (action === 'started') await item.started.promise;
        else { check(action === 'release', 'CONTROL_ACTION'); item.release.resolve(); }
        return new Response('ready');
      }
      if (url.hostname === 'oidc.fixture.invalid') {
        const item = run.identities.find(value => url.pathname === `/token/${value.id}`);
        check(!!item && item.kind !== 'impersonated' && request.method === 'GET', 'SUBJECT_ENDPOINT');
        check(request.headers.get('x-fixture-source') === item.sourceHeader, 'SUBJECT_HEADER');
        check(!request.headers.has('authorization') && !request.headers.has('x-goog-user-project'), 'SUBJECT_METADATA_ISOLATION');
        item.subjectRequests++;
        return item.format === 'text' ? new Response(item.subjectToken) : Response.json({ id_token: item.subjectToken });
      }
      if (url.hostname === 'sts.googleapis.com') {
        const item = run.identities.find(value => value.id === url.searchParams.get('fixture'));
        check(!!item && item.kind !== 'impersonated' && request.method === 'POST' && url.pathname === '/v1/token', 'STS_ENDPOINT');
        check(request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'), 'STS_CONTENT_TYPE');
        check(!request.headers.has('authorization') && !request.headers.has('x-fixture-source'), 'STS_METADATA_ISOLATION');
        const form = new URLSearchParams(await request.text());
        check(form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:token-exchange', 'STS_GRANT');
        check(form.get('requested_token_type') === 'urn:ietf:params:oauth:token-type:access_token', 'STS_REQUESTED_TYPE');
        check(form.get('subject_token_type') === item.credentials.subject_token_type && form.get('subject_token') === item.subjectToken, 'STS_SUBJECT');
        check(form.get('audience') === item.credentials.audience && form.get('scope') === scope, 'STS_AUDIENCE_SCOPE');
        item.stsRequests++;
        item.started.resolve();
        if (item.gated) await item.release.promise;
        if ((run.scenario === 'denied-exchange' && item.kind === 'external' || run.scenario === 'denied-sts') && item.stsRequests === 1) {
          return Response.json({ error: 'invalid_grant', error_description: item.subjectToken }, { status: 400 });
        }
        const token = fresh();
        item.stsTokens.push(token);
        return Response.json({ access_token: token, expires_in: 3600, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer' });
      }
      if (url.hostname === 'iamcredentials.googleapis.com') {
        const item = run.identities.find(value => url.pathname === `/v1/projects/-/serviceAccounts/${value.email}:generateAccessToken`);
        check(!!item && item.kind !== 'external' && request.method === 'POST', 'IAM_ENDPOINT');
        const sourceToken = item.kind === 'impersonated' ? item.sourceToken : item.stsTokens.at(-1);
        check(request.headers.get('authorization') === `Bearer ${sourceToken}`, 'IAM_SOURCE_AUTHORIZATION');
        check(!request.headers.has('x-fixture-source'), 'IAM_METADATA_ISOLATION');
        const data = await request.json();
        check(JSON.stringify(data.scope) === JSON.stringify(item.scopes) && data.lifetime === '900s', 'IAM_SCOPE_LIFETIME');
        check(item.kind === 'impersonated' ? JSON.stringify(data.delegates) === JSON.stringify(item.delegates) : data.delegates === undefined, 'IAM_DELEGATES');
        item.iamRequests++;
        if (item.kind === 'impersonated') {
          item.started.resolve();
          if (item.gated) await item.release.promise;
        }
        if (run.scenario === 'denied-exchange' && item.iamRequests === 1) {
          return Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: item.sourceToken } }, { status: 403 });
        }
        const token = fresh();
        item.iamTokens.push(token);
        return Response.json({ accessToken: token, expireTime: new Date(Date.now() + 900000).toISOString() });
      }
      check(request.method === 'POST', 'RPC_METHOD');
      const sdk = url.pathname === '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret';
      check(sdk || url.pathname === '/fixture.FederatedAuth/Echo', 'RPC_PATH_OR_UNEXPECTED_NETWORK');
      check(url.hostname === (run.mode === 'grpc-web' ? 'gateway.fixture.invalid' : sdk ? 'secretmanager.googleapis.com' : 'logical.fixture.invalid'), 'RPC_TARGET');
      const mime = run.mode === 'grpc-web' ? 'application/grpc-web+proto' : 'application/grpc-web';
      check(request.headers.get('content-type') === mime && request.headers.get('accept') === mime, 'RPC_CONTENT_TYPE');
      const bytes = Buffer.from(await request.arrayBuffer());
      check(bytes[0] === 0 && bytes.readUInt32BE(1) === bytes.length - 5, 'RPC_FRAMING');
      const decoded = sdk ? secretRequest.decode(bytes.subarray(5)).name : bytes.subarray(5).toString();
      const id = sdk ? decoded.split('/').pop() : decoded;
      const item = run.identities.find(value => value.id === id);
      check(!!item, 'RPC_ID_OR_LATE_FETCH');
      const token = item.kind === 'external' ? item.stsTokens.at(-1) : item.iamTokens.at(-1);
      check(!!token && request.headers.get('authorization') === `Bearer ${token}`, 'RPC_AUTHORIZATION');
      check(request.headers.get('x-goog-user-project') === item.quota && !request.headers.has('x-fixture-source'), 'RPC_METADATA_ISOLATION');
      run.rpcOwners.push(item.id);
      const reply = sdk ? secretResponse.encode(secretResponse.fromObject({ name: decoded })).finish() : Buffer.from('accepted');
      return new Response(Buffer.concat([encodeFrame(reply), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': mime } });
    } catch (error) {
      run.boundaryFailure = error.code === 'ERR_ASSERTION' ? error.message : 'BOUNDARY_VALIDATION';
      return new Response('Fixture boundary rejected request', { status: 500 });
    }
  } }));
  try {
    for (const authVersion of authVersions) for (const mode of ['grpc-web', 'cloudflare']) for (const kind of ['external', 'chained', 'impersonated']) {
      const cases = scenarios.filter(scenario => kind !== 'impersonated' || scenario !== 'concurrent-exchange');
      if (kind === 'chained') cases.push('denied-sts');
      if (authVersion === '11.1.0' && kind !== 'impersonated') cases.push('sdk-credentials');
      for (const scenario of cases) {
        const identities = Array.from({ length: scenario === 'isolated-exchange' ? 2 : 1 }, (_, index) => identity(`${authVersion}-${mode}-${kind}-${scenario}-${index}`, kind, scenario));
        current = { mode, kind, scenario, identities, rpcOwners: [] };
        const input = { mode, kind, scenario, authVersion, identities: identities.map(({ id, credentials, sourceToken, email, delegates, scopes, quota }) => ({ id, credentials, sourceToken, email, delegates, scopes, quota })) };
        const response = await worker.dispatchFetch('https://fixture.test/federated-auth', { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
        const data = await response.json();
        report.runtimeExecuted = true;
        const run = { id: `${authVersion}/${mode}/${kind}/${scenario}`, mode, kind, scenario, authVersion, status: 'running',
          subjectRequests: identities.reduce((sum, item) => sum + item.subjectRequests, 0),
          stsRequests: identities.reduce((sum, item) => sum + item.stsRequests, 0),
          iamRequests: identities.reduce((sum, item) => sum + item.iamRequests, 0), rpcCount: current.rpcOwners.length };
        report.runs.push(run);
        check(!current.boundaryFailure, current.boundaryFailure || 'BOUNDARY');
        check(response.status === 200 && data.status === 'passed', `${scenario}: ${data.stage || ''}/${data.diagnostic || 'RESPONSE'}`);
        const expectedRPCs = { 'cache-refresh': 3, 'concurrent-exchange': 6, 'isolated-exchange': 4, 'sdk-credentials': 3 }[scenario] ?? 1;
        const expectedExchanges = ['cache-refresh', 'isolated-exchange', 'denied-exchange', 'denied-sts', 'sdk-credentials'].includes(scenario) ? 2 : 1;
        check(run.rpcCount === expectedRPCs, 'RPC_COUNT');
        check(run.subjectRequests === (kind === 'impersonated' ? 0 : expectedExchanges), 'SUBJECT_COUNT');
        check(run.stsRequests === (kind === 'impersonated' ? 0 : expectedExchanges), 'STS_COUNT');
        check(run.iamRequests === (kind === 'external' ? 0 : scenario === 'denied-sts' ? 1 : expectedExchanges), 'IAM_COUNT');
        if (scenario === 'isolated-exchange') check(current.rpcOwners[0] === identities[1].id, 'REVERSE_EXCHANGE_ISOLATION');
        Object.assign(run, { status: 'passed', authorizationMatched: true, quotaMetadataMatched: true, subjectHeaderIsolated: true,
          ...(scenario === 'sdk-credentials' ? { sdkCreatesAuthFromCredentials: true } : {}),
          ...(['cancel-exchange', 'deadline-exchange'].includes(scenario) ? { noLateRPC: true, recoveryPassed: true } : {}),
          ...(scenario.startsWith('denied-') ? { sanitizedDenial: true, recoveryPassed: true } : {}) });
      }
    }
    report.status = 'passed';
    for (const field of ['rpcCount', 'subjectRequests', 'stsRequests', 'iamRequests']) report[field] = report.runs.reduce((sum, run) => sum + run[field], 0);
  } finally {
    for (const item of current?.identities || []) { item.started.resolve(); item.release.resolve(); }
    await worker.dispose();
  }
}
main().catch(error => {
  report.status = 'failed';
  report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERS_FEDERATED_AUTH_FAILED';
  console.error(JSON.stringify({ status: 'failed', diagnostic: report.diagnostic, errorClass: error.constructor?.name || 'Error' }));
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-federated-auth.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  fs.rmSync(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ status: report.status, scenarios: report.runs.length, rpcCount: report.rpcCount, report: 'verification/workers-federated-auth.json' }));
});
