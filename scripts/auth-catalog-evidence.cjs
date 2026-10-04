'use strict';
const { isDeepStrictEqual } = require('node:util');
const sources = ['scripts/test-auth-catalog.cjs', 'scripts/auth-catalog-evidence.cjs',
  'fixtures/google/shared/auth-catalog.mjs', 'fixtures/worker/auth-catalog.mjs', 'src/call.ts',
  'fixtures/google/package-lock.json', 'fixtures/worker/package-lock.json', 'fixtures/native/package-lock.json'];
const ids = ['AUTH-001', 'AUTH-003', 'AUTH-006', 'AUTH-007', 'AUTH-008', 'AUTH-009', 'AUTH-011', 'AUTH-012', 'AUTH-013', 'AUTH-014', 'AUTH-015'];
const forbidden = [0, 3, 5, 6, 9, 10, 11, 15];
const variants = [
  ...['10.9.1', '11.1.0'].map(version => ['AUTH-001', `default-gax-${version}`]),
  ...['public-call-options', 'direct-set-credentials'].map(variant => ['AUTH-003', variant]),
  ['AUTH-006', 'code-less'], ['AUTH-007', 'unauthenticated'], ['AUTH-007', 'unavailable'],
  ...forbidden.map(code => ['AUTH-008', `forbidden-${code}`]),
  ['AUTH-009', 'caller-and-generator'], ['AUTH-011', 'fake-clock-expiry'],
  ...['10.9.1', '11.1.0'].map(version => ['AUTH-012', `valid-expired-refreshed-${version}`]),
  ['AUTH-013', 'project-client-email'],
  ...['ca', 'private-key', 'certificate', 'key-and-certificate', 'verification-empty', 'verification-callback', 'verification-disable'].map(variant => ['AUTH-014', variant]),
  ['AUTH-015', 'logs-http-report-marker-scan'],
];
const need = (condition, diagnostic) => { if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: auth-catalog ${diagnostic}`); };
const same = (a, b, diagnostic) => need(isDeepStrictEqual(a, b), diagnostic);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
function catalogCases(runs) {
  return ids.map(id => {
    const rows = runs.flatMap(run => run.rows).filter(row => row.id === id);
    return { id, status: rows.length && rows.every(row => row.status === 'passed') ? 'passed' : 'failed',
      catalogMatch: rows.length === 4 * variants.filter(([value]) => value === id).length && rows.every(row => row.status === 'passed'),
      scenarioCount: rows.length, nodeCount: rows.filter(row => row.runtime === 'node').length, workerdCount: rows.filter(row => row.runtime === 'workerd').length };
  });
}
function validateAuthCatalogReport(report, { allowSourceBuild = false } = {}) {
  need(report?.status === 'passed' && (report.sourceBuild === false || allowSourceBuild && report.sourceBuild === true), 'execution mode');
  need(report.liveCloud === false && report.incomingCloudflareTranslation === false && report.controlledFetchPeer === true
    && report.credentialsPersisted === false && report.unexpectedRequests === 0 && report.runtimeDisposed === true, 'runtime boundary');
  need(report.compatibilityDate === '2026-09-21' && report.profile === 'google-static-v1', 'pinned runtime/profile');
  for (const field of ['bundleSha256', 'profileSha256', 'registrySha256']) need(digest(report[field]), `hash ${field}`);
  for (const file of sources) need(digest(report.evidence?.[file]), `source ${file}`);
  same(report.versions?.auth, ['10.9.1', '11.1.0'], 'auth versions');
  need(report.versions?.secretManager === '7.1.0' && report.versions?.gax === '6.5.0'
    && !!report.versions?.workerd && !!report.versions?.miniflare, 'package versions');
  if (!report.sourceBuild) {
    need(Object.keys(report.installedInputs || {}).length >= 4, 'installed provenance');
    for (const [file, hash] of Object.entries(report.installedInputs)) need(/^fixtures\/(worker|google)\/node_modules\/@grpc\/grpc-js\/dist\/[\w/.-]+$/.test(file)
      && !file.split('/').includes('..') && digest(hash), 'installed input');
  }
  const native = report.native;
  need(native?.version === '1.14.0' && native.actualLoadBalancingCall === true && native.controlledReadySubchannel === true && native.networkUsed === false, 'native oracle');
  for (const file of ['package.json', 'load-balancing-call.js', 'call-credentials.js', 'metadata.js', 'control-plane-status.js']) {
    const relative = `fixtures/native/node_modules/@grpc/grpc-js/${file === 'package.json' ? '' : 'build/src/'}${file}`;
    need(digest(native.inputs?.[relative]), `native provenance ${file}`);
  }
  same(native.codes, Object.fromEntries([['undefined', 2], ['16', 16], ['14', 14], ...forbidden.map(code => [String(code), 13])]), 'native restriction table');
  same(native.composition?.completed, ['channel-second', 'per-call', 'channel-first'], 'reverse completion');
  same(native.composition?.metadata, {
    'x-bin': [{ bytes: [0] }, { bytes: [3, 0, 255] }, { bytes: [1, 0, 255] }, { bytes: [2, 0, 255] }],
    'x-caller': ['caller'], 'x-channel-first': ['channel-first'], 'x-channel-second': ['channel-second'], 'x-per-call': ['per-call'],
    'x-repeat': ['caller', 'per-call-first', 'per-call-second', 'channel-first-first', 'channel-first-second', 'channel-second-first', 'channel-second-second'],
    'x-replaced': ['per-call', 'channel-first', 'channel-second'],
  }, 'native complete key semantics');
  need(Array.isArray(report.runs) && report.runs.length === 2, 'runtime matrix');
  for (const runtime of ['node', 'workerd']) {
    const matches = report.runs.filter(run => run.runtime === runtime); need(matches.length === 1, `unique ${runtime}`);
    const run = matches[0];
    need(run.status === 'passed' && run.markerOccurrences === 0 && run.rawCredentialsPersisted === false && run.logSensorCount === 1 && positive(run.logsScanned), `${runtime} execution/redaction`);
    need(run.rows.length === variants.length * 2, `${runtime} row count`);
    for (const mode of ['cloudflare', 'grpc-web']) for (const [id, variant] of variants) {
      const matching = run.rows.filter(row => row.runtime === runtime && row.mode === mode && row.id === id && row.variant === variant);
      need(matching.length === 1 && matching[0].status === 'passed', `${runtime}/${mode}/${id}/${variant}`);
      const row = matching[0], label = `${runtime}/${mode}/${id}/${variant}`;
      if (['AUTH-003', 'AUTH-006', 'AUTH-007', 'AUTH-008', 'AUTH-009', 'AUTH-011'].includes(id)) {
        same(row.cleanup, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }, `${label} cleanup`);
        need(row.callbackCount === 1 && row.terminalCount === 1, `${label} terminal counts`);
      }
      if (id === 'AUTH-003') {
        need(row.fetchCount === 1 && row.nativeMatched === true, `${label} native comparison`);
        same(row.completed, native.composition.completed, `${label} completion`);
        const headers = Object.fromEntries(Object.entries(native.composition.metadata).map(([key, values]) => [key,
          values.map(value => typeof value === 'string' ? value : Buffer.from(value.bytes).toString('base64')).join(', ')]));
        same(row.mergedHeaders, headers, `${label} merged headers`);
      } else if (['AUTH-006', 'AUTH-007', 'AUTH-008'].includes(id)) {
        const inputCode = id === 'AUTH-006' ? null : variant === 'unauthenticated' ? 16 : variant === 'unavailable' ? 14 : Number(variant.slice(10));
        need(row.inputCode === inputCode && row.code === (inputCode === null ? 2 : forbidden.includes(inputCode) ? 13 : inputCode)
          && row.safeDetails === 'WGA_AUTH_METADATA' && row.nativeMatched === true && row.fetchCount === 0 && row.authCalls === 1
          && row.httpStatus === 500 && row.httpErrorScanned === true, `${label} full-call error policy`);
      } else if (id === 'AUTH-009') {
        need(row.code === 13 && row.fetchCount === 0 && row.authCalls === 1 && row.callerAuthorizationPreserved === true, `${label} duplicate authorization`);
      } else if (id === 'AUTH-011') {
        need(row.code === 4 && row.fetchCount === 0 && row.authCalls === 1 && row.metadataCount === 0 && row.errorEventCount === 0
          && row.fakeClock === true && row.earlyTerminalCount === 0 && row.advancedMs === 61000 && row.remainingTimers === 0, `${label} fake deadline`);
        same(row.timerDelays, [1000], `${label} deadline schedule`);
      } else if (id === 'AUTH-014') {
        need(row.code === 'WGA_UNSUPPORTED_TLS' && row.connectorCalls === 0 && row.fetchCount === 0 && row.connectorSensors === 5, `${label} TLS rejection`);
        same(row.connectorNames, ['net.connect', 'net.createConnection', 'tls.connect', 'tls.createSecureContext', 'http2.connect'], `${label} connector sensors`);
      } else if (id === 'AUTH-001' || id === 'AUTH-012') {
        const version = variant.endsWith('11.1.0') ? '11.1.0' : '10.9.1';
        need(row.authVersion === version && row.sdkCalls === 3 && row.rpcCount === 3 && row.tokenRequests === 1, `${label} actual SDK count`);
        same(row.phasesObserved, ['valid', 'refreshed', 'reused'], `${label} observed transition`);
        const receipts = report.receipts?.filter(receipt => receipt.kind === 'oauth' && receipt.runtime === runtime && receipt.mode === mode && receipt.authVersion === version);
        need(receipts?.length === 3 && receipts.every(receipt => receipt.bearerMatched === true && receipt.quotaMatched === true), `${label} RPC credentials`);
        same(receipts.map(receipt => receipt.phase), ['valid', 'refreshed', 'reused'], `${label} RPC phases`);
        need(new Set(receipts.map(receipt => receipt.name)).size === 1, `${label} same SDK resource`);
        const tokens = report.tokenRequests?.filter(receipt => receipt.owner === receipts[0].name);
        need(tokens?.length === 1 && tokens[0].runtime === runtime && tokens[0].requestShapeMatched === true, `${label} token exchange`);
        if (id === 'AUTH-001') need(row.manuallyComposed === false && row.defaultSsl === true && row.bearerMatched === true && row.quotaMatched === true, `${label} GAX default SSL`);
        else {
          need(row.sameSdkClient === true && row.sameAuthClient === true && row.fakeClock === true && row.advancedMs === 3600001 && row.adapterOwnsTokenCache === false, `${label} auth-library refresh`);
          same(row.phases, ['valid', 'refreshed', 'reused'], `${label} refresh phases`);
        }
      } else if (id === 'AUTH-013') {
        need(row.identityCount === 2 && row.parallel === true && row.sdkCreatesAuthFromCredentials === true && row.distinctProjects === true
          && row.distinctClientEmails === true && row.resultIsolation === true && row.quotaIsolation === true && row.signaturesVerified === 2 && row.rpcCount === 2, `${label} service account identity`);
        same(row.completionOrder, [1, 0], `${label} reverse identity completion`);
        const receipts = report.receipts.filter(receipt => receipt.kind === 'service-account' && receipt.runtime === runtime && receipt.mode === mode);
        same(receipts.map(receipt => receipt.identity), [1, 0], `${label} boundary order`);
        for (const receipt of receipts) need(receipt.project === `wga-project-${receipt.identity}`
          && receipt.clientEmail === `account-${receipt.identity}@wga-project-${receipt.identity}.iam.gserviceaccount.com`
          && receipt.quota === `wga-quota-${receipt.identity}` && receipt.signatureVerified === true && receipt.claimsMatched === true && receipt.resultNameMatched === true
          && receipt.name === `projects/${receipt.project}/secrets/${runtime}-${mode}-identity`, `${label} signed boundary identity`);
      } else if (id === 'AUTH-015') {
        need(row.uniqueMarkerInjected === true && row.markerOccurrences === 0 && row.logSensorCount === 1 && positive(row.logsScanned)
          && row.httpErrorsScanned === (mode === 'cloudflare' ? 11 : 22) && positive(row.observerEventsScanned) && row.reportScanned === true, `${label} marker scan`);
        need(Array.isArray(row.emittedHttpArtifacts) && row.emittedHttpArtifacts.length === 11, `${label} HTTP artifacts`);
        for (const artifact of row.emittedHttpArtifacts) {
          let parsed; try { parsed = JSON.parse(artifact); } catch { need(false, `${label} HTTP JSON`); }
          need(parsed?.error?.details === 'WGA_AUTH_METADATA' && typeof parsed.error.stack === 'string', `${label} actual caller error artifact`);
        }
      }
    }
  }
  need(report.receipts.length === 32 && report.tokenRequests.length === 8 && report.caseCount === 112, 'total execution counts');
  need(report.workerHttpScanned === true && positive(report.runtimeLogsScanned) && report.runtimeLogSensorCount === 1
    && report.reportMarkerScanned === true && report.markerOccurrences === 0, 'outer artifact/log scan');
  same(report.catalogCases, catalogCases(report.runs), 'catalog summary');
  need(report.catalogCases.every(row => row.catalogMatch && row.status === 'passed'), 'catalog completeness');
  return report;
}
module.exports = { validateAuthCatalogReport, catalogCases, sources };
