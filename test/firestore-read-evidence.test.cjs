'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFirestoreReadReport } = require('../scripts/firestore-read-evidence.cjs');
const envoyPin = require('../fixtures/envoy/binary.json');

// Synthetic validator input only. Actual native/Node/workerd execution is
// produced separately by test-firestore-read-errors.cjs and validated there.
function fixture() {
  const hash = 'a'.repeat(64), results = [], wire = [], sources = {}, evidence = {}, installedInputs = {}, nativeInputs = {};
  const profiles = [
    { id: 'google-static-v1', version: '8.3.0', fixture: 'google', native: 'native', revision: 4 },
    { id: 'google-modern-v1', version: '9.2.0', fixture: 'modern', native: 'modern-native', revision: 2 },
  ];
  for (const file of ['scripts/test-firestore-read-errors.cjs', 'scripts/firestore-read-error-server.cjs', 'scripts/firestore-read-evidence.cjs',
    'fixtures/google/shared/firestore-read-errors.mjs', 'fixtures/worker/firestore-read-errors.mjs',
    'scripts/emulator-envoy.cjs', 'fixtures/envoy/binary.json',
    ...['google', 'native', 'modern', 'modern-native', 'worker'].map(name => `fixtures/${name}/package-lock.json`),
    ...profiles.map(profile => `src/build/profiles/${profile.id}.json`)]) evidence[file] = hash;
  let sequence = 0;
  for (const profile of profiles) {
    for (const [map, fixture, grpcEntry] of [[installedInputs, profile.fixture, 'dist/index.js'], [nativeInputs, profile.native, 'build/src/index.js']]) {
      for (const file of ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/firestore/package.json',
        '@google-cloud/firestore/build/src/index.js', '@google-cloud/firestore/build/src/document-reader.js',
        '@google-cloud/firestore/build/src/reference/query-util.js', 'google-gax/package.json', 'google-auth-library/package.json',
        ...(profile.fixture === 'modern' ? ['@google-cloud/firestore-api/package.json', '@google-cloud/firestore-api/build/protos/protos.json']
          : ['@google-cloud/firestore/build/protos/v1.json'])]) {
        map[`fixtures/${fixture}/node_modules/${file}`] = hash;
      }
    }
    for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare']) {
      sources[`${profile.id}/${runtime}`] = hash;
      const cases = ['batch', 'query-get', 'query-stream'].flatMap(shape =>
        ['permanent-partial', 'transient-before', 'transient-partial'].map(fault => [shape, fault]));
      cases.push(['query-stream', 'destroy']);
      for (const [shape, fault] of cases) {
        const scenario = `${shape}-${fault}`, batch = shape === 'batch', stream = shape === 'query-stream';
        const partial = fault.endsWith('partial'), permanent = fault.startsWith('permanent');
        const destroyed = fault === 'destroy';
        const method = batch ? 'BatchGetDocuments' : 'RunQuery';
        const initial = batch ? { documents: ['b', 'a', 'c'] } : { limit: 3, cursor: null, readTime: null };
        const resumed = !partial ? initial : batch ? { documents: ['c'] }
          : { limit: 2, cursor: { before: false, values: [1, 'a'] }, readTime: { seconds: '1700000000', nanos: 123000000 } };
        const requests = [{ method, attempt: 1, request: initial, sentDocuments: destroyed ? ['a'] : partial ? batch ? ['b', 'a'] : ['a'] : [],
          statusCode: destroyed ? 0 : permanent ? 7 : 14, deadlineBounded: true, progressAcknowledged: partial, releaseAfterDestroy: destroyed }];
        if (!permanent && !destroyed) requests.push({ method, attempt: 2, request: resumed,
          sentDocuments: batch ? partial ? ['c'] : ['c', 'a', 'b'] : partial ? ['b', 'c'] : ['a', 'b', 'c'],
          statusCode: 0, deadlineBounded: true, progressAcknowledged: false, releaseAfterDestroy: false });
        requests.push({ method: 'BatchGetDocuments', attempt: 1, request: { documents: ['marker'] }, sentDocuments: ['marker'],
          statusCode: 0, deadlineBounded: true, progressAcknowledged: false, releaseAfterDestroy: false });
        const rows = destroyed ? [{ id: 'a', exists: true, value: 1 }] : permanent ? stream ? [{ id: 'a', exists: true, value: 1 }] : [] : batch
          ? [{ id: 'b', exists: true, value: 2 }, { id: 'a', exists: false, value: null }, { id: 'c', exists: true, value: 3 }]
          : ['a', 'b', 'c'].map((id, index) => ({ id, exists: true, value: index + 1 }));
        const events = destroyed ? ['data:a', 'close'] : stream ? permanent ? ['data:a', 'error:7', 'close'] : ['data:a', 'data:b', 'data:c', 'end', 'close']
          : [permanent ? 'reject:7' : 'resolve'];
        const result = { scenario, rows, events, resolved: !stream && !permanent ? 1 : 0, rejected: !stream && permanent ? 1 : 0,
          errorCode: permanent ? 7 : null, streamErrorCount: stream && permanent ? 1 : 0,
          streamEndCount: stream && !permanent && !destroyed ? 1 : 0, streamCloseCount: stream ? 1 : 0, sameClientRecovery: true, noLateEvents: true,
          progressSnapshots: partial ? batch ? 2 : 1 : 0, progressAcknowledgements: partial ? 1 : 0 };
        if (destroyed) result.destroyRetainedUntilRelease = true;
        const observer = runtime === 'native' ? null : {
          calls: requests.map(call => ({ logicalCallId: `wga-${++sequence}`, startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1,
            statusCode: call.statusCode, responseMessages: call.sentDocuments.length })),
          resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 },
        };
        results.push({ profile: profile.id, runtime, scenario, status: 'passed', rpcCount: requests.length,
          fetchCount: runtime === 'native' ? 0 : requests.length, controlRequests: partial || destroyed ? 1 : 0,
          requests, result, observer, backendIdleBeforeNextCase: true });
        for (const call of destroyed ? [...requests].reverse() : requests) wire.push({ runtime: runtime === 'native' ? 'native' : runtime.startsWith('adapter-') ? 'replacement' : 'workerd',
          invocation: `${profile.id}/${runtime}/${scenario}`,
          method: `/google.firestore.v1.Firestore/${call.method}`, grpcStatus: call.statusCode, httpStatus: 200, upstream: 'firestore', flags: '-' });
      }
    }
  }
  return { status: 'passed', sourceBuild: false, nativeOnly: false, liveGoogle: false, cloudflareAutomaticConversion: false,
    officialEmulator: false, realEnvoy: true, controlledNativeGrpcServer: true, restFallback: false, adapterRetryEnabled: false,
    resourcesCheckedBeforeTerminate: true, nativeBusinessEquivalent: true, runtimeDisposed: true,
    sharedSha256: hash, sources, evidence, installedInputs, nativeInputs, node: 'v24.1.0', workerd: '1.20260923.0', miniflare: '4.0.0',
    compatibilityDate: '2026-09-21', peerFaults: [], boundaryErrors: [], asyncErrors: [], cleanupFailures: [],
    testInstrumentation: { method: 'Firestore.snapshot_', versions: ['8.3.0', '9.2.0'], originalInvoked: true, controlDataRpcSeparated: true },
    profiles: profiles.map(profile => ({ id: profile.id, firestore: profile.version, nativeFirestore: profile.version, nativeGrpc: '1.14.0',
      buildProfile: { name: profile.id, revision: profile.revision, sha256: hash, registrySha256: hash }, bundleSha256: hash })),
    results, caseCount: 100, rpcCount: 260, fetchCount: 208, controlRequests: 70, wire,
    envoy: { version: envoyPin.version, sha256: envoyPin.sha256, observationPoint: 'router-upstream-access-log',
      firestoreSyntheticOwnerInjected: true, exit: { code: 0, signal: null } },
  };
}
function row(report, scenario = 'query-stream-transient-partial', runtime = 'workerd-cloudflare', profile = 'google-modern-v1') {
  return report.results.find(value => value.profile === profile && value.runtime === runtime && value.scenario === scenario);
}
function rejectMutations(mutations) {
  for (const [reason, mutate] of mutations) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateFirestoreReadReport(report), /WGA_EVIDENCE_INVALID/, reason);
  }
}

