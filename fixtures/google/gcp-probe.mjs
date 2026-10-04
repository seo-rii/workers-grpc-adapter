// Temporary live probe: targets come only from deployment bindings, never requests.
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { suites } from './suites.mjs';
import { datastoreCrud, datastoreTransaction } from './shared/datastore.mjs';
import { firestoreCrud, firestoreTransaction } from './shared/firestore.mjs';
import { secretManagerRead } from './shared/secret-manager.mjs';
import { cloudDatastoreTyped, cloudDatastoreAggregation, cloudDatastoreRollback,
  cloudDatastoreErrors, cloudSecretManager, cloudPermissionDenied } from './shared/cloud-catalog.mjs';

// Load pinned SDK modules during Worker startup. Datastore loads its built-in
// Struct schema at import time; lazy SDK import inside a request requires eval.
const runners = {
  'datastore-crud': datastoreCrud, 'datastore-transaction': datastoreTransaction,
  'firestore-crud': firestoreCrud, 'firestore-transaction': firestoreTransaction,
  'secret-manager-read': secretManagerRead,
  'datastore-typed': cloudDatastoreTyped, 'datastore-aggregation': cloudDatastoreAggregation,
  'datastore-rollback': cloudDatastoreRollback, 'datastore-errors': cloudDatastoreErrors,
  'secret-manager-catalog': cloudSecretManager, 'permission-denied': cloudPermissionDenied,
};
const writes = name => suites[name]?.writes ?? name.startsWith('datastore-');

const authorities = ['datastore.googleapis.com:443', 'firestore.googleapis.com:443', 'secretmanager.googleapis.com:443'];
const configurations = {
  'google.datastore.v1.Datastore': ['Lookup', 'RunQuery', 'RunAggregationQuery', 'BeginTransaction', 'Commit', 'Rollback'],
  'google.firestore.v1.Firestore': ['BatchGetDocuments', 'RunQuery', 'BeginTransaction', 'Commit', 'Rollback'],
  'google.cloud.secretmanager.v1.SecretManagerService': ['GetSecret', 'AccessSecretVersion', 'ListSecrets'],
};
// Disable GAPIC retries during diagnostics so a missing conversion cannot consume
// the SDK's ten-minute retry budget. The shared suites retain their normal logic.
export const probeClientConfig = { interfaces: Object.fromEntries(Object.entries(configurations).map(([service, methods]) => [service, {
  retry_codes: { probe_no_retry: [] },
  methods: Object.fromEntries(methods.map(method => [method, { timeout_millis: 10000, retry_codes_name: 'probe_no_retry' }])),
}])) };

function requireBinding(condition) {
  if (!condition) throw Object.assign(new Error('Invalid probe binding'), { code: 'INVALID_PROBE_BINDING' });
}

