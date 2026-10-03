'use strict';
const { isDeepStrictEqual } = require('node:util');
const runtimes = ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'];
const scenarios = ['save-promise', 'save-callback', 'batch-save', 'batch-error-promise', 'batch-error-callback',
  'insert-existing', 'insert-missing', 'upsert-existing', 'upsert-missing', 'update-existing', 'update-missing',
  'incomplete-key', 'delete-existing', 'delete-missing', 'delete-batch', 'delete-error-promise', 'delete-error-callback', 'allocate-ids'];
const sources = ['scripts/test-datastore-mutations.cjs', 'scripts/datastore-mutation-server.cjs', 'scripts/datastore-mutation-evidence.cjs',
  'fixtures/worker/datastore-mutations.mjs', 'fixtures/google/shared/datastore-mutations.mjs', 'fixtures/google/shared/sdk-call-accounting.mjs',
  ...['google', 'native', 'worker'].map(name => `fixtures/${name}/package-lock.json`)];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, message) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: datastore-mutations ${message}`); }
const wire = (type, value) => ({ type, value, excluded: false });
function typedProperties(label) {
  return { label: wire('stringValue', label), count: wire('integerValue', '9007199254740993'),
    when: wire('timestampValue', { seconds: '1767323045', nanos: 0 }), blob: wire('blobValue', '00017fff'),
    enabled: wire('booleanValue', true), nothing: wire('nullValue', 'NULL_VALUE'), ratio: wire('doubleValue', 1.25),
    nested: wire('entityValue', { label: wire('stringValue', 'child') }),
    list: wire('arrayValue', [wire('integerValue', '1'), wire('stringValue', 'two'), wire('booleanValue', false)]) };
}
function typedRow(key, label) { return { key, label, count: '9007199254740993', when: '2026-01-02T03:04:05.000Z', blob: '00017fff',
  enabled: true, nothing: null, ratio: 1.25, nested: { label: 'child' }, list: [{ integer: '1' }, 'two', false] }; }
const key = name => ({ kind: 'MutationValue', name });
const keyId = key => `${key.kind}/${key.id ? `id:${key.id}` : key.name ? `name:${key.name}` : 'incomplete'}`;
// Independently specified public tuples, mutation payloads/order, and controlled
// peer status contracts. This is not the business module or server implementation.
function expected(scenario) {
  const allocate = scenario === 'allocate-ids', incomplete = scenario === 'incomplete-key';
  const batch = scenario.startsWith('batch-'), deleting = scenario.startsWith('delete-');
  const ids = ['9007199254740993', '9007199254740994', '9007199254740995'];
  const keys = allocate ? ids.map(id => ({ kind: 'MutationValue', id })) : incomplete ? [{ kind: 'MutationValue' }]
    : (batch ? ['third', 'first', 'second'] : scenario === 'delete-batch' ? ['existing', 'missing', 'other']
      : [scenario.includes('existing') || scenario.startsWith('delete-error') ? 'existing' : scenario.includes('missing') ? 'missing' : 'single']).map(key);
  const operation = deleting ? 'delete' : /^(insert|upsert|update)-/.test(scenario) ? scenario.split('-')[0] : 'upsert';
  const code = scenario.includes('error') ? 7 : scenario === 'insert-existing' ? 6 : scenario === 'update-missing' ? 5 : 0;
  const labels = keys.map((item, index) => allocate ? `allocated-${index}` : incomplete ? 'assigned' : item.name);
  const trace = [];
  if (allocate) trace.push({ method: 'AllocateIds', keys: Array(3).fill('MutationValue/incomplete'), statusCode: 0, mutations: [] });
  trace.push({ method: 'Commit', keys: keys.map(keyId), statusCode: code,
    mutations: keys.map((item, index) => ({ operation, key: keyId(item), properties: deleting ? null : typedProperties(labels[index]) })) });
  const readKeys = incomplete ? [{ kind: 'MutationValue', id: ids[0] }] : keys;
  trace.push({ method: 'Lookup', keys: readKeys.map(keyId), statusCode: 0, mutations: [] });
  trace.push({ method: 'Lookup', keys: ['MutationMarker/name:alive'], statusCode: 0, mutations: [] });
  const callback = scenario.endsWith('callback');
  const result = { scenario, responses: code ? [] : [{ tupleLength: callback ? null : deleting ? 3 : 1, mutationCount: keys.length,
    versions: keys.map((_, index) => String(101 + index)), indexUpdates: keys.length * 2,
    assignedIds: keys.map(() => incomplete ? ids[0] : null) }],
  error: code ? { code, details: `mutation-fixture-${code}`, text: ['controlled-whole-rpc'], binary: ['00ff80'] } : null,
  rows: code ? (keys.filter(item => item.name === 'existing').map(item => ({ key: item, label: 'before' })))
    : deleting ? [] : readKeys.map((item, index) => typedRow(item, labels[index])),
  callback: callback ? { calls: 1, arity: deleting ? 4 : 2, errorPosition: code ? 0 : null } : null,
  allocatedIds: allocate ? ids : incomplete ? [ids[0]] : [], reused: true };
  if (allocate) Object.assign(result, { allocationTupleLength: 2, incompleteUnchanged: true, highLevelReserveAvailable: false });
  if (incomplete) result.originalKeyUpdated = true;
  return { trace, result };
}
function validateDatastoreMutationReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false, 'complete installed execution');
  for (const flag of ['liveGoogle', 'cloudflareTranslation', 'officialEmulator', 'adapterRetryEnabled', 'sdkRetryEnabled']) need(report[flag] === false, `${flag} boundary`);
  for (const flag of ['controlledNativeGrpcServer', 'sameSharedSource', 'resourcesCheckedBeforeClose', 'controlDataRpcSeparated', 'nativeBusinessEquivalent', 'runtimeDisposed']) need(report[flag] === true, `${flag} guarantee`);
  need(report.authNetwork === 'anonymous-pass-through-no-network' && isDeepStrictEqual(report.failures, []), 'anonymous scope and peer failures');
  need(report.sdkVersion === '10.1.0' && report.nativeGrpcVersion === '1.14.0', 'pinned SDK versions');
  need(/^v\d+\.\d+\.\d+/.test(report.runtime) && typeof report.workerd === 'string' && report.workerd.length > 0
    && typeof report.miniflare === 'string' && report.miniflare.length > 0 && report.compatibilityDate === '2026-09-21', 'runtime versions');
  need(sources.every(file => hash(report.evidence?.[file])), 'source provenance');
  for (const file of ['datastore-mutations.mjs', 'sdk-call-accounting.mjs']) {
    const digest = report.sharedSourceHashes?.[file];
    need(hash(digest) && digest === report.evidence[`fixtures/google/shared/${file}`], 'shared source evidence');
    for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd']) need(report.sourceHashes?.[runtime]?.[file] === digest, `${runtime} shared identity`);
  }
  need(isDeepStrictEqual(Object.keys(report.sourceHashes).sort(), ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd'].sort()), 'exact source runtime set');
  need(report.buildProfile?.name === 'google-static-v1' && report.buildProfile.revision === 4
    && hash(report.buildProfile.sha256) && hash(report.buildProfile.registrySha256) && hash(report.bundleSha256), 'Worker build provenance');
  for (const [mapName, fixture, grpcEntry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
    const required = ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/datastore/package.json',
      '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js', '@google-cloud/datastore/build/src/entity.js',
      '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json', 'google-gax/package.json', 'google-auth-library/package.json']
      .map(file => `fixtures/${fixture}/node_modules/${file}`);
    need(isDeepStrictEqual(Object.keys(report[mapName] || {}).sort(), required.sort()) && Object.values(report[mapName]).every(hash), `${mapName} provenance`);
  }
  need(Array.isArray(report.results) && report.results.length === 90 && report.caseCount === 90, 'exact matrix');
  let rpcCount = 0, dataFetches = 0;
  for (const runtime of runtimes) for (const scenario of scenarios) {
    const matches = report.results.filter(row => row.runtime === runtime && row.scenario === scenario); need(matches.length === 1, `unique ${runtime}/${scenario}`);
    const row = matches[0], contract = expected(scenario), count = contract.trace.length;
    need(row.status === 'passed' && row.rpcCount === count, 'passed row and RPC count');
    need(isDeepStrictEqual(row.trace, contract.trace), `${runtime}/${scenario} exact mutation/read trace`);
    need(isDeepStrictEqual(row.result, contract.result), `${runtime}/${scenario} public SDK contract`);
    need(row.dataFetches === (runtime === 'native' ? 0 : count) && row.grpcWebRequests === row.dataFetches
      && row.authFetches === 0 && row.controlRequests === 0, 'data/auth/control accounting');
    need(Array.isArray(row.receipts) && row.receipts.length === count, 'peer receipts');
    row.receipts.forEach(receipt => {
      need(isDeepStrictEqual({ ...receipt, logicalCallId: null }, { logicalCallId: null, projectId: 'wga-mutations', databaseId: 'mutation-db',
        namespace: `${runtime}-${scenario}`, routing: { project_id: 'wga-mutations', database_id: 'mutation-db' } }), 'peer routing and namespace');
      if (runtime === 'native') need(receipt.logicalCallId === null, 'native IDs not fabricated');
    });
    if (runtime === 'native') need(row.accounting === null, 'native accounting boundary');
    else {
      const observed = row.accounting;
      need(observed?.beforeClose === true && observed.calls?.length === count, 'pre-close calls');
      need(isDeepStrictEqual(observed.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }) && observed.activeChannels === 0 && observed.channelCount === 1, 'released resources and channels');
      need(new Set(observed.calls.map(call => call.logicalCallId)).size === count, 'distinct logical calls');
      observed.calls.forEach((call, index) => {
        need(typeof call.logicalCallId === 'string' && call.logicalCallId.length > 0 && call.logicalCallId === row.receipts[index].logicalCallId, 'physical Fetch and peer call identity');
        need(call.method === `/google.datastore.v1.Datastore/${contract.trace[index].method}` && call.startCount === 1 && call.terminalCount === 1
          && call.attemptCount === 1 && call.fetchCount === 1 && call.fetchEventCount === 1 && call.authCount === 1, 'one lifecycle/Fetch per call');
        need(call.statusCode === contract.trace[index].statusCode && call.responseMessages === (call.statusCode ? 0 : 1), 'terminal result');
        need(isDeepStrictEqual(call.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }), 'retained buffers and timers');
        need(isDeepStrictEqual(call.execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }), 'actual asynchronous owners');
      });
    }
    rpcCount += count; dataFetches += row.dataFetches;
  }
  need(report.rpcCount === rpcCount && report.dataFetches === dataFetches && report.grpcWebRequests === dataFetches && report.authFetches === 0 && report.controlRequests === 0, 'aggregate accounting');
  return report;
}
module.exports = { validateDatastoreMutationReport, expected, scenarios, runtimes, sources };
