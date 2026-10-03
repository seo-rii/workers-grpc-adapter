'use strict';
const { isDeepStrictEqual } = require('node:util');
const runtimes = ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'];
const rounds = { 'mixed-promise': 3, 'mixed-callback': 3, 'mixed-stream': 3, 'single-deferred': 2,
  'single-missing': 1, 'all-missing': 1, 'denied-promise': 1, 'denied-callback': 1,
  'unavailable-no-retry': 1, 'unavailable-retry': 3, 'partial-stream-error': 2,
  'partial-get-error': 2, 'deferred-deadline': 2, 'end-first': 1, 'end-held': 2, 'invalid-options': 0, 'partition-variants': 2 };
const scenarios = Object.keys(rounds);
const sources = ['scripts/test-datastore-lookup.cjs', 'scripts/datastore-lookup-evidence.cjs', 'fixtures/worker/datastore-lookup.mjs',
  'fixtures/google/shared/datastore-lookup.mjs', 'fixtures/google/shared/assert.mjs', 'fixtures/google/shared/sdk-call-accounting.mjs',
  ...['google', 'native', 'worker'].map(name => `fixtures/${name}/package-lock.json`)];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, message) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: datastore-lookup ${message}`); }
const keyIds = ['id:9007199254740993', 'name:missing', 'name:name-1', 'name:name-2']
  .map(id => `LookupRoot/name:ancestor/LookupValue/${id}`);
function entity(rank, ancestor = 'ancestor') {
  return { rank, key: { kind: 'LookupValue', ...(rank === 0 ? { id: '9007199254740993' } : { name: `name-${rank}` }),
    parent: { kind: 'LookupRoot', name: ancestor } }, large: '9223372036854775806', when: '2026-01-02T03:04:05.000Z',
  blob: '00017fff', enabled: true, nothing: null, label: `value-${rank}` };
}
// Independent pinned public SDK contracts, including error/event order and the
// wire identities that deferred retries must preserve.
function expected(scenario) {
  const keys = scenario === 'invalid-options' ? []
    : scenario === 'partition-variants' ? [[keyIds[3]], ['LookupRoot/name:other-ancestor/LookupValue/name:name-2']]
    : scenario === 'single-deferred' ? [[keyIds[0]], [keyIds[0]]]
    : scenario === 'single-missing' ? [[keyIds[1]]]
    : scenario === 'all-missing' ? [[keyIds[1], 'LookupRoot/name:ancestor/LookupValue/name:also-missing']]
    : scenario === 'unavailable-retry' ? [keyIds, keyIds, keyIds]
    : [keyIds, [keyIds[3], keyIds[0]], [keyIds[3]]].slice(0, rounds[scenario]);
  const trace = keys.map((keys, index) => ({ marker: false, keys, status:
    scenario.startsWith('denied-') || (scenario.startsWith('partial-') && index === 1) ? 7
      : scenario === 'unavailable-no-retry' || (scenario === 'unavailable-retry' && index < 2) ? 14
        : scenario === 'deferred-deadline' && index === 1 ? 4 : 0 }));
  trace.push({ marker: true, keys: ['LookupMarker/name:alive'], status: 0 });
  const result = { scenario, rows: [], callbacks: scenario.endsWith('-callback') ? 1 : 0, reused: true };
  if (scenario === 'invalid-options') result.localInputErrors = 2;
  else if (scenario === 'partition-variants') result.variants = [
    { projectId: 'wga-lookup', databaseId: 'lookup-db', namespaceSuffix: '', row: entity(2) },
    { projectId: 'wga-lookup-alt', databaseId: 'lookup-alt-db', namespaceSuffix: '-alt', row: entity(2, 'other-ancestor') },
  ];
  else if (['mixed-stream', 'partial-stream-error', 'deferred-deadline', 'end-first', 'end-held'].includes(scenario)) {
    const code = scenario === 'partial-stream-error' ? 7 : scenario === 'deferred-deadline' ? 4 : null;
    const ranks = scenario === 'mixed-stream' ? [1, 0, 2] : [1];
    const close = scenario === 'mixed-stream' ? 0 : 1;
    result.stream = { rows: ranks.map(rank => entity(rank)),
      events: [...ranks.map(rank => `data:${rank}`), ...(code ? [`error:${code}`, 'close'] : ['end', ...(close ? ['close'] : [])])],
      errors: code ? [code] : [], end: code ? 0 : 1, close };
    if (scenario === 'end-held') result.currentUnaryCancelledByEnd = false;
  } else if (scenario.startsWith('denied-') || scenario === 'unavailable-no-retry' || scenario === 'partial-get-error') {
    result.errorCode = scenario === 'unavailable-no-retry' ? 14 : 7;
    result.partialArrayReturned = false;
  } else {
    result.rows = (scenario === 'single-deferred' ? [0] : scenario.includes('missing') ? []
      : scenario === 'unavailable-retry' ? [0, 1, 2] : [1, 0, 2]).map(rank => entity(rank));
    if (scenario === 'single-missing') result.singleMissing = true;
  }
  return { trace, result, controls: scenario === 'end-held' ? 3 : scenario === 'deferred-deadline' ? 1 : 0 };
}
function validateDatastoreLookupReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false, 'complete installed execution');
  for (const flag of ['liveGoogle', 'cloudflareTranslation', 'officialEmulator', 'adapterRetryEnabled']) need(report[flag] === false, `${flag} boundary`);
  for (const flag of ['controlledNativeGrpcServer', 'sameSharedSource', 'resourcesCheckedBeforeClose', 'controlDataRpcSeparated',
    'nativeBusinessEquivalent', 'runtimeDisposed']) need(report[flag] === true, `${flag} guarantee`);
  need(report.authNetwork === 'cached-oauth-token-no-network', 'authentication network scope');
  need(isDeepStrictEqual(report.failures, []), 'peer failures');
  need(report.sdkVersion === '10.1.0' && report.nativeGrpcVersion === '1.14.0', 'pinned SDK versions');
  need(/^v\d+\.\d+\.\d+/.test(report.runtime) && typeof report.workerd === 'string' && report.workerd.length > 0
    && typeof report.miniflare === 'string' && report.miniflare.length > 0 && report.compatibilityDate === '2026-09-21', 'runtime versions');
  need(sources.every(file => hash(report.evidence?.[file])), 'source provenance');
  for (const file of ['datastore-lookup.mjs', 'assert.mjs', 'sdk-call-accounting.mjs']) {
    const digest = report.sharedSourceHashes?.[file];
    need(hash(digest) && digest === report.evidence[`fixtures/google/shared/${file}`], 'shared source evidence');
    for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd']) {
      need(report.sourceHashes?.[runtime]?.[file] === digest, `shared ${runtime} source identity`);
    }
  }
  need(isDeepStrictEqual(Object.keys(report.sourceHashes).sort(), ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd'].sort()), 'exact source runtime set');
  need(report.buildProfile?.name === 'google-static-v1' && report.buildProfile.revision === 4
    && hash(report.buildProfile.sha256) && hash(report.buildProfile.registrySha256) && hash(report.bundleSha256), 'Worker build provenance');
  for (const [mapName, fixture, grpcEntry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
    const required = ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/datastore/package.json',
      '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js',
      '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json',
      'google-gax/package.json', 'google-auth-library/package.json'].map(file => `fixtures/${fixture}/node_modules/${file}`);
    need(isDeepStrictEqual(Object.keys(report[mapName] || {}).sort(), required.sort())
      && Object.values(report[mapName]).every(hash), `${mapName} installed input provenance`);
  }
  need(Array.isArray(report.results) && report.results.length === 85 && report.caseCount === 85, 'exact matrix');
  let rpcCount = 0, dataFetches = 0, controlRequests = 0;
  for (const runtime of runtimes) for (const scenario of scenarios) {
    const matches = report.results.filter(row => row.runtime === runtime && row.scenario === scenario);
    need(matches.length === 1, `unique ${runtime}/${scenario}`);
    const row = matches[0], contract = expected(scenario), count = contract.trace.length;
    need(row.status === 'passed' && row.rpcCount === count, 'successful row and exact RPC count');
    need(isDeepStrictEqual(row.authCalibration, { cachedNetworkRequests: 0, expiredNetworkRequests: 1, blockedBeforeNetwork: true }), 'calibrated auth network counter');
    need(isDeepStrictEqual(row.trace, contract.trace) && isDeepStrictEqual(row.result, contract.result), 'public result and wire trace');
    need(row.dataFetches === (runtime === 'native' ? 0 : count) && row.grpcWebRequests === row.dataFetches
      && row.authFetches === 0 && row.authNetworkRequests === 0 && row.controlRequests === contract.controls, 'data/auth/control request accounting');
    if (['deferred-deadline', 'end-held'].includes(scenario)) need(row.cancelledBeforeReply === (scenario === 'deferred-deadline'), 'held unary cancellation semantics');
    need(Array.isArray(row.receipts) && row.receipts.length === count, 'native peer receipts');
    for (let index = 0; index < count; index++) {
      const receipt = row.receipts[index], alternate = scenario === 'partition-variants' && index === 1;
      const projectId = alternate ? 'wga-lookup-alt' : 'wga-lookup', databaseId = alternate ? 'lookup-alt-db' : 'lookup-db';
      need(isDeepStrictEqual({ ...receipt, logicalCallId: null }, { projectId, databaseId,
        namespaceSuffix: alternate ? '-alt' : '', routing: { project_id: projectId, database_id: databaseId }, logicalCallId: null }), 'project/database/namespace routing');
      if (runtime === 'native') need(receipt.logicalCallId === null, 'native call IDs not fabricated');
    }
    if (runtime === 'native') need(row.accounting === null, 'native accounting boundary');
    else {
      const observed = row.accounting;
      need(observed?.beforeClose === true && observed.calls?.length === count, 'complete pre-close accounting');
      need(isDeepStrictEqual(observed.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }), 'released admission and buffers');
      need(observed.activeChannels === 0 && observed.channelCount === (scenario === 'partition-variants' ? 2 : 1), 'channel registries empty before SDK close');
      need(new Set(observed.calls.map(call => call.logicalCallId)).size === count, 'distinct SDK calls');
      observed.calls.forEach((call, index) => {
        need(typeof call.logicalCallId === 'string' && call.logicalCallId.length > 0 && call.logicalCallId === row.receipts[index].logicalCallId,
          'physical peer request linked to call ID');
        need(call.method === '/google.datastore.v1.Datastore/Lookup' && call.startCount === 1 && call.terminalCount === 1
          && call.attemptCount === 1 && call.fetchCount === 1 && call.fetchEventCount === 1 && call.authCount === 1,
        'one lifecycle and one actual Fetch per call');
        need(call.statusCode === contract.trace[index].status && call.responseMessages === (call.statusCode === 0 ? 1 : 0), 'call result accounting');
        need(isDeepStrictEqual(call.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }), 'call timers and retained buffers released');
        need(isDeepStrictEqual(call.execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }), 'actual asynchronous owners released');
      });
    }
    rpcCount += count; dataFetches += row.dataFetches; controlRequests += row.controlRequests;
  }
  need(report.rpcCount === rpcCount && report.dataFetches === dataFetches && report.grpcWebRequests === dataFetches
    && report.authFetches === 0 && report.authNetworkRequests === 0 && report.controlRequests === controlRequests, 'aggregate accounting');
  return report;
}
module.exports = { validateDatastoreLookupReport, expected, scenarios, runtimes, sources };
