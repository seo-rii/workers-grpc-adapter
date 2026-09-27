'use strict';
const { isDeepStrictEqual } = require('node:util');
const envoyPin = require('../fixtures/envoy/binary.json');
const runtimes = ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'];
const profiles = [
  { id: 'google-static-v1', fixture: 'google', native: 'native', version: '8.3.0', revision: 4 },
  { id: 'google-modern-v1', fixture: 'modern', native: 'modern-native', version: '9.2.0', revision: 2 },
];
const scenarios = ['batch-permanent-partial', 'batch-transient-before', 'batch-transient-partial',
  'query-get-permanent-partial', 'query-get-transient-before', 'query-get-transient-partial',
  'query-stream-permanent-partial', 'query-stream-transient-before', 'query-stream-transient-partial', 'query-stream-destroy'];
const sources = ['scripts/test-firestore-read-errors.cjs', 'scripts/firestore-read-error-server.cjs', 'scripts/firestore-read-evidence.cjs',
  'fixtures/google/shared/firestore-read-errors.mjs', 'fixtures/worker/firestore-read-errors.mjs',
  'scripts/emulator-envoy.cjs', 'fixtures/envoy/binary.json',
  ...['google', 'native', 'modern', 'modern-native', 'worker'].map(fixture => `fixtures/${fixture}/package-lock.json`),
  ...profiles.map(profile => `src/build/profiles/${profile.id}.json`)];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, reason) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: firestore-read ${reason}`); }

// These expectations are independent of the shared business/peer sources. They
// describe the pinned SDKs and deterministic peer, not arbitrary retry policy.
function expected(scenario) {
  const batch = scenario.startsWith('batch-'), stream = scenario.startsWith('query-stream-');
  const permanent = scenario.includes('-permanent-'), partial = scenario.endsWith('-partial');
  const destroyed = scenario === 'query-stream-destroy';
  const method = batch ? 'BatchGetDocuments' : 'RunQuery';
  const request = batch ? { documents: ['b', 'a', 'c'] } : { limit: 3, cursor: null, readTime: null };
  const resumed = !partial ? request : batch ? { documents: ['c'] }
    : { limit: 2, cursor: { before: false, values: [1, 'a'] }, readTime: { seconds: '1700000000', nanos: 123000000 } };
  const calls = [{ method, attempt: 1, request, sentDocuments: destroyed ? ['a'] : partial ? batch ? ['b', 'a'] : ['a'] : [],
    statusCode: destroyed ? 0 : permanent ? 7 : 14, deadlineBounded: true, progressAcknowledged: partial, releaseAfterDestroy: destroyed }];
  if (!permanent && !destroyed) calls.push({ method, attempt: 2, request: resumed,
    sentDocuments: batch ? partial ? ['c'] : ['c', 'a', 'b'] : partial ? ['b', 'c'] : ['a', 'b', 'c'],
    statusCode: 0, deadlineBounded: true, progressAcknowledged: false, releaseAfterDestroy: false });
  calls.push({ method: 'BatchGetDocuments', attempt: 1, request: { documents: ['marker'] }, sentDocuments: ['marker'],
    statusCode: 0, deadlineBounded: true, progressAcknowledged: false, releaseAfterDestroy: false });
  const rows = destroyed ? [{ id: 'a', exists: true, value: 1 }] : permanent ? stream ? [{ id: 'a', exists: true, value: 1 }] : [] : batch
    ? [{ id: 'b', exists: true, value: 2 }, { id: 'a', exists: false, value: null }, { id: 'c', exists: true, value: 3 }]
    : ['a', 'b', 'c'].map((id, index) => ({ id, exists: true, value: index + 1 }));
  const events = destroyed ? ['data:a', 'close'] : stream ? permanent ? ['data:a', 'error:7', 'close'] : ['data:a', 'data:b', 'data:c', 'end', 'close']
    : [permanent ? 'reject:7' : 'resolve'];
  const result = { scenario, rows, events, resolved: !stream && !permanent ? 1 : 0, rejected: !stream && permanent ? 1 : 0,
    errorCode: permanent ? 7 : null, streamErrorCount: stream && permanent ? 1 : 0,
    streamEndCount: stream && !permanent && !destroyed ? 1 : 0, streamCloseCount: stream ? 1 : 0,
    sameClientRecovery: true, noLateEvents: true,
    progressSnapshots: partial ? batch ? 2 : 1 : 0, progressAcknowledgements: partial ? 1 : 0 };
  if (destroyed) result.destroyRetainedUntilRelease = true;
  return { calls, result, controlRequests: partial || destroyed ? 1 : 0 };
}

function validateFirestoreReadReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false && report.nativeOnly === false, 'complete installed execution');
  for (const key of ['liveGoogle', 'cloudflareAutomaticConversion', 'officialEmulator', 'restFallback', 'adapterRetryEnabled']) {
    need(report[key] === false, `${key} boundary`);
  }
  for (const key of ['realEnvoy', 'controlledNativeGrpcServer', 'resourcesCheckedBeforeTerminate', 'nativeBusinessEquivalent', 'runtimeDisposed']) {
    need(report[key] === true, `${key} guarantee`);
  }
  for (const key of ['peerFaults', 'boundaryErrors', 'asyncErrors', 'cleanupFailures']) need(isDeepStrictEqual(report[key], []), `${key} must be empty`);
  need(typeof report.node === 'string' && /^v\d+\.\d+\.\d+/.test(report.node)
    && typeof report.workerd === 'string' && report.workerd.length > 0
    && typeof report.miniflare === 'string' && report.miniflare.length > 0
    && report.compatibilityDate === '2026-09-21', 'runtime identity');
  need(isDeepStrictEqual(report.testInstrumentation, { method: 'Firestore.snapshot_', versions: ['8.3.0', '9.2.0'],
    originalInvoked: true, controlDataRpcSeparated: true }), 'explicit deterministic progress instrumentation');
  need(sources.every(file => digest(report.evidence?.[file])), 'complete source evidence');
  need(digest(report.sharedSha256) && report.sharedSha256 === report.evidence['fixtures/google/shared/firestore-read-errors.mjs'], 'shared source identity');
  const sourceKeys = profiles.flatMap(profile => runtimes.map(runtime => `${profile.id}/${runtime}`));
  need(isDeepStrictEqual(Object.keys(report.sources || {}).sort(), sourceKeys.sort())
    && Object.values(report.sources).every(hash => hash === report.sharedSha256), 'byte-identical business sources');
  need(Array.isArray(report.profiles) && report.profiles.length === profiles.length, 'exact SDK profiles');
  for (const profile of profiles) {
    const receipts = report.profiles.filter(value => value.id === profile.id);
    need(receipts.length === 1, 'profile receipt uniqueness');
    const receipt = receipts[0];
    need(receipt.firestore === profile.version && receipt.nativeFirestore === profile.version && receipt.nativeGrpc === '1.14.0', 'pinned native and adapter SDKs');
    need(receipt.buildProfile?.name === profile.id && receipt.buildProfile.revision === profile.revision
      && digest(receipt.buildProfile.sha256) && digest(receipt.buildProfile.registrySha256) && digest(receipt.bundleSha256), 'built Worker profile provenance');
    for (const [mapName, fixture, grpcEntry] of [['installedInputs', profile.fixture, 'dist/index.js'], ['nativeInputs', profile.native, 'build/src/index.js']]) {
      const inputs = report[mapName];
      const required = ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/firestore/package.json',
        '@google-cloud/firestore/build/src/index.js', '@google-cloud/firestore/build/src/document-reader.js',
        '@google-cloud/firestore/build/src/reference/query-util.js', 'google-gax/package.json', 'google-auth-library/package.json',
        ...(profile.id === 'google-modern-v1' ? ['@google-cloud/firestore-api/package.json', '@google-cloud/firestore-api/build/protos/protos.json']
          : ['@google-cloud/firestore/build/protos/v1.json'])];
      need(inputs && required.every(file => digest(inputs[`fixtures/${fixture}/node_modules/${file}`])), `${mapName} ${profile.id} installed identity`);
    }
  }
  for (const [mapName, allowed] of [['installedInputs', ['google', 'modern']], ['nativeInputs', ['native', 'modern-native']]]) {
    need(Object.entries(report[mapName]).every(([file, value]) => allowed.some(fixture => file.startsWith(`fixtures/${fixture}/node_modules/`))
      && !file.split('/').includes('..') && digest(value)), `${mapName} scoped hash records`);
  }
  need(report.caseCount === 100 && report.rpcCount === 260 && report.fetchCount === 208 && report.controlRequests === 70
    && Array.isArray(report.results) && report.results.length === 100, 'aggregate case/RPC/fetch/control accounting');
  let rpcCount = 0, fetchCount = 0, controlRequests = 0;
  for (const profile of profiles) for (const runtime of runtimes) for (const scenario of scenarios) {
    const matches = report.results.filter(row => row?.profile === profile.id && row.runtime === runtime && row.scenario === scenario);
    need(matches.length === 1, `exact case matrix ${profile.id}/${runtime}/${scenario}`);
    const row = matches[0], oracle = expected(scenario);
    need(row.status === 'passed' && row.rpcCount === oracle.calls.length && row.fetchCount === (runtime === 'native' ? 0 : oracle.calls.length)
      && row.controlRequests === oracle.controlRequests && row.backendIdleBeforeNextCase === true, 'per-case counts and backend cleanup');
    need(isDeepStrictEqual(row.requests, oracle.calls), 'SDK retry request/document/cursor/read-time/status sequence');
    need(isDeepStrictEqual(row.result, oracle.result), 'application result/error/event/progress contract');
    const native = report.results.find(value => value.profile === profile.id && value.runtime === 'native' && value.scenario === scenario);
    need(native && isDeepStrictEqual(row.requests, native.requests) && isDeepStrictEqual(row.result, native.result), 'exact native business and retry parity');
    if (runtime === 'native') need(row.observer === null, 'native observer boundary');
    else {
      need(row.observer && isDeepStrictEqual(Object.keys(row.observer).sort(), ['calls', 'resources'])
        && isDeepStrictEqual(row.observer.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }), 'idle transport before SDK termination');
      need(Array.isArray(row.observer.calls) && row.observer.calls.length === oracle.calls.length, 'one observed logical call per SDK RPC');
      const ids = new Set();
      row.observer.calls.forEach((call, index) => {
        need(typeof call?.logicalCallId === 'string' && /^wga-[1-9]\d*$/.test(call.logicalCallId)
          && !ids.has(call.logicalCallId), 'distinct SDK retry logical calls');
        ids.add(call.logicalCallId);
        need(isDeepStrictEqual(call, { logicalCallId: call.logicalCallId, startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1,
          statusCode: oracle.calls[index].statusCode, responseMessages: oracle.calls[index].sentDocuments.length }),
        'single adapter attempt/fetch/terminal and consumed response messages');
      });
    }
    rpcCount += row.rpcCount; fetchCount += row.fetchCount; controlRequests += row.controlRequests;
  }
  need(rpcCount === report.rpcCount && fetchCount === report.fetchCount && controlRequests === report.controlRequests, 'summed RPC/fetch/control counts');
  const envoy = report.envoy;
  need(envoy?.version === envoyPin.version && envoy.sha256 === envoyPin.sha256
    && envoy.observationPoint === 'router-upstream-access-log' && envoy.firestoreSyntheticOwnerInjected === true
    && isDeepStrictEqual(envoy.exit, { code: 0, signal: null }), 'real pinned Envoy execution and shutdown');
  need(Array.isArray(report.wire) && report.wire.length === 260, 'real Envoy data RPC count');
  for (const receipt of report.wire) need(['native', 'replacement', 'workerd'].includes(receipt.runtime)
    && receipt.httpStatus === 200 && receipt.upstream === 'firestore' && receipt.flags === '-'
    && [0, 7, 14].includes(receipt.grpcStatus)
    && ['/google.firestore.v1.Firestore/BatchGetDocuments', '/google.firestore.v1.Firestore/RunQuery'].includes(receipt.method), 'observed native upstream RPC');
  for (const [runtime, count] of [['native', 52], ['replacement', 104], ['workerd', 104]]) {
    need(report.wire.filter(row => row.runtime === runtime).length === count, 'Envoy listener counts');
  }
  for (const [code, count] of [[0, 170], [7, 30], [14, 60]]) need(report.wire.filter(row => row.grpcStatus === code).length === count, 'Envoy status totals');
  for (const [method, count] of [['BatchGetDocuments', 150], ['RunQuery', 110]]) {
    need(report.wire.filter(row => row.method === `/google.firestore.v1.Firestore/${method}`).length === count, 'Envoy method totals');
  }
  for (const row of report.results) {
    const id = `${row.profile}/${row.runtime}/${row.scenario}`;
    const wire = report.wire.filter(receipt => receipt.invocation === id);
    // Destroy closes the application stream while RunQuery remains alive. The
    // same-client marker completes before explicit peer release of that RPC.
    const completed = row.scenario === 'query-stream-destroy' ? [...row.requests].reverse() : row.requests;
    need(isDeepStrictEqual(wire.map(receipt => ({ method: receipt.method.split('/').at(-1), statusCode: receipt.grpcStatus,
      runtime: receipt.runtime })), completed.map(call => ({ method: call.method, statusCode: call.statusCode,
      runtime: row.runtime === 'native' ? 'native' : row.runtime.startsWith('adapter-') ? 'replacement' : 'workerd' }))), 'Envoy per-case order/status receipt');
  }
}
module.exports = { validateFirestoreReadReport };
