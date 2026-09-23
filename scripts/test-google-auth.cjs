'use strict';
// Actual google-auth-library and Gaxios, controlled I/O only. Tokens never enter reports/logs.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, generateKeyPairSync, verify } = require('node:crypto');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sdkRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const { OAuth2Client, JWT } = sdkRequire('google-auth-library');
const authRequire = createRequire(sdkRequire.resolve('google-auth-library'));
const { Gaxios, GaxiosError } = authRequire('gaxios');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');
const oauthUrl = 'https://oauth.fixture.invalid/token';
const gatewayUrl = 'https://gateway.fixture.invalid';
const rpcPath = '/fixture.Auth/Echo';
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const freshToken = () => randomBytes(24).toString('hex');
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function provider({ expired = true, denied = false, gated = false, quotaProjectId } = {}) {
    const accessToken = freshToken(), refreshedToken = freshToken(), refreshToken = freshToken();
    const started = deferred(), gate = deferred();
    const state = { requests: 0, requestShapeValid: true };
    const transporter = new Gaxios({
        adapter: async options => {
            state.requests++;
            const form = new URLSearchParams(options.data);
            state.requestShapeValid &&= options.url.toString() === oauthUrl && options.method === 'POST' && form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === refreshToken;
            started.resolve();
            if (gated) await gate.promise;
            const data = denied ? { error: 'invalid_grant', error_description: 'controlled rejection' } : { access_token: refreshedToken, expires_in: 3600, token_type: 'Bearer' };
            const response = new Response(JSON.stringify(data), { status: denied ? 400 : 200, headers: { 'content-type': 'application/json' } });
            response.config = options;
            response.data = data;
            return response;
        },
    });
    const auth = new OAuth2Client({ clientId: 'fixture-client', clientSecret: freshToken(), quotaProjectId, transporter, endpoints: { oauth2TokenUrl: oauthUrl } });
    auth.setCredentials({ access_token: accessToken, refresh_token: refreshToken, expiry_date: Date.now() + (expired ? -1000 : 3600000) });
    return { auth, state, expectedToken: expired ? refreshedToken : accessToken, started: started.promise, release: gate.resolve, refreshToken };
}
function clientFor(auth) {
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'logical.fixture.invalid': gatewayUrl } });
    const credentials = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), grpc.credentials.createFromGoogleCredential(auth));
    return new grpc.Client('logical.fixture.invalid', credentials, transport.grpcOptions());
}
function invoke(client, owner) {
    const trace = [];
    let callbackCount = 0, call;
    const settled = new Promise(resolve => {
        call = client.makeUnaryRequest(rpcPath, value => Buffer.from(value), bytes => bytes.toString(), owner, { deadline: Date.now() + 5000 }, (error, value) => {
            callbackCount++;
            trace.push('callback');
            resolve({ error, value });
        });
    });
    call.on('metadata', () => trace.push('metadata'));
    call.on('status', status => trace.push(`status:${status.code}`));
    return { call, settled, trace, callbacks: () => callbackCount };
}
function fakeGateway(expected) {
    const state = { fetches: 0, authorizationMatches: true, quotaMatches: true, wireMatches: true };
    return {
        state,
        fetch: async (url, options) => {
            state.fetches++;
            const headers = new Headers(options.headers);
            const body = Buffer.from(options.body);
            const owner = body.subarray(5).toString();
            const entry = expected.get(owner);
            state.authorizationMatches &&= !!entry && headers.get('authorization') === `Bearer ${entry.token}`;
            state.quotaMatches &&= !entry?.quota || headers.get('x-goog-user-project') === entry.quota;
            state.wireMatches &&= url === gatewayUrl + rpcPath && options.method === 'POST' && headers.get('content-type') === 'application/grpc-web+proto' && body[0] === 0 && body.readUInt32BE(1) === body.length - 5;
            const bytes = Buffer.concat([encodeFrame(Buffer.from('accepted')), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]);
            return new Response(bytes, { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
        },
    };
}
async function withGateway(expected, run) {
    const gateway = fakeGateway(expected);
    const saved = globalThis.fetch;
    globalThis.fetch = gateway.fetch;
    try {
        const details = await run(gateway.state);
        assert.equal(gateway.state.authorizationMatches, true);
        assert.equal(gateway.state.quotaMatches, true);
        assert.equal(gateway.state.wireMatches, true);
        return { ...details, rpcFetches: gateway.state.fetches, authorizationMatched: true };
    } finally { globalThis.fetch = saved; }
}
async function successful(invocation) {
    const result = await invocation.settled;
    await nextTurn();
    assert.equal(result.error, null);
    assert.equal(result.value, 'accepted');
    assert.equal(invocation.callbacks(), 1);
    assert.equal(invocation.trace.filter(event => event === 'status:0').length, 1);
    return invocation.trace;
}
const cases = [
    ['service-account-jwt-exchange-and-cache', async () => {
        // Generate an ephemeral service-account key; only booleans/counters reach the report.
        const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        const email = 'service-account@wga-auth-fixture.invalid';
        const scope = 'https://www.googleapis.com/auth/cloud-platform';
        const tokenUrl = 'https://oauth2.googleapis.com/token';
        const accessToken = freshToken();
        let tokenRequests = 0;
        const transporter = new Gaxios({
            adapter: async options => {
                tokenRequests++;
                assert.equal(options.url.toString(), tokenUrl);
                assert.equal(options.method, 'POST');
                const form = new URLSearchParams(options.data);
                assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
                const parts = form.get('assertion').split('.');
                assert.equal(parts.length, 3);
                const [encodedHeader, encodedPayload, signature] = parts;
                const header = JSON.parse(Buffer.from(encodedHeader, 'base64url'));
                const claims = JSON.parse(Buffer.from(encodedPayload, 'base64url'));
                assert.equal(header.alg, 'RS256');
                assert.equal(verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), publicKey, Buffer.from(signature, 'base64url')), true);
                assert.equal(claims.iss, email);
                assert.equal(claims.scope, scope);
                assert.equal(claims.aud, tokenUrl);
                assert.ok(Math.abs(claims.iat - Math.floor(Date.now() / 1000)) < 60);
                assert.equal(claims.exp - claims.iat, 3600);
                const data = { access_token: accessToken, expires_in: 3600, token_type: 'Bearer' };
                const response = new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
                response.config = options;
                response.data = data;
                return response;
            },
        });
        const auth = new JWT({ email, key: privateKey.export({ type: 'pkcs8', format: 'pem' }), scopes: [scope], transporter, quotaProjectId: 'wga-auth-fixture' });
        const client = clientFor(auth);
        try {
            return await withGateway(new Map([['service-account', { token: accessToken, quota: 'wga-auth-fixture' }]]), async state => {
                await successful(invoke(client, 'service-account'));
                await successful(invoke(client, 'service-account'));
                assert.equal(tokenRequests, 1);
                assert.ok(auth.credentials.expiry_date > Date.now());
                assert.equal(state.fetches, 2);
                return { tokenRequests, signedAssertionVerified: true, grantClaimsMatched: true, cachedAccessTokenReused: true, quotaMetadataMatched: true };
            });
        } finally { client.close(); }
    }],
    ['valid-token-and-quota-metadata', async () => {
        const identity = provider({ expired: false, quotaProjectId: 'wga-auth-fixture' });
        const client = clientFor(identity.auth);
        try {
            return await withGateway(new Map([['valid', { token: identity.expectedToken, quota: 'wga-auth-fixture' }]]), async state => {
                const trace = await successful(invoke(client, 'valid'));
                assert.equal(identity.state.requests, 0);
                assert.equal(state.fetches, 1);
                return { tokenRequests: 0, eventTrace: trace, quotaMetadataMatched: true };
            });
        } finally { client.close(); }
    }],
    ['expired-token-refresh-and-reuse', async () => {
        const identity = provider();
        const client = clientFor(identity.auth);
        try {
            return await withGateway(new Map([['refreshed', { token: identity.expectedToken }]]), async state => {
                await successful(invoke(client, 'refreshed'));
                await successful(invoke(client, 'refreshed'));
                assert.equal(identity.state.requests, 1);
                assert.equal(identity.state.requestShapeValid, true);
                assert.ok(identity.auth.credentials.expiry_date > Date.now());
                assert.equal(identity.auth.credentials.refresh_token, identity.refreshToken);
                assert.equal(state.fetches, 2);
                return { tokenRequests: 1, requestShapeMatched: true, refreshedCredentialReused: true };
            });
        } finally { client.close(); }
    }],
    ['refresh-denied-before-rpc', async () => {
        const identity = provider({ denied: true });
        const client = clientFor(identity.auth);
        try {
            return await withGateway(new Map(), async state => {
                // Verify actual Google/Gaxios rejection before checking the adapter's sanitized status.
                const calls = grpc.credentials.createFromGoogleCredential(identity.auth);
                await assert.rejects(calls.generateMetadata({ service_url: 'https://logical.fixture.invalid/fixture.Auth', method_name: rpcPath }), error => error instanceof GaxiosError && error.status === 400);
                const invocation = invoke(client, 'denied');
                const { error } = await invocation.settled;
                await nextTurn();
                assert.equal(error.code, grpc.status.INTERNAL);
                assert.equal(error.details, 'WGA_AUTH_METADATA');
                assert.equal(invocation.callbacks(), 1);
                assert.deepEqual(invocation.trace, ['callback', 'status:13']);
                assert.equal(state.fetches, 0);
                assert.equal(identity.state.requests, 2);
                return { tokenRequests: 2, upstreamHttpStatus: 400, grpcCode: 13, diagnostic: 'WGA_AUTH_METADATA', eventTrace: invocation.trace };
            });
        } finally { client.close(); }
    }],
    ['concurrent-calls-share-one-refresh', async () => {
        const identity = provider({ gated: true });
        const client = clientFor(identity.auth);
        try {
            return await withGateway(new Map([['concurrent', { token: identity.expectedToken }]]), async state => {
                const invocations = Array.from({ length: 12 }, () => invoke(client, 'concurrent'));
                await identity.started;
                await nextTurn();
                assert.equal(identity.state.requests, 1);
                assert.equal(state.fetches, 0);
                identity.release();
                await Promise.all(invocations.map(successful));
                assert.equal(identity.state.requests, 1);
                assert.equal(state.fetches, 12);
                return { concurrentCalls: 12, tokenRequests: 1, refreshCoalescedByGoogleAuth: true, callbacksOnce: true };
            });
        } finally { identity.release(); client.close(); }
    }],
    ['separate-credentials-remain-isolated', async () => {
        const left = provider({ gated: true }), right = provider({ gated: true });
        const a = clientFor(left.auth), b = clientFor(right.auth);
        try {
            return await withGateway(new Map([['left', { token: left.expectedToken }], ['right', { token: right.expectedToken }]]), async state => {
                const first = invoke(a, 'left'), second = invoke(b, 'right');
                await Promise.all([left.started, right.started]);
                right.release();
                await successful(second);
                assert.equal(state.fetches, 1);
                left.release();
                await successful(first);
                await Promise.all([successful(invoke(a, 'left')), successful(invoke(b, 'right'))]);
                assert.equal(state.fetches, 4);
                assert.equal(left.state.requests, 1);
                assert.equal(right.state.requests, 1);
                assert.notEqual(left.auth.credentials.access_token, right.auth.credentials.access_token);
                return { credentials: 2, tokenRequests: 2, reverseRefreshCompletion: true, subsequentCallsIsolated: true };
            });
        } finally { left.release(); right.release(); a.close(); b.close(); }
    }],
    ['cancel-during-refresh-prevents-late-fetch', async () => {
        const identity = provider({ gated: true });
        const client = clientFor(identity.auth);
        try {
            return await withGateway(new Map([['after-cancel', { token: identity.expectedToken }]]), async state => {
                const cancelled = invoke(client, 'cancelled');
                await identity.started;
                cancelled.call.cancel();
                const { error } = await cancelled.settled;
                assert.equal(error.code, grpc.status.CANCELLED);
                identity.release();
                // Await the same in-flight refresh through the public auth API before checking for late I/O.
                await identity.auth.getRequestHeaders('https://logical.fixture.invalid/fixture.Auth');
                await nextTurn();
                assert.equal(state.fetches, 0);
                assert.equal(cancelled.callbacks(), 1);
                assert.deepEqual(cancelled.trace, ['callback', 'status:1']);
                await successful(invoke(client, 'after-cancel'));
                assert.equal(state.fetches, 1);
                assert.equal(identity.state.requests, 1);
                return { tokenRequests: 1, cancelledCode: 1, cancelledFetches: 0, subsequentCallPassed: true, eventTrace: cancelled.trace };
            });
        } finally { identity.release(); client.close(); }
    }],
];
async function main() {
    const results = [];
    for (const [id, run] of cases) {
        try { results.push({ id, status: 'passed', ...await run() }); }
        catch (error) { results.push({ id, status: 'failed', errorClass: error.constructor?.name || 'Error', code: typeof error.code === 'number' || error.code === 'ERR_ASSERTION' ? error.code : null }); }
    }
    // Package manifests may be hidden by exports; walk upward from their resolved runtime entry.
    function version(req, name) {
        let directory = path.dirname(req.resolve(name));
        while (directory !== path.dirname(directory)) {
            const manifest = path.join(directory, 'package.json');
            if (fs.existsSync(manifest)) {
                const value = JSON.parse(fs.readFileSync(manifest));
                if (value.name === name) return value.version;
            }
            directory = path.dirname(directory);
        }
        throw new Error('Package version unavailable');
    }
    const report = { scope: 'real OAuth2Client, service-account JWT and Gaxios credentials over injected token endpoint and gRPC-Web fetch transports', liveCloud: false, realNetwork: false, runtime: process.version, versions: { googleAuthLibrary: version(sdkRequire, 'google-auth-library'), gaxios: version(authRequire, 'gaxios') }, credentialsPersisted: false, status: results.every(item => item.status === 'passed') ? 'passed' : 'failed', results };
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/google-auth.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ status: 'failed', errorClass: error.constructor?.name || 'Error' })); process.exitCode = 1; });
