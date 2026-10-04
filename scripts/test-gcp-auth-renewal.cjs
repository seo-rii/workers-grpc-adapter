'use strict';
// Execute the exact deployable probe bundle. Only the IAM/data-plane peer is
// controlled; the SDK, auth constructors, real clock, and renewal code are real.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { validateCredentialRenewal } = require('./gcp-auth-renewal.cjs');
const root = path.resolve(__dirname, '..');
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const protobuf = googleRequire('protobufjs');
const schema = protobuf.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(
  path.dirname(googleRequire.resolve('@google-cloud/secret-manager/package.json')), 'build/protos/protos.json'), 'utf8')));
const SecretRequest = schema.lookupType('google.cloud.secretmanager.v1.GetSecretRequest');
const scope = 'https://www.googleapis.com/auth/cloud-platform';
const gateway = 'https://wga-renewal.run.app';
const fresh = () => 'synthetic-local-only-' + randomBytes(24).toString('hex');

function frame(body) {
  const prefix = Buffer.alloc(5); prefix[0] = 128; prefix.writeUInt32BE(body.length, 1);
  return Buffer.concat([prefix, body]);
}
function redacted(value, markers) {
  const text = JSON.stringify(value);
  for (const marker of markers) assert.ok(!text.includes(marker), 'Credential/identity must not appear in the receipt');
}
function setup(script, mode, fault, overrides = {}) {
  const markers = [];
  const secret = () => { const value = fresh(); markers.push(value); return value; };
  const key = secret(), source = secret(), idToken = secret();
  const project = '123456789012', uid = '123456789012345678901';
  const secretName = `projects/${project}/secrets/wga-probe-renewal-local`;
  markers.push(project, uid, secretName);
  const bindings = { WGA_TEST_KEY: key, WGA_PROBE_MODE: mode, WGA_RUN_GOOGLE_TESTS: '1',
    WGA_AUTH_RENEWAL_ENABLED: '1', WGA_GCP_PROJECT_NUMBER: project,
    WGA_GOOGLE_ACCESS_TOKEN: source, WGA_GATEWAY_ID_TOKEN: idToken,
    WGA_OWNED_SERVICE_ACCOUNT_UID: uid, WGA_SECRET_NAME: secretName,
    WGA_ENDPOINTS_JSON: JSON.stringify({ 'secretmanager.googleapis.com:443': gateway }),
    ...overrides };
  const state = { iam: [], rpc: [], unexpected: 0 };
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script,
    compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
    bindings, log: new Log(LogLevel.NONE),
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.origin === 'https://iamcredentials.googleapis.com') {
        assert.ok(request.url === `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${uid}:generateAccessToken`, 'Fixed owned IAM target');
        assert.equal(request.method, 'POST');
        assert.ok(request.headers.get('authorization') === `Bearer ${source}`, 'IAM receives only source bearer');
        assert.equal(request.headers.get('x-serverless-authorization'), null, 'Gateway credential must not reach IAM');
        assert.deepEqual(await request.json(), { delegates: [], scope: [scope], lifetime: '60s' });
        const startedAtMs = Date.now();
        assert.ok(state.iam.length < 2, 'Bounded IAM mint count');
        if (state.iam.length === 1) {
          assert.ok(startedAtMs >= state.iam[0].expireTimeMs + 250, 'Second mint follows natural expiration and margin');
          assert.equal(state.rpc.length, 2, 'Cached calls precede renewal');
        }
        const token = fault === 'reused-token' && state.iam.length === 1 ? state.iam[0].token : secret();
        const expireTimeMs = Date.now() + (fault === 'long-expiry' ? 3600000 : 60000);
        state.iam.push({ token, startedAtMs, expireTimeMs });
        if (fault === 'iam-denied' || fault === 'second-iam-denied' && state.iam.length === 2) return Response.json({ error: { code: 403,
          status: 'PERMISSION_DENIED', message: source } }, { status: 403 });
        return Response.json({ accessToken: token, expireTime: new Date(expireTimeMs).toISOString() });
      }
      const expectedOrigin = mode === 'cloudflare' ? 'https://secretmanager.googleapis.com' : gateway;
      if (url.origin !== expectedOrigin || url.pathname !== '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret') {
        state.unexpected++;
        throw new Error('Unexpected outbound destination; external network is forbidden');
      }
      assert.equal(request.method, 'POST');
      const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
      assert.equal(request.headers.get('content-type'), mime);
      assert.equal(request.headers.get('accept'), mime);
      assert.ok(request.headers.get('x-serverless-authorization') === (mode === 'grpc-web' ? `Bearer ${idToken}` : null), 'Gateway credential mode isolation');
      const generation = state.iam.length, expectedGeneration = [1, 1, 2, 2][state.rpc.length];
      assert.equal(generation, expectedGeneration, 'RPC uses cached/refreshed generation in order');
      const current = state.iam[generation - 1];
      assert.ok(current && request.headers.get('authorization') === `Bearer ${current.token}` &&
        request.headers.get('authorization') !== `Bearer ${source}`, 'RPC receives the current minted bearer');
      const body = Buffer.from(await request.arrayBuffer());
      assert.equal(body[0], 0);
      assert.equal(body.readUInt32BE(1), body.length - 5);
      assert.ok(SecretRequest.decode(body.subarray(5)).name === secretName, 'Fixed owned secret request');
      state.rpc.push({ generation, atMs: Date.now() });
      const grpcStatus = fault === 'wrong-status' ? 16 : 7;
      // Deliberately put a private marker in the peer error. The fixture must
      // retain only status assertions and never export this remote detail.
      return new Response(frame(Buffer.from(`grpc-status: ${grpcStatus}\r\ngrpc-message: ${encodeURIComponent(source)}\r\n`)),
        { headers: { 'content-type': mime } });
    },
  }));
  return { runtime, state, markers, headers: { authorization: `Bearer ${key}` },
    async request(options = {}) {
      const { route = `/gcp/${mode}/auth-renewal`, ...init } = options;
      return runtime.dispatchFetch(`https://probe.test${route}`, { method: 'POST', headers: { authorization: `Bearer ${key}` },
        // Neither this untrusted body nor the route can redirect credentials.
        body: JSON.stringify({ targetPrincipal: 'unapproved', secretName: 'unapproved', lifetime: 3600 }), ...init });
    } };
}

