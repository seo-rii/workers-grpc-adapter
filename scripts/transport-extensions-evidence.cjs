'use strict';
function need(condition, message) { if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: transport-extensions ${message}`); }
const kinds = ['shared-budget', 'concurrent-failures', 'pending-auth', 'rich-status'];
const sources = ['scripts/test-workerd-transport-extensions.cjs', 'scripts/transport-extensions-evidence.cjs',
  'fixtures/worker/transport-extensions.mjs', 'fixtures/worker/package-lock.json'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function validateWorkerdTransportExtensionsReport(report, { allowSourceBuild = false } = {}) {
  need(report?.status === 'passed', 'status');
  need(report.sourceBuild === false || (allowSourceBuild && report.sourceBuild === true), 'installed execution');
  for (const key of ['liveCloud', 'incomingCloudflareTranslation', 'nativeHttp2', 'serviceBindings']) need(report[key] === false, key);
  for (const key of ['controlledPeer', 'runtimeDisposed', 'cleanupVerifiedBeforeDispose']) need(report[key] === true, key);
  need(report.externalRequests === 0, 'external requests');
  need(report.compatibilityDate === '2026-09-21' && typeof report.workerd === 'string' && typeof report.miniflare === 'string', 'runtime identity');
  need(digest(report.bundleSha256), 'bundle hash');
  need(sources.every(file => digest(report.evidence?.[file])), 'source evidence');
  if (!report.sourceBuild) {
    for (const file of ['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'status-details.js', 'status-details.mjs']) {
      need(digest(report.installedInputs?.[`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`]), `installed ${file}`);
    }
  }
  need(Array.isArray(report.runs) && report.runs.length === 2, 'cold/warm runs');
  const ids = new Set();
  for (const run of report.runs) {
    need(run.status === 'passed' && run.resourcesIdle === true && run.moduleIdentity === true && run.activeClientCalls === 0, 'run cleanup and module identity');
    need(run.caseCount === 8 && run.rpcCount === 46 && run.fetchCount === 54 && run.attemptCount === 56, 'run totals');
    need(Array.isArray(run.results) && run.results.length === 8, 'case matrix');
    need(Array.isArray(run.receipts) && run.receipts.length === 54 && Array.isArray(run.cleanup) && run.cleanup.length === 54, 'peer and body receipts');
    for (const body of run.cleanup) need(body.bodyLocked === false && typeof body.ended === 'boolean'
      && body.cancellations === (body.ended ? 0 : 1) && Number.isSafeInteger(body.deliveredBytes) && body.deliveredBytes > 0, 'reader cleanup');
    const runCalls = [];
    for (const mode of ['cloudflare', 'grpc-web']) for (const kind of kinds) {
      const selected = run.results.filter(result => result.mode === mode && result.kind === kind);
      need(selected.length === 1, `${mode}/${kind} case`);
      const result = selected[0];
      const codes = kind === 'shared-budget' ? [14, 14, 14, 14, 0, 0, 0, 0, 14] : Array(kind === 'concurrent-failures' ? 8 : kind === 'pending-auth' ? 2 : 4).fill(kind === 'rich-status' ? 7 : 14);
      const fetches = kind === 'shared-budget' ? [2, 1, 2, 2, 1, 1, 1, 1, 2] : Array(codes.length).fill(1);
      need(Array.isArray(result.calls) && result.calls.length === codes.length, 'call matrix');
      result.calls.forEach((call, index) => {
        need(typeof call.logicalCallId === 'string' && /^wga-[0-9]+$/.test(call.logicalCallId) && !ids.has(call.logicalCallId), 'unique logical IDs'); ids.add(call.logicalCallId);
        need(call.code === codes[index] && call.statuses === 1 && call.callbacks === 1 && call.terminalLast === true, 'exact terminal delivery');
        const expectedAttempts = kind === 'pending-auth' && index === 0 ? 2 : fetches[index];
        need(call.fetches === fetches[index] && call.attempts === expectedAttempts, 'attempt/fetch separation');
        need(Array.isArray(call.attemptFetches) && call.attemptFetches.length === expectedAttempts &&
          call.attemptFetches.every((value, attempt) => value === (attempt < fetches[index])), 'attempt fetch boundary');
        need(Array.isArray(call.attemptCodes) && call.attemptCodes.length === expectedAttempts && call.attemptCodes.every(code => code === codes[index]), 'attempt statuses');
        need(Number.isSafeInteger(call.scheduled) && call.scheduled >= 0 && call.scheduled <= call.attempts, 'retry scheduling');
        const throttled = kind === 'shared-budget' ? Number(codes[index] === 14) : kind === 'concurrent-failures' ? 1 : kind === 'pending-auth' ? Number(index === 0) : 0;
        need(call.throttled === throttled, 'retry-throttled observations');
      });
      runCalls.push(...result.calls);
      const peer = run.receipts.filter(receipt => receipt.mode === mode && receipt.kind === kind);
      need(peer.length === fetches.reduce((sum, value) => sum + value, 0), 'peer fetch count');
      need(peer.every(receipt => receipt.sentBytes === 23 && typeof receipt.retry === 'boolean'), 'request frame bytes');
      need(peer.filter(receipt => receipt.retry).length === (kind === 'shared-budget' ? 4 : 0), 'actual retries');
      if (kind === 'shared-budget') {
        need(JSON.stringify(result.tokens) === '[2,1,1,1,4,2]' && result.otherEndpointTokens === 2 && result.otherFactoryTokens === 2 && result.immutableUsage === true && result.recovered === true, 'shared depletion, isolation and recovery');
      } else if (kind === 'concurrent-failures') {
        need(result.tokens === 0 && result.authCalls === 8 && result.suppressedRetries === 8, 'concurrent failure boundary');
      } else if (kind === 'pending-auth') {
        need(result.tokens === 2 && result.authCalls === 2 && result.suppressedRetries === 1 && result.lateRetryFetches === 0, 'pending-auth boundary');
      } else {
        need(JSON.stringify(result.diagnostics) === JSON.stringify(['valid', 'invalid-protobuf', 'code-mismatch', 'decoder-failed', 'decoder-failed', 'limit-exceeded', 'limit-exceeded', 'multiple-values', 'absent']), 'rich status diagnostics');
        need(result.originalStatusPreserved === true && result.ownedValues === true && result.decoderMismatchCalls === 0 && result.frozenResults === true, 'rich status preservation');
      }
    }
    need(runCalls.length === run.rpcCount && runCalls.reduce((sum, call) => sum + call.fetches, 0) === run.fetchCount
      && runCalls.reduce((sum, call) => sum + call.attempts, 0) === run.attemptCount, 'call totals');
  }
  need(report.caseCount === 16 && report.rpcCount === 92 && report.fetchCount === 108 && report.attemptCount === 112, 'aggregate totals');
}
module.exports = { validateWorkerdTransportExtensionsReport };
