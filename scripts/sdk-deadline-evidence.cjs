'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual: same } = require('node:util');
const { profiles } = require('./sdk-cancellation-evidence.cjs');
const reportFile = 'verification/sdk-deadline.json';
const sources = ['src/sdk.ts', 'scripts/test-sdk-deadline.cjs', 'fixtures/google/shared/sdk-deadline.mjs'];
const scenarios = ['query-lazy', 'query-budget', 'commit-response-lost'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(condition, message) {
  if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: sdk-deadline ${message}`);
}
function validateSdkDeadlineEvidence(root, aggregate) {
  const report = aggregate.sdkDeadline;
  need(report && same(report, JSON.parse(fs.readFileSync(path.join(root, reportFile), 'utf8'))), 'aggregate report drift');
  need(report.status === 'passed' && aggregate.commands?.some(command => command.id === 'sdk-deadline'
    && command.status === 'passed' && command.exitCode === 0), 'completed command and report');
  need(report.liveCloud === false && report.cloudflareTranslation === false && report.controlledFetchPeer === true
    && report.responseLossInjectedLocally === true && report.backendCancellationProven === false, 'local execution scope');
  need(same(Object.keys(report.sourceHashes || {}).sort(), [...sources].sort()), 'source inventory');
  for (const file of sources) need(hash(report.sourceHashes[file])
    && digest(fs.readFileSync(path.join(root, file))) === report.sourceHashes[file], `${file}: source drift`);
  need(Array.isArray(report.profiles) && report.profiles.length === profiles.length, 'profile matrix');
  for (const profile of profiles) {
    const matches = report.profiles.filter(item => item.id === profile.id);
    need(matches.length === 1, 'unique profile');
    const actual = matches[0], declared = JSON.parse(fs.readFileSync(path.join(root, `src/build/profiles/${profile.id}.json`), 'utf8'));
    need(actual.sdkVersion === profile.sdkVersion && actual.build?.profile === profile.id
      && actual.build.revision === declared.revision && actual.build.profileSha256 === digest(JSON.stringify(declared))
      && hash(actual.installedHelperSha256) && hash(actual.bundleSha256), 'SDK, profile and bundle identity');
  }
  need(Array.isArray(report.results) && report.results.length === 24, 'complete runtime/mode/scenario matrix');
  for (const profile of profiles) for (const runtime of ['node', 'workerd']) for (const mode of ['grpc-web', 'cloudflare']) for (const scenario of scenarios) {
    const matches = report.results.filter(row => row.profile === profile.id && row.runtime === runtime && row.mode === mode && row.scenario === scenario);
    need(matches.length === 1 && matches[0].status === 'passed', 'unique passed scenario');
    const { result, trace } = matches[0];
    need(result?.scenario === scenario && result.errorCode === 4
      && same(result.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 })
      && same(result.recoveryRows, [0, 1, 2, 3, 4, 5]) && result.authNetworkRequests === 0, 'deadline, cleanup and client recovery');
    need(Array.isArray(trace) && result.fetches === trace.length
      && trace.every(row => Number.isFinite(row.timeoutMs) && row.timeoutMs > 0), 'physical RPC and timeout accounting');
    const primary = trace.filter(row => row.primary), recovery = trace.filter(row => row.kind === 'Recovery');
    need(same(recovery.map(row => [row.method, row.primary, row.page]),
      [0, 1, 2].map(page => ['RunQuery', false, page])), 'recovery peer sequence');
    const held = scenario === 'query-lazy' ? 0 : 1;
    need(result.held === held && result.aborts === held, 'one local abort per held response');
    need(same(result.partialRows, scenario === 'query-budget' ? [0, 1] : [])
      && result.persisted === (scenario === 'commit-response-lost'), 'partial rows and accepted commit outcome');
    if (scenario === 'query-lazy') need(primary.length === 0 && trace.length === 3 && result.primaryFetches === 0
      && result.deadlineOrigin === 'helper', 'expired lazy operation cannot start an RPC');
    else if (scenario === 'query-budget') need(same(primary.map(row => [row.method, row.kind, row.page]),
      [['RunQuery', 'Primary', 0], ['RunQuery', 'Primary', 1]]) && trace.length === 5 && result.primaryFetches === 2
      && primary[0].timeoutMs <= 1000 && primary[1].timeoutMs <= primary[0].timeoutMs - 75, 'later page uses remaining budget');
    else need(same(primary.map(row => row.method), ['Commit']) && trace.length === 5 && result.primaryFetches === 2
      && trace[1].method === 'Lookup' && trace[1].primary === false, 'response loss is followed by receipt lookup');
  }
  return report;
}
module.exports = { reportFile, validateSdkDeadlineEvidence };
