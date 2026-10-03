'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDatastoreMutationReport, expected, scenarios, runtimes, sources } = require('../scripts/datastore-mutation-evidence.cjs');
// Synthetic validator mutation baseline, not execution evidence. The integration
// suite separately compares actual native/adapter/workerd behavior to this oracle.
function fixture() {
  const digest = 'a'.repeat(64), results = [];
  for (const runtime of runtimes) for (const scenario of scenarios) {
    const { trace, result } = expected(scenario), native = runtime === 'native';
    const receipts = trace.map((_, index) => ({ projectId: 'wga-mutations', databaseId: 'mutation-db',
      namespace: `${runtime}-${scenario}`, routing: { project_id: 'wga-mutations', database_id: 'mutation-db' },
      logicalCallId: native ? null : `${runtime}-${scenario}-${index}` }));
    results.push({ runtime, scenario, status: 'passed', rpcCount: trace.length, grpcWebRequests: native ? 0 : trace.length,
      dataFetches: native ? 0 : trace.length, authFetches: 0, controlRequests: 0, trace, result, receipts,
      accounting: native ? null : { beforeClose: true, resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 },
        activeChannels: 0, channelCount: 1,
        calls: trace.map((call, index) => ({ logicalCallId: receipts[index].logicalCallId, method: `/google.datastore.v1.Datastore/${call.method}`,
          startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1, fetchEventCount: 1, authCount: 1,
          statusCode: call.statusCode, responseMessages: call.statusCode === 0 ? 1 : 0,
          diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
          execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
            parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 } })) },
    });
  }
  const installedInputs = {}, nativeInputs = {};
  for (const [output, fixture, grpcEntry] of [[installedInputs, 'google', 'dist/index.js'], [nativeInputs, 'native', 'build/src/index.js']]) {
    for (const file of ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/datastore/package.json',
      '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js', '@google-cloud/datastore/build/src/entity.js',
      '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json',
      'google-gax/package.json', 'google-auth-library/package.json']) output[`fixtures/${fixture}/node_modules/${file}`] = digest;
  }
  const sharedSourceHashes = Object.fromEntries(['datastore-mutations.mjs', 'sdk-call-accounting.mjs'].map(name => [name, digest]));
  return { status: 'passed', sourceBuild: false, liveGoogle: false, cloudflareTranslation: false, officialEmulator: false,
    adapterRetryEnabled: false, sdkRetryEnabled: false, controlledNativeGrpcServer: true, sameSharedSource: true, resourcesCheckedBeforeClose: true,
    controlDataRpcSeparated: true, nativeBusinessEquivalent: true, runtimeDisposed: true, authNetwork: 'anonymous-pass-through-no-network',
    failures: [], sdkVersion: '10.1.0', nativeGrpcVersion: '1.14.0', runtime: 'v22.0.0', workerd: '1.20260923.0', miniflare: '4.0.0',
    compatibilityDate: '2026-09-21', evidence: Object.fromEntries(sources.map(source => [source, digest])), sharedSourceHashes,
    sourceHashes: Object.fromEntries(['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd'].map(runtime => [runtime, { ...sharedSourceHashes }])),
    buildProfile: { name: 'google-static-v1', revision: 4, sha256: digest, registrySha256: digest }, bundleSha256: digest,
    installedInputs, nativeInputs, results, caseCount: 90,
    rpcCount: results.reduce((n, row) => n + row.rpcCount, 0),
    dataFetches: results.reduce((n, row) => n + row.dataFetches, 0), grpcWebRequests: results.reduce((n, row) => n + row.dataFetches, 0),
    authFetches: 0, controlRequests: results.reduce((n, row) => n + row.controlRequests, 0),
  };
}const row = (report, scenario = 'save-promise', runtime = 'workerd-cloudflare') => report.results.find(row => row.runtime === runtime && row.scenario === scenario);
function mutations(cases) {
  for (const [reason, mutate] of cases) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateDatastoreMutationReport(report), /WGA_EVIDENCE_INVALID/, reason);
  }
}
test('EVIDENCE mutations accepts the full synthetic matrix and independent wire/public oracle', () => {
  const report = fixture(); validateDatastoreMutationReport(report);
  assert.equal(report.rpcCount, 275); assert.equal(report.dataFetches, 220);
});
test('EVIDENCE mutations rejects missing provenance, matrix rows and false certification claims', () => {
  mutations([
    ['failed suite', r => { r.status = 'failed'; }], ['source build', r => { r.sourceBuild = true; }],
    ['SDK retries', r => { r.sdkRetryEnabled = true; }], ['adapter retries', r => { r.adapterRetryEnabled = true; }],
    ['production claim', r => { r.liveGoogle = true; }], ['emulator claim', r => { r.officialEmulator = true; }],
    ['cloudflare claim', r => { r.cloudflareTranslation = true; }], ['auth scope', r => { r.authNetwork = 'live'; }],
    ['missing row', r => { r.results.pop(); }], ['duplicate row', r => { r.results[89] = structuredClone(r.results[88]); }],
    ['missing source', r => { delete r.evidence['scripts/datastore-mutation-server.cjs']; }],
    ['shared bytes differ', r => { r.sourceHashes.workerd['datastore-mutations.mjs'] = 'b'.repeat(64); }],
    ['installed request missing', r => { delete r.installedInputs['fixtures/google/node_modules/@google-cloud/datastore/build/src/request.js']; }],
    ['native wire code missing', r => { delete r.nativeInputs['fixtures/native/node_modules/@google-cloud/datastore/build/src/entity.js']; }],
    ['profile changed', r => { r.buildProfile.revision++; }], ['runtime alive', r => { r.runtimeDisposed = false; }],
    ['native version', r => { r.nativeGrpcVersion = '1.0.0'; }], ['peer invariant failure', r => { r.failures.push('broken'); }],
  ]);
});
test('EVIDENCE mutations enforces typed values, mutation order, whole-RPC errors and assigned key identity', () => {
  mutations([
    ['int64 lost', r => { row(r).trace[0].mutations[0].properties.count.value = '9007199254740992'; }],
    ['batch reversed', r => { row(r, 'batch-save').trace[0].mutations.reverse(); }],
    ['array reversed', r => { row(r, 'batch-save').result.rows.reverse(); }],
    ['save tuple missing', r => { row(r).result.responses[0].tupleLength = 0; }],
    ['callback repeated', r => { row(r, 'save-callback').result.callback.calls++; }],
    ['callback error position', r => { row(r, 'batch-error-callback').result.callback.errorPosition = 1; }],
    ['failure binary metadata lost', r => { row(r, 'delete-error-promise').result.error.binary = []; }],
    ['per-mutation fake response', r => { row(r, 'batch-error-promise').result.responses = [{ mutationResults: [] }]; }],
    ['insert ignores existence', r => { row(r, 'insert-existing').result.error.code = 0; }],
    ['update inserts', r => { row(r, 'update-missing').trace[0].mutations[0].operation = 'upsert'; }],
    ['delete missing fabricated error', r => { row(r, 'delete-missing').result.error = { code: 5 }; }],
    ['incomplete original key unchanged', r => { row(r, 'incomplete-key').result.originalKeyUpdated = false; }],
    ['assigned key lookup wrong', r => { row(r, 'incomplete-key').trace[1].keys[0] = 'MutationValue/id:9007199254740992'; }],
    ['allocate precision lost', r => { row(r, 'allocate-ids').result.allocatedIds[0] = '9007199254740992'; }],
    ['invented high-level reservation', r => { row(r, 'allocate-ids').result.highLevelReserveAvailable = true; }],
    ['same client not recovered', r => { row(r, 'batch-error-promise').result.reused = false; }],
  ]);
});
test('EVIDENCE mutations joins physical Fetch, SDK call and peer identity before cleanup', () => {
  mutations([
    ['second physical Fetch', r => { row(r).accounting.calls[0].fetchCount++; }],
    ['extra attempt', r => { row(r).accounting.calls[0].attemptCount++; }],
    ['missing terminal', r => { row(r).accounting.calls[0].terminalCount = 0; }],
    ['observer mismatch', r => { row(r).accounting.calls[0].fetchEventCount = 0; }],
    ['peer ID mismatch', r => { row(r).receipts[0].logicalCallId = 'unrelated'; }],
    ['duplicate IDs', r => { row(r).accounting.calls[1].logicalCallId = row(r).accounting.calls[0].logicalCallId; }],
    ['wrong method', r => { row(r).accounting.calls[0].method = '/Other'; }],
    ['error response fabricated', r => { row(r, 'insert-existing').accounting.calls[0].responseMessages = 1; }],
    ['native ID fabricated', r => { row(r, 'save-promise', 'native').receipts[0].logicalCallId = 'fake'; }],
    ['routing omitted', r => { delete row(r).receipts[0].routing.database_id; }],
    ['auth request hidden', r => { row(r).authFetches = 1; }], ['data count', r => { row(r).dataFetches++; }],
    ['closed too early', r => { row(r).accounting.beforeClose = false; }],
    ['active channel', r => { row(r).accounting.activeChannels = 1; }],
    ['queued call', r => { row(r).accounting.resources.queuedCalls = 1; }],
    ['pending write', r => { row(r).accounting.calls[0].execution.pendingWriteCallbacks = 1; }],
    ['parser retained', r => { row(r).accounting.calls[0].execution.parserAssemblyBytes = 1; }],
    ['timer retained', r => { row(r).accounting.calls[0].diagnostics.timerActive = true; }],
    ['aggregate hidden call', r => { r.rpcCount++; }],
  ]);
});
