'use strict';
const { isDeepStrictEqual: same } = require('node:util');
const scenarios = [
  'query-complete', 'query-destroy-first', 'query-break-first', 'query-destroy-inflight',
  'query-abort-inflight', 'query-precancel', 'query-lazy-cancel', 'query-shared-concurrent',
  'commit-complete', 'commit-cancel-inflight', 'commit-abort-inflight', 'commit-precancel',
  'commit-lazy-cancel', 'commit-completion-first', 'commit-shared-concurrent',
  'transaction-cancel-inflight', 'transaction-completion-first',
];
const profiles = [
  { id: 'google-static-v1', fixture: 'google', sdkVersion: '10.1.1', revision: 5,
    generatedPackage: '@google-cloud/datastore', generatedVersion: '10.1.1' },
  { id: 'google-modern-v1', fixture: 'modern', sdkVersion: '11.1.0', revision: 2,
    generatedPackage: '@google-cloud/datastore-api', generatedVersion: '0.3.0' },
];
const sources = ['scripts/test-sdk-cancellation.cjs', 'scripts/sdk-cancellation-evidence.cjs',
  'fixtures/google/shared/sdk-cancellation.mjs', 'fixtures/worker/sdk-cancellation.mjs',
  'test/sdk-cancellation-evidence.test.cjs', 'src/sdk.ts', 'src/call.ts', 'src/channel.ts', 'src/client.ts',
  'scripts/build.cjs', 'package.json', 'fixtures/google/package-lock.json',
  'fixtures/modern/package-lock.json', 'fixtures/worker/package-lock.json'];
const installed = ['@grpc/grpc-js/package.json', '@grpc/grpc-js/dist/sdk.js', '@grpc/grpc-js/dist/sdk.mjs',
  '@grpc/grpc-js/dist/index.js', '@grpc/grpc-js/dist/call.js', '@grpc/grpc-js/dist/channel.js',
  '@google-cloud/datastore/package.json', '@google-cloud/datastore/build/src/request.js',
  '@google-cloud/datastore/build/src/transaction.js', 'google-gax/package.json', 'google-auth-library/package.json'];
