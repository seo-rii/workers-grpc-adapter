'use strict';
const { isDeepStrictEqual } = require('node:util');
const envoyPin = require('../fixtures/envoy/binary.json');
const runtimes = ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'];
const profiles = [
  { id: 'google-static-v1', fixture: 'google', native: 'native', version: '10.1.1', revision: 5 },
  { id: 'google-modern-v1', fixture: 'modern', native: 'modern-native', version: '11.1.0', revision: 2 },
];
const scenarios = ['commit-success', 'query-commit', 'rollback-queued', 'readonly-read', 'readonly-write-rejected',
  'commit-aborted', 'disconnect-before-apply', 'disconnect-after-apply', 'v1-deadline-commit', 'crossed-transactions'];
const sources = ['scripts/test-datastore-transactions.cjs', 'scripts/datastore-transaction-server.cjs',
  'scripts/datastore-transaction-evidence.cjs', 'fixtures/google/shared/datastore-transactions.mjs',
  'fixtures/worker/datastore-transactions.mjs', 'scripts/emulator-envoy.cjs', 'fixtures/envoy/binary.json',
  ...['google', 'native', 'modern', 'modern-native', 'worker'].map(fixture => `fixtures/${fixture}/package-lock.json`),
  ...profiles.map(profile => `src/build/profiles/${profile.id}.json`)];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, reason) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: datastore-transactions ${reason}`); }

// Independent pinned-SDK/controlled-peer contracts. Neither the runner's
// success flag nor native/adapter agreement alone can establish correctness.
function expected(scenario) {
  const first = '00ff0180', second = '00ff0280';
  const readonly = scenario.startsWith('readonly-'), crossed = scenario === 'crossed-transactions';
  const deadline = scenario === 'v1-deadline-commit', disconnected = scenario.startsWith('disconnect-');
  const errorCode = scenario === 'readonly-write-rejected' ? 3 : scenario === 'commit-aborted' ? 10
    : disconnected ? 14 : deadline ? 4 : null;
  function call(method, identity, transactionId, extra = {}) {
    return { method, identity, transactionId, readOnly: false, deadlineBounded: true, query: null,
      keys: [], mutationValues: [], appliedMutations: 0, statusCode: 0, disconnect: false,
      credentialIdentity: null, quotaIdentity: null, targetIdentity: null, ...extra };
  }
  const calls = [call('BeginTransaction', 'a', first, { readOnly: readonly })];
  if (crossed) {
    calls.push(call('BeginTransaction', 'b', second), call('Lookup', 'b', second, { keys: ['b'] }),
      call('Lookup', 'a', first, { keys: ['a'] }),
      call('Commit', 'b', second, { keys: ['b'], mutationValues: [3], appliedMutations: 1 }),
      call('Commit', 'a', first, { keys: ['a'], mutationValues: [2], appliedMutations: 1 }),
      call('Lookup', 'recovery', null, { keys: ['a'] }), call('Lookup', 'recovery', null, { keys: ['b'] }));
  } else {
    if (!deadline) calls.push(call(scenario === 'query-commit' ? 'RunQuery' : 'Lookup', 'a', first,
      { keys: ['a'], ...(scenario === 'query-commit' ? { query: { kind: 'TransactionValue', limit: 2,
        filter: { property: 'count', op: 'EQUAL', integerValue: '1' } } } : {}) }));
    if (scenario === 'rollback-queued') calls.push(call('Rollback', 'a', first));
    else {
      const empty = scenario === 'readonly-read';
      calls.push(call('Commit', 'a', first, { keys: empty ? [] : ['a'], mutationValues: empty ? [] : [2],
        appliedMutations: empty || [3, 10].includes(errorCode) || scenario === 'disconnect-before-apply' ? 0 : 1,
        statusCode: errorCode ?? 0, disconnect: disconnected }));
      // The pinned high-level SDK automatically calls rollback on commit error
      // without copying commit's per-call headers. It cannot undo accepted writes.
      if (errorCode !== null && !deadline) calls.push(call('Rollback', null, first));
    }
    calls.push(call('Lookup', 'recovery', null, { keys: ['a'] }));
  }
  if (crossed) for (const request of calls) {
    const identity = request.identity === 'recovery' ? request.keys[0] : request.identity;
    request.credentialIdentity = identity; request.quotaIdentity = identity; request.targetIdentity = identity;
  }
  const commit = { mutationCount: 1, versions: ['2'], indexUpdates: 1 };
  const result = { scenario, surface: deadline ? 'generated-v1' : 'high-level',
    transactionIds: crossed ? [first, second] : [first], readCounts: crossed ? [1, 1] : deadline ? [] : [1],
    commitResponses: crossed ? [commit, commit] : scenario === 'readonly-read' ? [{ mutationCount: 0, versions: [], indexUpdates: 0 }]
      : ['commit-success', 'query-commit'].includes(scenario) ? [commit] : [],
    errorCode, persistedCounts: crossed ? [2, 3] : ['commit-success', 'query-commit', 'disconnect-after-apply', 'v1-deadline-commit'].includes(scenario) ? [2] : [1],
    cancelHandleAvailable: scenario === 'rollback-queued' ? null : false,
    resolved: errorCode === null ? crossed ? 2 : 1 : 0, rejected: errorCode === null ? 0 : 1,
    sameClientRecovery: true, noLateEvents: true,
    credentialIsolation: crossed ? { sdkClients: 2, authProviders: 2, distinctClients: true, distinctProviders: true, distinctTargets: true,
      authEvents: ['a', 'b', 'b', 'a', 'b', 'a', 'a', 'b'],
      providers: ['a', 'b'].map(identity => ({ identity, metadataCalls: 4, targets: [identity], authorizationGenerated: true, quotaGenerated: true })),
      externalAuthRequests: 0 } : null };
  return { calls, result, controlRequests: deadline ? 1 : 0 };
}

function businessRequests(requests) {
  return requests.map(({ http2ResetCode, responseSent, termination, cancelled, ...business }) => business);
}

function validateDatastoreTransactionReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false && report.nativeOnly === false, 'complete installed execution');
  for (const key of ['liveGoogle', 'cloudflareAutomaticConversion', 'officialEmulator', 'restFallback', 'adapterRetryEnabled']) {
    need(report[key] === false, `${key} boundary`);
  }
  for (const key of ['realEnvoy', 'controlledNativeGrpcServer', 'resourcesCheckedBeforeClose', 'nativeBusinessEquivalent', 'runtimeDisposed']) {
    need(report[key] === true, `${key} guarantee`);
  }
  for (const key of ['peerFaults', 'boundaryErrors', 'asyncErrors', 'cleanupFailures']) need(isDeepStrictEqual(report[key], []), `${key} must be empty`);
  need(typeof report.node === 'string' && /^v\d+\.\d+\.\d+/.test(report.node)
    && typeof report.workerd === 'string' && report.workerd.length > 0
    && typeof report.miniflare === 'string' && report.miniflare.length > 0
    && report.compatibilityDate === '2026-09-21', 'runtime identity');
  need(isDeepStrictEqual(report.testInstrumentation, { syntheticIdentityHeaders: true, oauthCredentialIsolation: true, syntheticCachedOAuthTokens: true, nativeLoopbackTls: true,
    targetObservation: 'auth-service-url-and-fetch-origin-or-native-authority', privateSdkHooks: false, privateSdkCleanup: true, controlDataRpcSeparated: true, realHttp2Reset: true }),
  'explicit synthetic OAuth tokens, real credential isolation, public request behavior, private cleanup and actual reset boundaries');
  need(isDeepStrictEqual(report.nativeTls, { calls: 16, temporaryCredentials: true, activeStreams: 0, faults: [], disposed: true }),
    'native credential TLS bridge was exercised and disposed');
  need(sources.every(file => digest(report.evidence?.[file])), 'complete source evidence');
  need(digest(report.sharedSha256) && report.sharedSha256 === report.evidence['fixtures/google/shared/datastore-transactions.mjs'], 'shared source identity');
  const sourceKeys = profiles.flatMap(profile => runtimes.map(runtime => `${profile.id}/${runtime}`));
  need(isDeepStrictEqual(Object.keys(report.sources || {}).sort(), sourceKeys.sort())
    && Object.values(report.sources).every(hash => hash === report.sharedSha256), 'byte-identical business sources');
  need(Array.isArray(report.profiles) && report.profiles.length === profiles.length, 'exact SDK profiles');
  for (const profile of profiles) {
    const receipts = report.profiles.filter(value => value.id === profile.id);
    need(receipts.length === 1, 'profile receipt uniqueness');
    const receipt = receipts[0];
    need(receipt.datastore === profile.version && receipt.nativeDatastore === profile.version && receipt.nativeGrpc === '1.14.5', 'pinned native and adapter SDKs');
    need(receipt.buildProfile?.name === profile.id && receipt.buildProfile.revision === profile.revision
      && digest(receipt.buildProfile.sha256) && digest(receipt.buildProfile.registrySha256) && digest(receipt.bundleSha256), 'built Worker profile provenance');
    for (const [mapName, fixture, grpcEntry] of [['installedInputs', profile.fixture, 'dist/index.js'], ['nativeInputs', profile.native, 'build/src/index.js']]) {
      const inputs = report[mapName];
      const required = ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/datastore/package.json',
        '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/transaction.js',
        '@google-cloud/datastore/build/src/request.js',
        profile.id === 'google-modern-v1' ? '@google-cloud/datastore-api/build/src/v1/datastore_client.js' : '@google-cloud/datastore/build/src/v1/datastore_client.js',
        profile.id === 'google-modern-v1' ? '@google-cloud/datastore-api/build/protos/protos.json' : '@google-cloud/datastore/build/protos/protos.json',
        'google-gax/package.json', 'google-auth-library/package.json', 'google-auth-library/build/src/auth/oauth2client.js'];
      need(inputs && required.every(file => digest(inputs[`fixtures/${fixture}/node_modules/${file}`])), `${mapName} ${profile.id} installed identity`);
    }
  }
  for (const [mapName, allowed] of [['installedInputs', ['google', 'modern']], ['nativeInputs', ['native', 'modern-native']]]) {
    need(Object.entries(report[mapName]).every(([file, value]) => allowed.some(fixture => file.startsWith(`fixtures/${fixture}/node_modules/`))
      && !file.split('/').includes('..') && digest(value)), `${mapName} scoped hash records`);
  }
  need(report.caseCount === 100 && report.rpcCount === 470 && report.fetchCount === 376 && report.controlRequests === 10
    && Array.isArray(report.results) && report.results.length === 100, 'aggregate case/RPC/fetch/control accounting');
  let rpcCount = 0, fetchCount = 0, controlRequests = 0;
  for (const profile of profiles) for (const runtime of runtimes) for (const scenario of scenarios) {
    const matches = report.results.filter(row => row?.profile === profile.id && row.runtime === runtime && row.scenario === scenario);
    need(matches.length === 1, `exact case matrix ${profile.id}/${runtime}/${scenario}`);
    const row = matches[0], oracle = expected(scenario);
    need(row.status === 'passed' && row.rpcCount === oracle.calls.length && row.fetchCount === (runtime === 'native' ? 0 : oracle.calls.length)
      && row.controlRequests === oracle.controlRequests && row.backendIdleBeforeNextCase === true, 'per-case counts and peer cleanup');
    need(Array.isArray(row.requests) && isDeepStrictEqual(businessRequests(row.requests), oracle.calls), 'exact transaction ID, method, identity, query, mutation, outcome and rollback sequence');
    for (const call of row.requests) {
      if (scenario === 'v1-deadline-commit' && call.method === 'Commit') {
        need(call.termination === 'client-reset' && [2, 8].includes(call.http2ResetCode) && call.responseSent === false && call.cancelled === (call.http2ResetCode === 8)
          || call.termination === 'peer-deadline' && [0, 2, 8].includes(call.http2ResetCode) && call.responseSent === true && call.cancelled === (call.http2ResetCode === 8),
        'deadline termination is measured client reset or cooperative peer deadline');
      } else need(call.termination === (call.disconnect ? 'server-reset' : 'server-response') && call.http2ResetCode === (call.disconnect ? 2 : 0)
        && call.responseSent === !call.disconnect && call.cancelled === false, 'actual peer response/reset receipt');
    }
    need(isDeepStrictEqual(row.result, oracle.result), 'application surface, tuple summary, status, write uncertainty and recovery contract');
    const native = report.results.find(value => value.profile === profile.id && value.runtime === 'native' && value.scenario === scenario);
    need(native && isDeepStrictEqual(businessRequests(row.requests), businessRequests(native.requests)) && isDeepStrictEqual(row.result, native.result), 'native application and request parity');
    if (runtime === 'native') need(row.observer === null, 'native observer boundary');
    else {
      need(row.observer && isDeepStrictEqual(Object.keys(row.observer).sort(), ['calls', 'resources'])
        && isDeepStrictEqual(row.observer.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }), 'idle transport before SDK close');
      need(Array.isArray(row.observer.calls) && row.observer.calls.length === oracle.calls.length, 'one observed logical call per SDK RPC');
      const ids = new Set();
      row.observer.calls.forEach((call, index) => {
        need(typeof call?.logicalCallId === 'string' && /^wga-[1-9]\d*$/.test(call.logicalCallId)
          && !ids.has(call.logicalCallId), 'distinct logical call IDs');
        ids.add(call.logicalCallId);
        need(isDeepStrictEqual(call, { logicalCallId: call.logicalCallId, startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1,
          statusCode: oracle.calls[index].statusCode, responseMessages: oracle.calls[index].statusCode === 0 ? 1 : 0 }),
        'one adapter attempt/fetch/terminal and exact response count per SDK RPC');
      });
    }
    rpcCount += row.rpcCount; fetchCount += row.fetchCount; controlRequests += row.controlRequests;
  }
  need(rpcCount === report.rpcCount && fetchCount === report.fetchCount && controlRequests === report.controlRequests, 'summed RPC/fetch/control counts');
  const envoy = report.envoy;
  need(envoy?.version === envoyPin.version && envoy.sha256 === envoyPin.sha256
    && envoy.observationPoint === 'router-upstream-access-log'
    && isDeepStrictEqual(envoy.exit, { code: 0, signal: null }), 'real pinned Envoy execution and shutdown');
  need(Array.isArray(report.wire) && report.wire.length === 470, 'real Envoy data RPC count');
  need(isDeepStrictEqual(report.results.map(row => `${row.profile}/${row.runtime}/${row.scenario}`),
    profiles.flatMap(profile => runtimes.flatMap(runtime => scenarios.map(scenario => `${profile.id}/${runtime}/${scenario}`)))), 'serial case order anchors untagged native SDK rollbacks');
  let wireOffset = 0;
  for (const row of report.results) {
    const id = `${row.profile}/${row.runtime}/${row.scenario}`;
    const wire = report.wire.slice(wireOffset, wireOffset + row.requests.length);
    wireOffset += row.requests.length;
    need(wire.length === row.requests.length, 'one upstream receipt per case RPC');
    // A service-bound Fetch need not propagate local abort. Its cooperative
    // peer deadline can complete after the same-client recovery read.
    const calls = row.scenario === 'v1-deadline-commit' && wire[1]?.method.endsWith('/Lookup')
      ? [row.requests[0], row.requests[2], row.requests[1]] : row.requests;
    wire.forEach((receipt, index) => {
      const call = calls[index];
      need(receipt.invocation === (row.runtime === 'native' && call.method === 'Rollback' && call.identity === null ? null : id), 'invocation or anchored native automatic rollback');
      need(receipt.runtime === (row.runtime === 'native' ? 'native' : row.runtime.startsWith('adapter-') ? 'replacement' : 'workerd')
        && receipt.upstream === 'datastore' && receipt.method === `/google.datastore.v1.Datastore/${call.method}`, 'exact upstream listener/method/sequence');
      // The peer's local close code and Envoy's response observation are
      // independent. Even after headersSent and a clean peer close, downstream
      // cancellation can leave Envoy with no response. Validate each receipt
      // at its own observation point; the peer's 0/2/8 close codes and response
      // attempt are checked above, and the application must still report code 4.
      // Envoy 1.39.1 infers UNKNOWN (2) from HTTP 200 when no grpc-status
      // arrived in headers/trailers (grpc/common.cc and grpc/status.cc). CI
      // captured this after the peer sent headers and then closed with
      // INTERNAL_ERROR (2). Accept only that measured reset pair; a clean
      // close, CANCEL reset or ordinary response must not hide a lost status.
      if (call.termination === 'peer-deadline') need(receipt.flags === '-' && (receipt.httpStatus === 200 && receipt.grpcStatus === 4
        || receipt.httpStatus === 200 && receipt.grpcStatus === 2 && call.http2ResetCode === 2
        || receipt.httpStatus === 0 && receipt.grpcStatus === null), 'peer deadline response or response/reset race');
      else if (call.termination === 'server-response') need(receipt.httpStatus === 200 && receipt.grpcStatus === call.statusCode && receipt.flags === '-', 'upstream response status');
      else need(receipt.httpStatus === 0 && receipt.grpcStatus === null && receipt.flags === (call.disconnect ? 'UR' : '-'), 'actual upstream reset without grpc-status');
    });
  }
}
module.exports = { validateDatastoreTransactionReport };
