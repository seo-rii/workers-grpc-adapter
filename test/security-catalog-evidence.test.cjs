'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { catalogCases, variants, invalidMethods, invalidTargets, validateSecurityCatalogReport } = require('../scripts/security-catalog-evidence.cjs');
const { sources, scanArtifacts } = require('../scripts/test-security-catalog.cjs');
const hash = 'a'.repeat(64);
const failure = (code, details) => ({ callbacks: 1, statuses: [{ code, details }], errors: [{ code, details, message: `${code}: ${details}` }], values: 0, activeCalls: 0 });
function fixture() {
  const report = { status: 'passed', runtimeDisposed: true, sourceBuild: false, liveCloud: false, productionTls: false, incomingCloudflareTranslation: false,
    externalRequests: 0, compatibilityDate: '2026-09-21', node: 'v24.1.0', workerd: '1.20260921.0', miniflare: '5.20260921.0-alpha', bundleSha256: hash,
    evidence: Object.fromEntries(sources.map(file => [file, hash])),
    installedInputs: { 'fixtures/worker/node_modules/@grpc/grpc-js/dist/credentials.js': hash, 'fixtures/google/node_modules/google-auth-library/build/src/auth/oauth2client.js': hash },
    nativeInputs: { 'fixtures/native/node_modules/@grpc/grpc-js/build/src/index.js': hash, 'fixtures/google/node_modules/google-gax/build/src/gax.js': hash }, runs: [], networkReceipts: [] };
  for (const runtime of ['node', 'workerd']) for (const mode of ['cloudflare', 'grpc-web']) {
    const rows = [];
    for (const [id, names] of variants(mode)) for (const variant of names) {
      let row;
      if (id === 'SEC-001') {
        const httpStatus = Number(variant.slice(9));
        row = { httpStatus, fetchCount: 1, authCalls: 1, manualRedirect: true, call: failure(2, 'WGA_REDIRECT_BLOCKED') };
        report.networkReceipts.push({ runtime, mode, httpStatus, gatewayArrivals: 1, gatewayBearerMatches: 1, attackerArrivals: 0, attackerBearerArrivals: 0 });
      } else if (id === 'SEC-002') row = { fetchCount: 0, authCalls: 0, outgoingHeaders: 0, vector: (variant.startsWith('method-') ? invalidMethods : invalidTargets)[Number(variant.split('-')[1])],
        ...(variant.startsWith('method-') ? { call: failure(13, 'WGA_INVALID_METHOD') } : { errorCode: 'WGA_INVALID_TARGET' }) };
      else if (id === 'SEC-003') row = { fetchCount: 0, outgoingHeaders: 0, authCalls: 1, directMetadataRejected: true, call: failure(2, 'WGA_AUTH_METADATA') };
      else if (id === 'SEC-004') row = { realGoogleCredential: true, insecureCompositionRejected: true, secureHttpRouteRejected: true,
        fetchCount: 0, tokenRequests: 0, credentialCalls: 0, tokenTransmissions: 0, call: failure(16, 'WGA_INSECURE_AUTH') };
      else if (id === 'SEC-006') {
        const fetching = variant === 'fetch-failure';
        row = { fetchCount: Number(fetching), authCalls: 1, redacted: true, payloadMatched: fetching, bearerMatched: fetching,
          call: failure(fetching ? 14 : 16, fetching ? 'WGA_FETCH_FAILED' : 'WGA_AUTH_METADATA') };
      } else {
        const environment = ['client-certificate-required', 'mtls-endpoint-required', 'both-required'].includes(variant);
        const control = ['default-environment', 'mtls-disabled', 'auto-without-certificate'].includes(variant);
        row = { fetchCount: 0, tokenRequests: 0, ...(environment ? { credentialCalls: 0, realGoogleCredential: true } : {}), ...(control ? { acceptedControl: true } : { errorCode: 'WGA_UNSUPPORTED_TLS', [environment ? 'environmentRejected' : 'credentialRejected']: true }) };
      }
      rows.push({ id, variant, status: 'passed', ...row });
    }
    report.runs.push({ runtime, mode, status: 'passed', rows, logs: [], observer: [{ type: 'call-start' }] });
  }
  const calls = [['direct-unavailable', 14], ['auth-success', 0], ['gax-retry', 14], ['gax-retry', 0]].map(([scenario, code]) => ({ scenario, callbacks: 1,
    statuses: [{ code, details: code ? 'controlled unavailable' : '' }], callbackCode: code }));
  report.interop = { status: 'passed', nativeHttp2: true, trustedLoopbackFetcher: true, productionTls: false, liveGoogle: false,
    cleanupVerifiedBeforeShutdown: true, nativeVersion: '1.13.4', googleAuthVersion: '10.9.1', gaxVersion: '5.0.0', results: [
      { id: 'RETRY-001', status: 'passed', dataFetches: 1, serverArrivals: 1, bridgeArrivals: 1, tokenRequests: 0, calls: [calls[0]], adapterRetryConfigured: false },
      { id: 'RETRY-004', status: 'passed', tokenRequests: 1, dataFetches: 4, bridgeArrivals: 4, serverArrivals: 4, serverBearerMatches: 3, serverBearerUnexpected: 0,
        tokenRequestShapeMatches: 1, gaxLogicalCalls: 1, gaxNewGrpcCalls: 2, adapterRetryConfigured: false, activeCalls: 0, calls,
        arrivals: calls.map(call => ({ scenario: call.scenario, bearerMatched: call.scenario !== 'direct-unavailable' })),
        adapterCallEnds: [14, 0, 14, 0].map(statusCode => ({ attemptCount: 1, fetchCount: 1, statusCode })) },
    ] };
  report.artifactScan = { markerCount: 2, markerGeneration: 'runtime-random-256-bit', finalReportClean: true,
    positiveControlHits: ['log', 'report', 'source-map'].map(kind => ({ kind, hits: 2 })),
    files: ['verification/security-catalog.json', 'verification/security-catalog/runtime.log', 'verification/security-catalog/calls.json', 'verification/security-catalog/worker.mjs.map', 'verification/security-catalog/worker.mjs']
      .map(path => ({ path, bytes: 100, sha256: hash, markerHits: 0 })) };
  report.nativePadding = [{ input: 'AQI=', decodedHex: ['0102'] }, { input: 'AQI', decodedHex: ['0102'] }, { input: 'AQI==', decodedHex: ['0102'] },
    { input: 'AQ=', decodedHex: ['01'] }, { input: 'AAAA=', decodedHex: ['000000'] }];
  report.nativePaddingPolicyDifference = 'Native permissive base64 decoding differs from strict adapter.';
  report.artifactInputs = Object.fromEntries(['runtime.log', 'calls.json', 'worker.mjs', 'worker.mjs.map'].map(name => [`verification/security-catalog/${name}`, hash]));
  report.catalogCases = catalogCases(report); return report;
}
const mutateRejects = mutation => { const report = fixture(); mutation(report); assert.throws(() => validateSecurityCatalogReport(report), /WGA_EVIDENCE_INVALID/); };
test('EVIDENCE security accepts complete measured matrix and derives eight catalog cases', () => {
  const report = fixture(); validateSecurityCatalogReport(report); assert.equal(report.catalogCases.length, 8);
});
test('EVIDENCE security rejects missing vectors duplicate runs or unmeasured credential leaks', () => {
  for (const mutation of [r => r.runs[0].rows.pop(), r => r.runs[3] = r.runs[0], r => r.networkReceipts[0].attackerArrivals++,
    r => r.networkReceipts[0].attackerBearerArrivals++, r => r.networkReceipts[0].gatewayBearerMatches = 0,
    r => r.runs[1].rows.find(row => row.id === 'SEC-004').tokenTransmissions++, r => r.runs[0].rows.find(row => row.id === 'SEC-003').outgoingHeaders++,
    r => r.runs[0].rows.find(row => row.id === 'SEC-007').environmentRejected = false]) mutateRejects(mutation);
});
test('EVIDENCE security rejects conflated auth data GAX counts and weak terminal evidence', () => {
  for (const mutation of [r => r.interop.results[0].serverArrivals++, r => r.interop.results[1].tokenRequests = 4,
    r => r.interop.results[1].gaxNewGrpcCalls = 1, r => r.interop.results[1].adapterCallEnds[2].attemptCount = 2,
    r => r.interop.results[1].serverBearerMatches = 0, r => r.runs[0].rows[0].call.callbacks = 2]) mutateRejects(mutation);
});
test('EVIDENCE security rejects marker leaks missing maps stale summaries and absent provenance', () => {
  for (const mutation of [r => r.artifactScan.files[0].markerHits++, r => r.artifactScan.files.pop(), r => r.artifactScan.positiveControlHits[0].hits = 0,
    r => r.catalogCases[0].scenarioCount = 1, r => r.evidence = {}, r => r.installedInputs = {}, r => r.sourceBuild = true,
    r => r.nativePadding[2].decodedHex = [], r => r.runtimeDisposed = false]) mutateRejects(mutation);
});
test('SECURITY artifact scanner detects injected auth and payload markers in log report and map files', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-security-scan-'));
  try {
    const files = ['runtime.log', 'report.json', 'worker.mjs.map'].map(name => path.join(directory, name));
    for (const file of files) fs.writeFileSync(file, 'synthetic-auth-marker synthetic-payload-marker', { mode: 0o600 });
    assert.deepEqual(scanArtifacts(files, ['synthetic-auth-marker', 'synthetic-payload-marker']).map(row => row.markerHits), [2, 2, 2]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
