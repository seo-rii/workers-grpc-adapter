'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSdkCancellationReport: validate, sources, profiles, scenarios, installedForProfile, extensionCases,
  expectedBusiness, expectedTrace } = require('../scripts/sdk-cancellation-evidence.cjs');

// Synthetic validator inputs only. The executable integration separately calls
// both real installed SDK graphs with identical Node/workerd business code.
function fixture() {
  const hash = 'a'.repeat(64), report = { status: 'passed', runtimeDisposed: true,
    startedAt: '2026-10-04T00:00:00Z', finishedAt: '2026-10-04T00:01:00Z', runtime: 'v22.23.3',
    liveCloud: false, cloudflareTranslation: false, officialEmulator: false, controlledFetchPeer: true,
    backendCancellationProven: false, optionalExtensions: true, upstreamSdkBehaviorChanged: false,
    compatibilityDate: '2026-09-21', versions: { workerd: '1.20261006.1', miniflare: '5.20261006.0-alpha' },
    instrumentation: { channelDiagnostics: true, observer: true, localAbortSignal: true,
      projectIdResolutionBarrier: true, resourcesBeforeSdkClose: true },
    evidence: Object.fromEntries(sources.map(file => [file, hash])), installedInputs: {}, profiles: [],
    results: [], unhandledRejections: [], unexpectedRequests: [], scenarioCount: 136, fetchCount: 664, signalAbortCount: 56 };
  let nextId = 0;
  for (const profile of profiles) {
    const installed = installedForProfile(profile);
    for (const file of installed) report.installedInputs[`fixtures/${profile.fixture}/node_modules/${file}`] = hash;
    report.profiles.push({ ...profile, status: 'passed', installedInputs: Object.fromEntries(installed.map(file => [file, hash])),
      copiedHashes: { 'fixtures/google/shared/sdk-cancellation.mjs': hash, 'fixtures/worker/sdk-cancellation.mjs': hash },
      sharedSourceSha256: hash, bundleSha256: hash,
      build: { profile: profile.id, revision: profile.revision, profileSha256: hash, registrySha256: hash } });
    for (const runtime of ['node', 'workerd']) for (const mode of ['grpc-web', 'cloudflare']) for (const scenario of scenarios) {
      const trace = expectedTrace(scenario).map(call => ({ ...call, logicalCallId: `wga-${++nextId}`,
        requestSha256: hash, responseSha256: hash, contentType: mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto' }));
      const result = expectedBusiness(scenario);
      result.accounting = { beforeClose: true, activeChannels: 0,
        channelCount: scenario.startsWith('query-') || scenario === 'commit-precancel' ? 1 : 2,
        resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }, signalAborts: trace.filter(call => call.cancelTarget).map(call => call.logicalCallId),
        calls: trace.map(call => ({ logicalCallId: call.logicalCallId, method: `/google.datastore.v1.Datastore/${call.method}`,
          startCount: 1, terminalCount: 1, fetchCount: 1, fetchEventCount: 1, attemptCount: 1, authCount: 1,
          statusCode: call.cancelTarget ? 1 : 0, responseMessages: call.cancelTarget ? 0 : 1,
          diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
          execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
            parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 } })) };
      if (scenario.endsWith('-lazy-cancel')) {
        const delayed = structuredClone(result.accounting.calls[0]);
        Object.assign(delayed, { logicalCallId: `wga-${++nextId}`,
          method: `/google.datastore.v1.Datastore/${scenario.startsWith('query-') ? 'RunQuery' : 'Commit'}`,
          fetchCount: 0, fetchEventCount: 0, attemptCount: 0, authCount: 0, statusCode: 1, responseMessages: 0 });
        delayed.diagnostics.fetchCount = 0; result.accounting.calls.unshift(delayed);
      }
      report.results.push({ profile: profile.id, runtime, mode, scenario, namespace: `${profile.fixture}-${runtime}-${mode}-${scenario}`,
        status: 'passed', heldResponseReleased: true, unhandledRejections: [], trace, result,
        controlCount: 1 + trace.filter(call => call.cancelTarget).length + (scenario === 'transaction-cancel-inflight' ? 1 : 0)
          + (scenario.endsWith('-shared-concurrent') ? 2 : 0),
        stored: scenario.startsWith('query-') || scenario.endsWith('-precancel') || scenario.endsWith('-lazy-cancel') ? []
          : scenario === 'commit-shared-concurrent' ? [{ name: 'primary', rank: 41 }, { name: 'concurrent', rank: 41 }]
            : [{ name: 'primary', rank: 41 }] });
    }
  }
  report.extensionCases = extensionCases(report.results);
  return report;
}
function row(report, scenario = 'commit-cancel-inflight') {
  return report.results.find(value => value.profile === 'google-modern-v1' && value.runtime === 'workerd' && value.mode === 'cloudflare' && value.scenario === scenario);
}
function rejectMutations(mutations) {
  for (const [label, mutate] of mutations) {
    const report = fixture(); mutate(report);
    assert.throws(() => validate(report), /WGA_EVIDENCE_INVALID/, label);
  }
}
test('EVIDENCE SDK cancellation accepts the complete installed-profile and runtime matrix', () => {
  assert.doesNotThrow(() => validate(fixture()));
});
test('EVIDENCE SDK cancellation rejects omitted runtime, source, installation and provenance evidence', () => rejectMutations([
  ['missing result', report => { report.results.pop(); }],
  ['duplicate result', report => { report.results[1] = structuredClone(report.results[0]); }],
  ['wrong SDK version', report => { report.profiles[1].sdkVersion = 'latest'; }],
  ['wrong workerd version', report => { report.versions.workerd = 'latest'; }],
  ['generated SDK changed', report => { report.profiles[1].generatedVersion = 'latest'; }],
  ['false extension count', report => { report.extensionCases[0].scenarioCount++; }],
  ['missing extension runtime', report => { report.extensionCases[1].runtimes = ['node']; }],
  ['wrong build profile', report => { report.profiles[1].build.profile = 'google-static-v1'; }],
  ['missing source', report => { delete report.evidence[sources[0]]; }],
  ['copied source changed', report => { report.profiles[0].copiedHashes['fixtures/google/shared/sdk-cancellation.mjs'] = 'b'.repeat(64); }],
  ['missing installed helper', report => { delete report.installedInputs['fixtures/modern/node_modules/@grpc/grpc-js/dist/sdk.js']; }],
  ['runtime not disposed', report => { report.runtimeDisposed = false; }],
  ['live certification', report => { report.liveCloud = true; }],
  ['backend cancellation overclaim', report => { report.backendCancellationProven = true; }],
  ['upstream mutation claim', report => { report.upstreamSdkBehaviorChanged = true; }],
  ['unhandled rejection', report => { report.unhandledRejections.push('Error'); }],
  ['worker unhandled rejection', report => { row(report).unhandledRejections.push('Error'); }],
  ['unexpected network', report => { report.unexpectedRequests.push('unexpected'); }],
]));
test('EVIDENCE SDK cancellation rejects continuation, rollback and completion-race regressions', () => rejectMutations([
  ['destroy fetched later page', report => { row(report, 'query-destroy-first').trace.push(structuredClone(row(report, 'query-destroy-first').trace[0])); }],
  ['cancel received late row', report => { row(report, 'query-abort-inflight').result.original.ranks.push(2); }],
  ['iterator did not close', report => { row(report, 'query-break-first').result.original.close = 0; }],
  ['precancel started SDK', report => { row(report, 'query-precancel').result.started = 1; }],
  ['lazy init omitted', report => { row(report, 'query-lazy-cancel').result.lazyBarrier = null; }],
  ['lazy RPC never created', report => { row(report, 'query-lazy-cancel').result.accounting.calls.shift(); }],
  ['double cancellation', report => { row(report).result.rejected = 2; }],
  ['wrong error code', report => { row(report).result.errorCodes = [4]; }],
  ['accepted write rolled back', report => { row(report).stored = []; }],
  ['lookup hidden write loss', report => { row(report).result.persisted.rank = 0; }],
  ['transaction cancellation succeeds', report => { row(report, 'transaction-cancel-inflight').result.resolved = 1; }],
  ['completion replaced by cancellation', report => { row(report, 'commit-completion-first').result.errorCodes = [1]; }],
  ['concurrent sibling cancelled', report => { row(report, 'query-shared-concurrent').result.concurrent.errors = [1]; }],
  ['sibling completed before cancel', report => { row(report, 'query-shared-concurrent').result.overlapAtCancel.activeCalls = 1; }],
  ['sibling not actually pending', report => { row(report, 'commit-shared-concurrent').result.overlapAtCancel.pendingResponses = 1; }],
  ['sibling response not held', report => { row(report, 'commit-shared-concurrent').trace[1].held = false; }],
  ['recovery incomplete', report => { row(report).result.reused.ranks.pop(); }],
  ['RPC response not released', report => { row(report).heldResponseReleased = false; }],
  ['cursor progression', report => { row(report).trace[3].cursor = ''; }],
]));
test('EVIDENCE SDK cancellation rejects stale resource and observer receipts', () => rejectMutations([
  ['not before SDK close', report => { row(report).result.accounting.beforeClose = false; }],
  ['active calls', report => { row(report).result.accounting.resources.activeCalls = 1; }],
  ['buffer leak', report => { row(report).result.accounting.resources.bufferedBytes = 1; }],
  ['missing terminal', report => { row(report).result.accounting.calls[0].terminalCount = 0; }],
  ['extra Fetch', report => { row(report).result.accounting.calls[0].fetchCount = 2; }],
  ['unjoined peer', report => { row(report).trace[0].logicalCallId = 'wga-999999'; }],
  ['timer retained', report => { row(report).result.accounting.calls[0].diagnostics.timerActive = true; }],
  ['parser retained', report => { row(report).result.accounting.calls[0].execution.parserAssemblies = 1; }],
  ['missing abort', report => { row(report).result.accounting.signalAborts = []; }],
  ['double abort', report => { row(report).result.accounting.signalAborts.push(row(report).result.accounting.signalAborts[0]); }],
  ['canceled response delivered', report => { row(report).result.accounting.calls[0].responseMessages = 1; }],
  ['fetch total drift', report => { report.fetchCount++; }],
  ['abort total drift', report => { report.signalAbortCount--; }],
]));
