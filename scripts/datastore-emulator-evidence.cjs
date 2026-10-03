'use strict';
const { isDeepStrictEqual } = require('node:util');
const runtimes = ['native', 'replacement', 'workerd-first', 'workerd-second'];
const prefix = '/google.datastore.v1.Datastore/';
const sources = ['scripts/google-emulator-test.cjs', 'scripts/emulator-envoy.cjs', 'scripts/datastore-emulator-evidence.cjs',
  'fixtures/google/emulator-worker.mjs', 'fixtures/emulators/toolchain.json', 'fixtures/emulators/launcher.cjs',
  'fixtures/emulators/download.cjs', ...['google', 'native', 'worker'].map(name => `fixtures/${name}/package-lock.json`)];
const helpers = ['sdk-call-accounting.mjs', 'emulator-datastore.mjs', 'emulator-datastore-streams.mjs', 'datastore.mjs', 'assert.mjs'];
// These method/status contracts follow the explicit business operations,
// including cleanup RPCs. They are independent of the observed event counts.
const contracts = {
  'datastore-crud': ['Commit', 'Lookup', 'RunQuery', 'Commit'],
  'datastore-transaction': ['Commit', 'BeginTransaction', 'Lookup', 'Commit', 'Lookup', 'Commit'],
  'datastore-emulator-types': ['Commit', 'Lookup', 'Lookup', 'Commit'],
  'datastore-emulator-batch': ['Commit', 'Lookup', 'Lookup', 'Lookup', 'Lookup', 'Lookup', 'Commit', 'Lookup', 'Commit'],
  'datastore-emulator-queries': ['Commit', 'RunQuery', 'RunQuery', 'RunQuery', 'RunQuery', 'RunQuery', 'RunQuery', 'Commit'],
  'datastore-emulator-aggregation': ['Commit', 'RunAggregationQuery', 'RunAggregationQuery', 'Commit'],
  'datastore-emulator-ids': ['AllocateIds', 'ReserveIds', 'Lookup', 'Commit', 'Lookup', 'Commit', 'Lookup', 'Commit'],
  'datastore-emulator-rollback': ['Commit', 'BeginTransaction', 'Lookup', 'Rollback', 'Lookup', 'Lookup', 'Commit'],
  'datastore-emulator-errors': ['Commit', 'Commit#6', 'Lookup', 'Commit#5', 'Lookup', 'Commit', 'Lookup', 'Commit', 'Lookup', 'Commit', 'Lookup', 'Commit', 'Lookup', 'BeginTransaction', 'Lookup', 'Commit#5', 'Rollback', 'Lookup', 'Commit', 'Lookup'],
  'datastore-emulator-streams': ['Commit', 'RunQuery', 'Lookup', 'RunQuery', 'Lookup', 'Commit', 'Lookup'],
};
const addedChecks = {
  'datastore-emulator-types': ['explicit-undefined-object-properties-omitted', 'explicit-null-and-missing-distinguished', 'input-undefined-properties-not-mutated'],
  'datastore-emulator-queries': ['out-of-order-insertion-with-equal-ranks', 'equal-rank-key-tiebreaker-across-page-boundary'],
  'datastore-emulator-aggregation': ['empty-promise-tuple-and-exact-aliases', 'empty-count-and-sum-number-positive-zero-average-own-null'],
  'datastore-emulator-ids': ['save-incomplete-key-assigns-caller-key-id', 'assigned-key-get-round-trip', 'high-level-allocateIds-no-reserveIds-generated-v1-reserveIds'],
  'datastore-emulator-errors': ['insert-missing-creates-entity', 'upsert-missing-creates-and-existing-replaces', 'update-existing-replaces-entity', 'public-mutation-methods-state-verified'],
};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, message) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: datastore-emulator ${message}`); }
function runtimeMatches(entry, runtime) {
  return runtime.startsWith('workerd-') ? entry.runtime === 'workerd' && entry.invocation === runtime.slice(8) : entry.runtime === runtime;
}
function methodStatus(value) { const [method, status] = value.split('#'); return { method: prefix + method, statusCode: Number(status || 0) }; }
function validateDatastoreEmulatorReport(report) {
  need(report?.status === 'passed' && report.realGoogleSDK === true && report.officialEmulators === true, 'official emulator execution');
  for (const flag of ['liveGoogleApiExecuted', 'deployedCloudflareExecuted', 'releaseEligible']) need(report[flag] === false, `${flag} boundary`);
  for (const flag of ['sameSharedFiles', 'businessEquivalent', 'wireEquivalent']) need(report[flag] === true, `${flag} guarantee`);
  need(sources.every(file => hash(report.evidence?.[file])), 'source provenance');
  for (const file of helpers) {
    const digest = report.sourceHashes?.native?.[file];
    need(hash(digest) && ['replacement', 'workerd'].every(runtime => report.sourceHashes?.[runtime]?.[file] === digest), 'same shared accounting/business source');
  }
  for (const [name, fixture, entry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
    const required = ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${entry}`, '@google-cloud/datastore/package.json',
      '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js',
      '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json',
      'google-gax/package.json', 'google-auth-library/package.json'].map(file => `fixtures/${fixture}/node_modules/${file}`);
    need(isDeepStrictEqual(Object.keys(report[name] || {}).sort(), required.sort()) && Object.values(report[name]).every(hash), `${name} pinned installed inputs`);
  }
  const summary = report.datastoreAccounting;
  need(summary?.status === 'passed' && summary.scope === 'anonymous-grpc-web-official-emulator' && summary.mode === 'grpc-web'
    && summary.adapterRetryEnabled === false && summary.resourcesCheckedBeforeClose === true && summary.physicalEnvoyReceiptsJoined === true,
  'accounting scope and lifecycle guarantees');
  need(summary.authMode === 'disabled-insecure-loopback' && summary.authFetches === 0 && summary.authNetworkRequests === 0
    && summary.authMetadataRequests === 0 && summary.controlRequests === 0
    && summary.controlScope === 'no-suite-control-requests; emulator and Envoy readiness are harness setup', 'anonymous data/auth/control separation');
  const rows = report.results?.filter(row => row.sdk === '@google-cloud/datastore');
  need(rows?.length === runtimes.length * Object.keys(contracts).length, 'exact Datastore matrix');
  const nativeSignature = [];
  let logicalCalls = 0, dataFetches = 0;
  for (const runtime of runtimes) {
    const seen = new Set();
    for (const [suite, sequence] of Object.entries(contracts)) {
      const matches = rows.filter(row => row.runtime === runtime && row.suite === suite);
      need(matches.length === 1, `unique ${runtime}/${suite}`);
      const row = matches[0], expected = sequence.map(methodStatus), count = expected.length;
      need(row.status === 'passed' && Array.isArray(row.checks) && row.checks.length > 0, 'suite business passed');
      need((addedChecks[suite] || []).every(check => row.checks.includes(check)), 'added public SDK contracts exercised');
      need(row.registeredClients === (suite === 'datastore-emulator-ids' ? 2 : 1)
        && row.clientsClosed === row.registeredClients, 'all SDK clients closed after suite');
      need(row.authMode === 'disabled-insecure-loopback' && row.authFetches === 0 && row.authNetworkRequests === 0
        && row.authMetadataRequests === 0 && row.controlRequests === 0, 'suite anonymous counters');
      need(row.dataFetches === (runtime === 'native' ? 0 : count) && row.grpcWebRequests === row.dataFetches, 'actual data Fetch count');
      if (runtime === 'native') {
        need(row.accounting === null, 'no fabricated native adapter telemetry');
        nativeSignature.push(...expected.map(call => `${call.method}#${call.statusCode}`));
        continue;
      }
      need(isDeepStrictEqual(row.checks, rows.find(value => value.runtime === 'native' && value.suite === suite).checks), 'native shared business contract');
      const observed = row.accounting;
      need(observed?.beforeClose === true && observed.calls?.length === count, 'complete snapshot before SDK close');
      need(observed.activeChannels === 0 && observed.channelCount === row.registeredClients, 'channel registries drained before close');
      need(isDeepStrictEqual(observed.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }), 'admission and buffers released');
      const requests = report.requests.filter(item => runtimeMatches(item, runtime) && item.suite === suite);
      const arrivals = report.wire.filter(item => runtimeMatches(item, runtime) && item.suite === suite);
      need(requests.length === count && arrivals.length === count, 'independent transport and Envoy receipt count');
      observed.calls.forEach((call, index) => {
        need(typeof call.logicalCallId === 'string' && /^wga-\d+$/.test(call.logicalCallId) && !seen.has(call.logicalCallId), 'unique actual logical call identity');
        seen.add(call.logicalCallId);
        need(call.method === expected[index].method && call.statusCode === expected[index].statusCode, 'explicit method/status sequence');
        need(call.startCount === 1 && call.terminalCount === 1 && call.attemptCount === 1 && call.fetchCount === 1
          && call.fetchEventCount === 1 && call.authCount === 1 && call.responseMessages === (call.statusCode === 0 ? 1 : 0), 'one lifecycle and one physical Fetch');
        need(isDeepStrictEqual(call.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }), 'terminal timer and retained buffers released');
        need(isDeepStrictEqual(call.execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }), 'actual execution owners released');
        const sent = requests.filter(item => item.logicalCallId === call.logicalCallId), received = arrivals.filter(item => item.logicalCallId === call.logicalCallId);
        need(sent.length === 1 && received.length === 1 && sent[0].method === call.method && received[0].method === call.method,
          'observer to actual Fetch to Envoy identity join');
        need(Number(received[0].grpcStatus) === call.statusCode && Number(received[0].httpStatus) === 200 && received[0].upstream === 'datastore'
          && received[0].flags === '-' && sent[0].httpStatus === 200 && sent[0].requestContentType === 'application/grpc-web+proto'
          && /^application\/grpc-web(?:\+proto)?$/.test(sent[0].responseContentType) && Number.isSafeInteger(sent[0].requestBytes)
          && sent[0].requestBytes > 0, 'peer method/status and transport framing');
      });
      logicalCalls += count; dataFetches += row.dataFetches;
    }
    const arrivals = report.wire.filter(item => runtimeMatches(item, runtime) && item.method.startsWith(prefix));
    need(isDeepStrictEqual(arrivals.map(item => `${item.method}#${item.grpcStatus}`).sort(), [...nativeSignature].sort()), 'native-equivalent complete Datastore wire methods/statuses');
    const requests = report.requests.filter(item => runtimeMatches(item, runtime) && item.method.startsWith(prefix));
    need(requests.length === (runtime === 'native' ? 0 : arrivals.length), 'no unattributed Datastore Fetches');
  }
  need(summary.logicalCalls === logicalCalls && summary.dataFetches === dataFetches && logicalCalls === dataFetches, 'aggregate actual accounting');
  return report;
}
module.exports = { validateDatastoreEmulatorReport, contracts, runtimes, sources, helpers, addedChecks };
