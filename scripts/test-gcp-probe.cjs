'use strict';
// Exact deployable SDK bundle, with outbound calls intercepted before the network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { buildGoogleWorker } = require('./build-google-worker.cjs');
const root = path.resolve(__dirname, '..');
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const protobuf = googleRequire('protobufjs');
const schemas = Object.fromEntries(['datastore', 'firestore', 'secret-manager'].map(sdk => [sdk,
  protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(path.resolve(path.dirname(googleRequire.resolve(`@google-cloud/${sdk}`)),
    `../protos/${sdk === 'firestore' ? 'v1' : 'protos'}.json`), 'utf8'))),
]));
const key = 'local-gcp-probe-auth-key-at-least-32-characters';
const accessToken = 'local-google-access-token-never-valid';
const idToken = 'local-cloud-run-identity-token-never-valid';
const origin = 'https://gateway.invalid';
const project = 'demo-wga-probe-local';
const projectNumber = '123456789012';
const endpoints = Object.fromEntries(['datastore', 'firestore', 'secretmanager'].map(service => [`${service}.googleapis.com:443`, origin]));
const bindings = {
  WGA_TEST_KEY: key,
  WGA_PROBE_MODE: 'cloudflare',
  WGA_RUN_GOOGLE_TESTS: '1',
  WGA_ALLOW_TEST_WRITES: '1',
  WGA_GCP_PROJECT: project,
  WGA_GCP_PROJECT_NUMBER: projectNumber,
  WGA_GOOGLE_ACCESS_TOKEN: accessToken,
  WGA_GATEWAY_ID_TOKEN: idToken,
  WGA_FIRESTORE_DATABASE: 'wga-probe-firestore-local',
  WGA_DATASTORE_DATABASE: 'wga-probe-datastore-local',
  WGA_SECRET_NAME: `projects/${projectNumber}/secrets/wga-probe-secret-local`,
  WGA_ENDPOINTS_JSON: JSON.stringify(endpoints),
};
const suites = ['datastore-crud', 'datastore-transaction', 'firestore-crud', 'firestore-transaction', 'secret-manager-read'];
const headers = { authorization: `Bearer ${key}` };
const temporaryBase = path.join(root, '.wga-build');
fs.mkdirSync(temporaryBase, { recursive: true });
const temporary = fs.mkdtempSync(path.join(temporaryBase, 'gcp-probe-local-'));