test('EVIDENCE Firestore read errors accepts only complete synthetic validator input', () => {
  const report = fixture();
  assert.equal(report.results.length, 100);
  assert.equal(report.results.reduce((sum, value) => sum + value.rpcCount, 0), 260);
  assert.equal(report.wire.length, 260);
  validateFirestoreReadReport(report);
});

test('EVIDENCE Firestore read errors rejects missing profiles, runtimes and scenarios', () => {
  rejectMutations([
    ['failed run', r => { r.status = 'failed'; }],
    ['native development only', r => { r.nativeOnly = true; }],
    ['missing profile', r => { r.profiles.pop(); }],
    ['duplicate profile', r => { r.profiles[1] = structuredClone(r.profiles[0]); }],
    ['wrong SDK version', r => { r.profiles[1].firestore = '9.3.0'; }],
    ['native SDK differs', r => { r.profiles[1].nativeFirestore = '8.3.0'; }],
    ['missing runtime', r => { r.results = r.results.filter(value => value.runtime !== 'adapter-cloudflare'); }],
    ['missing scenario', r => { r.results.pop(); }],
    ['duplicate row', r => { r.results[99] = structuredClone(r.results[98]); }],
    ['unknown runtime', r => { row(r).runtime = 'workerd'; }],
    ['unknown profile', r => { row(r).profile = 'google-unverified-v1'; }],
    ['failed scenario', r => { row(r).status = 'failed'; }],
    ['aggregate cases', r => { r.caseCount--; }],
    ['aggregate RPC', r => { r.rpcCount++; }],
    ['aggregate fetch', r => { r.fetchCount++; }],
    ['row RPC', r => { row(r).rpcCount++; }],
    ['row fetch', r => { row(r).fetchCount++; }],
    ['native fetch overclaim', r => { row(r, 'batch-transient-before', 'native').fetchCount = 1; }],
  ]);
});

