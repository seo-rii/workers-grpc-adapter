'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateAuthCatalogReport, catalogCases, sources } = require('../scripts/auth-catalog-evidence.cjs');

// Independent synthetic receipts test evidence rejection, never claim execution.
function fixture() {
  const hash = 'a'.repeat(64), metadata = {
    'x-bin': [{ bytes: [0] }, { bytes: [3, 0, 255] }, { bytes: [1, 0, 255] }, { bytes: [2, 0, 255] }],
    'x-caller': ['caller'], 'x-channel-first': ['channel-first'], 'x-channel-second': ['channel-second'], 'x-per-call': ['per-call'],
    'x-repeat': ['caller', 'per-call-first', 'per-call-second', 'channel-first-first', 'channel-first-second', 'channel-second-first', 'channel-second-second'],
    'x-replaced': ['per-call', 'channel-first', 'channel-second'],
  };
  const completed = ['channel-second', 'per-call', 'channel-first'];
  const report = { status: 'passed', sourceBuild: false, liveCloud: false, incomingCloudflareTranslation: false,
    controlledFetchPeer: true, credentialsPersisted: false, unexpectedRequests: 0, runtimeDisposed: true,
    compatibilityDate: '2026-09-21', profile: 'google-static-v1', bundleSha256: hash, profileSha256: hash, registrySha256: hash,
    evidence: Object.fromEntries(sources.map(file => [file, hash])),
    versions: { auth: ['10.9.1', '11.1.0'], secretManager: '7.1.0', gax: '6.5.0', miniflare: 'synthetic', workerd: 'synthetic' },
    installedInputs: Object.fromEntries(['index.js', 'adapter.js', 'call.js', 'wire.js'].map(file => [`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`, hash])),
    native: { version: '1.14.5', actualLoadBalancingCall: true, controlledReadySubchannel: true, networkUsed: false,
      inputs: Object.fromEntries(['package.json', 'build/src/load-balancing-call.js', 'build/src/call-credentials.js', 'build/src/metadata.js', 'build/src/control-plane-status.js']
        .map(file => [`fixtures/native/node_modules/@grpc/grpc-js/${file}`, hash])),
      codes: { undefined: 2, 16: 16, 14: 14, 0: 13, 3: 13, 5: 13, 6: 13, 9: 13, 10: 13, 11: 13, 15: 13 }, composition: { metadata, completed } },
    runs: [], receipts: [], tokenRequests: [], workerHttpScanned: true, runtimeLogsScanned: 1,
    runtimeLogSensorCount: 1, reportMarkerScanned: true, markerOccurrences: 0, caseCount: 112 };
  for (const runtime of ['node', 'workerd']) {
    const run = { runtime, status: 'passed', markerOccurrences: 0, rawCredentialsPersisted: false, logSensorCount: 1, logsScanned: 1, rows: [] };
    report.runs.push(run);
    for (const mode of ['cloudflare', 'grpc-web']) {
      const add = (id, variant, data) => run.rows.push({ runtime, mode, id, variant, status: 'passed', ...data });
      const cleanup = { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 };
      const terminal = { callbackCount: 1, terminalCount: 1, cleanup };
      for (const variant of ['public-call-options', 'direct-set-credentials']) add('AUTH-003', variant, { ...terminal, nativeMatched: true, fetchCount: 1, completed,
        mergedHeaders: Object.fromEntries(Object.entries(metadata).map(([key, values]) => [key, values.map(value => typeof value === 'string' ? value : Buffer.from(value.bytes).toString('base64')).join(', ')])) });
      for (const [id, variant, code, inputCode] of [['AUTH-006', 'code-less', 2, null], ['AUTH-007', 'unauthenticated', 16, 16], ['AUTH-007', 'unavailable', 14, 14],
        ...[0, 3, 5, 6, 9, 10, 11, 15].map(value => ['AUTH-008', `forbidden-${value}`, 13, value])]) {
        add(id, variant, { ...terminal, code, inputCode, safeDetails: 'WGA_AUTH_METADATA', nativeMatched: true, fetchCount: 0, authCalls: 1, httpStatus: 500, httpErrorScanned: true });
      }
      add('AUTH-009', 'caller-and-generator', { ...terminal, code: 13, fetchCount: 0, authCalls: 1, callerAuthorizationPreserved: true });
      add('AUTH-011', 'fake-clock-expiry', { ...terminal, code: 4, fetchCount: 0, authCalls: 1, metadataCount: 0, errorEventCount: 0,
        fakeClock: true, earlyTerminalCount: 0, advancedMs: 61000, remainingTimers: 0, timerDelays: [1000] });
      for (const variant of ['ca', 'private-key', 'certificate', 'key-and-certificate', 'verification-empty', 'verification-callback', 'verification-disable']) {
        add('AUTH-014', variant, { code: 'WGA_UNSUPPORTED_TLS', connectorCalls: 0, fetchCount: 0, connectorSensors: 5,
          connectorNames: ['net.connect', 'net.createConnection', 'tls.connect', 'tls.createSecureContext', 'http2.connect'] });
      }
      for (const authVersion of ['10.9.1', '11.1.0']) {
        const phases = ['valid', 'refreshed', 'reused'];
        const data = { authVersion, sdkCalls: 3, rpcCount: 3, tokenRequests: 1, phasesObserved: phases };
        add('AUTH-001', `default-gax-${authVersion}`, { ...data, manuallyComposed: false, defaultSsl: true, bearerMatched: true, quotaMatched: true });
        add('AUTH-012', `valid-expired-refreshed-${authVersion}`, { ...data, sameSdkClient: true, sameAuthClient: true, fakeClock: true,
          advancedMs: 3600001, adapterOwnsTokenCache: false, phases });
        const name = `projects/wga-oauth-project/secrets/${runtime}-${mode}-${authVersion}`;
        report.receipts.push(...phases.map(phase => ({ kind: 'oauth', runtime, mode, name, authVersion, phase, bearerMatched: true, quotaMatched: true })));
        report.tokenRequests.push({ runtime, owner: name, requestShapeMatched: true });
      }
      add('AUTH-013', 'project-client-email', { identityCount: 2, parallel: true, sdkCreatesAuthFromCredentials: true, distinctProjects: true,
        distinctClientEmails: true, resultIsolation: true, quotaIsolation: true, signaturesVerified: 2, rpcCount: 2, completionOrder: [1, 0] });
      report.receipts.push(...[1, 0].map(identity => ({ kind: 'service-account', runtime, mode, identity,
        project: `wga-project-${identity}`, clientEmail: `account-${identity}@wga-project-${identity}.iam.gserviceaccount.com`, quota: `wga-quota-${identity}`,
        name: `projects/wga-project-${identity}/secrets/${runtime}-${mode}-identity`, signatureVerified: true, claimsMatched: true, resultNameMatched: true })));
      add('AUTH-015', 'logs-http-report-marker-scan', { uniqueMarkerInjected: true, markerOccurrences: 0, logSensorCount: 1, logsScanned: 1,
        httpErrorsScanned: mode === 'cloudflare' ? 11 : 22, observerEventsScanned: 11, reportScanned: true,
        emittedHttpArtifacts: Array(11).fill(JSON.stringify({ error: { details: 'WGA_AUTH_METADATA', stack: 'Error: WGA_AUTH_METADATA' } })) });
    }
  }
  report.catalogCases = catalogCases(report.runs);
  return report;
}
const row = (report, id) => report.runs[0].rows.find(value => value.id === id);
function reject(mutate) { const report = fixture(); mutate(report); assert.throws(() => validateAuthCatalogReport(report), /WGA_EVIDENCE_INVALID/); }

