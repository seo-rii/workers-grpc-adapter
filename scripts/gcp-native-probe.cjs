'use strict';
// Native controls for the temporary GCP probe. Callers supply short-lived tokens;
// this module never discovers credentials or creates/deletes cloud resources.
const fs = require('node:fs/promises');
const http2 = require('node:http2');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const NATIVE_ROOT = path.join(ROOT, 'fixtures/native');
const nativeRequire = createRequire(path.join(NATIVE_ROOT, 'package.json'));
const MAX_BYTES = 1024 * 1024;
const NATIVE_TIMEOUT_MS = 30000;
const WEB_TIMEOUT_MS = 20000;
const PREFIX = '/grpcbin.GRPCBin/';
const ECHO = field1('wga deployed probe % / 한글');
const ERROR_REASON = 'wga probe % / 한글';
const suites = [
    ['datastore-crud', 'datastore.mjs', 'datastoreCrud'],
    ['datastore-transaction', 'datastore.mjs', 'datastoreTransaction'],
    ['firestore-crud', 'firestore.mjs', 'firestoreCrud'],
    ['firestore-transaction', 'firestore.mjs', 'firestoreTransaction'],
    ['secret-manager-read', 'secret-manager.mjs', 'secretManagerRead'],
];
// Keep these diagnostic limits aligned with fixtures/google/gcp-probe.mjs.
// Importing that Worker entry would load the adapter into the native baseline.
const configurations = {
    'google.datastore.v1.Datastore': ['Lookup', 'RunQuery', 'RunAggregationQuery', 'BeginTransaction', 'Commit', 'Rollback'],
    'google.firestore.v1.Firestore': ['GetDocument', 'BatchGetDocuments', 'RunQuery', 'BeginTransaction', 'Commit', 'Rollback'],
    'google.cloud.secretmanager.v1.SecretManagerService': ['GetSecret', 'AccessSecretVersion', 'ListSecrets'],
};
const probeClientConfig = { interfaces: Object.fromEntries(Object.entries(configurations).map(([service, methods]) => [service, {
    retry_codes: { probe_no_retry: [] },
    methods: Object.fromEntries(methods.map(method => [method, { timeout_millis: 10000, retry_codes_name: 'probe_no_retry' }])),
}])) };

function requireBinding(condition) {
    if (!condition) throw Object.assign(new Error('Invalid probe binding'), { code: 'INVALID_PROBE_BINDING' });
}
function safeError(error) {
    // Never include messages, stacks, metadata, tokens or remote payloads.
    const atom = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;
    return {
        name: atom(error?.name),
        code: Number.isInteger(error?.code) ? error.code : atom(error?.code),
        ...(Array.isArray(error?.errors) ? { causes: error.errors.slice(0, 3).map(item => ({
            code: Number.isInteger(item?.code) ? item.code : atom(item?.code),
        })) } : {}),
    };
}
function validateSuiteBindings(env) {
    requireBinding(env && typeof env === 'object');
    const project = env.WGA_GCP_PROJECT;
    const projectNumber = env.WGA_GCP_PROJECT_NUMBER;
    requireBinding(typeof project === 'string' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project));
    requireBinding(typeof projectNumber === 'string' && /^[1-9][0-9]{5,19}$/.test(projectNumber));
    requireBinding(env.WGA_RUN_GOOGLE_TESTS === '1' && env.WGA_ALLOW_TEST_WRITES === '1');
    requireBinding(typeof env.WGA_GOOGLE_ACCESS_TOKEN === 'string' && env.WGA_GOOGLE_ACCESS_TOKEN.length > 20);
    for (const key of ['WGA_FIRESTORE_DATABASE', 'WGA_DATASTORE_DATABASE']) {
        requireBinding(typeof env[key] === 'string' && /^wga-probe-[a-z0-9-]{4,52}$/.test(env[key]));
    }
    requireBinding(typeof env.WGA_SECRET_NAME === 'string' &&
        env.WGA_SECRET_NAME.startsWith(`projects/${projectNumber}/secrets/wga-probe-`) &&
        /^projects\/[^/]+\/secrets\/wga-probe-[a-z0-9-]{4,52}$/.test(env.WGA_SECRET_NAME));
    // Do not allow ambient emulator or universal endpoint settings to turn this
    // purported cloud baseline into a different target.
    for (const key of ['DATASTORE_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST', 'GOOGLE_API_USE_MTLS_ENDPOINT']) {
        requireBinding(!process.env[key] || (key === 'GOOGLE_API_USE_MTLS_ENDPOINT' && process.env[key] === 'never'));
    }
}

