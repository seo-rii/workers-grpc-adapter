'use strict';
const { isDeepStrictEqual } = require('node:util');
const need = (value, message) => { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: security-catalog ${message}`); };
const same = (actual, expected, message) => need(isDeepStrictEqual(actual, expected), message);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ids = ['SEC-001', 'SEC-002', 'SEC-003', 'SEC-004', 'SEC-006', 'SEC-007', 'RETRY-001', 'RETRY-004'];
const sources = ['scripts/test-security-catalog.cjs', 'scripts/security-catalog-evidence.cjs', 'fixtures/worker/security-catalog.mjs',
  'test/security-catalog.test.cjs', 'test/security-catalog-evidence.test.cjs', 'test/retry-interop.test.cjs',
  'fixtures/worker/package-lock.json', 'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json'];
const environment = ['client-certificate-required', 'mtls-endpoint-required', 'both-required'];
const credentials = ['private-key-and-certificate', 'root-certificate', 'verification-options'];
const controls = ['default-environment', 'mtls-disabled', 'auto-without-certificate'];
const invalidMethods = ['/security.Catalog/Unary?x=1', '/security.Catalog/../Unary', '/security.Catalog/%2fUnary',
  '/security.Catalog/%2FUnary', '/security.Catalog/%252fUnary', '/security.Catalog/%2e%2e', '//attacker.test/Unary',
  '/security.Catalog/Unary#x', '/security.Catalog\\Unary', '/security.Catalog/Unary@attacker.test'];
const invalidTargets = ['security-gateway.test?x=1', 'security-gateway.test/..', 'security-gateway.test%2fescape',
  'security-gateway.test%2Fescape', 'security-gateway.test%252fescape', 'user@security-gateway.test',
  'user:pass@security-gateway.test', 'security-gateway.test#x', 'security-gateway.test\\escape'];
function variants(mode) {
  return new Map([
    ['SEC-001', [301, 302, 307, 308].map(code => `redirect-${code}`)],
    ['SEC-002', [...Array.from({ length: 10 }, (_, index) => `method-${index}`), ...Array.from({ length: 9 }, (_, index) => `target-${index}`)]],
    ['SEC-003', ['crlf-key', 'crlf-value']],
    ['SEC-004', mode === 'grpc-web' ? ['cached-google-credential', 'expired-google-credential'] : []],
    ['SEC-006', ['auth-failure', 'fetch-failure']],
    ['SEC-007', [...environment, ...credentials, ...controls]],
  ]);
}
function terminal(call, code, details, label) {
  need(call?.callbacks === 1 && call.values === 0 && call.activeCalls === 0, `${label} single callback and cleanup`);
  same(call.statuses, [{ code, details }], `${label} exact status`);
  need(call.errors?.length === 1 && call.errors[0].code === code && call.errors[0].details === details
    && typeof call.errors[0].message === 'string' && call.errors[0].message.includes(details), `${label} sanitized callback`);
}
function catalogCases(report) {
  return ids.map(id => {
    if (id.startsWith('RETRY')) {
      const result = report.interop?.results?.find(row => row.id === id);
      return { id, status: result?.status, catalogMatch: true, nativeHttp2: report.interop?.nativeHttp2 === true, scenarioCount: id === 'RETRY-001' ? 1 : 3 };
    }
    const runs = report.runs.filter(run => run.rows.some(row => row.id === id));
    return { id, status: 'passed', catalogMatch: true, runtimes: [...new Set(runs.map(run => run.runtime))].sort(),
      modes: [...new Set(runs.map(run => run.mode))].sort(), scenarioCount: runs.reduce((sum, run) => sum + run.rows.filter(row => row.id === id).length, 0),
      ...(id === 'SEC-006' ? { artifactMarkerHits: report.artifactScan?.files.reduce((sum, file) => sum + file.markerHits, 0) } : {}) };
  });
}
function validateSecurityCatalogReport(report, { allowSourceBuild = false } = {}) {
  need(report?.status === 'passed' && report.runtimeDisposed === true, 'complete report and runtime cleanup');
  need(report.sourceBuild === false || allowSourceBuild && report.sourceBuild === true, 'installed-package execution');
  need(report.liveCloud === false && report.productionTls === false && report.incomingCloudflareTranslation === false, 'honest local scope');
  need(report.externalRequests === 0, 'no unrelated external requests');
  need(report.compatibilityDate === '2026-09-21' && /^v\d+\./.test(report.node) && typeof report.workerd === 'string' && typeof report.miniflare === 'string', 'exact runtime profile');
  need(hash(report.bundleSha256), 'bundle fingerprint');
  for (const file of sources) need(hash(report.evidence?.[file]), `source fingerprint ${file}`);
  for (const [file, digest] of Object.entries(report.installedInputs ?? {})) need(hash(digest) && file.includes('/node_modules/'), 'installed input fingerprint');
  need(Object.keys(report.installedInputs ?? {}).some(file => file.includes('/google-auth-library/')), 'real bundled Google auth input');
  if (!report.sourceBuild) need(Object.keys(report.installedInputs).some(file => file.includes('/@grpc/grpc-js/dist/credentials.js')), 'installed credential guard');
  need(Object.keys(report.nativeInputs ?? {}).some(file => file.startsWith('fixtures/native/node_modules/@grpc/grpc-js/'))
    && Object.keys(report.nativeInputs).some(file => file.includes('/google-gax/')), 'native and GAX provenance');
  for (const digest of Object.values(report.nativeInputs)) need(hash(digest), 'native input hash');
  need(Array.isArray(report.runs) && report.runs.length === 4, 'four runtime/mode runs');
  same(report.runs.map(run => `${run.runtime}/${run.mode}`).sort(), ['node/cloudflare', 'node/grpc-web', 'workerd/cloudflare', 'workerd/grpc-web'], 'runtime/mode matrix');
  for (const run of report.runs) {
    need(run.status === 'passed' && Array.isArray(run.rows), 'passed run');
    const expected = [...variants(run.mode)].flatMap(([id, values]) => values.map(variant => `${id}/${variant}`));
    same(run.rows.map(row => `${row.id}/${row.variant}`).sort(), expected.sort(), 'complete nonduplicate vector matrix');
    need(Array.isArray(run.logs) && Array.isArray(run.observer) && run.observer.length > 0, 'captured diagnostic surfaces');
    for (const row of run.rows) {
      const label = `${run.runtime}/${run.mode}/${row.id}/${row.variant}`;
      need(row.status === 'passed', `${label} executed`);
      if (row.id === 'SEC-001') {
        need(row.fetchCount === 1 && row.authCalls === 1 && row.manualRedirect === true && row.variant === `redirect-${row.httpStatus}`, `${label} one manual fetch with bearer`);
        terminal(row.call, 2, 'WGA_REDIRECT_BLOCKED', label);
      } else if (row.id === 'SEC-002') {
        need(row.fetchCount === 0 && row.authCalls === 0 && row.outgoingHeaders === 0, `${label} preauth/prenetwork rejection`);
        same(row.vector, (row.variant.startsWith('method-') ? invalidMethods : invalidTargets)[Number(row.variant.split('-')[1])], `${label} exact attempted vector`);
        if (row.variant.startsWith('method-')) terminal(row.call, 13, 'WGA_INVALID_METHOD', label);
        else need(row.errorCode === 'WGA_INVALID_TARGET', `${label} constructor rejection`);
      } else if (row.id === 'SEC-003') {
        need(row.fetchCount === 0 && row.outgoingHeaders === 0 && row.authCalls === 1 && row.directMetadataRejected === true, `${label} no injected header`);
        terminal(row.call, 2, 'WGA_AUTH_METADATA', label);
      } else if (row.id === 'SEC-004') {
        need(row.realGoogleCredential === true && row.insecureCompositionRejected === true && row.secureHttpRouteRejected === true, `${label} real Google guard variants`);
        for (const key of ['fetchCount', 'tokenRequests', 'credentialCalls', 'tokenTransmissions']) need(row[key] === 0, `${label} zero ${key}`);
        terminal(row.call, 16, 'WGA_INSECURE_AUTH', label);
      } else if (row.id === 'SEC-006') {
        const fetching = row.variant === 'fetch-failure';
        need(row.fetchCount === Number(fetching) && row.authCalls === 1 && row.redacted === true, `${label} marker failure was exercised`);
        need(row.payloadMatched === fetching && row.bearerMatched === fetching, `${label} auth and payload reached controlled failure`);
        terminal(row.call, fetching ? 14 : 16, fetching ? 'WGA_FETCH_FAILED' : 'WGA_AUTH_METADATA', label);
      } else {
        need(row.fetchCount === 0 && row.tokenRequests === 0, `${label} no insecure side effects`);
        if (controls.includes(row.variant)) need(row.acceptedControl === true, `${label} default preserved`);
        else need(row.errorCode === 'WGA_UNSUPPORTED_TLS' && (environment.includes(row.variant) ? row.environmentRejected === true : row.credentialRejected === true), `${label} required TLS rejected explicitly`);
        if (environment.includes(row.variant)) need(row.credentialCalls === 0 && row.realGoogleCredential === true, `${label} real credential not evaluated`);
      }
    }
  }
  const network = report.networkReceipts;
  need(Array.isArray(network) && network.length === 16, 'redirect peer receipt count');
  same(network.map(row => `${row.runtime}/${row.mode}/${row.httpStatus}`).sort(), ['node', 'workerd'].flatMap(runtime => ['cloudflare', 'grpc-web'].flatMap(mode => [301, 302, 307, 308].map(code => `${runtime}/${mode}/${code}`))).sort(), 'all redirect attacker origins');
  for (const row of network) need(row.gatewayArrivals === 1 && row.gatewayBearerMatches === 1 && row.attackerArrivals === 0 && row.attackerBearerArrivals === 0, 'no attacker arrival or bearer leak');
  const interop = report.interop;
  need(interop?.status === 'passed' && interop.nativeHttp2 === true && interop.trustedLoopbackFetcher === true
    && interop.productionTls === false && interop.liveGoogle === false && interop.cleanupVerifiedBeforeShutdown === true, 'native interop scope and cleanup');
  for (const key of ['nativeVersion', 'googleAuthVersion', 'gaxVersion']) need(/^\d+\./.test(interop[key]), `pinned interop ${key}`);
  same(interop.results?.map(row => row.id), ['RETRY-001', 'RETRY-004'], 'native retry case matrix');
  const [once, auth] = interop.results;
  need(once.status === 'passed' && once.dataFetches === 1 && once.bridgeArrivals === 1 && once.serverArrivals === 1 && once.tokenRequests === 0 && once.adapterRetryConfigured === false, 'one native UNAVAILABLE arrival');
  same(once.calls, [{ scenario: 'direct-unavailable', callbacks: 1, statuses: [{ code: 14, details: 'controlled unavailable' }], callbackCode: 14 }], 'native UNAVAILABLE terminal');
  need(auth.status === 'passed' && auth.adapterRetryConfigured === false && auth.activeCalls === 0, 'authenticated call cleanup');
  for (const [key, value] of Object.entries({ tokenRequests: 1, dataFetches: 4, bridgeArrivals: 4, serverArrivals: 4, serverBearerMatches: 3,
    serverBearerUnexpected: 0, tokenRequestShapeMatches: 1, gaxLogicalCalls: 1, gaxNewGrpcCalls: 2 })) need(auth[key] === value, `separate auth/data/GAX counter ${key}`);
  same(auth.calls?.map(call => [call.scenario, call.callbacks, call.callbackCode, call.statuses.length, call.statuses[0]?.code]),
    [['direct-unavailable', 1, 14, 1, 14], ['auth-success', 1, 0, 1, 0], ['gax-retry', 1, 14, 1, 14], ['gax-retry', 1, 0, 1, 0]], 'four independent grpc calls');
  same(auth.arrivals, [{ scenario: 'direct-unavailable', bearerMatched: false }, { scenario: 'auth-success', bearerMatched: true },
    { scenario: 'gax-retry', bearerMatched: true }, { scenario: 'gax-retry', bearerMatched: true }], 'native server authentication receipts');
  same(auth.adapterCallEnds?.map(event => [event.attemptCount, event.fetchCount, event.statusCode]), [[1, 1, 14], [1, 1, 0], [1, 1, 14], [1, 1, 0]], 'one attempt per new GAX grpc call');
  const scan = report.artifactScan;
  need(scan?.markerCount === 2 && scan.markerGeneration === 'runtime-random-256-bit' && scan.finalReportClean === true, 'fresh markers and final report scan');
  same(scan.positiveControlHits, ['log', 'report', 'source-map'].map(kind => ({ kind, hits: 2 })), 'scanner positive controls');
  need(Array.isArray(scan.files) && scan.files.length >= 4 && new Set(scan.files.map(file => file.path)).size === scan.files.length, 'unique artifact inventory');
  for (const file of scan.files) need(typeof file.path === 'string' && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && hash(file.sha256) && file.markerHits === 0, 'zero secret marker artifacts');
  for (const file of ['verification/security-catalog.json', 'verification/security-catalog/runtime.log', 'verification/security-catalog/calls.json', 'verification/security-catalog/worker.mjs.map']) {
    need(scan.files.some(row => row.path === file && row.bytes > 0), `scanned ${file}`);
  }
  for (const name of ['runtime.log', 'calls.json', 'worker.mjs', 'worker.mjs.map']) {
    const file = `verification/security-catalog/${name}`;
    need(hash(report.artifactInputs?.[file]) && scan.files.some(row => row.path === file && row.sha256 === report.artifactInputs[file]), `owned artifact hash ${name}`);
  }
  same(report.nativePadding, [{ input: 'AQI=', decodedHex: ['0102'] }, { input: 'AQI', decodedHex: ['0102'] },
    { input: 'AQI==', decodedHex: ['0102'] }, { input: 'AQ=', decodedHex: ['01'] }, { input: 'AAAA=', decodedHex: ['000000'] }], 'measured native base64 policy difference');
  need(typeof report.nativePaddingPolicyDifference === 'string' && report.nativePaddingPolicyDifference.includes('permissive'), 'documented native padding difference');
  same(report.catalogCases, catalogCases(report), 'derived catalog summary');
  return report;
}
module.exports = { validateSecurityCatalogReport, catalogCases, variants, invalidMethods, invalidTargets };