test('EVIDENCE auth catalog requires the complete Node and workerd matrix and native credentials oracle', () => {
  validateAuthCatalogReport(fixture());
  for (const mutate of [r => { r.runs.pop(); }, r => { r.runs[0].rows.pop(); }, r => { r.runs[0].rows.push(r.runs[0].rows[0]); },
    r => { r.installedInputs = {}; }, r => { r.native.actualLoadBalancingCall = false; }, r => { r.native.inputs = {}; },
    r => { r.native.composition.metadata['x-repeat'].reverse(); }, r => { r.native.codes[0] = 0; },
    r => { r.sourceBuild = true; }, r => { r.evidence['src/call.ts'] = ''; }, r => { r.unexpectedRequests++; },
    r => { r.versions.auth[1] = 'future'; }, r => { r.catalogCases[0].scenarioCount++; }]) reject(mutate);
});
test('EVIDENCE auth catalog rejects anonymous fetches, duplicate terminal events and unchecked TLS connectors', () => {
  for (const id of ['AUTH-006', 'AUTH-007', 'AUTH-008', 'AUTH-009', 'AUTH-011']) {
    reject(r => { row(r, id).fetchCount = 1; }); reject(r => { row(r, id).terminalCount = 2; });
    reject(r => { row(r, id).callbackCount = 0; }); reject(r => { row(r, id).cleanup.bufferedBytes = 1; });
  }
  for (const mutate of [r => { row(r, 'AUTH-003').mergedHeaders['x-repeat'] = 'channel-first, per-call'; },
    r => { row(r, 'AUTH-011').fakeClock = false; }, r => { row(r, 'AUTH-011').timerDelays = []; },
    r => { row(r, 'AUTH-014').connectorCalls = 1; }, r => { row(r, 'AUTH-014').connectorSensors = 0; }]) reject(mutate);
});
test('EVIDENCE auth catalog binds refresh and service account identities to actual peer receipts', () => {
  for (const mutate of [r => { row(r, 'AUTH-001').manuallyComposed = true; }, r => { row(r, 'AUTH-012').sameSdkClient = false; },
    r => { r.receipts[0].bearerMatched = false; }, r => { r.receipts[0].phase = 'refreshed'; }, r => { r.tokenRequests.pop(); },
    r => { row(r, 'AUTH-012').tokenRequests = 0; }, r => { row(r, 'AUTH-013').completionOrder.reverse(); },
    r => { r.receipts.find(value => value.kind === 'service-account').clientEmail = 'other'; },
    r => { r.receipts.find(value => value.kind === 'service-account').signatureVerified = false; }]) reject(mutate);
});
test('EVIDENCE auth catalog requires scanned caller, HTTP, observer, runtime log and report artifacts', () => {
  for (const mutate of [r => { row(r, 'AUTH-015').uniqueMarkerInjected = false; }, r => { row(r, 'AUTH-015').markerOccurrences = 1; },
    r => { row(r, 'AUTH-015').httpErrorsScanned = 0; }, r => { row(r, 'AUTH-015').emittedHttpArtifacts.pop(); },
    r => { row(r, 'AUTH-015').observerEventsScanned = 0; }, r => { r.runtimeLogSensorCount = 0; }, r => { r.workerHttpScanned = false; },
    r => { r.reportMarkerScanned = false; }, r => { r.credentialsPersisted = true; }]) reject(mutate);
});
module.exports = { fixture };