test('EVIDENCE Firestore read errors checks native error, partial result and exact event order', () => {
  rejectMutations([
    ['wrong application error', r => { row(r, 'query-get-permanent-partial').result.errorCode = 14; }],
    ['resolved failed promise', r => { row(r, 'batch-permanent-partial').result.resolved = 1; }],
    ['double promise rejection', r => { row(r, 'query-get-permanent-partial').result.rejected = 2; }],
    ['partial promise result leaked', r => { row(r, 'batch-permanent-partial').result.rows = [{ id: 'b', exists: true, value: 2 }]; }],
    ['partial stream result discarded', r => { row(r, 'query-stream-permanent-partial').result.rows = []; }],
    ['transient partial duplicated', r => { row(r).result.rows.unshift({ id: 'a', exists: true, value: 1 }); }],
    ['batch result wire order exposed', r => { row(r, 'batch-transient-before').result.rows.reverse(); }],
    ['missing document treated as existing', r => { row(r, 'batch-transient-partial').result.rows[1].exists = true; }],
    ['error before data', r => { row(r, 'query-stream-permanent-partial').result.events = ['error:7', 'data:a', 'close']; }],
    ['unexpected end after error', r => { row(r, 'query-stream-permanent-partial').result.events.push('end'); }],
    ['destroy incorrectly ends', r => { row(r, 'query-stream-destroy').result.events = ['data:a', 'end', 'close']; }],
    ['destroy incorrectly cancelled RPC', r => { row(r, 'query-stream-destroy').result.destroyRetainedUntilRelease = false; }],
    ['end before data', r => { row(r).result.events.unshift('end'); }],
    ['duplicate close', r => { row(r).result.streamCloseCount = 2; }],
    ['duplicate error', r => { row(r, 'query-stream-permanent-partial').result.streamErrorCount = 2; }],
    ['missing successful EOF', r => { row(r).result.streamEndCount = 0; }],
    ['recovery absent', r => { row(r).result.sameClientRecovery = false; }],
    ['late callback', r => { row(r).result.noLateEvents = false; }],
    ['native baseline altered', r => { row(r, 'query-stream-transient-partial', 'native').result.rows.pop(); }],
    ['extra raw error', r => { row(r).result.error = { message: 'unexpected' }; }],
  ]);
});