function contextFor(env, suiteName, mode) {
  requireBinding(typeof env.WGA_GCP_PROJECT === 'string' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(env.WGA_GCP_PROJECT));
  const secretSuite = suiteName.startsWith('secret-manager-') || suiteName === 'permission-denied';
  if (secretSuite) requireBinding(typeof env.WGA_GCP_PROJECT_NUMBER === 'string' && /^[1-9][0-9]{5,19}$/.test(env.WGA_GCP_PROJECT_NUMBER));
  // Database RPCs need the project ID. Secret Manager returns its canonical
  // numeric project name, which the unchanged shared suite compares exactly.
  const projectId = secretSuite ? env.WGA_GCP_PROJECT_NUMBER : env.WGA_GCP_PROJECT;
  requireBinding(typeof env.WGA_GOOGLE_ACCESS_TOKEN === 'string' && env.WGA_GOOGLE_ACCESS_TOKEN.length > 20);
  const endpointConfig = mode === 'cloudflare' ? { mode } : { mode, endpoints: JSON.parse(env.WGA_ENDPOINTS_JSON || '{}') };
  if (mode === 'grpc-web') {
    requireBinding(endpointConfig.endpoints && !Array.isArray(endpointConfig.endpoints));
    requireBinding(Object.keys(endpointConfig.endpoints).every(authority => authorities.includes(authority)));
  }
  const transport = createWorkersGrpcTransport({ ...endpointConfig, defaultTimeoutMs: 10000,
    transportMaxSendBytes: 1024 * 1024, transportMaxReceiveBytes: 1024 * 1024 });
  // An access token without refresh credentials prevents accidental ADC or
  // refresh-token discovery. Root orchestration mints and removes this secret.
  const authClient = new OAuth2Client();
  const token = suiteName === 'permission-denied' ? env.WGA_RESTRICTED_ACCESS_TOKEN : env.WGA_GOOGLE_ACCESS_TOKEN;
  requireBinding(typeof token === 'string' && token.length > 20);
  authClient.setCredentials({ access_token: token });
  if (mode === 'grpc-web') {
    requireBinding(typeof env.WGA_GATEWAY_ID_TOKEN === 'string' && env.WGA_GATEWAY_ID_TOKEN.length > 20);
    const googleHeaders = authClient.getRequestHeaders.bind(authClient);
    authClient.getRequestHeaders = async url => {
      const headers = await googleHeaders(url);
      headers.set('x-serverless-authorization', `Bearer ${env.WGA_GATEWAY_ID_TOKEN}`);
      return headers;
    };
  }
  const options = transport.gaxOptions({ projectId, authClient, clientConfig: probeClientConfig, preferRest: false });
  if (suiteName.startsWith('firestore') || suiteName.startsWith('datastore')) {
    const databaseId = suiteName.startsWith('firestore') ? env.WGA_FIRESTORE_DATABASE : env.WGA_DATASTORE_DATABASE;
    // The default database and arbitrary existing database names are prohibited.
    requireBinding(typeof databaseId === 'string' && /^wga-probe-[a-z0-9-]{4,52}$/.test(databaseId));
    options.databaseId = databaseId;
  }
  if (secretSuite) {
    requireBinding(typeof env.WGA_SECRET_NAME === 'string' &&
      env.WGA_SECRET_NAME.startsWith(`projects/${projectId}/secrets/wga-probe-`) &&
      /^projects\/[^/]+\/secrets\/wga-probe-[a-z0-9-]{4,52}$/.test(env.WGA_SECRET_NAME));
  }
  return { options, allowedProjectId: projectId, runId: crypto.randomUUID(),
    allowWrites: env.WGA_ALLOW_TEST_WRITES === '1', secretName: env.WGA_SECRET_NAME,
    secretVersion: env.WGA_SECRET_VERSION, secretPayload: env.WGA_SECRET_PAYLOAD,
    secretNames: JSON.parse(env.WGA_SECRET_NAMES || '[]'), resourceLabel: env.WGA_RESOURCE_LABEL };
}

export async function runGcpSuite(env, suite, mode) {
  requireBinding(Object.hasOwn(runners, suite) && (mode === 'cloudflare' || mode === 'grpc-web'));
  requireBinding(env.WGA_PROBE_MODE === mode);
  requireBinding(env.WGA_RUN_GOOGLE_TESTS === '1' && (!writes(suite) || env.WGA_ALLOW_TEST_WRITES === '1'));
  const context = contextFor(env, suite, mode);
  return runners[suite](context);
}

function publicError(error) {
  return {
    code: Number.isInteger(error?.code) ? error.code : error?.code === 'INVALID_PROBE_BINDING' ? error.code : 'PROBE_ERROR',
    ...(Array.isArray(error?.errors) ? { causes: error.errors.slice(0, 3).map(item => ({
      code: Number.isInteger(item?.code) ? item.code : 'PROBE_ERROR',
    })) } : {}),
  };
}

export default {
  async fetch(request, env) {
    const expected = env.WGA_TEST_KEY;
    const actual = request.headers.get('authorization') ?? '';
    const wanted = `Bearer ${expected}`;
    if (typeof expected !== 'string' || expected.length < 32 || request.method !== 'POST' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(wanted) || !timingSafeEqual(Buffer.from(actual), Buffer.from(wanted))) {
      return new Response('Not found', { status: 404 });
    }
    const route = /^\/gcp\/(cloudflare|grpc-web)\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!route || route[1] !== env.WGA_PROBE_MODE) return new Response('Not found', { status: 404 });
    // This confirms deployment availability only. It neither validates Google
    // bindings nor enables or executes any test-suite network requests.
    if (route[2] === 'ready') return Response.json({ status: 'ready', mode: route[1] });
    if (!Object.hasOwn(runners, route[2])) return new Response('Not found', { status: 404 });
    if (env.WGA_RUN_GOOGLE_TESTS !== '1' || (writes(route[2]) && env.WGA_ALLOW_TEST_WRITES !== '1')) {
      return new Response('Disabled', { status: 403 });
    }
    const [, mode, suite] = route;
    const started = Date.now();
    try {
      const checks = await runGcpSuite(env, suite, mode);
      return Response.json({ suite, mode, status: 'passed', checks, elapsedMs: Date.now() - started });
    } catch (error) {
      return Response.json({ suite, mode, status: 'failed', ...publicError(error), elapsedMs: Date.now() - started }, { status: 500 });
    }
  },
};