async function guards(script, mode) {
  let checked = 0;
  const base = setup(script, mode);
  try {
    for (const options of [
      { method: 'GET', body: undefined }, { headers: {} },
      { headers: { authorization: `Bearer ${fresh()}` } },
      { route: `/gcp/${mode === 'grpc-web' ? 'cloudflare' : 'grpc-web'}/auth-renewal` },
      { route: `/gcp/${mode}/auth-renewal/extra` },
    ]) {
      const response = await base.request(options);
      assert.equal(response.status, 404); assert.equal(await response.text(), 'Not found');
      checked++;
    }
    assert.equal(base.state.iam.length + base.state.rpc.length, 0, 'Route authorization precedes any network');
  } finally { await base.runtime.dispose(); }
  for (const [overrides, expected] of [
    [{ WGA_AUTH_RENEWAL_ENABLED: '0' }, 403],
    [{ WGA_RUN_GOOGLE_TESTS: '0' }, 403],
    [{ WGA_OWNED_SERVICE_ACCOUNT_UID: 'unapproved@example.invalid' }, 500],
    [{ WGA_SECRET_NAME: 'projects/123456789012/secrets/existing-secret' }, 500],
  ]) {
    const test = setup(script, mode, null, overrides);
    try {
      const response = await test.request();
      assert.equal(response.status, expected);
      const text = await response.text(); redacted(text, test.markers);
      assert.equal(test.state.iam.length + test.state.rpc.length, 0, 'Binding guards precede any network');
      checked++;
    } finally { await test.runtime.dispose(); }
  }
  return checked;
}

