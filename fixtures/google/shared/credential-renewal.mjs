import { Impersonated, OAuth2Client } from 'google-auth-library';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const scope = 'https://www.googleapis.com/auth/cloud-platform';
const lifetimeSeconds = 60;
const eagerRefreshThresholdMs = 1000;
const maxDurationMs = 120000;
const diagnostics = new Set(['INPUT', 'ABORTED', 'TIMEOUT', 'IAM_REQUEST', 'IAM_RESPONSE',
  'IAM_LIFETIME', 'IAM_TOKEN', 'IAM_COUNT', 'OPTIONS', 'RPC_STATUS', 'AUTHORIZATION',
  'PHASE_COUNT', 'CACHE', 'RENEWAL', 'WAIT', 'CLOSE', 'RUNTIME']);
function failure(code) {
  const error = new Error(`CREDENTIAL_RENEWAL_${code}`);
  error.fixtureDiagnostic = `CREDENTIAL_RENEWAL_${code}`;
  return error;
}
function check(condition, code) { if (!condition) throw failure(code); }
function safeError(error) {
  const code = typeof error?.fixtureDiagnostic === 'string'
    ? error.fixtureDiagnostic.replace(/^CREDENTIAL_RENEWAL_/, '') : '';
  return diagnostics.has(code) ? failure(code) : failure('RUNTIME');
}