test('EVIDENCE Firestore read errors distinguishes SDK resume RPCs from adapter attempts', () => {
  rejectMutations([
    ['batch refetches completed documents', r => { row(r, 'batch-transient-partial').requests[1].request.documents = ['b', 'a', 'c']; }],
    ['batch omits unresolved document', r => { row(r, 'batch-transient-before').requests[1].request.documents = ['c']; }],
    ['query limit not reduced', r => { row(r).requests[1].request.limit = 3; }],
    ['query cursor absent', r => { row(r).requests[1].request.cursor = null; }],
    ['cursor includes last document', r => { row(r).requests[1].request.cursor.before = true; }],
    ['cursor value differs', r => { row(r).requests[1].request.cursor.values = [2, 'b']; }],
    ['read time absent', r => { row(r).requests[1].request.readTime = null; }],
    ['read time changed', r => { row(r).requests[1].request.readTime.nanos = 0; }],
    ['before-data retry cursor invented', r => { row(r, 'query-get-transient-before').requests[1].request.cursor = { before: false, values: [1, 'a'] }; }],
    ['missing marker barrier', r => { row(r).requests.pop(); }],
    ['wrong peer status', r => { row(r).requests[0].statusCode = 7; }],
    ['destroy release not observed', r => { row(r, 'query-stream-destroy').requests[0].releaseAfterDestroy = false; }],
    ['destroy mistaken for cancellation', r => { row(r, 'query-stream-destroy').observer.calls[0].statusCode = 1; }],
    ['unbounded RPC deadline', r => { row(r).requests[0].deadlineBounded = false; }],
    ['retry ordinal wrong', r => { row(r).requests[1].attempt = 1; }],
    ['adapter retry enabled', r => { r.adapterRetryEnabled = true; }],
    ['two adapter attempts', r => { row(r).observer.calls[0].attemptCount = 2; }],
    ['hidden adapter Fetch', r => { row(r).observer.calls[0].fetchCount = 2; }],
    ['SDK retries reuse logical call', r => { row(r).observer.calls[1].logicalCallId = row(r).observer.calls[0].logicalCallId; }],
    ['missing observed call', r => { row(r).observer.calls.pop(); }],
    ['wrong observer status', r => { row(r).observer.calls[0].statusCode = 0; }],
    ['partial message unobserved', r => { row(r).observer.calls[0].responseMessages = 0; }],
    ['double logical terminal', r => { row(r).observer.calls[0].terminalCount = 2; }],
    ['missing logical start', r => { row(r).observer.calls[0].startCount = 0; }],
    ['fabricated native observer', r => { row(r, 'query-stream-transient-partial', 'native').observer = row(r).observer; }],
  ]);
});

test('EVIDENCE Firestore read errors requires deterministic progress gates and cleanup before termination', () => {
  rejectMutations([
    ['snapshot instrumentation hidden', r => { delete r.testInstrumentation; }],
    ['original snapshot conversion skipped', r => { r.testInstrumentation.originalInvoked = false; }],
    ['instrumentation version unpinned', r => { r.testInstrumentation.versions.pop(); }],
    ['control conflated with RPC', r => { r.testInstrumentation.controlDataRpcSeparated = false; }],
    ['missing progress acknowledgement', r => { row(r).requests[0].progressAcknowledged = false; }],
    ['wrong observed progress', r => { row(r, 'batch-transient-partial').result.progressSnapshots = 1; }],
    ['before-data progress invented', r => { row(r, 'batch-transient-before').result.progressSnapshots = 1; }],
    ['duplicate acknowledgement', r => { row(r).result.progressAcknowledgements = 2; }],
    ['row controls omitted', r => { row(r).controlRequests = 0; }],
    ['aggregate controls wrong', r => { r.controlRequests++; }],
    ['idle check after terminate', r => { r.resourcesCheckedBeforeTerminate = false; }],
    ['backend still active', r => { row(r).backendIdleBeforeNextCase = false; }],
    ['active RPC remains', r => { row(r).observer.resources.activeCalls = 1; }],
    ['queued RPC remains', r => { row(r).observer.resources.queuedCalls = 1; }],
    ['buffer retained', r => { row(r).observer.resources.bufferedBytes = 1; }],
    ['runtime alive', r => { r.runtimeDisposed = false; }],
    ['peer error', r => { r.peerFaults.push('READ_PEER_FAILURE'); }],
    ['boundary error', r => { r.boundaryErrors.push('READ_BOUNDARY_FAILURE'); }],
    ['unhandled rejection', r => { r.asyncErrors.push('READ_UNHANDLED_REJECTION'); }],
    ['cleanup failure', r => { r.cleanupFailures.push('READ_CLEANUP_FAILURE'); }],
  ]);
});