async function negative(script, mode, fault) {
  const test = setup(script, mode, fault);
  try {
    const response = await test.request();
    assert.equal(response.status, 500, `${mode}/${fault}`);
    const receipt = await response.json();
    assert.notEqual(receipt.status, 'passed');
    assert.equal(validateCredentialRenewal(receipt, { mode }).valid, false);
    redacted(receipt, test.markers);
    const renewedFailure = ['second-iam-denied', 'reused-token'].includes(fault);
    assert.equal(test.state.iam.length, renewedFailure ? 2 : 1, 'Failed mint or RPC must not retry');
    assert.equal(test.state.rpc.length, renewedFailure ? 2 : fault === 'wrong-status' ? 1 : 0);
    if (renewedFailure) {
      assert.deepEqual(test.state.rpc.map(value => value.generation), [1, 1]);
      assert.ok(test.state.iam[1].startedAtMs >= test.state.iam[0].expireTimeMs + 250,
        'Failure must occur on natural renewal after cached calls');
    }
    assert.equal(test.state.unexpected, 0);
    return { mode, fault, iamOperations: test.state.iam.length, rpcRequests: test.state.rpc.length };
  } finally { await test.runtime.dispose(); }
}

async function positive(script, mode) {
  const test = setup(script, mode);
  try {
    const response = await test.request();
    assert.equal(response.status, 200, `${mode}/natural-expiry`);
    const receipt = await response.json();
    const validation = validateCredentialRenewal(receipt, { mode });
    assert.deepEqual(validation.errors, []); assert.equal(validation.valid, true);
    redacted(receipt, test.markers);
    assert.equal(test.state.iam.length, 2);
    assert.equal(test.state.rpc.length, 4);
    assert.equal(test.state.unexpected, 0);
    assert.deepEqual(test.state.rpc.map(value => value.generation), [1, 1, 2, 2]);
    assert.ok(test.state.iam[0].token !== test.state.iam[1].token, 'Peer issued two different tokens');
    assert.deepEqual(receipt.mints.map(value => value.expireTimeMs), test.state.iam.map(value => value.expireTimeMs));
    assert.ok(receipt.wait.completedAtMs >= test.state.iam[0].expireTimeMs + 250);
    assert.ok(receipt.elapsedMs >= 60000 && receipt.elapsedMs < 120000);
    return { mode, iamOperations: 2, rpcRequests: 4, generations: [1, 1, 2, 2],
      naturalExpiryWaitMs: receipt.wait.elapsedMs, elapsedMs: receipt.elapsedMs,
      exactReceiptValidated: true, sourceAndGatewayCredentialsIsolated: true };
  } finally { await test.runtime.dispose(); }
}

async function together(tasks) {
  const results = await Promise.allSettled(tasks);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

async function runLocalCredentialRenewal({ script }) {
  assert.equal(typeof script, 'string'); assert.ok(script.length > 0);
  const modes = ['grpc-web', 'cloudflare'];
  const guarded = await together(modes.map(mode => guards(script, mode)));
  const rejected = await together(modes.map(async mode => {
    const rows = [];
    for (const fault of ['iam-denied', 'long-expiry', 'wrong-status']) rows.push(await negative(script, mode, fault));
    return rows;
  }));
  // All natural-expiry waits overlap; no global time or credential mutation is used.
  const longRunning = await together([
    ...modes.map(mode => positive(script, mode)),
    ...modes.flatMap(mode => ['second-iam-denied', 'reused-token'].map(fault => negative(script, mode, fault))),
  ]);
  const passed = longRunning.slice(0, modes.length);
  const rejectedRenewals = longRunning.slice(modes.length);
  return { status: 'passed', runtime: 'workerd', modes: 2,
    exactDeployableBundle: true, realGoogleAuth: true, realGoogleSDK: true,
    liveGoogle: false, realClock: true, credentialMutationToForceExpiry: false,
    tokenEndpointBoundary: 'Miniflare outbound Fetch', externalNetworkRequests: 0,
    guards: guarded.reduce((sum, value) => sum + value, 0),
    passedScenarios: passed, rejectedScenarios: [...rejected.flat(), ...rejectedRenewals],
    requestDisconnectAbortVerified: false };
}

module.exports = { runLocalCredentialRenewal };
