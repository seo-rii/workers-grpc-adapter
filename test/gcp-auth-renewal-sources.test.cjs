'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, verify } = require('node:crypto');
const { createRequire } = require('node:module');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const googleRequire = createRequire(path.join(__dirname, '../fixtures/google/package.json'));
let OAuth2Client, IdentityPoolClient, JWT, Impersonated;
let originalNetwork, blockedNetworkCalls = 0;
function rejectNetwork() {
  blockedNetworkCalls++;
  throw Object.assign(new Error('UNEXPECTED_EXTERNAL_NETWORK'), { code: 'UNEXPECTED_EXTERNAL_NETWORK' });
}
before(() => {
  originalNetwork = { fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get };
  globalThis.fetch = rejectNetwork;
  http.request = rejectNetwork;
  http.get = rejectNetwork;
  https.request = rejectNetwork;
  https.get = rejectNetwork;
  ({ OAuth2Client, IdentityPoolClient, JWT, Impersonated } = googleRequire('google-auth-library'));
});
after(() => {
  globalThis.fetch = originalNetwork.fetch;
  http.request = originalNetwork.httpRequest;
  http.get = originalNetwork.httpGet;
  https.request = originalNetwork.httpsRequest;
  https.get = originalNetwork.httpsGet;
  assert.equal(blockedNetworkCalls, 0, 'The synthetic source-renewal tests must make no network call');
});
const scope = 'https://www.googleapis.com/auth/cloud-platform';
const targetPrincipal = '123456789012345678901';
const iamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${targetPrincipal}:generateAccessToken`;

// These are auth-library compatibility checks with synthetic peers. Expiry is
// forced locally to keep CI short; the separate deployed probe proves natural
// expiry only for its access-token-only source and denied data RPCs.
async function checkSourceRenewal(source, expireSource, expectedSourceTokens) {
  const sourceHeadersAtMint = [];
  let mints = 0;
  source.request = async options => {
    assert.equal(options.url, iamUrl);
    assert.equal(options.method, 'POST');
    assert.deepEqual(options.data, { delegates: [], scope: [scope], lifetime: '60s' });
    assert.ok(mints < 2, 'No third target mint');
    const headers = await source.getRequestHeaders(options.url);
    sourceHeadersAtMint.push(headers.get('authorization'));
    mints++;
    return { status: 200, data: { accessToken: `synthetic-target-${mints}`,
      expireTime: new Date(Date.now() + 60000).toISOString() } };
  };
  const target = new Impersonated({ sourceClient: source, targetPrincipal,
    targetScopes: [scope], delegates: [], lifetime: 60, eagerRefreshThresholdMillis: 1000 });
  const authorize = async () => (await target.getRequestHeaders('https://secretmanager.googleapis.com')).get('authorization');
  assert.equal(target.sourceClient, source);
  assert.equal(await authorize(), 'Bearer synthetic-target-1');
  assert.equal(await authorize(), 'Bearer synthetic-target-1');
  assert.equal(mints, 1);
  expireSource();
  target.credentials.expiry_date = 1;
  assert.equal(await authorize(), 'Bearer synthetic-target-2');
  assert.equal(await authorize(), 'Bearer synthetic-target-2');
  assert.equal(mints, 2);
  assert.deepEqual(sourceHeadersAtMint, expectedSourceTokens.map(token => `Bearer ${token}`));
  return { target, authorize, getMintCount: () => mints };
}

test('refresh-token source renews before the same impersonated client mints again', async () => {
  const source = new OAuth2Client({ clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
    eagerRefreshThresholdMillis: 1000 });
  source.setCredentials({ refresh_token: 'synthetic-refresh' });
  let exchanges = 0, denyRefresh = false;
  source.transporter.request = async options => {
    assert.equal(options.url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.data.get('grant_type'), 'refresh_token');
    assert.equal(options.data.get('refresh_token'), 'synthetic-refresh');
    assert.equal(options.data.get('client_id'), 'synthetic-client');
    assert.equal(options.data.get('client_secret'), 'synthetic-secret');
    if (denyRefresh) throw new Error('synthetic-refresh-rejected');
    exchanges++;
    return { status: 200, data: { access_token: `synthetic-source-${exchanges}`,
      expires_in: 60, token_type: 'Bearer' } };
  };
  const chain = await checkSourceRenewal(source, () => { source.credentials.expiry_date = 1; },
    ['synthetic-source-1', 'synthetic-source-2']);
  assert.equal(exchanges, 2);
  denyRefresh = true;
  source.credentials.expiry_date = 1;
  chain.target.credentials.expiry_date = 1;
  await assert.rejects(chain.authorize(), /synthetic-refresh-rejected/);
  assert.equal(chain.getMintCount(), 2, 'A failed source refresh cannot mint or reuse a stale target token');
});

test('external-account subject exchange renews before target impersonation', async () => {
  let subjects = 0, exchanges = 0, denyExchange = false;
  const audience = '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/synthetic/providers/synthetic';
  const source = new IdentityPoolClient({ type: 'external_account', audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    subject_token_supplier: { async getSubjectToken() { return `synthetic-subject-${++subjects}`; } } });
  source.eagerRefreshThresholdMillis = 1000;
  source.stsCredential.transporter.request = async options => {
    assert.equal(options.url, 'https://sts.googleapis.com/v1/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.data.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(options.data.get('audience'), audience);
    assert.equal(options.data.get('subject_token'), `synthetic-subject-${subjects}`);
    assert.equal(options.data.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:jwt');
    if (denyExchange) throw new Error('synthetic-sts-rejected');
    exchanges++;
    return { status: 200, data: { access_token: `synthetic-federated-${exchanges}`,
      issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      token_type: 'Bearer', expires_in: 60 } };
  };
  const chain = await checkSourceRenewal(source, () => { source.cachedAccessToken.expiry_date = 1; },
    ['synthetic-federated-1', 'synthetic-federated-2']);
  assert.equal(subjects, 2);
  assert.equal(exchanges, 2);
  denyExchange = true;
  source.cachedAccessToken.expiry_date = 1;
  chain.target.credentials.expiry_date = 1;
  await assert.rejects(chain.authorize(), /synthetic-sts-rejected/);
  assert.equal(chain.getMintCount(), 2, 'A failed STS exchange cannot mint or reuse a stale target token');
});

test('service-account JWT assertions are signed and exchanged again before target renewal', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const source = new JWT({ email: 'synthetic@example.invalid', key: privateKey,
    scopes: [scope], eagerRefreshThresholdMillis: 1000 });
  let exchanges = 0, denyExchange = false;
  source.transporter.request = async options => {
    assert.equal(options.url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.method, 'POST');
    assert.equal(options.data.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const parts = options.data.get('assertion').split('.');
    assert.equal(parts.length, 3);
    assert.equal(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey,
      Buffer.from(parts[2], 'base64url')), true);
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    assert.equal(claims.iss, 'synthetic@example.invalid');
    assert.equal(claims.scope, scope);
    assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
    if (denyExchange) throw new Error('synthetic-jwt-exchange-rejected');
    exchanges++;
    return { status: 200, data: { access_token: `synthetic-jwt-source-${exchanges}`,
      token_type: 'Bearer', expires_in: 60 } };
  };
  const chain = await checkSourceRenewal(source, () => { source.credentials.expiry_date = 1; },
    ['synthetic-jwt-source-1', 'synthetic-jwt-source-2']);
  assert.equal(exchanges, 2);
  denyExchange = true;
  source.credentials.expiry_date = 1;
  chain.target.credentials.expiry_date = 1;
  await assert.rejects(chain.authorize(), /synthetic-jwt-exchange-rejected/);
  assert.equal(chain.getMintCount(), 2, 'A failed JWT exchange cannot mint or reuse a stale target token');
});
