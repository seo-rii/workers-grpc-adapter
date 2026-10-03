'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDatastorePaginationReport: validate, sources } = require('../scripts/datastore-pagination-evidence.cjs');

// Synthetic report input for the validator only. The executable fixture runs
// real installed SDKs against the native peer in Node and workerd separately.
function fixture() {
  const hash = 'a'.repeat(64), results = [], installedInputs = {};
  const runtimes = ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'];
  const cases = { complete: 3, 'destroy-first': 3, 'destroy-inflight': 3, 'end-first': 1, 'end-inflight': 2,
    'promise-complete': 3, 'callback-complete': 3, 'promise-error': 1, 'callback-error': 1, 'stream-error': 2 };
  const helpers = Object.fromEntries(['datastore-pagination.mjs', 'assert.mjs', 'sdk-call-accounting.mjs'].map(name => [name, hash]));
  for (const directory of ['native', 'google']) for (const file of ['@grpc/grpc-js/package.json',
    directory === 'native' ? '@grpc/grpc-js/build/src/index.js' : '@grpc/grpc-js/dist/index.js',
    '@google-cloud/datastore/package.json', '@google-cloud/datastore/build/src/request.js',
    '@google-cloud/datastore/build/src/query.js', '@google-cloud/datastore/build/src/index.js',
    'google-gax/package.json', 'google-auth-library/package.json']) installedInputs[`fixtures/${directory}/node_modules/${file}`] = hash;
  let sequence = 0;
  for (const runtime of runtimes) for (const [scenario, pages] of Object.entries(cases)) {
    const all = [0, 1, 2, 3, 4, 5], info = { moreResults: 'NO_MORE_RESULTS', endCursor: 'Y3Vyc29yLTY=' };
    const error = code => ({ code, details: code === 3 ? 'controlled-invalid-query' : 'controlled-index-required',
      metadata: { index: ['controlled-index'], binary: ['00ff41'] } });
    const complete = { ranks: all, names: all.map(rank => `row-${rank}`), infos: [info], end: 1, close: 1,
      errors: [], events: ['data', 'data', 'data', 'data', 'data', 'data', 'info', 'end'] };
    const result = { scenario, original: complete, reused: complete };
    if (/^(?:promise|callback)-/.test(scenario)) {
      result.original = null;
      const kind = scenario.split('-')[0];
      if (scenario.endsWith('error')) result.overload = kind === 'promise' ? { kind, rejected: true, error: error(3) }
        : { kind, tupleLength: 1, errorPosition: 0, error: error(3), entities: null, info: null };
      else result.overload = { kind, tupleLength: kind === 'promise' ? 2 : 3, errorPosition: null,
        ...(kind === 'callback' ? { error: null } : {}), entities: all.map(rank => ({ rank, name: `row-${rank}` })), info };
    } else if (scenario !== 'complete') {
      const count = scenario.endsWith('first') ? 1 : 2;
      const destroy = scenario.startsWith('destroy'), fault = scenario === 'stream-error';
      result.original = { ranks: all.slice(0, count), names: complete.names.slice(0, count), infos: destroy ? [info] : [],
        end: scenario.startsWith('end') ? 1 : 0, close: 1, errors: fault ? [error(9)] : [],
        events: [...Array(count).fill('data'), destroy ? 'info' : fault ? 'error' : 'end'] };
    }
    if (scenario.endsWith('inflight')) result.outstandingUnaryAfterDestroy = true;
    const query = (kind, page) => ({ method: 'RunQuery', kind, cursor: page ? `cursor-${page * 2}` : '',
      limit: 6 - page * 2, offset: page ? 0 : 3,
      statusCode: kind === 'Pagination' && scenario.endsWith('error') ? scenario === 'stream-error' ? page ? 9 : 0 : 3 : 0 });
    const trace = [...Array.from({ length: pages }, (_, index) => query('Pagination', index)),
      { method: 'Lookup', statusCode: 0 }, ...[0, 1, 2].map(index => query('ReusePagination', index))];
    trace.forEach(call => { call.logicalCallId = runtime === 'native' ? null : `wga-${++sequence}`; });
    if (runtime !== 'native') result.accounting = { beforeClose: true, channelCount: 1, activeChannels: 0,
      resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }, calls: trace.map(call => ({
        logicalCallId: call.logicalCallId, method: `/google.datastore.v1.Datastore/${call.method}`,
        startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1, fetchEventCount: 1, authCount: 1,
        statusCode: call.statusCode, responseMessages: call.statusCode ? 0 : 1,
        diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
        execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 },
      })) };
    results.push({ runtime, scenario, status: 'passed', rpcCount: pages + 4, grpcWebRequests: runtime === 'native' ? 0 : pages + 4,
      controlRequests: scenario.endsWith('inflight') ? 3 : 0, authNetworkRequests: 0, trace, result,
      ...(scenario.endsWith('inflight') ? { cancelledBeforeReply: false } : {}) });
  }
  return { status: 'passed', liveGoogle: false, cloudflareTranslation: false, officialEmulator: false,
    controlledNativeGrpcServer: true, workerAbortPropagationTested: false, resourcesCheckedBeforeClose: true,
    sameSharedSource: true, runtimeDisposed: true, nativeBusinessEquivalent: true, runtime: 'v22.0.0', compatibilityDate: '2026-09-21',
    workerdVersion: '1.20260923.0', miniflareVersion: '4.0.0', sdkVersion: '10.1.0', nativeGrpcVersion: '1.14.0',
    instrumentation: { syntheticCallIdHeader: true, internalCallDiagnostics: true, oauthNetworkGuard: true, sdkCloseAfterSnapshot: true },
    installedInputs, evidence: Object.fromEntries(sources.map(source => [source, hash])), bundleSha256: hash,
    sharedSourceHashes: helpers, sourceHashes: Object.fromEntries(['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd'].map(runtime => [runtime, { ...helpers }])),
    buildProfile: { name: 'google-static-v1', revision: 4, sha256: hash, registrySha256: hash },
    results, rpcCount: 310, grpcWebRequests: 248, authNetworkRequests: 0, controlRequests: 30 };
}
function row(report, scenario = 'stream-error', runtime = 'workerd-cloudflare') {
  return report.results.find(value => value.scenario === scenario && value.runtime === runtime);
}
function rejectAll(mutations) {
  for (const [reason, mutate] of mutations) {
    const report = fixture(); mutate(report);
    assert.throws(() => validate(report), /WGA_EVIDENCE_INVALID/, reason);
  }
}
test('EVIDENCE pagination accepts the complete synthetic native and installed-runtime matrix', () => {
  assert.doesNotThrow(() => validate(fixture()));
});
test('EVIDENCE pagination rejects missing provenance, runtimes and RPC accounting', () => rejectAll([
  ['source hash', report => { delete report.evidence[sources[0]]; }],
  ['installed input', report => { delete report.installedInputs['fixtures/google/node_modules/@google-cloud/datastore/build/src/query.js']; }],
  ['same source', report => { report.sourceHashes.workerd['datastore-pagination.mjs'] = 'b'.repeat(64); }],
  ['runtime omitted', report => { report.results.pop(); }],
  ['duplicate runtime', report => { report.results[49] = structuredClone(report.results[48]); }],
  ['profile revision', report => { report.buildProfile.revision++; }],
  ['cleanup', report => { report.runtimeDisposed = false; }],
  ['cloud claim', report => { report.cloudflareTranslation = true; }],
  ['data Fetch', report => { row(report).grpcWebRequests++; }],
  ['auth network', report => { row(report).authNetworkRequests++; }],
  ['control count', report => { row(report).controlRequests++; }],
  ['cursor', report => { row(report).trace[1].cursor = ''; }],
  ['offset', report => { row(report).trace[1].offset = 3; }],
]));
test('EVIDENCE pagination rejects corrupted public events, tuple positions and metadata even with equal native results', () => rejectAll([
  ['event order', report => { for (const value of report.results.filter(value => value.scenario === 'stream-error')) value.result.original.events = ['error', 'data', 'data']; }],
  ['partial entities', report => { row(report).result.original.ranks.pop(); }],
  ['binary metadata', report => { row(report).result.original.errors[0].metadata.binary = ['ffff']; }],
  ['error details', report => { row(report).result.original.errors[0].details = 'wrong'; }],
  ['Promise tuple', report => { row(report, 'promise-complete').result.overload.tupleLength = 3; }],
  ['callback error slot', report => { row(report, 'callback-error').result.overload.errorPosition = 1; }],
  ['callback omitted info', report => { delete row(report, 'callback-complete').result.overload.info; }],
  ['destroy contract', report => { row(report, 'destroy-inflight').cancelledBeforeReply = true; }],
]));
test('EVIDENCE pagination rejects premature cleanup and mismatched logical/physical call identities', () => rejectAll([
  ['snapshot after SDK close', report => { row(report).result.accounting.beforeClose = false; }],
  ['active registry', report => { row(report).result.accounting.activeChannels = 1; }],
  ['buffer budget', report => { row(report).result.accounting.resources.bufferedBytes = 1; }],
  ['pump', report => { row(report).result.accounting.calls[0].execution.activePumps = 1; }],
  ['timer', report => { row(report).result.accounting.calls[0].diagnostics.timerActive = true; }],
  ['retained parser', report => { row(report).result.accounting.calls[0].execution.parserAssemblyBytes = 5; }],
  ['fetch mismatch', report => { row(report).result.accounting.calls[0].fetchCount = 2; }],
  ['observer mismatch', report => { row(report).result.accounting.calls[0].fetchEventCount = 0; }],
  ['missing terminal', report => { row(report).result.accounting.calls[0].terminalCount = 0; }],
  ['duplicate ID', report => { row(report).result.accounting.calls[1].logicalCallId = row(report).result.accounting.calls[0].logicalCallId; }],
  ['peer mismatch', report => { row(report).trace[0].logicalCallId = 'other'; }],
  ['method mismatch', report => { row(report).result.accounting.calls[0].method = '/other'; }],
]));
