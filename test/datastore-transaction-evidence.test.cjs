'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDatastoreTransactionReport } = require('../scripts/datastore-transaction-evidence.cjs');
const envoyPin = require('../fixtures/envoy/binary.json');

// Validator-only synthetic receipts. The real SDK, HTTP/2 peer, Envoy and
// workerd executions are produced by test-datastore-transactions.cjs instead.
// This fixture deliberately does not import the production validator's oracle.
function fixture() {
  const hash = 'a'.repeat(64), results = [], wire = [], sources = {}, evidence = {}, installedInputs = {}, nativeInputs = {};
  const profiles = [
    { id: 'google-static-v1', version: '10.1.0', fixture: 'google', native: 'native', revision: 4 },
    { id: 'google-modern-v1', version: '11.1.0', fixture: 'modern', native: 'modern-native', revision: 2 },
  ];
  const one = '00ff0180', two = '00ff0280';
  const commit = { mutationCount: 1, versions: ['2'], indexUpdates: 1 };
  const catalog = [
    { name: 'commit-success', ids: [one], reads: [1], commits: [commit], persisted: [2], code: null, resolved: 1,
      calls: [['BeginTransaction', 'a', one], ['Lookup', 'a', one, ['a']], ['Commit', 'a', one, ['a'], [2], 1], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'query-commit', ids: [one], reads: [1], commits: [commit], persisted: [2], code: null, resolved: 1,
      calls: [['BeginTransaction', 'a', one], ['RunQuery', 'a', one, ['a']], ['Commit', 'a', one, ['a'], [2], 1], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'rollback-queued', ids: [one], reads: [1], commits: [], persisted: [1], code: null, resolved: 1,
      calls: [['BeginTransaction', 'a', one], ['Lookup', 'a', one, ['a']], ['Rollback', 'a', one], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'readonly-read', ids: [one], reads: [1], commits: [{ mutationCount: 0, versions: [], indexUpdates: 0 }], persisted: [1], code: null, resolved: 1,
      calls: [['BeginTransaction', 'a', one], ['Lookup', 'a', one, ['a']], ['Commit', 'a', one], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'readonly-write-rejected', ids: [one], reads: [1], commits: [], persisted: [1], code: 3, resolved: 0,
      calls: [['BeginTransaction', 'a', one], ['Lookup', 'a', one, ['a']], ['Commit', 'a', one, ['a'], [2], 0, 3], ['Rollback', null, one], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'commit-aborted', ids: [one], reads: [1], commits: [], persisted: [1], code: 10, resolved: 0,
      calls: [['BeginTransaction', 'a', one], ['Lookup', 'a', one, ['a']], ['Commit', 'a', one, ['a'], [2], 0, 10], ['Rollback', null, one], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'disconnect-before-apply', ids: [one], reads: [1], commits: [], persisted: [1], code: 14, resolved: 0,
      calls: [['BeginTransaction', 'a', one], ['Lookup', 'a', one, ['a']], ['Commit', 'a', one, ['a'], [2], 0, 14], ['Rollback', null, one], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'disconnect-after-apply', ids: [one], reads: [1], commits: [], persisted: [2], code: 14, resolved: 0,
      calls: [['BeginTransaction', 'a', one], ['Lookup', 'a', one, ['a']], ['Commit', 'a', one, ['a'], [2], 1, 14], ['Rollback', null, one], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'v1-deadline-commit', ids: [one], reads: [], commits: [], persisted: [2], code: 4, resolved: 0,
      calls: [['BeginTransaction', 'a', one], ['Commit', 'a', one, ['a'], [2], 1, 4], ['Lookup', 'recovery', null, ['a']]] },
    { name: 'crossed-transactions', ids: [one, two], reads: [1, 1], commits: [commit, commit], persisted: [2, 3], code: null, resolved: 2,
      calls: [['BeginTransaction', 'a', one], ['BeginTransaction', 'b', two], ['Lookup', 'b', two, ['b']], ['Lookup', 'a', one, ['a']],
        ['Commit', 'b', two, ['b'], [3], 1], ['Commit', 'a', one, ['a'], [2], 1], ['Lookup', 'recovery', null, ['a']], ['Lookup', 'recovery', null, ['b']]] },
  ];
  for (const file of ['scripts/test-datastore-transactions.cjs', 'scripts/datastore-transaction-server.cjs', 'scripts/datastore-transaction-evidence.cjs',
    'fixtures/google/shared/datastore-transactions.mjs', 'fixtures/worker/datastore-transactions.mjs', 'scripts/emulator-envoy.cjs', 'fixtures/envoy/binary.json',
    ...['google', 'native', 'modern', 'modern-native', 'worker'].map(name => `fixtures/${name}/package-lock.json`),
    ...profiles.map(profile => `src/build/profiles/${profile.id}.json`)]) evidence[file] = hash;
  let sequence = 0;
  for (const profile of profiles) {
    for (const [map, fixture, grpcEntry] of [[installedInputs, profile.fixture, 'dist/index.js'], [nativeInputs, profile.native, 'build/src/index.js']]) {
      for (const file of ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/datastore/package.json',
        '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/transaction.js',
        '@google-cloud/datastore/build/src/request.js',
        profile.fixture === 'modern' ? '@google-cloud/datastore-api/build/src/v1/datastore_client.js' : '@google-cloud/datastore/build/src/v1/datastore_client.js',
        profile.fixture === 'modern' ? '@google-cloud/datastore-api/build/protos/protos.json' : '@google-cloud/datastore/build/protos/protos.json', 'google-gax/package.json', 'google-auth-library/package.json', 'google-auth-library/build/src/auth/oauth2client.js']) {
        map[`fixtures/${fixture}/node_modules/${file}`] = hash;
      }
    }
    for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare']) {
      sources[`${profile.id}/${runtime}`] = hash;
      for (const entry of catalog) {
        const scenario = entry.name;
        const requests = entry.calls.map(([method, identity, transactionId, keys = [], mutationValues = [], appliedMutations = 0, statusCode = 0]) => ({
          method, identity, transactionId, readOnly: method === 'BeginTransaction' && scenario.startsWith('readonly-'), deadlineBounded: true,
          query: method === 'RunQuery' ? { kind: 'TransactionValue', limit: 2, filter: { property: 'count', op: 'EQUAL', integerValue: '1' } } : null,
          keys: [...keys], mutationValues: [...mutationValues], appliedMutations, statusCode,
          disconnect: statusCode === 14, cancelled: false,
          credentialIdentity: scenario === 'crossed-transactions' ? identity === 'recovery' ? keys[0] : identity : null,
          quotaIdentity: scenario === 'crossed-transactions' ? identity === 'recovery' ? keys[0] : identity : null,
          targetIdentity: scenario === 'crossed-transactions' ? identity === 'recovery' ? keys[0] : identity : null,
          http2ResetCode: statusCode === 14 || statusCode === 4 ? 2 : 0, responseSent: statusCode !== 14 && statusCode !== 4,
          termination: statusCode === 14 ? 'server-reset' : statusCode === 4 ? 'client-reset' : 'server-response',
        }));
        const result = { scenario, surface: scenario === 'v1-deadline-commit' ? 'generated-v1' : 'high-level',
          transactionIds: [...entry.ids], readCounts: [...entry.reads], commitResponses: structuredClone(entry.commits),
          errorCode: entry.code, persistedCounts: [...entry.persisted], cancelHandleAvailable: scenario === 'rollback-queued' ? null : false, resolved: entry.resolved, rejected: entry.code === null ? 0 : 1,
          sameClientRecovery: true, noLateEvents: true,
          credentialIsolation: scenario === 'crossed-transactions' ? { sdkClients: 2, authProviders: 2,
            distinctClients: true, distinctProviders: true, distinctTargets: true,
            authEvents: ['a', 'b', 'b', 'a', 'b', 'a', 'a', 'b'],
            providers: ['a', 'b'].map(identity => ({ identity, metadataCalls: 4, targets: [identity], authorizationGenerated: true, quotaGenerated: true })),
            externalAuthRequests: 0 } : null };
        const observer = runtime === 'native' ? null : {
          calls: requests.map(call => ({ logicalCallId: `wga-${++sequence}`, startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1,
            statusCode: call.statusCode, responseMessages: call.statusCode === 0 ? 1 : 0 })),
          resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 },
        };
        results.push({ profile: profile.id, runtime, scenario, status: 'passed', rpcCount: requests.length,
          fetchCount: runtime === 'native' ? 0 : requests.length, controlRequests: scenario === 'v1-deadline-commit' ? 1 : 0,
          requests, result, observer, backendIdleBeforeNextCase: true });
        for (const call of requests) wire.push({ runtime: runtime === 'native' ? 'native' : runtime.startsWith('adapter-') ? 'replacement' : 'workerd',
          invocation: runtime === 'native' && call.method === 'Rollback' && call.identity === null ? null : `${profile.id}/${runtime}/${scenario}`, method: `/google.datastore.v1.Datastore/${call.method}`,
          grpcStatus: call.disconnect || call.statusCode === 4 ? null : call.statusCode,
          httpStatus: call.disconnect || call.statusCode === 4 ? 0 : 200, upstream: 'datastore', flags: call.disconnect ? 'UR' : '-' });
      }
    }
  }
  return { status: 'passed', sourceBuild: false, nativeOnly: false, liveGoogle: false, cloudflareAutomaticConversion: false,
    officialEmulator: false, realEnvoy: true, controlledNativeGrpcServer: true, restFallback: false, adapterRetryEnabled: false,
    resourcesCheckedBeforeClose: true, nativeBusinessEquivalent: true, runtimeDisposed: true,
    sharedSha256: hash, sources, evidence, installedInputs, nativeInputs, node: 'v24.1.0', workerd: '1.20260923.0', miniflare: '4.0.0',
    compatibilityDate: '2026-09-21', peerFaults: [], boundaryErrors: [], asyncErrors: [], cleanupFailures: [],
    testInstrumentation: { syntheticIdentityHeaders: true, oauthCredentialIsolation: true, syntheticCachedOAuthTokens: true, nativeLoopbackTls: true, targetObservation: 'auth-service-url-and-fetch-origin-or-native-authority', privateSdkHooks: false,
      privateSdkCleanup: true, controlDataRpcSeparated: true, realHttp2Reset: true },
    nativeTls: { calls: 16, temporaryCredentials: true, activeStreams: 0, faults: [], disposed: true },
    profiles: profiles.map(profile => ({ id: profile.id, datastore: profile.version, nativeDatastore: profile.version, nativeGrpc: '1.14.0',
      buildProfile: { name: profile.id, revision: profile.revision, sha256: hash, registrySha256: hash }, bundleSha256: hash })),
    results, caseCount: 100, rpcCount: 470, fetchCount: 376, controlRequests: 10, wire,
    envoy: { version: envoyPin.version, sha256: envoyPin.sha256, observationPoint: 'router-upstream-access-log', exit: { code: 0, signal: null } },
  };
}
function row(report, scenario = 'commit-success', runtime = 'workerd-cloudflare', profile = 'google-modern-v1') {
  return report.results.find(value => value.profile === profile && value.runtime === runtime && value.scenario === scenario);
}
function rejectMutations(mutations) {
  for (const [reason, mutate] of mutations) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateDatastoreTransactionReport(report), /WGA_EVIDENCE_INVALID/, reason);
  }
}

test('EVIDENCE Datastore transactions accepts complete synthetic validator input', () => {
  const report = fixture();
  assert.equal(report.results.length, 100);
  assert.equal(report.results.reduce((sum, value) => sum + value.rpcCount, 0), 470);
  assert.equal(report.results.reduce((sum, value) => sum + value.fetchCount, 0), 376);
  assert.equal(report.wire.length, 470);
  validateDatastoreTransactionReport(report);
});

test('EVIDENCE Datastore transactions accepts measured deadline response/reset races and completion order', () => {
  for (const profile of ['google-static-v1', 'google-modern-v1'])
  for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'])
  for (const [termination, resetCode, responseSent, receivedStatus, reversed] of [
    ['client-reset', 8, false, null, false],
    ['peer-deadline', 0, true, 4, false],
    ['peer-deadline', 0, true, 4, true],
    // Captured in a real native/Envoy run: the peer closes normally after
    // replying, while Envoy completes the cancelled request without a response.
    ['peer-deadline', 0, true, null, false],
    ['peer-deadline', 0, true, null, true],
    ['peer-deadline', 2, true, null, false],
    ['peer-deadline', 8, true, null, false],
    ['peer-deadline', 2, true, 4, false],
  ]) {
    const report = fixture(), result = row(report, 'v1-deadline-commit', runtime, profile);
    Object.assign(result.requests[1], { termination, http2ResetCode: resetCode, responseSent, cancelled: resetCode === 8 });
    const index = report.wire.findIndex(receipt => receipt.invocation === `${result.profile}/${result.runtime}/${result.scenario}` && receipt.method.endsWith('/Commit'));
    Object.assign(report.wire[index], { grpcStatus: receivedStatus, httpStatus: receivedStatus === null ? 0 : 200 });
    if (reversed) [report.wire[index], report.wire[index + 1]] = [report.wire[index + 1], report.wire[index]];
    validateDatastoreTransactionReport(report);
  }
});

test('EVIDENCE Datastore transactions rejects inconsistent peer and proxy deadline receipts', () => {
  for (const [httpStatus, grpcStatus, flags] of [
    [0, 4, '-'], [200, null, '-'], [200, 0, '-'], [200, 14, '-'],
    [503, null, '-'], [0, null, 'UR'], [200, 4, 'UR'],
  ]) {
    const report = fixture(), result = row(report, 'v1-deadline-commit');
    Object.assign(result.requests[1], { termination: 'peer-deadline', http2ResetCode: 0, responseSent: true, cancelled: false });
    const receipt = report.wire.find(value => value.invocation === `${result.profile}/${result.runtime}/${result.scenario}` && value.method.endsWith('/Commit'));
    Object.assign(receipt, { httpStatus, grpcStatus, flags });
    assert.throws(() => validateDatastoreTransactionReport(report), /peer deadline response or response\/reset race/,
      JSON.stringify({ httpStatus, grpcStatus, flags }));
  }
  for (const mutation of [
    { http2ResetCode: 7 }, { responseSent: false }, { cancelled: true },
  ]) {
    const report = fixture(), result = row(report, 'v1-deadline-commit');
    Object.assign(result.requests[1], { termination: 'peer-deadline', http2ResetCode: 0, responseSent: true, cancelled: false }, mutation);
    const receipt = report.wire.find(value => value.invocation === `${result.profile}/${result.runtime}/${result.scenario}` && value.method.endsWith('/Commit'));
    Object.assign(receipt, { httpStatus: 0, grpcStatus: null, flags: '-' });
    assert.throws(() => validateDatastoreTransactionReport(report), /deadline termination is measured/);
  }
});

test('EVIDENCE Datastore transactions rejects incomplete or duplicate matrix cells', () => {
  rejectMutations([
    ['failed run', r => { r.status = 'failed'; }],
    ['native development only', r => { r.nativeOnly = true; }],
    ['missing profile', r => { r.profiles.pop(); }],
    ['duplicate profile', r => { r.profiles[1] = structuredClone(r.profiles[0]); }],
    ['wrong SDK', r => { r.profiles[1].datastore = '11.2.0'; }],
    ['wrong native SDK', r => { r.profiles[1].nativeDatastore = '10.1.0'; }],
    ['wrong native gRPC', r => { r.profiles[0].nativeGrpc = '1.15.0'; }],
    ['missing runtime', r => { r.results = r.results.filter(value => value.runtime !== 'adapter-cloudflare'); }],
    ['missing case', r => { r.results.pop(); }],
    ['duplicate case', r => { r.results[99] = structuredClone(r.results[98]); }],
    ['unknown runtime', r => { row(r).runtime = 'workerd'; }],
    ['unknown profile', r => { row(r).profile = 'unverified'; }],
    ['failed case', r => { row(r).status = 'failed'; }],
    ['case total', r => { r.caseCount--; }],
    ['RPC total', r => { r.rpcCount++; }],
    ['Fetch total', r => { r.fetchCount++; }],
    ['control total', r => { r.controlRequests++; }],
    ['row RPC', r => { row(r).rpcCount++; }],
    ['row Fetch', r => { row(r).fetchCount++; }],
    ['native Fetch overclaim', r => { row(r, 'commit-success', 'native').fetchCount = 4; }],
  ]);
});

test('EVIDENCE Datastore transactions checks exact SDK transaction and tuple contracts', () => {
  rejectMutations([
    ['binary ID truncated', r => { row(r).result.transactionIds = ['00ff01']; }],
    ['transaction ID changed on read', r => { row(r).requests[1].transactionId = '00ff0280'; }],
    ['transaction ID absent on commit', r => { row(r).requests[2].transactionId = null; }],
    ['begin readOnly absent', r => { row(r, 'readonly-read').requests[0].readOnly = false; }],
    ['wrong read key', r => { row(r).requests[1].keys = ['b']; }],
    ['query transaction absent', r => { row(r, 'query-commit').requests[1].transactionId = null; }],
    ['query kind', r => { row(r, 'query-commit').requests[1].query.kind = 'Other'; }],
    ['query filter property', r => { row(r, 'query-commit').requests[1].query.filter.property = 'other'; }],
    ['query filter operator', r => { row(r, 'query-commit').requests[1].query.filter.op = 'LESS_THAN'; }],
    ['query filter value', r => { row(r, 'query-commit').requests[1].query.filter.integerValue = '2'; }],
    ['query limit', r => { row(r, 'query-commit').requests[1].query.limit = 3; }],
    ['read result wrong', r => { row(r).result.readCounts = [2]; }],
    ['queued write sent twice', r => { row(r).requests[2].mutationValues = [2, 2]; }],
    ['queued rollback sends commit', r => { row(r, 'rollback-queued').requests[2].method = 'Commit'; }],
    ['rollback mutation leaked', r => { row(r, 'rollback-queued').requests[2].mutationValues = [2]; }],
    ['rollback changed ID', r => { row(r, 'rollback-queued').requests[2].transactionId = '00ff0280'; }],
    ['readOnly commit contains mutation', r => { row(r, 'readonly-read').requests[2].mutationValues = [2]; }],
    ['commit response omitted', r => { row(r).result.commitResponses = []; }],
    ['commit mutationResults count wrong', r => { row(r).result.commitResponses[0].mutationCount = 2; }],
    ['commit version wrong', r => { row(r).result.commitResponses[0].versions = ['1']; }],
    ['commit indexUpdates wrong', r => { row(r).result.commitResponses[0].indexUpdates = 0; }],
    ['empty readonly response wrong', r => { row(r, 'readonly-read').result.commitResponses[0].mutationCount = 1; }],
    ['extra result material', r => { row(r).result.rawError = 'unexpected'; }],
  ]);
});

test('EVIDENCE Datastore transactions preserves uncertainty and actual reset/deadline semantics', () => {
  rejectMutations([
    ['readOnly write succeeds', r => { row(r, 'readonly-write-rejected').result.errorCode = null; }],
    ['ABORTED reclassified', r => { row(r, 'commit-aborted').result.errorCode = 14; }],
    ['ABORTED written', r => { row(r, 'commit-aborted').requests[2].appliedMutations = 1; }],
    ['ABORTED retry hidden', r => { row(r, 'commit-aborted').requests.splice(3, 0, structuredClone(row(r, 'commit-aborted').requests[0])); }],
    ['automatic rollback absent', r => { row(r, 'commit-aborted').requests.splice(3, 1); }],
    ['automatic rollback metadata invented', r => { row(r, 'commit-aborted').requests[3].identity = 'a'; }],
    ['reset simulated by status', r => { row(r, 'disconnect-before-apply').requests[2].disconnect = false; }],
    ['reset response sent', r => { row(r, 'disconnect-before-apply').requests[2].responseSent = true; }],
    ['reset code not observed', r => { row(r, 'disconnect-after-apply').requests[2].http2ResetCode = null; }],
    ['wrong reset code', r => { row(r, 'disconnect-after-apply').requests[2].http2ResetCode = 8; }],
    ['before-apply write occurred', r => { row(r, 'disconnect-before-apply').requests[2].appliedMutations = 1; }],
    ['after-apply write lost', r => { row(r, 'disconnect-after-apply').requests[2].appliedMutations = 0; }],
    ['failed call resolves', r => { row(r, 'disconnect-before-apply').result.resolved = 1; }],
    ['failure rejects twice', r => { row(r, 'disconnect-after-apply').result.rejected = 2; }],
    ['rollback undone accepted write', r => { row(r, 'disconnect-after-apply').result.persistedCounts = [1]; }],
    ['generated-v1 deadline mislabeled', r => { row(r, 'v1-deadline-commit').result.surface = 'high-level'; }],
    ['client reset not observed at peer', r => { row(r, 'v1-deadline-commit').requests[1].http2ResetCode = 0; }],
    ['deadline wrong reset code', r => { row(r, 'v1-deadline-commit').requests[1].http2ResetCode = 7; }],
    ['client-reset sent status response', r => { row(r, 'v1-deadline-commit').requests[1].responseSent = true; }],
    ['deadline lost original status', r => { row(r, 'v1-deadline-commit').result.errorCode = 14; }],
    ['deadline undoes accepted mutation', r => { row(r, 'v1-deadline-commit').result.persistedCounts = [1]; }],
    ['deadline response invented', r => { row(r, 'v1-deadline-commit').result.commitResponses = [{ mutationCount: 1, versions: ['2'], indexUpdates: 1 }]; }],
    ['deadline receipt barrier absent', r => { row(r, 'v1-deadline-commit').controlRequests = 0; }],
    ['pending deadline hidden', r => { row(r, 'v1-deadline-commit').requests[1].termination = 'pending-deadline'; }],
    ['peer deadline did not reply', r => { row(r, 'v1-deadline-commit').requests[1].termination = 'peer-deadline'; }],
    ['deadline advertised cancel handle', r => { row(r, 'v1-deadline-commit').result.cancelHandleAvailable = true; }],
    ['high-level advertised cancel handle', r => { row(r).result.cancelHandleAvailable = true; }],
    ['rollback fabricated commit Promise', r => { row(r, 'rollback-queued').result.cancelHandleAvailable = false; }],
    ['normal peer termination hidden', r => { delete row(r).requests[0].termination; }],
    ['reset server action misclassified', r => { row(r, 'disconnect-after-apply').requests[2].termination = 'client-reset'; }],
  ]);
});

test('EVIDENCE Datastore transactions distinguishes crossed transaction IDs from credentials', () => {
  rejectMutations([
    ['transaction IDs reused', r => { row(r, 'crossed-transactions').result.transactionIds[1] = '00ff0180'; }],
    ['crossed begin ID reused', r => { row(r, 'crossed-transactions').requests[1].transactionId = '00ff0180'; }],
    ['crossed reads reorder', r => { row(r, 'crossed-transactions').requests.splice(2, 2, ...row(r, 'crossed-transactions').requests.slice(2, 4).reverse()); }],
    ['crossed key misrouted', r => { row(r, 'crossed-transactions').requests[2].keys = ['a']; }],
    ['crossed identity mixed', r => { row(r, 'crossed-transactions').requests[4].identity = 'a'; }],
    ['crossed writes confused', r => { row(r, 'crossed-transactions').requests[4].mutationValues = [2]; }],
    ['crossed commit wrong ID', r => { row(r, 'crossed-transactions').requests[4].transactionId = '00ff0180'; }],
    ['crossed recovery values', r => { row(r, 'crossed-transactions').result.persistedCounts = [3, 2]; }],
    ['metadata hidden', r => { r.testInstrumentation.syntheticIdentityHeaders = false; }],
    ['credential instrumentation missing', r => { r.testInstrumentation.oauthCredentialIsolation = false; }],
    ['fixture credential boundary hidden', r => { r.testInstrumentation.syntheticCachedOAuthTokens = false; }],
    ['target observation hidden', r => { delete r.testInstrumentation.targetObservation; }],
    ['native TLS boundary hidden', r => { r.testInstrumentation.nativeLoopbackTls = false; }],
    ['credential wrong owner', r => { row(r, 'crossed-transactions').requests[2].credentialIdentity = 'a'; }],
    ['quota wrong owner', r => { row(r, 'crossed-transactions').requests[4].quotaIdentity = 'a'; }],
    ['target wrong owner', r => { row(r, 'crossed-transactions').requests[5].targetIdentity = 'b'; }],
    ['recovery credential crossed', r => { row(r, 'crossed-transactions').requests[7].credentialIdentity = 'a'; }],
    ['single SDK client', r => { row(r, 'crossed-transactions').result.credentialIsolation.sdkClients = 1; }],
    ['single credential provider', r => { row(r, 'crossed-transactions').result.credentialIsolation.authProviders = 1; }],
    ['providers identical', r => { row(r, 'crossed-transactions').result.credentialIsolation.distinctProviders = false; }],
    ['targets identical', r => { row(r, 'crossed-transactions').result.credentialIsolation.distinctTargets = false; }],
    ['auth not executed', r => { row(r, 'crossed-transactions').result.credentialIsolation.providers[0].metadataCalls = 0; }],
    ['auth saw gateway', r => { row(r, 'crossed-transactions').result.credentialIsolation.providers[1].targets = ['gateway']; }],
    ['wrong auth order', r => { row(r, 'crossed-transactions').result.credentialIsolation.authEvents.reverse(); }],
    ['external auth request', r => { row(r, 'crossed-transactions').result.credentialIsolation.externalAuthRequests = 1; }],
    ['TLS unused', r => { r.nativeTls.calls = 0; }],
    ['TLS left open', r => { r.nativeTls.disposed = false; }],
    ['TLS stream retained', r => { r.nativeTls.activeStreams = 1; }],
    ['TLS forwarding error', r => { r.nativeTls.faults.push('TX_TLS_FORWARD_ERROR'); }],
    ['request hook hidden', r => { r.testInstrumentation.privateSdkHooks = true; }],
    ['private cleanup hidden', r => { r.testInstrumentation.privateSdkCleanup = false; }],
    ['reset instrumentation hidden', r => { r.testInstrumentation.realHttp2Reset = false; }],
    ['controls conflated', r => { r.testInstrumentation.controlDataRpcSeparated = false; }],
  ]);
});

test('EVIDENCE Datastore transactions requires one attempt and resource recovery before close', () => {
  rejectMutations([
    ['native oracle changed', r => { row(r, 'commit-success', 'native').result.persistedCounts = [3]; }],
    ['same client recovery absent', r => { row(r).result.sameClientRecovery = false; }],
    ['late callback', r => { row(r).result.noLateEvents = false; }],
    ['deadline absent', r => { row(r).requests[0].deadlineBounded = false; }],
    ['adapter retry enabled', r => { r.adapterRetryEnabled = true; }],
    ['second attempt', r => { row(r).observer.calls[0].attemptCount = 2; }],
    ['second Fetch', r => { row(r).observer.calls[0].fetchCount = 2; }],
    ['second terminal', r => { row(r).observer.calls[0].terminalCount = 2; }],
    ['start omitted', r => { row(r).observer.calls[0].startCount = 0; }],
    ['call ID reused', r => { row(r).observer.calls[1].logicalCallId = row(r).observer.calls[0].logicalCallId; }],
    ['call omitted', r => { row(r).observer.calls.pop(); }],
    ['observer status wrong', r => { row(r, 'commit-aborted').observer.calls[2].statusCode = 0; }],
    ['failed response invented', r => { row(r, 'commit-aborted').observer.calls[2].responseMessages = 1; }],
    ['success response omitted', r => { row(r).observer.calls[0].responseMessages = 0; }],
    ['native observer fabricated', r => { row(r, 'commit-success', 'native').observer = row(r).observer; }],
    ['active call remains', r => { row(r).observer.resources.activeCalls = 1; }],
    ['queued call remains', r => { row(r).observer.resources.queuedCalls = 1; }],
    ['buffer remains', r => { row(r).observer.resources.bufferedBytes = 1; }],
    ['resource check after close', r => { r.resourcesCheckedBeforeClose = false; }],
    ['peer remains active', r => { row(r).backendIdleBeforeNextCase = false; }],
    ['runtime retained', r => { r.runtimeDisposed = false; }],
    ['peer fault', r => { r.peerFaults.push('TX_PEER_FAILURE'); }],
    ['boundary fault', r => { r.boundaryErrors.push('TX_BOUNDARY_FAILURE'); }],
    ['unhandled rejection', r => { r.asyncErrors.push('TX_UNHANDLED_REJECTION'); }],
    ['cleanup failed', r => { r.cleanupFailures.push('TX_CLEANUP_FAILURE'); }],
  ]);
});

test('EVIDENCE Datastore transactions requires precise Envoy wire receipts', () => {
  const wire = (r, scenario, method) => r.wire.find(value => value.invocation === `google-modern-v1/workerd-cloudflare/${scenario}` && value.method.endsWith(`/${method}`));
  rejectMutations([
    ['no real proxy', r => { r.realEnvoy = false; }],
    ['different binary', r => { r.envoy.sha256 = 'b'.repeat(64); }],
    ['different version', r => { r.envoy.version = 'unverified'; }],
    ['wrong observation point', r => { r.envoy.observationPoint = 'downstream'; }],
    ['proxy never stopped', r => { delete r.envoy.exit; }],
    ['proxy killed', r => { r.envoy.exit = { code: null, signal: 'SIGKILL' }; }],
    ['receipt omitted', r => { r.wire.pop(); }],
    ['wrong HTTP', r => { r.wire[0].httpStatus = 503; }],
    ['wrong upstream', r => { r.wire[0].upstream = 'firestore'; }],
    ['wrong listener', r => { r.wire[0].runtime = 'workerd'; }],
    ['wrong invocation', r => { r.wire[0].invocation = 'unknown'; }],
    ['wrong method', r => { r.wire[0].method = '/google.datastore.v1.Datastore/Lookup'; }],
    ['control mixed into RPCs', r => { r.wire[0].method = '/await-commit'; }],
    ['wrong status', r => { wire(r, 'commit-aborted', 'Commit').grpcStatus = 14; }],
    ['status-only substitute for reset', r => { Object.assign(wire(r, 'disconnect-before-apply', 'Commit'), { grpcStatus: 14, httpStatus: 200, flags: '-' }); }],
    ['reset flag omitted', r => { wire(r, 'disconnect-after-apply', 'Commit').flags = '-'; }],
    ['reset status invented', r => { wire(r, 'disconnect-after-apply', 'Commit').grpcStatus = 14; }],
    ['missing reset flag', r => { wire(r, 'disconnect-before-apply', 'Commit').flags = 'LR'; }],
    ['reset flag for downstream deadline', r => { wire(r, 'v1-deadline-commit', 'Commit').flags = 'UR'; }],
    ['normal flag wrong', r => { r.wire[0].flags = 'UR'; }],
    ['request order swapped', r => { [r.wire[0], r.wire[1]] = [r.wire[1], r.wire[0]]; }],
    ['native automatic rollback has invented headers', r => { r.wire.find(value => value.invocation === null).invocation = 'google-static-v1/native/readonly-write-rejected'; }],
    ['native rollback anchor moved', r => { const i = r.wire.findIndex(value => value.invocation === null); [r.wire[i], r.wire[i + 1]] = [r.wire[i + 1], r.wire[i]]; }],
    ['case ordering hides rollback association', r => { [r.results[0], r.results[1]] = [r.results[1], r.results[0]]; }],
  ]);
});

test('EVIDENCE Datastore transactions requires complete installed source provenance and scope', () => {
  rejectMutations([
    ['source build', r => { r.sourceBuild = true; }],
    ['live Google overclaim', r => { r.liveGoogle = true; }],
    ['edge conversion overclaim', r => { r.cloudflareAutomaticConversion = true; }],
    ['official emulator overclaim', r => { r.officialEmulator = true; }],
    ['REST fallback', r => { r.restFallback = true; }],
    ['peer uncontrolled', r => { r.controlledNativeGrpcServer = false; }],
    ['native parity omitted', r => { r.nativeBusinessEquivalent = false; }],
    ['source omitted', r => { delete r.evidence['scripts/datastore-transaction-server.cjs']; }],
    ['source hash invalid', r => { r.evidence['scripts/datastore-transaction-evidence.cjs'] = 'unknown'; }],
    ['shared runtime omitted', r => { delete r.sources['google-static-v1/native']; }],
    ['workerd source differs', r => { r.sources['google-modern-v1/workerd-cloudflare'] = 'b'.repeat(64); }],
    ['shared source unlinked', r => { r.sharedSha256 = 'b'.repeat(64); }],
    ['extra runtime source', r => { r.sources['google-modern-v1/unknown'] = 'a'.repeat(64); }],
    ['installed gRPC omitted', r => { delete r.installedInputs['fixtures/google/node_modules/@grpc/grpc-js/dist/index.js']; }],
    ['native gRPC omitted', r => { delete r.nativeInputs['fixtures/modern-native/node_modules/@grpc/grpc-js/build/src/index.js']; }],
    ['transaction source omitted', r => { delete r.installedInputs['fixtures/google/node_modules/@google-cloud/datastore/build/src/transaction.js']; }],
    ['request source omitted', r => { delete r.nativeInputs['fixtures/modern-native/node_modules/@google-cloud/datastore/build/src/request.js']; }],
    ['generated v1 source omitted', r => { delete r.nativeInputs['fixtures/native/node_modules/@google-cloud/datastore/build/src/v1/datastore_client.js']; }],
    ['OAuth implementation omitted', r => { delete r.nativeInputs['fixtures/native/node_modules/google-auth-library/build/src/auth/oauth2client.js']; }],
    ['schema omitted', r => { delete r.installedInputs['fixtures/modern/node_modules/@google-cloud/datastore-api/build/protos/protos.json']; }],
    ['malformed installed hash', r => { r.installedInputs['fixtures/google/node_modules/@google-cloud/datastore/package.json'] = 'unknown'; }],
    ['wrong fixture provenance', r => { r.installedInputs['fixtures/native/node_modules/@grpc/grpc-js/package.json'] = 'a'.repeat(64); }],
    ['path traversal', r => { r.nativeInputs['fixtures/native/node_modules/../package.json'] = 'a'.repeat(64); }],
    ['build profile wrong', r => { r.profiles[1].buildProfile.name = 'google-static-v1'; }],
    ['revision wrong', r => { r.profiles[0].buildProfile.revision++; }],
    ['bundle hash missing', r => { delete r.profiles[0].bundleSha256; }],
    ['profile hash missing', r => { delete r.profiles[1].buildProfile.sha256; }],
    ['registry hash missing', r => { delete r.profiles[0].buildProfile.registrySha256; }],
    ['Node identity missing', r => { delete r.node; }],
    ['workerd identity missing', r => { delete r.workerd; }],
    ['Miniflare identity missing', r => { delete r.miniflare; }],
    ['compatibility date differs', r => { r.compatibilityDate = '2026-09-22'; }],
  ]);
});
