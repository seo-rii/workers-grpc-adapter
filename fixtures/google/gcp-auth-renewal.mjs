import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { runCredentialRenewal } from './shared/credential-renewal.mjs';

function check(value) {
  if (!value) {
    const error = new Error('CREDENTIAL_RENEWAL_BINDING');
    error.fixtureDiagnostic = 'CREDENTIAL_RENEWAL_BINDING';
    throw error;
  }
}

// Only deployment bindings select identities and destinations. The authenticated
// probe router owns request authorization; no request body enters this module.
export async function runGcpAuthRenewal(env, mode, signal) {
  check(env.WGA_AUTH_RENEWAL_ENABLED === '1' && env.WGA_RUN_GOOGLE_TESTS === '1' &&
    (mode === 'grpc-web' || mode === 'cloudflare') && env.WGA_PROBE_MODE === mode &&
    typeof env.WGA_OWNED_SERVICE_ACCOUNT_UID === 'string' && /^[1-9][0-9]{5,31}$/.test(env.WGA_OWNED_SERVICE_ACCOUNT_UID) &&
    typeof env.WGA_GCP_PROJECT_NUMBER === 'string' && /^[1-9][0-9]{5,19}$/.test(env.WGA_GCP_PROJECT_NUMBER) &&
    typeof env.WGA_GOOGLE_ACCESS_TOKEN === 'string' && env.WGA_GOOGLE_ACCESS_TOKEN.length > 20 &&
    typeof env.WGA_SECRET_NAME === 'string' &&
    new RegExp(`^projects/${env.WGA_GCP_PROJECT_NUMBER}/secrets/wga-probe-[a-z0-9-]{4,52}$`).test(env.WGA_SECRET_NAME));
  let gateway;
  if (mode === 'grpc-web') {
    check(typeof env.WGA_GATEWAY_ID_TOKEN === 'string' && env.WGA_GATEWAY_ID_TOKEN.length > 20);
    let endpoints;
    try { endpoints = JSON.parse(env.WGA_ENDPOINTS_JSON || '{}'); } catch { check(false); }
    check(endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints) &&
      Object.keys(endpoints).every(key => ['secretmanager.googleapis.com:443', 'firestore.googleapis.com:443',
        'datastore.googleapis.com:443'].includes(key)));
    try { gateway = new URL(endpoints['secretmanager.googleapis.com:443']); } catch { check(false); }
    check(gateway.protocol === 'https:' && gateway.hostname.endsWith('.run.app') && !gateway.port &&
      !gateway.username && !gateway.password && gateway.pathname === '/' && !gateway.search && !gateway.hash);
  }
  return runCredentialRenewal({ mode, projectNumber: env.WGA_GCP_PROJECT_NUMBER,
    secretName: env.WGA_SECRET_NAME, sourceToken: env.WGA_GOOGLE_ACCESS_TOKEN,
    targetPrincipal: env.WGA_OWNED_SERVICE_ACCOUNT_UID, signal,
    optionsForAuth(auth, observeAuthorization) {
      if (mode === 'grpc-web') {
        const original = auth.getRequestHeaders.bind(auth);
        auth.getRequestHeaders = async url => {
          const headers = await original(url);
          headers.set('x-serverless-authorization', `Bearer ${env.WGA_GATEWAY_ID_TOKEN}`);
          return headers;
        };
      }
      const expectedOrigin = mode === 'cloudflare' ? 'https://secretmanager.googleapis.com' : gateway.origin;
      const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
      const transport = createWorkersGrpcTransport({ ...(mode === 'cloudflare' ? { mode }
        : { mode, endpoints: { 'secretmanager.googleapis.com:443': gateway.origin } }),
        defaultTimeoutMs: 10000, transportMaxSendBytes: 1048576, transportMaxReceiveBytes: 1048576,
        fetcher: { fetch(input, init) {
          check(String(input) === `${expectedOrigin}/google.cloud.secretmanager.v1.SecretManagerService/GetSecret` &&
            init?.method === 'POST' && init.redirect === 'manual' &&
            init.cf?.grpcWeb === (mode === 'cloudflare' ? 'convert' : 'passthrough'));
          const headers = new Headers(init.headers);
          check(headers.get('content-type') === mime && headers.get('accept') === mime &&
            headers.get('x-serverless-authorization') === (mode === 'grpc-web' ? `Bearer ${env.WGA_GATEWAY_ID_TOKEN}` : null));
          observeAuthorization(headers.get('authorization'));
          // Preserve CF conversion and abort semantics at the actual Fetch boundary.
          return globalThis.fetch(input, init);
        } },
      });
      return transport.gaxOptions({ projectId: env.WGA_GCP_PROJECT_NUMBER, authClient: auth,
        preferRest: false, clientConfig: { interfaces: {
          'google.cloud.secretmanager.v1.SecretManagerService': {
            retry_codes: { renewal_no_retry: [] },
            methods: { GetSecret: { timeout_millis: 10000, retry_codes_name: 'renewal_no_retry' } },
          },
        } } });
    },
  });
}
