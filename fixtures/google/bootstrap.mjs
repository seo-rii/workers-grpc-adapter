import { configureWorkersGrpc } from '@grpc/grpc-js/config';
import { check } from './shared/assert.mjs';
import { suites } from './suites.mjs';
export function configureTransport(env, runtime) {
    const mode = env.WGA_TRANSPORT_MODE || (runtime === 'worker' ? 'cloudflare' : 'grpc-web');
    check(mode === 'cloudflare' || mode === 'grpc-web', 'invalid-transport-mode');
    check(runtime === 'worker' || mode === 'grpc-web', 'node-requires-grpc-web-endpoint');
    if (mode === 'cloudflare') {
        configureWorkersGrpc({ mode });
    }
    else {
        configureWorkersGrpc({ mode, endpoints: JSON.parse(env.WGA_ENDPOINTS_JSON || '{}') });
    }
}
export function contextFor(env, suiteName, runId) {
    const suite = Object.hasOwn(suites, suiteName) ? suites[suiteName] : undefined;
    check(!!suite, 'unknown-suite');
    const projectId = env[suite.project];
    check(typeof projectId === 'string' && projectId.length > 0, 'test-project-required');
    check(!suite.writes || env.WGA_ALLOW_TEST_WRITES === '1', 'writes-not-explicitly-enabled');
    const credentials = JSON.parse(env.WGA_GOOGLE_CREDENTIALS_JSON || '{}');
    check(typeof credentials.client_email === 'string' && typeof credentials.private_key === 'string', 'explicit-test-credentials-required');
    const options = { projectId, credentials };
    if (suiteName.startsWith('firestore') && env.WGA_FIRESTORE_DATABASE) {
        options.databaseId = env.WGA_FIRESTORE_DATABASE;
    }
    if (suiteName.startsWith('datastore') && env.WGA_DATASTORE_DATABASE) {
        options.databaseId = env.WGA_DATASTORE_DATABASE;
    }
    return { options, allowedProjectId: projectId, runId, allowWrites: env.WGA_ALLOW_TEST_WRITES === '1', secretName: env.WGA_SECRET_NAME };
}
