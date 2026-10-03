'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDatastoreLookupReport, expected, scenarios, runtimes, sources } = require('../scripts/datastore-lookup-evidence.cjs');
// The validator contract supplies this synthetic mutation-test baseline. The
// actual native/adapter/workerd integration separately checks that contract
// against executed SDK behavior; this fixture is not execution evidence.
function fixture() {
  const digest = 'a'.repeat(64), results = [];
  for (const runtime of runtimes) for (const scenario of scenarios) {
    const { trace, result, controls } = expected(scenario), native = runtime === 'native';
    const receipts = trace.map((_, index) => {
      const alternate = scenario === 'partition-variants' && index === 1;
      const projectId = alternate ? 'wga-lookup-alt' : 'wga-lookup', databaseId = alternate ? 'lookup-alt-db' : 'lookup-db';
      return { projectId, databaseId, namespaceSuffix: alternate ? '-alt' : '',
        routing: { project_id: projectId, database_id: databaseId }, logicalCallId: native ? null : `${runtime}-${scenario}-${index}` };
    });
    results.push({ runtime, scenario, status: 'passed', rpcCount: trace.length, grpcWebRequests: native ? 0 : trace.length,
      authCalibration: { cachedNetworkRequests: 0, expiredNetworkRequests: 1, blockedBeforeNetwork: true },
      dataFetches: native ? 0 : trace.length, authFetches: 0, authNetworkRequests: 0, controlRequests: controls, trace, result, receipts,
      ...(scenario === 'deferred-deadline' ? { cancelledBeforeReply: true } : scenario === 'end-held' ? { cancelledBeforeReply: false } : {}),
      accounting: native ? null : { beforeClose: true, resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 },
        activeChannels: 0, channelCount: scenario === 'partition-variants' ? 2 : 1,
        calls: trace.map((call, index) => ({ logicalCallId: receipts[index].logicalCallId, method: '/google.datastore.v1.Datastore/Lookup',
          startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1, fetchEventCount: 1, authCount: 1,
          statusCode: call.status, responseMessages: call.status === 0 ? 1 : 0,
          diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
          execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
            parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 } })) },
    });
  }
  const installedInputs = {}, nativeInputs = {};
  for (const [output, fixture, grpcEntry] of [[installedInputs, 'google', 'dist/index.js'], [nativeInputs, 'native', 'build/src/index.js']]) {
    for (const file of ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/datastore/package.json',
      '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js',
      '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json',
      'google-gax/package.json', 'google-auth-library/package.json']) output[`fixtures/${fixture}/node_modules/${file}`] = digest;
  }
  const sharedSourceHashes = Object.fromEntries(['datastore-lookup.mjs', 'assert.mjs', 'sdk-call-accounting.mjs'].map(name => [name, digest]));
  return { status: 'passed', sourceBuild: false, liveGoogle: false, cloudflareTranslation: false, officialEmulator: false,
    adapterRetryEnabled: false, controlledNativeGrpcServer: true, sameSharedSource: true, resourcesCheckedBeforeClose: true,
    controlDataRpcSeparated: true, nativeBusinessEquivalent: true, runtimeDisposed: true, authNetwork: 'cached-oauth-token-no-network',
    failures: [], sdkVersion: '10.1.0', nativeGrpcVersion: '1.14.0', runtime: 'v22.0.0', workerd: '1.20260923.0', miniflare: '4.0.0',
    compatibilityDate: '2026-09-21', evidence: Object.fromEntries(sources.map(source => [source, digest])), sharedSourceHashes,
    sourceHashes: Object.fromEntries(['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd'].map(runtime => [runtime, { ...sharedSourceHashes }])),
    buildProfile: { name: 'google-static-v1', revision: 4, sha256: digest, registrySha256: digest }, bundleSha256: digest,
    installedInputs, nativeInputs, results, caseCount: 85,
    rpcCount: results.reduce((n, row) => n + row.rpcCount, 0),
    dataFetches: results.reduce((n, row) => n + row.dataFetches, 0), grpcWebRequests: results.reduce((n, row) => n + row.dataFetches, 0),
    authFetches: 0, authNetworkRequests: 0, controlRequests: results.reduce((n, row) => n + row.controlRequests, 0),
  };
}
const row = (report, scenario = 'unavailable-retry', runtime = 'workerd-cloudflare') => report.results.find(row => row.runtime === runtime && row.scenario === scenario);
function mutations(cases) {
  for (const [reason, mutate] of cases) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateDatastoreLookupReport(report), /WGA_EVIDENCE_INVALID/, reason);
  }
}

