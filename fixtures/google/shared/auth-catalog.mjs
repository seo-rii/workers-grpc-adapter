import { Buffer } from 'node:buffer';
import net from 'node:net';
import tls from 'node:tls';
import http2 from 'node:http2';
import { OAuth2Client } from 'google-auth-library';
import { OAuth2Client as OAuth2Client11 } from '@google-cloud/secret-manager/node_modules/google-auth-library/build/src/index.js';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

export const rpcPath = '/catalog.Auth/Echo';
export const forbiddenCodes = [0, 3, 5, 6, 9, 10, 11, 15];
export function check(condition, diagnostic) {
  if (!condition) { const error = new Error(diagnostic); error.fixtureDiagnostic = diagnostic; throw error; }
}
const same = (a, b, diagnostic) => check(JSON.stringify(a) === JSON.stringify(b), diagnostic);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const originalSetTimeout = globalThis.setTimeout;
const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => originalSetTimeout(resolve, 0)); };
const frame = (body, trailer = false) => { const head = Buffer.alloc(5); head[0] = trailer ? 128 : 0; head.writeUInt32BE(body.length, 1); return Buffer.concat([head, body]); };
const response = mode => new Response(Buffer.concat([frame(Buffer.from('accepted')), frame(Buffer.from('grpc-status: 0\r\n'), true)]),
  { headers: { 'content-type': mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto' } });
export function metadataSnapshot(metadata) {
  return Object.fromEntries(Object.keys(metadata.getMap()).sort().map(key => [key,
    metadata.get(key).map(value => typeof value === 'string' ? value : { bytes: [...value] })]));
}

// Shared inputs; the native oracle runs upstream LoadBalancingCall itself.
export function compositionFixture(grpc) {
  const pending = new Map(), started = deferred(), completed = [];
  const make = (owner, byte) => grpc.credentials.createFromMetadataGenerator((_options, done) => {
    pending.set(owner, () => {
      const metadata = new grpc.Metadata();
      metadata.add('X-Repeat', `${owner}-first`); metadata.add('x-repeat', `${owner}-second`);
      metadata.add('x-bin', Buffer.from([byte, 0, 255]));
      metadata.set('x-replaced', 'discarded'); metadata.set('x-replaced', owner);
      metadata.set(`x-${owner}`, owner); completed.push(owner); done(null, metadata);
    });
    if (pending.size === 3) started.resolve();
  });
  const first = make('channel-first', 1), second = make('channel-second', 2), perCall = make('per-call', 3);
  const caller = new grpc.Metadata();
  caller.add('x-repeat', 'caller'); caller.add('x-bin', Buffer.from([0])); caller.set('x-caller', 'caller');
  return { channelCalls: grpc.credentials.combineCallCredentials(first, second), perCall, caller, completed,
    async release() { await started.promise; for (const name of ['channel-second', 'per-call', 'channel-first']) pending.get(name)(); } };
}

function installClock(timers = false) {
  const SavedDate = globalThis.Date, savedSet = globalThis.setTimeout, savedClear = globalThis.clearTimeout;
  let now = SavedDate.now(), sequence = 0;
  const pending = new Map(), delays = [];
  class ControlledDate extends SavedDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  globalThis.Date = ControlledDate;
  if (timers) {
    globalThis.setTimeout = (callback, delay = 0, ...args) => {
      check(Number.isFinite(delay) && delay >= 0, 'CLOCK_DELAY');
      const id = ++sequence; pending.set(id, { at: now + delay, callback: () => callback(...args) }); delays.push(delay); return id;
    };
    globalThis.clearTimeout = id => pending.delete(id);
  }
  return { delays, count: () => pending.size,
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; pending.delete(next[0]); next[1].callback();
      }
      now = target;
    },
    restore() { globalThis.Date = SavedDate; globalThis.setTimeout = savedSet; globalThis.clearTimeout = savedClear; },
  };
}
function invoke(grpc, client, metadata = new grpc.Metadata(), options = {}) {
  const statuses = [], metadataEvents = [], errors = [];
  let callbackCount = 0, call;
  const settled = new Promise(resolve => {
    call = client.makeUnaryRequest(rpcPath, value => Buffer.from(value), value => value.toString(), 'request', metadata, options,
      (error, value) => { callbackCount++; resolve({ error, value }); });
  });
  call.on('status', value => statuses.push(value.code)); call.on('metadata', value => metadataEvents.push(value));
  call.on('error', error => errors.push(error.code));
  return { call, settled, statuses, metadataEvents, errors, count: () => callbackCount };
}
function errorArtifact(error) {
  return { code: error?.code, details: error?.details, message: error?.message, stack: error?.stack,
    metadata: error?.metadata && metadataSnapshot(error.metadata) };
}
function safe(text, marker, diagnostic) { check(!text.includes(marker), diagnostic); }

/** Real public calls, shared unchanged by Node and workerd. All peers are local. */
export async function runAuthCatalog({ grpc, createWorkersGrpcTransport, input, runtime, native }) {
  const rows = [], capturedLogs = [], observerArtifacts = [], httpArtifacts = [];
  const consoleOriginals = Object.fromEntries(['log', 'error', 'warn', 'info', 'debug', 'trace'].map(name => [name, console[name]]));
  for (const name of Object.keys(consoleOriginals)) console[name] = (...values) => capturedLogs.push(values.map(value =>
    value instanceof Error ? JSON.stringify(errorArtifact(value)) : typeof value === 'string' ? value : JSON.stringify(value)).join(' '));
  console.warn('AUTH_CATALOG_LOG_SENSOR');
  let stage = 'start';
  try {
    for (const mode of ['cloudflare', 'grpc-web']) {
      const config = extra => ({ mode, ...(mode === 'grpc-web' ? { endpoints: {
        'logical.fixture.invalid': 'https://gateway.fixture.invalid', 'secretmanager.googleapis.com': 'https://gateway.fixture.invalid',
      } } : {}), ...extra });
      const row = (id, variant, details) => rows.push({ id, variant, runtime, mode, status: 'passed', ...details });
      const direct = (calls, fetcher, observer) => {
        const transport = createWorkersGrpcTransport(config({ fetcher, ...(observer ? { observer } : {}) }));
        const client = new grpc.Client('logical.fixture.invalid', grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), calls), transport.grpcOptions());
        return { client, transport };
      };
      const idle = (client, transport) => {
        check(client.getChannel().activeCallCount() === 0, 'AUTH_ACTIVE_CALL_CLEANUP');
        const usage = transport.resourceUsage();
        for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) check(usage[key] === 0, 'AUTH_RESOURCE_CLEANUP');
        return { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 };
      };
      for (const variant of ['public-call-options', 'direct-set-credentials']) {
        stage = `AUTH-003/${variant}`;
        const generated = compositionFixture(grpc); let fetchCount = 0, wire;
        const { client, transport } = direct(generated.channelCalls, { async fetch(_url, init) {
          fetchCount++; wire = Object.fromEntries([...init.headers].filter(([key]) => key.startsWith('x-') && !['x-grpc-web', 'x-user-agent'].includes(key)));
          return response(mode);
        } });
        let terminalCount = 0, callbackCount = 0;
        try {
          if (variant === 'public-call-options') {
            const invocation = invoke(grpc, client, generated.caller, { credentials: generated.perCall });
            await generated.release(); const result = await invocation.settled; await drain();
            check(!result.error && result.value === 'accepted', 'COMPOSITION_RPC_SUCCESS');
            terminalCount = invocation.statuses.length; callbackCount = invocation.count(); same(invocation.statuses, [0], 'COMPOSITION_STATUS');
          } else {
            const call = client.getChannel().createCallForMethod(rpcPath, false, false, {});
            const finished = deferred();
            call.setCredentials(generated.perCall);
            call.start(generated.caller, { onReceiveMetadata() {}, onReceiveMessage() {}, onReceiveStatus(status) { terminalCount++; check(status.code === 0, 'COMPOSITION_DIRECT_STATUS'); finished.resolve(); } });
            call.sendMessageWithContext({ callback(error) { check(!error, 'COMPOSITION_WRITE'); callbackCount++; } }, Buffer.from('request'));
            call.startRead(); call.halfClose(); await generated.release(); await finished.promise; await drain();
          }
          const expectedWire = Object.fromEntries(Object.entries(native.composition.metadata).map(([key, values]) => [key,
            values.map(value => typeof value === 'string' ? value : Buffer.from(value.bytes).toString('base64')).join(', ')]));
          same(wire, Object.fromEntries(Object.entries(expectedWire).sort(([a], [b]) => a.localeCompare(b))), 'NATIVE_MERGED_KEY_SEMANTICS');
          same(generated.completed, native.composition.completed, 'NATIVE_GENERATOR_COMPLETION');
          check(fetchCount === 1 && terminalCount === 1 && callbackCount === 1, 'COMPOSITION_TERMINALS');
          row('AUTH-003', variant, { fetchCount, terminalCount, callbackCount, nativeMatched: true,
            mergedHeaders: wire, completed: generated.completed, cleanup: idle(client, transport) });
        } finally { client.close(); }
      }
      const errorCases = [['AUTH-006', 'code-less', undefined, 2], ['AUTH-007', 'unauthenticated', 16, 16], ['AUTH-007', 'unavailable', 14, 14],
        ...forbiddenCodes.map(code => ['AUTH-008', `forbidden-${code}`, code, 13])];
      for (const [id, variant, suppliedCode, expectedCode] of errorCases) {
        stage = `${id}/${variant}`;
        let authCalls = 0, fetchCount = 0; const observations = [];
        const calls = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
          authCalls++; const error = new Error(input.marker); if (suppliedCode !== undefined) error.code = suppliedCode; callback(error);
        });
        const { client, transport } = direct(calls, { async fetch() { fetchCount++; return response(mode); } }, event => observations.push(event));
        try {
          const invocation = invoke(grpc, client); const result = await invocation.settled; await drain();
          check(result.error?.code === expectedCode && result.error.details === 'WGA_AUTH_METADATA', 'AUTH_ERROR_POLICY');
          check(native.codes[String(suppliedCode)] === expectedCode, 'NATIVE_RESTRICTION_TABLE');
          same(invocation.statuses, [expectedCode], 'AUTH_ERROR_STATUS');
          check(invocation.count() === 1 && invocation.metadataEvents.length === 0 && fetchCount === 0 && authCalls === 1, 'AUTH_NO_ANONYMOUS_RETRY');
          const artifact = await Response.json({ error: errorArtifact(result.error) }, { status: 500 }).text();
          safe(artifact, input.marker, 'HTTP_ERROR_REDACTION'); httpArtifacts.push(artifact); observerArtifacts.push(...observations);
          row(id, variant, { inputCode: suppliedCode ?? null, code: result.error.code, safeDetails: result.error.details,
            fetchCount, authCalls, callbackCount: invocation.count(), terminalCount: invocation.statuses.length,
            nativeMatched: true, httpStatus: 500, httpErrorScanned: true, cleanup: idle(client, transport) });
        } finally { client.close(); }
      }
      stage = 'AUTH-009/caller-and-generator';
      {
        let fetchCount = 0, authCalls = 0;
        const calls = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
          authCalls++; const metadata = new grpc.Metadata(); metadata.set('authorization', `Bearer ${input.marker}-generator`); callback(null, metadata);
        });
        const { client, transport } = direct(calls, { async fetch() { fetchCount++; return response(mode); } });
        try {
          const metadata = new grpc.Metadata(); metadata.set('authorization', `Bearer ${input.marker}-caller`);
          const invocation = invoke(grpc, client, metadata); const result = await invocation.settled; await drain();
          check(result.error?.code === 13 && fetchCount === 0 && authCalls === 1 && invocation.count() === 1, 'DUPLICATE_AUTHORIZATION_REJECTED');
          same(invocation.statuses, [13], 'DUPLICATE_AUTHORIZATION_STATUS');
          safe(JSON.stringify(errorArtifact(result.error)), input.marker, 'DUPLICATE_AUTHORIZATION_REDACTION');
          row('AUTH-009', 'caller-and-generator', { code: 13, fetchCount, authCalls, callbackCount: 1, terminalCount: 1,
            callerAuthorizationPreserved: metadata.get('authorization')[0] === `Bearer ${input.marker}-caller`, cleanup: idle(client, transport) });
        } finally { client.close(); }
      }
      stage = 'AUTH-011/fake-clock-expiry';
      {
        const clock = installClock(true), started = deferred(); let complete, fetchCount = 0, authCalls = 0;
        const calls = grpc.credentials.createFromMetadataGenerator((_options, callback) => { authCalls++; complete = callback; started.resolve(); });
        const { client, transport } = direct(calls, { async fetch() { fetchCount++; return response(mode); } });
        try {
          const invocation = invoke(grpc, client, undefined, { deadline: Date.now() + 1000 });
          await started.promise; clock.advance(999); await drain();
          check(invocation.count() === 0 && invocation.statuses.length === 0 && fetchCount === 0, 'DEADLINE_NOT_EARLY');
          clock.advance(1); const result = await invocation.settled; await drain();
          check(result.error?.code === 4, 'DEADLINE_EXPIRED');
          const metadata = new grpc.Metadata(); metadata.set('authorization', `Bearer ${input.marker}`); complete(null, metadata);
          await drain(); clock.advance(60000); await drain();
          same(invocation.statuses, [4], 'DEADLINE_EXACTLY_ONE_STATUS');
          check(invocation.count() === 1 && invocation.metadataEvents.length === 0 && invocation.errors.length === 0 && authCalls === 1 && fetchCount === 0 && clock.count() === 0, 'DEADLINE_LATE_AUTH_QUIESCENCE');
          row('AUTH-011', 'fake-clock-expiry', { code: 4, authCalls, fetchCount, callbackCount: 1, terminalCount: 1,
            metadataCount: 0, errorEventCount: 0, fakeClock: true, earlyTerminalCount: 0, advancedMs: 61000,
            timerDelays: clock.delays, remainingTimers: clock.count(), cleanup: idle(client, transport) });
        } finally { client.close(); clock.restore(); }
      }
      stage = 'AUTH-014/custom-tls';
      {
        const connectors = [[net, 'connect'], [net, 'createConnection'], [tls, 'connect'], [tls, 'createSecureContext'], [http2, 'connect']];
        const saved = connectors.map(([object, name]) => object[name]); let connectorCalls = 0, fetchCount = 0;
        check(saved.every(value => typeof value === 'function'), 'CONNECTOR_ENTRYPOINTS_EXIST');
        const savedFetch = globalThis.fetch;
        for (const [object, name] of connectors) object[name] = () => { connectorCalls++; throw new Error('NATIVE_CONNECTOR_CALLED'); };
        globalThis.fetch = async () => { fetchCount++; throw new Error('TLS_FETCH_CALLED'); };
        const variants = [['ca', [Buffer.from('fixture-ca')]], ['private-key', [null, Buffer.from('fixture-key')]],
          ['certificate', [null, null, Buffer.from('fixture-cert')]], ['key-and-certificate', [null, Buffer.from('key'), Buffer.from('cert')]],
          ['verification-empty', [null, null, null, {}]], ['verification-callback', [null, null, null, { checkServerIdentity() { throw new Error('VERIFIER_CALLED'); } }]],
          ['verification-disable', [null, null, null, { rejectUnauthorized: false }]]];
        try {
          // Positive control proves each hook is live before the zero-use check.
          for (const [object, name] of connectors) { try { object[name](); } catch {} }
          check(connectorCalls === connectors.length, 'CONNECTOR_SENSOR'); connectorCalls = 0;
          for (const [variant, args] of variants) {
            let error; try { grpc.credentials.createSsl(...args); } catch (value) { error = value; }
            check(error?.code === 'WGA_UNSUPPORTED_TLS' && connectorCalls === 0 && fetchCount === 0, 'TLS_REJECTS_BEFORE_CONNECT');
            row('AUTH-014', variant, { code: error.code, connectorCalls, fetchCount, connectorSensors: connectors.length,
              connectorNames: connectors.map(([, name], index) => `${['net', 'net', 'tls', 'tls', 'http2'][index]}.${name}`) });
          }
        } finally { connectors.forEach(([object, name], index) => { object[name] = saved[index]; }); globalThis.fetch = savedFetch; }
      }
      for (const [authVersion, OAuth] of [['10.9.1', OAuth2Client], ['11.1.0', OAuth2Client11]]) {
        stage = `AUTH-001/AUTH-012/${authVersion}`;
        const identity = input.oauth;
        const auth = new OAuth({ clientId: identity.clientId, clientSecret: identity.clientSecret, quotaProjectId: identity.quota,
          endpoints: { oauth2TokenUrl: 'https://oauth.fixture.invalid/token' }, transporterOptions: { fetchImplementation: (...args) => fetch(...args) } });
        const clock = installClock(false);
        auth.setCredentials({ access_token: identity.accessToken, refresh_token: identity.refreshToken, expiry_date: Date.now() + 3600000 });
        const transport = createWorkersGrpcTransport(config());
        const options = transport.gaxOptions({ projectId: identity.project, authClient: auth });
        check(!Object.hasOwn(options, 'sslCreds'), 'GAX_DEFAULT_SSL_NO_MANUAL_CREDENTIALS');
        const sdk = new SecretManagerServiceClient(options);
        const name = `projects/${identity.project}/secrets/${runtime}-${mode}-${authVersion}`;
        try {
          for (const phase of ['valid', 'refreshed', 'reused']) {
            if (phase === 'refreshed') clock.advance(3600001);
            const [secret] = await sdk.getSecret({ name }, { retry: null, timeout: 5000 });
            check(secret.name === name, 'DEFAULT_GAX_SDK_RESULT');
            check(auth.credentials.access_token === (phase === 'valid' ? identity.accessToken : identity.nextToken), 'AUTH_LIBRARY_OWNS_REFRESH');
          }
          check(auth.credentials.expiry_date > Date.now() && auth.credentials.refresh_token === identity.refreshToken, 'SDK_REFRESH_STATE');
          row('AUTH-001', `default-gax-${authVersion}`, { authVersion, sdkCalls: 3, manuallyComposed: false, defaultSsl: true, bearerMatched: true, quotaMatched: true });
          row('AUTH-012', `valid-expired-refreshed-${authVersion}`, { authVersion, sdkCalls: 3, sameSdkClient: true, sameAuthClient: true,
            fakeClock: true, advancedMs: 3600001, adapterOwnsTokenCache: false, phases: ['valid', 'refreshed', 'reused'] });
        } finally { await sdk.close(); clock.restore(); }
      }
      stage = 'AUTH-013/project-client-email';
      {
        const transport = createWorkersGrpcTransport(config());
        const clients = input.serviceAccounts.map(identity => new SecretManagerServiceClient(transport.gaxOptions({
          projectId: identity.project, credentials: { type: 'service_account', project_id: identity.project,
            client_email: identity.email, private_key: identity.privateKey, quota_project_id: identity.quota },
        })));
        const names = input.serviceAccounts.map(identity => `projects/${identity.project}/secrets/${runtime}-${mode}-identity`);
        try {
          const results = await Promise.all(clients.map(async (sdk, index) => {
            const [secret] = await sdk.getSecret({ name: names[index] }, { retry: null, timeout: 5000 });
            check(secret.name === names[index], 'SERVICE_ACCOUNT_RESULT_ISOLATION');
            const auth = await sdk.auth.getClient();
            check(auth.email === input.serviceAccounts[index].email, 'SDK_CLIENT_EMAIL_IDENTITY');
            check(await sdk.getProjectId() === input.serviceAccounts[index].project, 'SDK_PROJECT_IDENTITY');
            return secret.name;
          }));
          same(results, names, 'PARALLEL_IDENTITY_RESULTS');
          row('AUTH-013', 'project-client-email', { identityCount: 2, parallel: true, sdkCreatesAuthFromCredentials: true,
            distinctProjects: true, distinctClientEmails: true, resultIsolation: true });
        } finally { await Promise.all(clients.map(client => client.close())); }
      }
      safe(JSON.stringify({ capturedLogs, httpArtifacts, observerArtifacts, rows }), input.marker, 'AUTH_OUTPUT_REDACTION');
      check(capturedLogs.includes('AUTH_CATALOG_LOG_SENSOR'), 'AUTH_LOG_SENSOR_PRESENT');
      row('AUTH-015', 'logs-http-report-marker-scan', { uniqueMarkerInjected: true, markerOccurrences: 0,
        logSensorCount: capturedLogs.filter(value => value === 'AUTH_CATALOG_LOG_SENSOR').length,
        logsScanned: capturedLogs.length, httpErrorsScanned: httpArtifacts.length, observerEventsScanned: observerArtifacts.length,
        reportScanned: true, emittedHttpArtifacts: httpArtifacts.slice(-errorCases.length) });
    }
    safe(JSON.stringify({ rows, capturedLogs, observerArtifacts, httpArtifacts }), input.marker, 'FINAL_AUTH_MARKER_SCAN');
    return { status: 'passed', runtime, rows, logSensorCount: 1, logsScanned: capturedLogs.length,
      markerOccurrences: 0, rawCredentialsPersisted: false };
  } catch (error) {
    return { status: 'failed', runtime, stage, diagnostic: error.fixtureDiagnostic || 'AUTH_CATALOG_RUNTIME_FAILURE',
      errorClass: error.constructor?.name || 'Error', locations: error.stack?.match(/auth-catalog\.[cm]?js:\d+:\d+/g) || [], rows };
  } finally { for (const [name, original] of Object.entries(consoleOriginals)) console[name] = original; }
}