test('EVIDENCE Firestore read errors requires genuine Envoy receipts for each adapter RPC', () => {
  rejectMutations([
    ['no real proxy', r => { r.realEnvoy = false; }],
    ['different binary', r => { r.envoy.sha256 = 'b'.repeat(64); }],
    ['different version', r => { r.envoy.version = 'unverified'; }],
    ['wrong observation point', r => { r.envoy.observationPoint = 'downstream'; }],
    ['synthetic owner hidden', r => { r.envoy.firestoreSyntheticOwnerInjected = false; }],
    ['proxy never stopped', r => { delete r.envoy.exit; }],
    ['proxy forced down', r => { r.envoy.exit = { code: null, signal: 'SIGKILL' }; }],
    ['missing wire receipt', r => { r.wire.pop(); }],
    ['HTTP failure', r => { r.wire[0].httpStatus = 503; }],
    ['wrong upstream', r => { r.wire[0].upstream = 'datastore'; }],
    ['unexpected response flag', r => { r.wire[0].flags = 'UC'; }],
    ['wrong gRPC status', r => { r.wire[0].grpcStatus = 4; }],
    ['control request mixed into data receipts', r => { r.wire[0].method = '/__read_progress'; }],
    ['wrong listener', r => { r.wire[0].runtime = 'workerd'; }],
    ['wrong RPC status totals', r => { r.wire[0].grpcStatus = 0; }],
    ['wrong method totals', r => { r.wire[0].method = '/google.firestore.v1.Firestore/RunQuery'; }],
    ['wrong invocation', r => { r.wire[0].invocation = 'unknown'; }],
    ['same totals but wrong case order', r => { const rows = r.wire.filter(value => value.invocation?.endsWith('/query-stream-transient-partial')); const code = rows[0].grpcStatus; rows[0].grpcStatus = rows[1].grpcStatus; rows[1].grpcStatus = code; }],
    ['destroy completed before marker', r => { const rows = r.wire.filter(value => value.invocation.endsWith('/query-stream-destroy')); const method = rows[0].method; rows[0].method = rows[1].method; rows[1].method = method; }],
  ]);
});

test('EVIDENCE Firestore read errors requires exact installed and shared-source provenance', () => {
  rejectMutations([
    ['source build', r => { r.sourceBuild = true; }],
    ['live Google overclaim', r => { r.liveGoogle = true; }],
    ['edge conversion overclaim', r => { r.cloudflareAutomaticConversion = true; }],
    ['official emulator overclaim', r => { r.officialEmulator = true; }],
    ['REST fallback', r => { r.restFallback = true; }],
    ['uncontrolled native peer', r => { r.controlledNativeGrpcServer = false; }],
    ['native parity absent', r => { r.nativeBusinessEquivalent = false; }],
    ['source missing', r => { delete r.evidence['scripts/firestore-read-error-server.cjs']; }],
    ['invalid source digest', r => { r.evidence['scripts/firestore-read-evidence.cjs'] = 'unknown'; }],
    ['missing shared runtime', r => { delete r.sources['google-static-v1/native']; }],
    ['different workerd source', r => { r.sources['google-modern-v1/workerd-cloudflare'] = 'b'.repeat(64); }],
    ['shared digest unlinked', r => { r.sharedSha256 = 'b'.repeat(64); }],
    ['extra unverified source', r => { r.sources['google-modern-v1/unknown'] = 'a'.repeat(64); }],
    ['missing installed package', r => { delete r.installedInputs['fixtures/google/node_modules/@grpc/grpc-js/dist/index.js']; }],
    ['missing native package', r => { delete r.nativeInputs['fixtures/modern-native/node_modules/@grpc/grpc-js/build/src/index.js']; }],
    ['missing modern API', r => { delete r.installedInputs['fixtures/modern/node_modules/@google-cloud/firestore-api/package.json']; }],
    ['missing DocumentReader implementation', r => { delete r.installedInputs['fixtures/google/node_modules/@google-cloud/firestore/build/src/document-reader.js']; }],
    ['missing QueryUtil implementation', r => { delete r.nativeInputs['fixtures/modern-native/node_modules/@google-cloud/firestore/build/src/reference/query-util.js']; }],
    ['missing modern schema', r => { delete r.installedInputs['fixtures/modern/node_modules/@google-cloud/firestore-api/build/protos/protos.json']; }],
    ['missing native legacy schema', r => { delete r.nativeInputs['fixtures/native/node_modules/@google-cloud/firestore/build/protos/v1.json']; }],
    ['malformed installed hash', r => { r.installedInputs['fixtures/google/node_modules/@google-cloud/firestore/package.json'] = 'unknown'; }],
    ['provenance wrong fixture', r => { r.installedInputs['fixtures/native/node_modules/@grpc/grpc-js/package.json'] = 'a'.repeat(64); }],
    ['provenance path traversal', r => { r.nativeInputs['fixtures/native/node_modules/../package.json'] = 'a'.repeat(64); }],
    ['wrong build profile', r => { r.profiles[1].buildProfile.name = 'google-static-v1'; }],
    ['wrong profile revision', r => { r.profiles[0].buildProfile.revision++; }],
    ['missing bundle digest', r => { delete r.profiles[0].bundleSha256; }],
    ['missing registry digest', r => { delete r.profiles[1].buildProfile.registrySha256; }],
    ['missing runtime identity', r => { delete r.workerd; }],
    ['changed compatibility date', r => { r.compatibilityDate = '2026-09-20'; }],
  ]);
});