test('EVIDENCE Lookup accepts the complete synthetic 85-case mutation baseline', () => {
  const report = fixture(); validateDatastoreLookupReport(report);
  assert.equal(report.rpcCount, 235); assert.equal(report.dataFetches, 188);
});
test('EVIDENCE Lookup rejects missing execution, provenance and unsupported claims', () => {
  mutations([
    ['failed suite', r => { r.status = 'failed'; }], ['source build', r => { r.sourceBuild = true; }],
    ['missing runtime', r => { r.results = r.results.filter(row => row.runtime !== 'adapter-cloudflare'); }],
    ['duplicate scenario', r => { r.results[84] = structuredClone(r.results[83]); }],
    ['bad source hash', r => { r.evidence['fixtures/google/shared/sdk-call-accounting.mjs'] = 'unknown'; }],
    ['shared source differs', r => { r.sourceHashes.workerd['datastore-lookup.mjs'] = 'b'.repeat(64); }],
    ['unpinned profile', r => { r.buildProfile.revision++; }], ['missing bundle', r => { delete r.bundleSha256; }],
    ['missing installed implementation', r => { delete r.installedInputs['fixtures/google/node_modules/@google-cloud/datastore/build/src/request.js']; }],
    ['malformed native hash', r => { r.nativeInputs['fixtures/native/node_modules/@grpc/grpc-js/build/src/index.js'] = ''; }],
    ['live claim', r => { r.liveGoogle = true; }], ['conversion claim', r => { r.cloudflareTranslation = true; }],
    ['emulator claim', r => { r.officialEmulator = true; }], ['peer failed', r => { r.failures.push('peer error'); }],
    ['wrong SDK', r => { r.sdkVersion = '11.1.0'; }], ['wrong runtime date', r => { r.compatibilityDate = '2026-09-20'; }],
    ['runtime not disposed', r => { r.runtimeDisposed = false; }], ['aggregate data count', r => { r.dataFetches++; }],
  ]);
});
test('EVIDENCE Lookup ties each SDK retry to one actual Fetch and native peer receipt', () => {
  mutations([
    ['hidden fetch', r => { row(r).accounting.calls[0].fetchCount = 2; }],
    ['extra observer attempt', r => { row(r).accounting.calls[0].attemptCount = 2; }],
    ['observer differs from network', r => { row(r).accounting.calls[0].fetchEventCount = 0; }],
    ['same call reused for SDK retry', r => { row(r).accounting.calls[1].logicalCallId = row(r).accounting.calls[0].logicalCallId; }],
    ['peer ID differs', r => { row(r).receipts[0].logicalCallId += '-other'; }],
    ['missing logical terminal', r => { row(r).accounting.calls[0].terminalCount = 0; }],
    ['duplicate start', r => { row(r).accounting.calls[0].startCount = 2; }],
    ['auth plugin skipped', r => { row(r).accounting.calls[0].authCount = 0; }],
    ['cached auth fetch', r => { row(r).authFetches = 1; }],
    ['cached auth network request', r => { row(r).authNetworkRequests = 1; }],
    ['network positive control absent', r => { row(r).authCalibration.expiredNetworkRequests = 0; }],
    ['real network in calibration', r => { row(r).authCalibration.blockedBeforeNetwork = false; }],
    ['data fetch count', r => { row(r).dataFetches++; }],
    ['wrong method', r => { row(r).accounting.calls[0].method = '/Other'; }],
    ['status changed', r => { row(r).accounting.calls[0].statusCode = 0; }],
    ['invented failure response', r => { row(r).accounting.calls[0].responseMessages = 1; }],
    ['fabricated native ID', r => { row(r, 'unavailable-retry', 'native').receipts[0].logicalCallId = 'fake'; }],
    ['control mixed into data', r => { row(r, 'end-held').controlRequests = 0; }],
    ['adapter retry enabled', r => { r.adapterRetryEnabled = true; }],
  ]);
});
test('EVIDENCE Lookup requires cleanup before SDK close and preserves public SDK semantics', () => {
  mutations([
    ['cleanup checked too late', r => { row(r).accounting.beforeClose = false; }],
    ['active channel', r => { row(r).accounting.activeChannels = 1; }],
    ['active pump', r => { row(r).accounting.calls[0].execution.activePumps = 1; }],
    ['pending callback', r => { row(r).accounting.calls[0].execution.pendingWriteCallbacks = 1; }],
    ['retained buffer', r => { row(r).accounting.resources.bufferedBytes = 5; }],
    ['timer remains', r => { row(r).accounting.calls[0].diagnostics.timerActive = true; }],
    ['deferred keys broadened', r => { row(r, 'mixed-promise').trace[1].keys.push('unrequested'); }],
    ['callback twice', r => { row(r, 'denied-callback').result.callbacks = 2; }],
    ['partial get leaks rows', r => { row(r, 'partial-get-error').result.rows = [1]; }],
    ['stream error before data', r => { row(r, 'partial-stream-error').result.stream.events.reverse(); }],
    ['end incorrectly cancels', r => { row(r, 'end-held').cancelledBeforeReply = true; }],
    ['deadline fails to cancel', r => { row(r, 'deferred-deadline').cancelledBeforeReply = false; }],
    ['alternate project ignored', r => { row(r, 'partition-variants').receipts[1].projectId = 'wga-lookup'; }],
    ['database routing omitted', r => { delete row(r).receipts[0].routing.database_id; }],
    ['ancestor not changed', r => { row(r, 'partition-variants').result.variants[1].row.key.parent.name = 'ancestor'; }],
    ['native result mismatch', r => { row(r, 'mixed-promise', 'native').result.rows.reverse(); }],
  ]);
});
