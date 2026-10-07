'use strict';
const { isDeepStrictEqual: same } = require('node:util');
const scenarios = ['complete', 'destroy-first', 'destroy-inflight', 'end-first', 'end-inflight',
  'promise-complete', 'callback-complete', 'promise-error', 'callback-error', 'stream-error'];
const runtimes = ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'];
const pages = { complete: 3, 'destroy-first': 3, 'destroy-inflight': 3, 'end-first': 1, 'end-inflight': 2,
  'promise-complete': 3, 'callback-complete': 3, 'promise-error': 1, 'callback-error': 1, 'stream-error': 2 };
const sources = ['scripts/test-datastore-pagination.cjs', 'scripts/datastore-pagination-evidence.cjs',
  'fixtures/google/pagination-worker.mjs', 'fixtures/google/shared/sdk-call-accounting.mjs',
  'fixtures/google/shared/datastore-pagination.mjs', 'fixtures/google/package-lock.json',
  'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'];
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function need(ok, reason) { if (!ok) throw new Error(`WGA_EVIDENCE_INVALID: datastore-pagination ${reason}`); }
function expectedBusiness(scenario) {
  const info = { moreResults: 'NO_MORE_RESULTS', endCursor: 'Y3Vyc29yLTY=' };
  const ranks = [0, 1, 2, 3, 4, 5];
  const complete = { ranks, names: ranks.map(rank => `row-${rank}`), infos: [info], end: 1,
    errors: [], events: [...ranks.map(() => 'data'), 'info', 'end'] };
  const error = code => ({ code, details: code === 9 ? 'controlled-index-required' : 'controlled-invalid-query',
    metadata: { index: ['controlled-index'], binary: ['00ff41'] } });
  let original = complete, overload;
  if (scenario.startsWith('promise-') || scenario.startsWith('callback-')) {
    original = null;
    const kind = scenario.startsWith('promise-') ? 'promise' : 'callback';
    if (scenario.endsWith('-error')) overload = kind === 'promise'
      ? { kind, rejected: true, error: error(3) }
      : { kind, tupleLength: 1, errorPosition: 0, error: error(3), entities: null, info: null };
    else overload = { kind, tupleLength: kind === 'promise' ? 2 : 3, errorPosition: null,
      ...(kind === 'callback' ? { error: null } : {}),
      entities: ranks.map(rank => ({ rank, name: `row-${rank}` })), info };
  } else if (scenario !== 'complete') {
    const count = scenario.endsWith('-first') ? 1 : 2;
    const destroyed = scenario.startsWith('destroy'), errored = scenario === 'stream-error';
    original = { ranks: ranks.slice(0, count), names: complete.names.slice(0, count),
      infos: destroyed ? [info] : [], end: scenario.startsWith('end') ? 1 : 0,
      errors: errored ? [error(9)] : [],
      events: [...ranks.slice(0, count).map(() => 'data'), destroyed ? 'info' : errored ? 'error' : 'end'] };
  }
  return { scenario, original, reused: complete, ...(overload ? { overload } : {}),
    ...(scenario.endsWith('-inflight') ? { outstandingUnaryAfterDestroy: true } : {}) };
}
function business(result) {
  const { accounting, original, reused, ...rest } = result;
  const clean = stream => { if (!stream) return null; const { close, ...events } = stream; return events; };
  return { ...rest, original: clean(original), reused: clean(reused) };
}
function validateDatastorePaginationReport(report) {
  need(report?.status === 'passed', 'successful execution');
  need(report.liveGoogle === false && report.cloudflareTranslation === false && report.officialEmulator === false
    && report.controlledNativeGrpcServer === true && report.workerAbortPropagationTested === false, 'local controlled-peer boundary');
  need(report.resourcesCheckedBeforeClose === true && report.sameSharedSource === true && report.runtimeDisposed === true && report.nativeBusinessEquivalent === true, 'source and cleanup contract');
  need(report.compatibilityDate === '2026-09-21' && typeof report.workerdVersion === 'string'
    && typeof report.miniflareVersion === 'string' && /^v\d+\.\d+\.\d+/.test(report.runtime), 'runtime provenance');
  need(same(report.instrumentation, { syntheticCallIdHeader: true, internalCallDiagnostics: true,
    oauthNetworkGuard: true, sdkCloseAfterSnapshot: true }), 'explicit instrumentation boundaries');
  for (const fixture of ['native', 'google']) for (const file of ['@grpc/grpc-js/package.json',
    fixture === 'native' ? '@grpc/grpc-js/build/src/index.js' : '@grpc/grpc-js/dist/index.js',
    '@google-cloud/datastore/package.json', '@google-cloud/datastore/build/src/request.js',
    '@google-cloud/datastore/build/src/query.js', '@google-cloud/datastore/build/src/index.js',
    'google-gax/package.json', 'google-auth-library/package.json']) {
    need(hash(report.installedInputs?.[`fixtures/${fixture}/node_modules/${file}`]), 'installed SDK and transport inputs');
  }
  need(report.sdkVersion === '10.1.1' && report.nativeGrpcVersion === '1.14.5', 'pinned SDK and grpc versions');
  need(sources.every(source => hash(report.evidence?.[source])) && hash(report.bundleSha256), 'source and bundle hashes');
  need(report.buildProfile?.name === 'google-static-v1' && report.buildProfile.revision === 5
    && hash(report.buildProfile.sha256) && hash(report.buildProfile.registrySha256), 'Worker build profile');
  need(same(Object.keys(report.sourceHashes ?? {}).sort(), [...runtimes.slice(0, 3), 'workerd'].sort()), 'exact source runtime matrix');
  const helpers = ['datastore-pagination.mjs', 'assert.mjs', 'sdk-call-accounting.mjs'];
  need(same(Object.keys(report.sharedSourceHashes ?? {}).sort(), [...helpers].sort())
    && helpers.every(helper => hash(report.sharedSourceHashes[helper]))
    && Object.values(report.sourceHashes).every(value => same(value, report.sharedSourceHashes)), 'byte-identical business sources');
  need(Array.isArray(report.results) && report.results.length === 50 && report.rpcCount === 310
    && report.grpcWebRequests === 248 && report.authNetworkRequests === 0 && report.controlRequests === 30, 'aggregate call/data/auth/control counts');
  for (const runtime of runtimes) for (const scenario of scenarios) {
    const matches = report.results.filter(row => row.runtime === runtime && row.scenario === scenario);
    need(matches.length === 1, `unique ${runtime}/${scenario}`);
    const row = matches[0];
    const count = pages[scenario] + 4;
    need(row.status === 'passed' && row.rpcCount === count && row.grpcWebRequests === (runtime === 'native' ? 0 : count)
      && row.authNetworkRequests === 0 && row.controlRequests === (scenario.endsWith('-inflight') ? 3 : 0), 'per-scenario accounting');
    need(Array.isArray(row.trace) && row.trace.length === count && row.result?.scenario === scenario, 'trace and business scenario');
    const query = row.trace.filter(call => call.kind === 'Pagination');
    const reuse = row.trace.filter(call => call.kind === 'ReusePagination');
    for (const [calls, expectedCount] of [[query, pages[scenario]], [reuse, 3]]) {
      need(calls.length === expectedCount, 'exact page count');
      calls.forEach((call, page) => need(call.method === 'RunQuery' && call.cursor === (page ? `cursor-${page * 2}` : '')
        && call.limit === 6 - page * 2 && call.offset === (page ? 0 : 3), 'cursor, decreasing limit and consumed offset'));
    }
    need(row.trace.filter(call => call.method === 'Lookup').length === 1, 'same-client recovery lookup');
    for (const call of row.trace) {
      const expectedCode = call.kind === 'Pagination' && scenario.endsWith('-error')
        ? scenario === 'stream-error' ? call.cursor === 'cursor-2' ? 9 : 0 : 3 : 0;
      need(call.statusCode === expectedCode, 'peer error code');
    }
    need(same(business(row.result), expectedBusiness(scenario)), 'independent event, tuple, entity and metadata contract');
    if (row.result.original && scenario !== 'complete') need(row.result.original.close === 1, 'closed stopped or errored public stream');
    if (scenario.endsWith('-inflight')) need(row.cancelledBeforeReply === false, 'native SDK retains pending page RPC after public stop');
    if (runtime !== 'native') {
      const accounting = row.result.accounting;
      need(accounting?.beforeClose === true && Array.isArray(accounting.calls) && accounting.calls.length === count,
        'logical calls inspected before SDK close');
      need(same(accounting.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }), 'idle resource budget');
      const ids = new Set();
      for (const call of accounting.calls) {
        need(typeof call.logicalCallId === 'string' && /^wga-[1-9]\d*$/.test(call.logicalCallId) && !ids.has(call.logicalCallId), 'distinct logical call IDs');
        ids.add(call.logicalCallId);
        const peers = row.trace.filter(peer => peer.logicalCallId === call.logicalCallId);
        need(peers.length === 1, 'one actual peer RPC per logical call');
        need(call.method === `/google.datastore.v1.Datastore/${peers[0].method}` && call.startCount === 1
          && call.terminalCount === 1 && call.authCount === 1 && call.attemptCount === 1 && call.fetchCount === 1 && call.fetchEventCount === 1
          && call.statusCode === peers[0].statusCode && call.responseMessages === (call.statusCode === 0 ? 1 : 0),
        'one physical data Fetch, attempt and terminal per RPC');
        need(same(call.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }),
          'released call buffers and timer');
        need(same(call.execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }), 'released pumps and parser ownership');
      }
      need(accounting.activeChannels === 0 && accounting.channelCount === 1, 'no registered active call');
    } else need(row.result.accounting === undefined && row.trace.every(call => call.logicalCallId === null), 'native measurement boundary');
    const baseline = report.results.find(value => value.runtime === 'native' && value.scenario === scenario);
    need(same(business(row.result), business(baseline.result)), 'native tuple, metadata and public event parity');
  }
}
module.exports = { validateDatastorePaginationReport, sources };
