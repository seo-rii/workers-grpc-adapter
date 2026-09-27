'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkerdTransportExtensionsReport } = require('../scripts/transport-extensions-evidence.cjs');
function fixture() {
  let sequence = 0;
  const runs = Array.from({ length: 2 }, () => {
    const results = [], receipts = [], cleanup = [];
    for (const mode of ['cloudflare', 'grpc-web']) for (const kind of ['shared-budget', 'concurrent-failures', 'pending-auth', 'rich-status']) {
      const codes = kind === 'shared-budget' ? [14, 14, 14, 14, 0, 0, 0, 0, 14]
        : Array(kind === 'concurrent-failures' ? 8 : kind === 'pending-auth' ? 2 : 4).fill(kind === 'rich-status' ? 7 : 14);
      const fetches = kind === 'shared-budget' ? [2, 1, 2, 2, 1, 1, 1, 1, 2] : Array(codes.length).fill(1);
      const calls = codes.map((code, index) => {
        const attempts = kind === 'pending-auth' && index === 0 ? 2 : fetches[index];
        for (let attempt = 0; attempt < fetches[index]; attempt++) {
          receipts.push({ mode, kind, sentBytes: 23, retry: attempt > 0 });
          cleanup.push({ bodyLocked: false, ended: false, cancellations: 1, deliveredBytes: 32 });
        }
        return { logicalCallId: `wga-${++sequence}`, code, statuses: 1, callbacks: 1, terminalLast: true,
          fetches: fetches[index], attempts, attemptFetches: Array.from({ length: attempts }, (_, attempt) => attempt < fetches[index]),
          attemptCodes: Array(attempts).fill(code), scheduled: attempts - 1,
          throttled: kind === 'shared-budget' ? Number(code === 14) : kind === 'concurrent-failures' ? 1 : kind === 'pending-auth' ? Number(index === 0) : 0 };
      });
      results.push({ mode, kind, calls,
        ...(kind === 'shared-budget' ? { tokens: [2, 1, 1, 1, 4, 2], otherEndpointTokens: 2, otherFactoryTokens: 2, immutableUsage: true, recovered: true } : {}),
        ...(kind === 'concurrent-failures' ? { tokens: 0, authCalls: 8, suppressedRetries: 8 } : {}),
        ...(kind === 'pending-auth' ? { tokens: 2, authCalls: 2, suppressedRetries: 1, lateRetryFetches: 0 } : {}),
        ...(kind === 'rich-status' ? { diagnostics: ['valid', 'invalid-protobuf', 'code-mismatch', 'decoder-failed', 'decoder-failed', 'limit-exceeded', 'limit-exceeded', 'multiple-values', 'absent'], originalStatusPreserved: true, ownedValues: true, decoderMismatchCalls: 0, frozenResults: true } : {}),
      });
    }
    return { status: 'passed', resourcesIdle: true, moduleIdentity: true, activeClientCalls: 0,
      caseCount: 8, rpcCount: 46, fetchCount: 54, attemptCount: 56, results, receipts, cleanup };
  });
  return { status: 'passed', sourceBuild: false, liveCloud: false, incomingCloudflareTranslation: false, nativeHttp2: false,
    serviceBindings: false, controlledPeer: true, runtimeDisposed: true, cleanupVerifiedBeforeDispose: true, externalRequests: 0,
    compatibilityDate: '2026-09-21', workerd: 'test', miniflare: 'test', bundleSha256: 'a'.repeat(64),
    installedInputs: Object.fromEntries(['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'status-details.js', 'status-details.mjs']
      .map(file => [`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`, 'a'.repeat(64)])),
    evidence: Object.fromEntries(['scripts/test-workerd-transport-extensions.cjs', 'scripts/transport-extensions-evidence.cjs',
      'fixtures/worker/transport-extensions.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, 'a'.repeat(64)])),
    runs, caseCount: 16, rpcCount: 92, fetchCount: 108, attemptCount: 112 };
}
test('EVIDENCE transport extensions requires installed cold/warm execution and complete retry/status invariants', () => {
  validateWorkerdTransportExtensionsReport(fixture());
  const mutations = [
    report => { report.status = 'failed'; }, report => { report.sourceBuild = true; },
    report => { report.liveCloud = true; }, report => { report.incomingCloudflareTranslation = true; },
    report => { report.nativeHttp2 = true; }, report => { report.serviceBindings = true; },
    report => { report.controlledPeer = false; }, report => { report.runtimeDisposed = false; },
    report => { report.cleanupVerifiedBeforeDispose = false; }, report => { report.externalRequests = 1; },
    report => { report.compatibilityDate = '2020-01-01'; }, report => { report.bundleSha256 = ''; },
    report => { report.installedInputs = {}; }, report => { delete report.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/dist/status-details.mjs']; },
    report => { delete report.evidence['scripts/transport-extensions-evidence.cjs']; }, report => { report.runs.pop(); },
    report => { report.runs[0].moduleIdentity = false; }, report => { report.runs[0].resourcesIdle = false; },
    report => { report.runs[0].activeClientCalls = 1; }, report => { report.runs[0].results.pop(); },
    report => { report.runs[0].results[0].tokens[1] = 2; }, report => { report.runs[0].results[0].otherFactoryTokens = 1; },
    report => { report.runs[0].results[0].otherEndpointTokens = 1; }, report => { report.runs[0].results[0].recovered = false; },
    report => { report.runs[0].results[1].authCalls++; }, report => { report.runs[0].results[1].suppressedRetries--; },
    report => { report.runs[0].results[2].tokens--; }, report => { report.runs[0].results[2].lateRetryFetches++; },
    report => { report.runs[0].results[3].diagnostics.pop(); }, report => { report.runs[0].results[3].originalStatusPreserved = false; },
    report => { report.runs[0].results[3].ownedValues = false; }, report => { report.runs[0].results[3].decoderMismatchCalls = 1; },
    report => { report.runs[0].results[3].frozenResults = false; }, report => { report.runs[0].results[0].calls[0].statuses = 2; },
    report => { report.runs[0].results[0].calls[0].callbacks = 0; }, report => { report.runs[0].results[0].calls[0].terminalLast = false; },
    report => { report.runs[0].results[2].calls[0].attemptFetches[1] = true; }, report => { report.runs[0].results[2].calls[0].attemptCodes[1] = 0; },
    report => { report.runs[0].results[2].calls[0].throttled = 0; }, report => { report.runs[0].results[2].calls[0].fetches = 2; },
    report => { report.runs[0].cleanup[0].bodyLocked = true; }, report => { report.runs[0].cleanup[0].cancellations = 0; },
    report => { report.runs[0].receipts[0].sentBytes++; }, report => { report.runs[0].receipts[0].retry = true; },
    report => { report.rpcCount--; }, report => { report.fetchCount++; },
    report => { report.runs[1].results[0].calls[0].logicalCallId = report.runs[0].results[0].calls[0].logicalCallId; },
  ];
  for (const mutate of mutations) { const report = fixture(); mutate(report); assert.throws(() => validateWorkerdTransportExtensionsReport(report), /WGA_EVIDENCE_INVALID/); }
});
test('EVIDENCE source-build development mode is explicit and keeps runtime checks', () => {
  const report = fixture(); report.sourceBuild = true; report.installedInputs = {};
  assert.throws(() => validateWorkerdTransportExtensionsReport(report), /WGA_EVIDENCE_INVALID/);
  validateWorkerdTransportExtensionsReport(report, { allowSourceBuild: true });
  report.runs[0].results[2].lateRetryFetches = 1;
  assert.throws(() => validateWorkerdTransportExtensionsReport(report, { allowSourceBuild: true }), /WGA_EVIDENCE_INVALID/);
});