async function runNativeSuites(env, { catalog = false, transactions = false } = {}) {
    validateSuiteBindings(env);
    requireBinding(!transactions || env.WGA_TRANSACTIONS_ENABLED === '1');
    requireBinding(!(catalog && transactions));
    const startedAt = new Date().toISOString();
    const { OAuth2Client } = nativeRequire('google-auth-library');
    const authClient = new OAuth2Client();
    authClient.setCredentials({ access_token: env.WGA_GOOGLE_ACCESS_TOKEN });
    const directory = await fs.mkdtemp(path.join(NATIVE_ROOT, '.gcp-probe-'));
    const results = [];
    try {
        // Identical source modules resolve the native fixture's pinned SDK graph
        // because these copies live beneath fixtures/native, not fixtures/google.
        for (const file of ['assert.mjs', 'datastore.mjs', 'firestore.mjs', 'secret-manager.mjs',
            ...(catalog ? ['cloud-catalog.mjs'] : []), ...(transactions ? ['cloud-transactions.mjs'] : [])]) {
            await fs.copyFile(path.join(ROOT, 'fixtures/google/shared', file), path.join(directory, file));
        }
        const selected = transactions ? [
            ['datastore-conflict', 'cloud-transactions.mjs', 'cloudDatastoreConflict'],
            ['firestore-conflict', 'cloud-transactions.mjs', 'cloudFirestoreConflict'],
            ['datastore-commit-response-lost', 'cloud-transactions.mjs', 'cloudDatastoreCommitResponseLost'],
            ['firestore-commit-response-lost', 'cloud-transactions.mjs', 'cloudFirestoreCommitResponseLost'],
        ] : catalog ? [
            ['datastore-typed', 'cloud-catalog.mjs', 'cloudDatastoreTyped'],
            ['datastore-aggregation', 'cloud-catalog.mjs', 'cloudDatastoreAggregation'],
            ['datastore-rollback', 'cloud-catalog.mjs', 'cloudDatastoreRollback'],
            ['datastore-errors', 'cloud-catalog.mjs', 'cloudDatastoreErrors'],
            ['secret-manager-catalog', 'cloud-catalog.mjs', 'cloudSecretManager'],
            ['permission-denied', 'cloud-catalog.mjs', 'cloudPermissionDenied'],
        ] : suites;
        for (const [suite, file, exported] of selected) {
            const started = Date.now();
            try {
                // Database resource paths require the project ID; Secret Manager
                // returns its canonical resource name with the project number.
                const projectId = suite.startsWith('secret-manager-') || suite === 'permission-denied' ? env.WGA_GCP_PROJECT_NUMBER : env.WGA_GCP_PROJECT;
                if (suite === 'permission-denied' && !env.WGA_RESTRICTED_ACCESS_TOKEN) {
                    results.push({ suite, status: 'blocked', reason: 'restricted-principal-token-unavailable' });
                    continue;
                }
                const selectedAuth = suite === 'permission-denied' ? new OAuth2Client() : authClient;
                if (suite === 'permission-denied') selectedAuth.setCredentials({ access_token: env.WGA_RESTRICTED_ACCESS_TOKEN });
                const options = {
                    projectId, authClient: selectedAuth, clientConfig: probeClientConfig,
                    preferRest: false, fallback: false,
                    'grpc.max_receive_message_length': MAX_BYTES,
                    'grpc.max_send_message_length': MAX_BYTES,
                    'grpc.enable_retries': 0,
                };
                if (suite.startsWith('firestore')) options.databaseId = env.WGA_FIRESTORE_DATABASE;
                if (suite.startsWith('datastore')) options.databaseId = env.WGA_DATASTORE_DATABASE;
                const run = (await import(pathToFileURL(path.join(directory, file)).href))[exported];
                const checks = await run({ options, allowedProjectId: projectId, runId: randomUUID(),
                    allowWrites: true, nativeCommitResponseLoss: transactions, secretName: env.WGA_SECRET_NAME,
                    secretVersion: env.WGA_SECRET_VERSION, secretPayload: env.WGA_SECRET_PAYLOAD,
                    secretNames: JSON.parse(env.WGA_SECRET_NAMES || '[]'), resourceLabel: env.WGA_RESOURCE_LABEL });
                requireBinding(Array.isArray(checks) && checks.every(check => typeof check === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(check)));
                results.push({ suite, status: 'passed', checks, elapsedMs: Date.now() - started });
            } catch (error) {
                results.push({ suite, status: 'failed', error: safeError(error), elapsedMs: Date.now() - started });
            }
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
    return {
        status: results.every(result => result.status === 'passed') ? 'passed' : 'failed',
        startedAt, completedAt: new Date().toISOString(),
        nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version,
        scope: transactions ? 'Live optimistic conflicts and controlled accepted-Commit response loss; native SDK completion boundary'
            : catalog ? 'Live catalog shared fixtures using native grpc-js and short-lived OAuth credentials'
            : 'The five unchanged Google fixtures using native grpc-js and explicit short-lived OAuth credentials',
        suites: results,
    };
}

async function runNativeCredentialRenewal(env, { signal } = {}) {
    validateSuiteBindings(env);
    requireBinding(env.WGA_AUTH_RENEWAL_ENABLED === '1');
    requireBinding(typeof env.WGA_OWNED_SERVICE_ACCOUNT_UID === 'string' &&
        /^[1-9][0-9]{9,29}$/.test(env.WGA_OWNED_SERVICE_ACCOUNT_UID) && !/\s/.test(env.WGA_OWNED_SERVICE_ACCOUNT_UID));
    requireBinding(env.WGA_GOOGLE_ACCESS_TOKEN.length <= 8192 && !/\s/.test(env.WGA_GOOGLE_ACCESS_TOKEN));
    requireBinding(signal === undefined || signal instanceof AbortSignal);
    const directory = await fs.mkdtemp(path.join(NATIVE_ROOT, '.gcp-renewal-'));
    try {
        const filename = path.join(directory, 'credential-renewal.mjs');
        await fs.copyFile(path.join(ROOT, 'fixtures/google/shared/credential-renewal.mjs'), filename);
        const { runCredentialRenewal } = await import(pathToFileURL(filename).href);
        return await runCredentialRenewal({
            mode: 'native', projectNumber: env.WGA_GCP_PROJECT_NUMBER,
            secretName: env.WGA_SECRET_NAME, sourceToken: env.WGA_GOOGLE_ACCESS_TOKEN,
            targetPrincipal: env.WGA_OWNED_SERVICE_ACCOUNT_UID, signal,
            optionsForAuth(auth, observeAuthorization) {
                // This observes the actual auth-client result, not native HTTP/2
                // wire metadata. The shared receipt names that narrower boundary.
                const getRequestHeaders = auth.getRequestHeaders.bind(auth);
                auth.getRequestHeaders = async (...args) => {
                    const headers = await getRequestHeaders(...args);
                    observeAuthorization(headers.get('authorization'));
                    return headers;
                };
                return {
                    projectId: env.WGA_GCP_PROJECT_NUMBER, authClient: auth, clientConfig: probeClientConfig,
                    preferRest: false, fallback: false,
                    'grpc.max_receive_message_length': MAX_BYTES,
                    'grpc.max_send_message_length': MAX_BYTES,
                    'grpc.enable_retries': 0,
                };
            },
        });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

function varint(value) {
    const bytes = [];
    do {
        const byte = value % 128;
        value = Math.floor(value / 128);
        bytes.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(bytes);
}
function field1(value) {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([10]), varint(bytes.length), bytes]);
}
function frame(bytes) {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}
function grpcStatus(value) {
    return typeof value === 'string' && /^(?:[0-9]|1[0-6])$/.test(value) ? Number(value) : null;
}
function inspectFrames(body) {
    const result = { bodyBytes: body.length, messageFrames: 0, trailerFrames: 0,
        grpcWebStatuses: [], framingError: null, echoMatches: true };
    let offset = 0, trailerSeen = false;
    while (offset < body.length) {
        if (body.length - offset < 5) { result.framingError = 'truncated-prefix'; break; }
        const flag = body[offset], length = body.readUInt32BE(offset + 1);
        offset += 5;
        if (flag !== 0 && flag !== 128) { result.framingError = 'unsupported-flag'; break; }
        if (length > MAX_BYTES) { result.framingError = 'frame-too-large'; break; }
        if (length > body.length - offset) { result.framingError = 'truncated-payload'; break; }
        if (trailerSeen) { result.framingError = 'frame-after-trailers'; break; }
        const payload = body.subarray(offset, offset + length);
        offset += length;
        if (flag === 0) {
            result.messageFrames++;
            result.echoMatches &&= payload.equals(ECHO);
        } else {
            trailerSeen = true;
            result.trailerFrames++;
            for (const line of payload.toString('utf8').split('\r\n')) {
                const match = /^grpc-status:\s*(.*?)\s*$/i.exec(line);
                if (match) result.grpcWebStatuses.push(grpcStatus(match[1]));
            }
        }
    }
    return result;
}
function nativeEcho(grpc, origin, idToken, method, request, expected) {
    return new Promise(resolve => {
        const started = Date.now();
        const client = new grpc.Client(`${new URL(origin).hostname}:443`, grpc.credentials.createSsl(), {
            'grpc.max_receive_message_length': MAX_BYTES,
            'grpc.max_send_message_length': MAX_BYTES,
            'grpc.enable_retries': 0,
        });
        const metadata = new grpc.Metadata();
        metadata.set('x-serverless-authorization', `Bearer ${idToken}`);
        const result = { protocol: 'native-grpc', method: PREFIX + method, status: 'failed',
            responseMessages: 0, responseBytes: 0, allEchoesMatch: true, grpcStatus: null,
            reasonMatches: expected.code === 3 ? false : null };
        let call, settled = false;
        const finish = extra => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (extra?.timeout || extra?.limitExceeded) call?.cancel();
            client.close();
            Object.assign(result, extra, { durationMs: Date.now() - started });
            result.status = result.grpcStatus === expected.code && result.responseMessages === expected.messages &&
                (expected.code !== 0 || result.allEchoesMatch) && (expected.code !== 3 || result.reasonMatches) &&
                !result.timeout && !result.limitExceeded ? 'passed' : 'failed';
            resolve(result);
        };
        const timer = setTimeout(() => finish({ timeout: true }), NATIVE_TIMEOUT_MS);
        const receive = bytes => {
            result.responseMessages++;
            result.responseBytes += bytes.length;
            result.allEchoesMatch &&= bytes.equals(ECHO);
            if (result.responseBytes > MAX_BYTES || result.responseMessages > 10) finish({ limitExceeded: true });
        };
        const options = { deadline: Date.now() + NATIVE_TIMEOUT_MS };
        try {
            if (expected.messages === 10) {
                call = client.makeServerStreamRequest(PREFIX + method, value => value, value => value, request, metadata, options);
                call.on('data', receive);
                call.on('error', error => { if (!settled) result.error = safeError(error); });
                call.on('status', status => finish({ grpcStatus: status.code }));
            } else {
                call = client.makeUnaryRequest(PREFIX + method, value => value, value => value, request, metadata, options, (error, bytes) => {
                    if (bytes) receive(bytes);
                    finish({ grpcStatus: error ? error.code : 0,
                        reasonMatches: expected.code === 3 ? error?.details === ERROR_REASON : null,
                        ...(error ? { error: safeError(error) } : {}) });
                });
            }
        } catch (error) { finish({ error: safeError(error) }); }
    });
}
function directHttp2Web(origin, idToken) {
    return new Promise(resolve => {
        const started = Date.now(), chunks = [];
        let session, call, headers, trailers, bytes = 0, settled = false;
        const finish = extra => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            call?.destroy();
            session?.destroy();
            const type = headers?.['content-type'];
            const summary = {
                protocol: 'grpc-web-over-http2', method: PREFIX + 'DummyUnary', responseReceived: Boolean(headers),
                httpStatus: Number.isInteger(headers?.[':status']) ? headers[':status'] : null,
                contentType: typeof type === 'string' ? type.slice(0, 160).replace(/[^\x20-\x7e]/g, '?') : null,
                headerGrpcStatus: grpcStatus(headers?.['grpc-status']),
                httpTrailerGrpcStatus: grpcStatus(trailers?.['grpc-status']),
                ...inspectFrames(Buffer.concat(chunks)), ...extra, durationMs: Date.now() - started,
            };
            summary.validGrpcWebSuccess = summary.httpStatus === 200 &&
                /^application\/grpc-web(?:\+proto)?(?:\s*;|$)/i.test(summary.contentType || '') &&
                summary.framingError === null && summary.messageFrames === 1 && summary.echoMatches &&
                summary.trailerFrames === 1 && summary.grpcWebStatuses.length === 1 &&
                summary.grpcWebStatuses[0] === 0 && extra?.completed === true;
            resolve(summary);
        };
        const timer = setTimeout(() => finish({ timeout: true }), WEB_TIMEOUT_MS);
        try {
            session = http2.connect(origin);
            session.on('error', error => finish({ error: safeError(error) }));
            call = session.request({ ':method': 'POST', ':path': PREFIX + 'DummyUnary',
                'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1',
                'x-serverless-authorization': `Bearer ${idToken}`, 'grpc-timeout': '20S', te: 'trailers' });
            call.on('response', value => { headers = value; });
            call.on('trailers', value => { trailers = value; });
            call.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_BYTES) { finish({ limitExceeded: true }); return; }
                chunks.push(chunk);
            });
            call.on('end', () => finish({ completed: true }));
            call.on('error', error => finish({ error: safeError(error) }));
            call.on('close', () => { if (!settled) finish({ closedBeforeEnd: true }); });
            call.end(frame(ECHO));
        } catch (error) { finish({ error: safeError(error) }); }
    });
}
async function runEchoControls({ origin, idToken } = {}) {
    requireBinding(typeof origin === 'string');
    let target;
    try { target = new URL(origin); } catch { requireBinding(false); }
    requireBinding(target.protocol === 'https:' && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.run\.app$/.test(target.hostname) &&
        !target.port && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash);
    requireBinding(typeof idToken === 'string' && idToken.length > 20 && !/[\r\n]/.test(idToken));
    const grpc = nativeRequire('@grpc/grpc-js');
    const reason = Buffer.from(ERROR_REASON, 'utf8');
    const errorRequest = Buffer.concat([Buffer.from([8, 3, 18]), varint(reason.length), reason]);
    const startedAt = new Date().toISOString();
    const probes = await Promise.all([
        nativeEcho(grpc, target.origin, idToken, 'DummyUnary', ECHO, { code: 0, messages: 1 }),
        nativeEcho(grpc, target.origin, idToken, 'DummyServerStream', ECHO, { code: 0, messages: 10 }),
        nativeEcho(grpc, target.origin, idToken, 'SpecificError', errorRequest, { code: 3, messages: 0 }),
        directHttp2Web(target.origin, idToken),
    ]);
    return {
        status: 'completed', startedAt, completedAt: new Date().toISOString(),
        nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version,
        scope: 'Private Cloud Run native echo and direct HTTP/2 gRPC-Web controls',
        target: target.origin, limits: { maxResponseBytes: MAX_BYTES, nativeDeadlineMs: NATIVE_TIMEOUT_MS, webTimeoutMs: WEB_TIMEOUT_MS },
        nativeGrpcPassed: probes.slice(0, 3).every(probe => probe.status === 'passed'), probes,
    };
}

module.exports = { runNativeSuites, runNativeCredentialRenewal, runEchoControls };