// Shared unchanged by native Node and the deployed Worker. Only short-lived
// source access credentials enter this fixture. The target token is acquired
// and renewed by the real Impersonated client, never installed by the fixture.
export async function runCredentialRenewal({ mode, projectNumber, secretName,
  sourceToken, targetPrincipal, optionsForAuth, signal }) {
  const startedAtMs = Date.now();
  check(['native', 'grpc-web', 'cloudflare'].includes(mode) &&
    typeof projectNumber === 'string' && /^[1-9][0-9]{5,19}$/.test(projectNumber) &&
    typeof targetPrincipal === 'string' && /^[1-9][0-9]{5,31}$/.test(targetPrincipal) &&
    typeof secretName === 'string' && new RegExp(`^projects/${projectNumber}/secrets/wga-probe-[a-z0-9-]{4,52}$`).test(secretName) &&
    typeof sourceToken === 'string' && sourceToken.length > 20 &&
    typeof optionsForAuth === 'function' &&
    (signal === undefined || typeof signal?.addEventListener === 'function'), 'INPUT');
  const controller = new AbortController();
  let timedOut = false, sdk, closePromise, sdkClosed = false;
  const closeSdk = () => {
    if (!closePromise && sdk) {
      closePromise = Promise.resolve().then(() => sdk.close()).then(() => { sdkClosed = true; });
      // An abort may start cleanup before the main finally can await it.
      closePromise.catch(() => {});
    }
    return closePromise ?? Promise.resolve();
  };
  const abort = () => { controller.abort(); void closeSdk(); };
  const abortError = () => failure(timedOut ? 'TIMEOUT' : 'ABORTED');
  const requireActive = () => {
    if (controller.signal.aborted) throw abortError();
    if (Date.now() - startedAtMs >= maxDurationMs) { timedOut = true; abort(); throw abortError(); }
  };
  const bounded = promise => {
    const task = Promise.resolve(promise);
    if (controller.signal.aborted) { task.catch(() => {}); return Promise.reject(abortError()); }
    let onAbort;
    return Promise.race([task, new Promise((_, reject) => {
      onAbort = () => reject(abortError());
      controller.signal.addEventListener('abort', onAbort, { once: true });
    })]).finally(() => controller.signal.removeEventListener('abort', onAbort));
  };
  const sleep = milliseconds => {
    let timer;
    return bounded(new Promise(resolve => { timer = setTimeout(resolve, milliseconds); }))
      .finally(() => clearTimeout(timer));
  };
  const deadlineTimer = setTimeout(() => { timedOut = true; abort(); }, maxDurationMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const mints = [], steps = [];
  let mintOperations = 0, authorizationChecks = 0, currentToken, firstToken;
  let activeStep, receipt, primaryError;
  const sourceClient = new OAuth2Client();
  sourceClient.setCredentials({ access_token: sourceToken });
  const originalRequest = sourceClient.request;
  const auth = new Impersonated({ sourceClient, targetPrincipal, targetScopes: [scope],
    delegates: [], lifetime: lifetimeSeconds, eagerRefreshThresholdMillis: eagerRefreshThresholdMs });
  const expectedIamUrl = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${targetPrincipal}:generateAccessToken`;
  sourceClient.request = async function(options) {
    requireActive();
    check(options?.url === expectedIamUrl && options.method === 'POST' &&
      options.data?.lifetime === '60s' &&
      JSON.stringify(options.data.scope) === JSON.stringify([scope]) &&
      Array.isArray(options.data.delegates) && options.data.delegates.length === 0 &&
      Object.keys(options.data).sort().join(',') === 'delegates,lifetime,scope', 'IAM_REQUEST');
    check(++mintOperations <= 2, 'IAM_COUNT');
    const mintStartedAtMs = Date.now();
    let result;
    try {
      // This is a real Google-auth request. Only retry/time bounds are narrowed
      // for this finite diagnostic, and cancellation follows the enclosing run.
      result = await bounded(originalRequest.call(this, { ...options,
        retry: false, timeout: 10000, signal: controller.signal }));
    } catch {
      requireActive();
      throw failure('IAM_RESPONSE');
    }
    requireActive();
    const completedAtMs = Date.now(), expireTimeMs = Date.parse(result?.data?.expireTime);
    const remainingLifetimeMs = expireTimeMs - completedAtMs;
    check(result?.status === 200 && Number.isFinite(expireTimeMs), 'IAM_RESPONSE');
    check(remainingLifetimeMs >= 40000 && remainingLifetimeMs <= 70000, 'IAM_LIFETIME');
    const token = result.data.accessToken;
    check(typeof token === 'string' && token.length > 20 && token !== sourceToken &&
      (!firstToken || token !== firstToken), 'IAM_TOKEN');
    if (!firstToken) firstToken = token;
    currentToken = token;
    mints.push({ generation: mints.length + 1, httpStatus: 200,
      startedAtMs: mintStartedAtMs, completedAtMs, expireTimeMs, remainingLifetimeMs });
    return result;
  };
  const observeAuthorization = authorization => {
    requireActive();
    check(activeStep && typeof authorization === 'string' && currentToken &&
      authorization === `Bearer ${currentToken}` && auth.credentials.access_token === currentToken &&
      authorization !== `Bearer ${sourceToken}`, 'AUTHORIZATION');
    activeStep.authorizationCount++;
    authorizationChecks++;
    check(activeStep.authorizationCount === 1, 'AUTHORIZATION');
  };
  try {
    requireActive();
    const options = optionsForAuth(auth, observeAuthorization);
    check(options && typeof options === 'object' && options.authClient === auth &&
      options.projectId === projectNumber && options.fallback === false, 'OPTIONS');
    sdk = new SecretManagerServiceClient(options);
    // Initializing before the first call also gives abort/close a concrete SDK
    // stub to terminate. No source token is refreshed during initialization.
    await bounded(sdk.initialize());
    requireActive();
    let wait;
    for (const [index, id] of ['initial', 'cached', 'renewed', 'recached'].entries()) {
      requireActive();
      if (id === 'renewed') {
        check(mints.length === 1 && auth.credentials.expiry_date === mints[0].expireTimeMs, 'CACHE');
        const waitStartedAtMs = Date.now(), until = mints[0].expireTimeMs + 250;
        check(until > waitStartedAtMs && until - startedAtMs < maxDurationMs - 20000, 'WAIT');
        // Use Google's real expiration and the real clock. No credential or
        // clock mutation is used to force the live refresh path.
        while (Date.now() < until) { requireActive(); await sleep(Math.min(1000, until - Date.now())); }
        const waitCompletedAtMs = Date.now();
        wait = { startedAtMs: waitStartedAtMs, previousExpiryMs: mints[0].expireTimeMs,
          completedAtMs: waitCompletedAtMs, elapsedMs: waitCompletedAtMs - waitStartedAtMs };
      }
      const step = activeStep = { id, grpcCode: null, mintCount: 0,
        authorizationCount: 0, tokenGeneration: 0, startedAtMs: Date.now(), completedAtMs: 0, elapsedMs: 0 };
      let code;
      try { await bounded(sdk.getSecret({ name: secretName }, { retry: null, timeout: 10000 })); }
      catch (error) {
        requireActive();
        code = error?.code;
      }
      step.completedAtMs = Date.now();
      step.elapsedMs = step.completedAtMs - step.startedAtMs;
      step.grpcCode = code;
      step.mintCount = mintOperations;
      step.tokenGeneration = mints.length;
      activeStep = undefined;
      check(code === 7, 'RPC_STATUS');
      check(step.authorizationCount === 1 && mintOperations === [1, 1, 2, 2][index] &&
        mints.length === mintOperations, 'PHASE_COUNT');
      check(auth.credentials.access_token === currentToken && auth.credentials.expiry_date === mints.at(-1).expireTimeMs, 'CACHE');
      steps.push(step);
    }
    check(mints.length === 2 && currentToken !== firstToken && authorizationChecks === 4 &&
      mints[1].startedAtMs >= wait.completedAtMs && mints[1].expireTimeMs > mints[0].expireTimeMs, 'RENEWAL');
    receipt = { schemaVersion: 1, kind: 'credential-renewal', mode, status: 'passed',
      observationBoundary: mode === 'native' ? 'auth-request-headers' : 'transport-fetch',
      clock: 'real', sourceCredential: 'access-token-only', sourceRefreshSupported: false,
      sameSdkClient: true, sameAuthClient: true, lifetimeSeconds, eagerRefreshThresholdMs,
      mints, steps, wait, mintOperations, authorizationChecks, tokensChanged: true,
      cleanup: { sdkClosed: false }, startedAtMs, completedAtMs: 0, elapsedMs: 0 };
  } catch (error) { primaryError = safeError(error); }
  finally {
    activeStep = undefined;
    try { await bounded(closeSdk()); }
    catch { primaryError ??= controller.signal.aborted ? abortError() : failure('CLOSE'); }
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', abort);
    sourceClient.request = originalRequest;
  }
  if (primaryError) throw primaryError;
  check(sdkClosed, 'CLOSE');
  receipt.cleanup.sdkClosed = true;
  receipt.completedAtMs = Date.now();
  receipt.elapsedMs = receipt.completedAtMs - startedAtMs;
  check(receipt.elapsedMs < maxDurationMs, 'TIMEOUT');
  return receipt;
}