async function main() {
  const bundle = await buildGoogleWorker({ entry: path.join(root, 'fixtures/google/gcp-probe.mjs'), outdir: temporary });
  const config = path.join(temporary, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({ name: 'wga-gcp-probe-local-only', main: bundle.main,
    compatibility_date: '2026-09-21', compatibility_flags: ['nodejs_compat'], workers_dev: false }));
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const name of Object.keys(environment)) if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(name)) delete environment[name];
  const output = path.join(temporary, 'dry-run');
  execFileSync(process.execPath, [path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
    'deploy', '--dry-run', '--config', config, '--outdir', output, '--no-autoconfig'],
  { cwd: root, env: environment, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  const script = fs.readFileSync(path.join(output, 'worker.js'), 'utf8');
  const requests = [];
  const runtime = overrides => new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.NONE), modules: true, script,
    compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
    bindings: { ...bindings, ...overrides },
    outboundService: async request => {
      requests.push({ url: request.url, headers: Object.fromEntries(request.headers), body: Buffer.from(await request.arrayBuffer()) });
      const trailer = Buffer.from('grpc-status: 7\r\ngrpc-message: diagnostic-denied\r\n');
      const frame = Buffer.alloc(5 + trailer.length);
      frame[0] = 128; frame.writeUInt32BE(trailer.length, 1); trailer.copy(frame, 5);
      return new Response(frame, { headers: { 'content-type': overrides?.WGA_PROBE_MODE === 'grpc-web'
        ? 'application/grpc-web+proto' : 'application/grpc-web' } });
    },
  }));
  let guardedRequests = 0;
  for (const test of [
    { options: { method: 'GET', headers }, status: 404 },
    { options: { method: 'POST' }, status: 404 },
    { options: { method: 'POST', headers: { authorization: `Bearer ${key}x` } }, status: 404 },
    { env: { WGA_TEST_KEY: 'short' }, status: 404 },
    { env: { WGA_RUN_GOOGLE_TESTS: '0' }, status: 403 },
    { env: { WGA_ALLOW_TEST_WRITES: '0' }, status: 403 },
    { route: '/gcp/cloudflare/constructor', status: 404 },
    { route: '/gcp/invalid/firestore-crud', status: 404 },
    { route: '/gcp/grpc-web/firestore-crud', status: 404 },
    { route: '/other/cloudflare/firestore-crud', status: 404 },
    { env: { WGA_FIRESTORE_DATABASE: '(default)' }, status: 500 },
    { env: { WGA_FIRESTORE_DATABASE: 'existing-database' }, status: 500 },
    { env: { WGA_GOOGLE_ACCESS_TOKEN: '' }, status: 500 },
    { env: { WGA_GCP_PROJECT: projectNumber }, status: 500 },
    { env: { WGA_GCP_PROJECT_NUMBER: '' }, route: '/gcp/cloudflare/secret-manager-read', status: 500 },
    { env: { WGA_GCP_PROJECT_NUMBER: project }, route: '/gcp/cloudflare/secret-manager-read', status: 500 },
    { env: { WGA_GCP_PROJECT_NUMBER: '000000' }, route: '/gcp/cloudflare/secret-manager-read', status: 500 },
    { env: { WGA_SECRET_NAME: `projects/${project}/secrets/wga-probe-secret-local` }, route: '/gcp/cloudflare/secret-manager-read', status: 500 },
    { env: { WGA_SECRET_NAME: `projects/${projectNumber}/secrets/existing-secret` }, route: '/gcp/cloudflare/secret-manager-read', status: 500 },
    { env: { WGA_PROBE_MODE: 'grpc-web', WGA_ENDPOINTS_JSON: '{"unapproved.example:443":"https://gateway.invalid"}' }, route: '/gcp/grpc-web/firestore-crud', status: 500 },
    { env: { WGA_PROBE_MODE: 'grpc-web', WGA_GATEWAY_ID_TOKEN: '' }, route: '/gcp/grpc-web/firestore-crud', status: 500 },
  ]) {
    const worker = runtime(test.env);
    try {
      const response = await worker.dispatchFetch(`https://probe.test${test.route ?? '/gcp/cloudflare/firestore-crud'}`,
        test.options ?? { method: 'POST', headers });
      assert.equal(response.status, test.status);
      await response.text();
      guardedRequests++;
    } finally { await worker.dispose(); }
  }
  assert.equal(requests.length, 0, 'Invalid or unapproved inputs must not make network calls');
  let readinessRequests = 0;
  for (const mode of ['cloudflare', 'grpc-web']) {
    // Readiness must work with suites disabled and no usable Google bindings.
    const worker = runtime({ WGA_PROBE_MODE: mode, WGA_RUN_GOOGLE_TESTS: '0', WGA_ALLOW_TEST_WRITES: '0',
      WGA_GOOGLE_ACCESS_TOKEN: '', WGA_GATEWAY_ID_TOKEN: '', WGA_GCP_PROJECT: '', WGA_GCP_PROJECT_NUMBER: '',
      WGA_ENDPOINTS_JSON: 'invalid-json', WGA_FIRESTORE_DATABASE: '(default)', WGA_DATASTORE_DATABASE: '(default)' });
    try {
      for (const test of [
        { status: 200 },
        { options: { method: 'GET', headers }, status: 404 },
        { options: { method: 'POST' }, status: 404 },
        { options: { method: 'POST', headers: { authorization: `Bearer ${'x'.repeat(key.length)}` } }, status: 404 },
        { route: `/gcp/${mode === 'cloudflare' ? 'grpc-web' : 'cloudflare'}/ready`, status: 404 },
        { route: '/gcp/invalid/ready', status: 404 },
        { route: `/gcp/${mode}/ready/extra`, status: 404 },
      ]) {
        const response = await worker.dispatchFetch(`https://probe.test${test.route ?? `/gcp/${mode}/ready`}`,
          test.options ?? { method: 'POST', headers });
        assert.equal(response.status, test.status);
        if (test.status === 200) {
          assert.equal(response.headers.get('content-type'), 'application/json');
          assert.deepEqual(await response.json(), { status: 'ready', mode });
        } else assert.equal(await response.text(), 'Not found');
        assert.equal(requests.length, 0, 'Readiness must not make network calls');
        readinessRequests++;
      }
    } finally { await worker.dispose(); }
  }
  let suitesChecked = 0;
  for (const mode of ['cloudflare', 'grpc-web']) {
    const worker = runtime({ WGA_PROBE_MODE: mode });
    try { for (const suite of suites) {
      const firstRequest = requests.length;
      const response = await worker.dispatchFetch(`https://probe.test/gcp/${mode}/${suite}`, { method: 'POST', headers });
      assert.equal(response.status, 500);
      const result = await response.json();
      assert.equal(result.status, 'failed');
      assert.equal(result.suite, suite);
      assert.equal(result.mode, mode);
      if (result.causes) assert.ok(result.causes.every(cause => cause.code === 7));
      else assert.equal(result.code, 7, `${mode}/${suite}, outbound requests: ${requests.length - firstRequest}`);
      const text = JSON.stringify(result);
      for (const secret of [key, accessToken, idToken, 'diagnostic-denied']) assert.ok(!text.includes(secret));
      const sent = requests.slice(firstRequest);
      assert.ok(sent.length >= 1);
      for (const request of sent) {
        const url = new URL(request.url);
        assert.equal(request.headers.authorization, `Bearer ${accessToken}`);
        const contentType = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
        assert.equal(request.headers['content-type'], contentType);
        assert.equal(request.headers.accept, contentType);
        assert.equal(request.headers['x-serverless-authorization'], mode === 'grpc-web' ? `Bearer ${idToken}` : undefined);
        const sdk = suite.split('-')[0];
        assert.equal(url.origin, mode === 'grpc-web' ? origin : `https://${sdk === 'secret' ? 'secretmanager' : sdk}.googleapis.com`);
        assert.equal(request.body[0], 0);
        assert.equal(request.body.readUInt32BE(1), request.body.length - 5);
        const service = sdk === 'secret' ? 'google.cloud.secretmanager.v1.GetSecretRequest' : `google.${sdk}.v1.CommitRequest`;
        const decoded = schemas[sdk === 'secret' ? 'secret-manager' : sdk].lookupType(service).decode(request.body.subarray(5));
        if (sdk === 'datastore') {
          assert.equal(decoded.projectId, project);
          assert.equal(decoded.databaseId, bindings.WGA_DATASTORE_DATABASE);
        } else if (sdk === 'firestore') assert.equal(decoded.database, `projects/${project}/databases/${bindings.WGA_FIRESTORE_DATABASE}`);
        else assert.equal(decoded.name, bindings.WGA_SECRET_NAME);
      }
      suitesChecked++;
    } } finally { await worker.dispose(); }
  }
  console.log(JSON.stringify({ status: 'passed', guardedRequests, readinessRequests, suitesChecked, outboundRequests: requests.length,
    networkRequests: 0, googleAuthorizationChecked: true, gatewayTokenModeIsolationChecked: true,
    namedDatabaseTargetsChecked: true, projectIdAndNumberSeparated: true, modeContentTypesChecked: true,
    readinessWithoutGoogleCredentialsChecked: true, errorsRedacted: true }));
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