function installedForProfile(profile) {
  return [...new Set([...installed, `${profile.generatedPackage}/package.json`,
    `${profile.generatedPackage}/build/src/v1/datastore_client.js`, `${profile.generatedPackage}/build/protos/protos.json`])];
}
function extensionCases(results) {
  return ['sdk-query-cancellation', 'sdk-call-cancellation'].map(id => {
    const selected = results.filter(row => row.scenario.startsWith('query-') === (id === 'sdk-query-cancellation'));
    return { id, status: selected.every(row => row.status === 'passed') ? 'passed' : 'failed', scenarioCount: selected.length,
      profiles: profiles.map(profile => profile.id), runtimes: ['node', 'workerd'], modes: ['grpc-web', 'cloudflare'] };
  });
}
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const zeroExecution = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
function need(condition, reason) { if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: sdk-cancellation ${reason}`); }
function complete() {
  return { ranks: [0, 1, 2, 3, 4, 5], names: [0, 1, 2, 3, 4, 5].map(rank => `row-${rank}`), errors: [], end: 1, close: 1 };
}
function expectedBusiness(scenario) {
  const isQuery = scenario.startsWith('query-'), pre = scenario.endsWith('-precancel'), lazy = scenario.endsWith('-lazy-cancel');
  const cancelled = !isQuery && (pre || lazy || scenario.endsWith('-inflight') || scenario === 'commit-shared-concurrent');
  let original = null, concurrent = null;
  if (isQuery) {
    if (scenario === 'query-complete') original = complete();
    else {
      const ranks = pre || lazy ? [] : scenario.endsWith('-first') ? [0] : [0, 1];
      original = { ranks, names: ranks.map(rank => `row-${rank}`),
        errors: pre || scenario === 'query-abort-inflight' ? [1] : scenario === 'query-break-first' ? ['ABORT_ERR'] : [], end: 0, close: 1 };
    }
    if (scenario === 'query-shared-concurrent') concurrent = complete();
  } else if (scenario === 'commit-shared-concurrent') concurrent = { committed: 'concurrent', mutations: 1 };
  return { scenario, started: pre ? 0 : 1, original, concurrent, reused: complete(),
    resolved: isQuery || cancelled ? 0 : 1, rejected: cancelled ? 1 : 0, errorCodes: cancelled ? [1] : [],
    persisted: !isQuery && !pre && !lazy ? { name: 'primary', rank: 41 } : null,
    lazyBarrier: lazy ? isQuery ? 'project-id-resolution' : 'gapic-initialize-promise' : null,
    overlapAtCancel: scenario.endsWith('-shared-concurrent') ? { activeCalls: 2, pendingResponses: 2 } : null, authNetworkRequests: 0 };
}
function expectedTrace(scenario) {
  const result = [];
  const query = (kind, count, afterRelease) => { for (let page = 0; page < count; page++) {
    const cancelTarget = kind === 'Primary' && page === 1 && (scenario.endsWith('-inflight') || scenario === 'query-shared-concurrent');
    result.push({ method: 'RunQuery', kind, cursor: page ? `cursor-${page * 2}` : '', limit: 6 - page * 2, key: null, afterRelease,
      held: cancelTarget || kind === 'Concurrent' && page === 0 && scenario === 'query-shared-concurrent', cancelTarget });
  } };
  const call = (method, key = null, cancelTarget = false) => result.push({ method, kind: null, cursor: null, limit: null, key, afterRelease: false,
    held: cancelTarget || method === 'Commit' && key === 'concurrent' && scenario === 'commit-shared-concurrent', cancelTarget });
  if (scenario.startsWith('query-')) {
    query('Primary', scenario === 'query-complete' ? 3 : scenario.endsWith('-precancel') || scenario.endsWith('-lazy-cancel') ? 0
      : scenario.endsWith('-first') ? 1 : 2, false);
    if (scenario === 'query-shared-concurrent') query('Concurrent', 3, false);
  } else if (!scenario.endsWith('-precancel') && !scenario.endsWith('-lazy-cancel')) {
    if (scenario.startsWith('transaction-')) call('BeginTransaction');
    call('Commit', 'primary', scenario.endsWith('-inflight') || scenario === 'commit-shared-concurrent');
    if (scenario === 'commit-shared-concurrent') call('Commit', 'concurrent');
    if (scenario === 'transaction-cancel-inflight') call('Rollback');
    call('Lookup', 'primary');
  }
  query('Recovery', 3, true); return result;
}
function validateSdkCancellationReport(report) {
  need(report?.status === 'passed' && report.runtimeDisposed === true, 'completed execution and disposal');
  need(report.liveCloud === false && report.cloudflareTranslation === false && report.officialEmulator === false
    && report.controlledFetchPeer === true && report.backendCancellationProven === false
    && report.optionalExtensions === true && report.upstreamSdkBehaviorChanged === false, 'explicit local optional-extension boundary');
  need(same(report.instrumentation, { channelDiagnostics: true, observer: true, localAbortSignal: true,
    projectIdResolutionBarrier: true, resourcesBeforeSdkClose: true }), 'instrumentation disclosure');
  need(report.compatibilityDate === '2026-09-21' && /^v\d+\.\d+\.\d+/.test(report.runtime)
    && same(report.versions, { workerd: '1.20261006.1', miniflare: '5.20261006.0-alpha' }), 'pinned workerd runtime provenance');
  need(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt))
    && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'execution interval');
  need(same(Object.keys(report.evidence ?? {}).sort(), [...sources].sort())
    && sources.every(file => hash(report.evidence[file])), 'exact source manifest');
  need(Array.isArray(report.profiles) && report.profiles.length === profiles.length, 'both supported SDK profiles');
  for (const expected of profiles) {
    const matches = report.profiles.filter(profile => profile.id === expected.id);
    need(matches.length === 1, 'unique profile'); const profile = matches[0];
    need(profile.status === 'passed' && profile.fixture === expected.fixture && profile.sdkVersion === expected.sdkVersion
      && profile.generatedPackage === expected.generatedPackage && profile.generatedVersion === expected.generatedVersion
      && profile.revision === expected.revision && hash(profile.bundleSha256), 'pinned SDK and bundle');
    need(profile.build?.profile === expected.id && profile.build.revision === expected.revision
      && hash(profile.build.profileSha256) && hash(profile.build.registrySha256), 'pinned Worker transform');
    const expectedInstalled = installedForProfile(expected);
    need(same(Object.keys(profile.installedInputs ?? {}).sort(), [...expectedInstalled].sort()), 'installed SDK input inventory');
    for (const file of expectedInstalled) need(hash(profile.installedInputs[file])
      && profile.installedInputs[file] === report.installedInputs?.[`fixtures/${expected.fixture}/node_modules/${file}`], 'installed and top-level hash join');
    for (const file of ['fixtures/google/shared/sdk-cancellation.mjs', 'fixtures/worker/sdk-cancellation.mjs']) {
      need(profile.copiedHashes?.[file] === report.evidence[file], 'identical installed consumer source');
    }
    need(profile.sharedSourceSha256 === report.evidence['fixtures/google/shared/sdk-cancellation.mjs'], 'same Node/workerd business source');
  }
  need(Object.keys(report.installedInputs ?? {}).length === profiles.reduce((sum, profile) => sum + installedForProfile(profile).length, 0), 'exact installed source manifest');
  need(same(report.unhandledRejections, []) && same(report.unexpectedRequests, []), 'no unhandled rejection or unknown peer traffic');
  need(Array.isArray(report.results) && report.results.length === 136 && report.scenarioCount === 136, 'complete scenario matrix');
  need(same(report.extensionCases, extensionCases(report.results)) && report.extensionCases[0].scenarioCount === 64
    && report.extensionCases[1].scenarioCount === 72, 'strict query and call extension summaries');
  let totalFetches = 0, totalAborts = 0;
  for (const profile of profiles) for (const runtime of ['node', 'workerd']) for (const mode of ['grpc-web', 'cloudflare']) for (const scenario of scenarios) {
    const matches = report.results.filter(row => row.profile === profile.id && row.runtime === runtime && row.mode === mode && row.scenario === scenario);
    need(matches.length === 1, `unique ${profile.id}/${runtime}/${mode}/${scenario}`);
    const row = matches[0], expected = expectedTrace(scenario);
    need(row.status === 'passed' && row.namespace === `${profile.fixture}-${runtime}-${mode}-${scenario}`
      && row.heldResponseReleased === true && same(row.unhandledRejections, []), 'scenario identity, release and rejection capture');
    const { accounting, ...business } = row.result ?? {};
    need(same(business, expectedBusiness(scenario)), `independent business assertion ${scenario}`);
    const actualTrace = (row.trace ?? []).map(({ logicalCallId, requestSha256, responseSha256, contentType, ...business }) => business);
    need(same(actualTrace, expected), `independent peer sequence ${scenario}`);
    const cancelled = expected.filter(item => item.cancelTarget).length;
    need(row.controlCount === 1 + cancelled + (scenario === 'transaction-cancel-inflight' ? 1 : 0)
      + (scenario.endsWith('-shared-concurrent') ? 2 : 0), 'release and required response/concurrency/SDK cleanup barriers');
    need(same(row.stored, scenario.startsWith('query-') || scenario.endsWith('-precancel') || scenario.endsWith('-lazy-cancel') ? []
      : scenario === 'commit-shared-concurrent' ? [{ name: 'primary', rank: 41 }, { name: 'concurrent', rank: 41 }]
        : [{ name: 'primary', rank: 41 }]), 'controlled accepted mutations survive cancellation');
    need(accounting?.beforeClose === true && accounting.activeChannels === 0
      && accounting.channelCount === (scenario.startsWith('query-') || scenario === 'commit-precancel' ? 1 : 2)
      && same(accounting.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }), 'idle resources before SDK close');
    need(Array.isArray(accounting.calls)
      && accounting.calls.length === expected.length + (scenario.endsWith('-lazy-cancel') ? 1 : 0), 'captured transport calls and actual late SDK cancellation');
    const ids = new Set(), peerIds = new Set();
    for (const peer of row.trace) {
      need(/^wga-[1-9]\d*$/.test(peer.logicalCallId) && !peerIds.has(peer.logicalCallId), 'unique peer call identity'); peerIds.add(peer.logicalCallId);
      need(hash(peer.requestSha256) && hash(peer.responseSha256)
        && peer.contentType === (mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto'), 'actual protobuf and mode evidence');
    }
    for (const call of accounting.calls) {
      need(/^wga-[1-9]\d*$/.test(call.logicalCallId) && !ids.has(call.logicalCallId), 'unique captured call'); ids.add(call.logicalCallId);
      const peers = row.trace.filter(peer => peer.logicalCallId === call.logicalCallId), fetched = peers.length;
      need(fetched <= 1 && call.fetchCount === fetched && call.fetchEventCount === fetched
        && call.startCount === 1 && call.terminalCount === 1, 'exact physical Fetch and terminal accounting');
      need(call.statusCode === (fetched === 0 || peers[0].cancelTarget ? 1 : 0)
        && call.responseMessages === (call.statusCode === 0 ? 1 : 0), 'cancellation code and no late response delivery');
      if (fetched) need(call.method === `/google.datastore.v1.Datastore/${peers[0].method}`
        && call.attemptCount === 1 && call.authCount === 1, 'peer, attempt and auth join');
      else need(scenario.endsWith('-lazy-cancel') && call.attemptCount === 0 && call.authCount === 0
        && call.method === `/google.datastore.v1.Datastore/${scenario.startsWith('query-') ? 'RunQuery' : 'Commit'}`,
      'actual lazy cancelled call cannot authenticate or Fetch');
      need(same(call.diagnostics, { terminal: true, fetchCount: fetched, requestBytes: 0, responseBytes: 0, timerActive: false })
        && same(call.execution, zeroExecution), 'buffers, timers, callbacks and parser owners released');
    }
    need([...peerIds].every(id => ids.has(id)), 'all peer RPCs captured');
    need(same(accounting.signalAborts, row.trace.filter(peer => peer.cancelTarget).map(peer => peer.logicalCallId)), 'in-flight cancellation reaches only its own Fetch AbortSignal once');
    totalFetches += expected.length; totalAborts += cancelled;
  }
  need(report.fetchCount === totalFetches && totalFetches === 664 && report.signalAbortCount === totalAborts
    && totalAborts === 56, 'aggregate physical RPC and cancellation counts');
  return report;
}
module.exports = { validateSdkCancellationReport, sources, profiles, scenarios, installedForProfile, extensionCases, expectedBusiness, expectedTrace };
