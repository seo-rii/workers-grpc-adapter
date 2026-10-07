'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSecretManagerReport } = require('../scripts/secret-manager-evidence.cjs');

// A deliberately synthetic schema fixture for mutation testing. This is not
// an execution receipt; the integration runner validates its own actual report.
function fixture() {
  const hash = 'a'.repeat(64);
  const sources = ['scripts/test-secret-manager-extended.cjs', 'scripts/secret-manager-evidence.cjs',
    'fixtures/google/shared/secret-manager-extended.mjs', 'fixtures/google/shared/assert.mjs',
    'fixtures/google/secret-manager-worker.mjs', 'fixtures/google/package-lock.json',
    'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'];
  const sharedSourceHashes = { 'secret-manager-extended.mjs': hash, 'assert.mjs': hash };
  const scenarios = [
    ['list-manual-promise', 'ListSecrets', 0, 3], ['list-manual-callback', 'ListSecrets', 0, 3],
    ['list-auto', 'ListSecrets', 0, 3], ['list-async', 'ListSecrets', 0, 3], ['list-async-break', 'ListSecrets', 0, 1],
    ['access-promise', 'AccessSecretVersion', 0, 0], ['access-callback', 'AccessSecretVersion', 0, 0],
    ['access-empty', 'AccessSecretVersion', 0, 0], ['access-bad-crc', 'AccessSecretVersion', 0, 0],
    ['access-not-found', 'AccessSecretVersion', 5, 0], ['access-denied', 'AccessSecretVersion', 7, 0],
  ];
  for (const [prefix, method, codes] of [['get', 'GetSecret', [3, 5, 7]], ['list', 'ListSecrets', [3, 7, 8, 14]],
    ['access', 'AccessSecretVersion', [3, 5, 7, 9, 14]]]) {
    for (const code of codes) for (const shape of ['promise', 'callback']) {
      scenarios.push([`${prefix}-error-${code}-${shape}`, method, code, prefix === 'list' ? 1 : 0]);
    }
  }
  for (const shape of ['manual-promise', 'manual-callback', 'auto-promise', 'auto-callback', 'async']) {
    scenarios.push([`list-page-error-${shape}`, 'ListSecrets', 14, 2]);
  }
  const report = {
    status: 'passed', sourceBuild: false, liveGoogle: false, cloudflareTranslation: false, officialEmulator: false,
    controlledNativeGrpcServer: true, payloadsRecorded: false, sdkValidatesChecksum: false,
    consumerChecksumValidationTested: true, sameSharedSource: true, retryDisabled: true, runtimeDisposed: true,
    resourcesCheckedBeforeClientClose: true,
    runtime: 'v24.1.0', nativeGrpcVersion: '1.14.5', sdkVersion: '7.1.0', bundleSha256: hash,
    buildProfile: { name: 'google-static-v1', revision: 5, sha256: hash, registrySha256: hash },
    evidence: Object.fromEntries(sources.map(file => [file, hash])), sharedSourceHashes,
    sourceHashes: Object.fromEntries(['native', 'adapter', 'workerd'].map(runtime => [runtime, { ...sharedSourceHashes }])),
    installedInputs: {}, nativeInputs: {}, results: [], contracts: {}, caseCount: 200, rpcCount: 445, grpcWebRequests: 356,
  };
  for (const [map, fixture, grpcEntry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
    for (const file of ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${grpcEntry}`, '@google-cloud/secret-manager/package.json',
      '@google-cloud/secret-manager/build/src/v1/secret_manager_service_client.js', '@google-cloud/secret-manager/build/protos/protos.json']) {
      report[map][`fixtures/${fixture}/node_modules/${file}`] = hash;
    }
  }
  for (const runtime of ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare']) {
    let sequence = 0;
    for (const [scenario, method, errorCode, pages] of scenarios) {
      const failed = errorCode !== 0, pageError = scenario.startsWith('list-page-error-');
      const trace = pages ? Array.from({ length: pages }, (_, index) => ({ method, pageToken: index ? `page-${index}` : '' })) : [{ method }];
      if (pages || failed) trace.push({ method: 'GetSecret' });
      const contract = { kind: pageError ? 'page-error' : failed ? 'error' : 'success', method, pages, rpcCount: trace.length };
      if (failed) Object.assign(contract, { errorCode, shape: pageError ? scenario.slice('list-page-error-'.length)
        : scenario.endsWith('callback') || scenario === 'access-denied' ? 'callback' : 'promise' });
      report.contracts[scenario] = contract;
      let result;
      if (failed) {
        const callback = scenario.endsWith('callback') || scenario === 'access-denied';
        const manualPageError = pageError && scenario.includes('-manual-');
        result = { scenario, errorCode, errorMetadata: true, detailsPreserved: true, repeatedTextMetadata: true, repeatedBinaryMetadata: true,
          callbackCount: callback ? manualPageError ? 2 : 1 : 0, rejectionCount: callback ? 0 : 1,
          resolutionCount: manualPageError ? 1 : 0, resultAbsent: true, clientReuse: true };
        if (pageError) Object.assign(result, { deliveredItems: scenario.includes('-auto-') ? 0 : 2,
          completedPages: scenario.includes('-auto-') ? 0 : 1, nextPageSuppressed: true });
      } else if (pages) result = { scenario, items: scenario === 'list-async-break' ? 1 : 6,
        manualPages: scenario.startsWith('list-manual-') ? 3 : 0, clientReuse: true };
      else result = { scenario, bytesChecked: scenario === 'access-callback' ? 65536 : scenario === 'access-empty' ? 0
        : scenario === 'access-bad-crc' ? 257 : 1024, sdkReturnedPayload: true, checksumMatches: scenario !== 'access-bad-crc',
      consumerRejectedChecksum: scenario === 'access-bad-crc' };
      const observer = runtime === 'native' ? null : {
        calls: trace.map((_, index) => ({ logicalCallId: `wga-${++sequence}`, startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1,
          statusCode: failed && index === trace.length - 2 ? errorCode : 0 })),
        resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 },
      };
      report.results.push({ runtime, scenario, status: 'passed', rpcCount: trace.length,
        grpcWebRequests: runtime === 'native' ? 0 : trace.length, metadataChecks: trace.length,
        authMetadataChecks: runtime === 'native' ? 0 : trace.length, trace, result, observer });
    }
  }
  return report;
}

function row(report, scenario = 'access-error-14-callback', runtime = 'workerd-cloudflare') {
  return report.results.find(value => value.runtime === runtime && value.scenario === scenario);
}
function rejectMutations(mutations) {
  for (const [description, mutate] of mutations) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateSecretManagerReport(report), /WGA_EVIDENCE_INVALID/, description);
  }
}

test('EVIDENCE Secret Manager accepts the complete synthetic schema but treats it only as validator input', () => {
  const report = fixture();
  assert.equal(report.results.length, 200);
  assert.equal(report.results.reduce((total, value) => total + value.rpcCount, 0), 445);
  assert.equal(report.results.reduce((total, value) => total + value.grpcWebRequests, 0), 356);
  validateSecretManagerReport(report);
});

test('EVIDENCE Secret Manager rejects incomplete or duplicate runtime and scenario matrices', () => {
  rejectMutations([
    ['failed suite', r => { r.status = 'failed'; }],
    ['missing runtime', r => { r.results = r.results.filter(value => value.runtime !== 'adapter-cloudflare'); }],
    ['unknown runtime', r => { row(r).runtime = 'workerd'; }],
    ['duplicate row', r => { r.results[199] = structuredClone(r.results[198]); }],
    ['missing scenario', r => { r.results.pop(); }],
    ['unknown scenario', r => { row(r).scenario = 'access-error-14'; }],
    ['failed scenario', r => { row(r).status = 'failed'; }],
    ['aggregate cases', r => { r.caseCount--; }],
    ['aggregate RPC', r => { r.rpcCount++; }],
    ['aggregate fetch', r => { r.grpcWebRequests--; }],
    ['row RPC', r => { row(r).rpcCount++; }],
    ['row fetch', r => { row(r).grpcWebRequests++; }],
    ['native fetch', r => { row(r, 'access-promise', 'native').grpcWebRequests = 1; }],
    ['changed scenario contract', r => { r.contracts['access-promise'].rpcCount = 2; }],
    ['missing scenario contract', r => { delete r.contracts['access-promise']; }],
  ]);
});

test('EVIDENCE Secret Manager rejects wrong status, metadata preservation and callback contracts', () => {
  rejectMutations([
    ['error code', r => { row(r).result.errorCode = 7; }],
    ['error metadata', r => { row(r).result.errorMetadata = false; }],
    ['error details', r => { row(r).result.detailsPreserved = false; }],
    ['repeated text', r => { row(r).result.repeatedTextMetadata = false; }],
    ['repeated binary', r => { row(r).result.repeatedBinaryMetadata = false; }],
    ['duplicate callback', r => { row(r).result.callbackCount = 2; }],
    ['missing callback', r => { row(r).result.callbackCount = 0; }],
    ['wrong promise rejection count', r => { row(r, 'access-error-14-promise').result.rejectionCount = 0; }],
    ['manual callback omits successful page', r => { row(r, 'list-page-error-manual-callback').result.callbackCount = 1; }],
    ['manual resolution count missing', r => { row(r, 'list-page-error-manual-promise').result.resolutionCount = 0; }],
    ['error response leak', r => { row(r).result.resultAbsent = false; }],
    ['failed recovery', r => { row(r).result.clientReuse = false; }],
    ['raw error', r => { row(r).result.error = { message: 'fixture-only-value' }; }],
    ['raw metadata', r => { row(r).result.metadata = { authorization: 'fixture-only-value' }; }],
    ['raw payload', r => { row(r, 'access-promise').result.payload = [1, 2, 3]; }],
    ['unexpected result key', r => { row(r).result.access_token = 'fixture-only-value'; }],
    ['raw value beside result', r => { row(r).payload = 'fixture-only-value'; }],
    ['raw value beside matrix', r => { r.authorization = 'fixture-only-value'; }],
    ['wrong 64 KiB result', r => { row(r, 'access-callback').result.bytesChecked = 1024; }],
    ['empty payload untested', r => { row(r, 'access-empty').result.bytesChecked = 1; }],
    ['invalid CRC accepted', r => { row(r, 'access-bad-crc').result.consumerRejectedChecksum = false; }],
    ['SDK CRC overclaim', r => { r.sdkValidatesChecksum = true; }],
    ['payload recording enabled', r => { r.payloadsRecorded = true; }],
  ]);
});

test('EVIDENCE Secret Manager rejects reordered pages, partial-result overclaims and missing reuse barriers', () => {
  rejectMutations([
    ['page order', r => { row(r, 'list-auto').trace[1].pageToken = 'page-2'; }],
    ['wrong service method', r => { row(r, 'get-error-3-promise').trace[0].method = 'AccessSecretVersion'; }],
    ['missing marker', r => { row(r, 'list-manual-promise').trace.pop(); }],
    ['marker before error', r => { row(r).trace.reverse(); }],
    ['extra page after failure', r => { row(r, 'list-page-error-async').trace.splice(2, 0, { method: 'ListSecrets', pageToken: 'page-2' }); }],
    ['extra page after break', r => { row(r, 'list-async-break').trace.splice(1, 0, { method: 'ListSecrets', pageToken: 'page-1' }); }],
    ['manual page failure loses items', r => { row(r, 'list-page-error-manual-promise').result.deliveredItems = 0; }],
    ['auto page failure exposes items', r => { row(r, 'list-page-error-auto-callback').result.deliveredItems = 2; }],
    ['async page completed count', r => { row(r, 'list-page-error-async').result.completedPages = 0; }],
    ['following page not suppressed', r => { row(r, 'list-page-error-async').result.nextPageSuppressed = false; }],
    ['successful manual page count', r => { row(r, 'list-manual-callback').result.manualPages = 2; }],
    ['iterator break yields too many', r => { row(r, 'list-async-break').result.items = 2; }],
    ['unsafe trace values', r => { row(r).trace[0].request = { name: 'fixture-only-value' }; }],
    ['request metadata unobserved', r => { row(r).metadataChecks--; }],
    ['request auth unobserved', r => { row(r).authMetadataChecks--; }],
    ['native auth overclaim', r => { row(r, 'access-promise', 'native').authMetadataChecks = 1; }],
  ]);
});

test('EVIDENCE Secret Manager requires observed single terminals, disabled retries and released resources', () => {
  rejectMutations([
    ['missing observer', r => { delete row(r).observer; }],
    ['fabricated native observer', r => { row(r, 'access-promise', 'native').observer = row(r).observer; }],
    ['missing call', r => { row(r).observer.calls.pop(); }],
    ['duplicate call id', r => { row(r).observer.calls[1].logicalCallId = row(r).observer.calls[0].logicalCallId; }],
    ['missing start', r => { row(r).observer.calls[0].startCount = 0; }],
    ['double terminal', r => { row(r).observer.calls[0].terminalCount = 2; }],
    ['hidden retry', r => { row(r).observer.calls[0].attemptCount = 2; }],
    ['hidden fetch', r => { row(r).observer.calls[0].fetchCount = 2; }],
    ['wrong transport code', r => { row(r).observer.calls[0].statusCode = 0; }],
    ['wrong recovery code', r => { row(r).observer.calls[1].statusCode = 14; }],
    ['active RPC remains', r => { row(r).observer.resources.activeCalls = 1; }],
    ['queued RPC remains', r => { row(r).observer.resources.queuedCalls = 1; }],
    ['buffer remains', r => { row(r).observer.resources.bufferedBytes = 1; }],
    ['observer payload leak', r => { row(r).observer.calls[0].payload = 'fixture-only-value'; }],
    ['retry boundary', r => { r.retryDisabled = false; }],
    ['runtime still alive', r => { r.runtimeDisposed = false; }],
    ['resources checked after SDK close', r => { r.resourcesCheckedBeforeClientClose = false; }],
  ]);
});

test('EVIDENCE Secret Manager requires installed native and adapter provenance and identical shared sources', () => {
  rejectMutations([
    ['source build', r => { r.sourceBuild = true; }],
    ['live Google claim', r => { r.liveGoogle = true; }],
    ['edge translation claim', r => { r.cloudflareTranslation = true; }],
    ['emulator claim', r => { r.officialEmulator = true; }],
    ['uncontrolled peer', r => { r.controlledNativeGrpcServer = false; }],
    ['checksum consumer untested', r => { r.consumerChecksumValidationTested = false; }],
    ['changed SDK', r => { r.sdkVersion = '8.0.0'; }],
    ['changed native', r => { r.nativeGrpcVersion = '1.15.0'; }],
    ['missing node identity', r => { delete r.runtime; }],
    ['missing bundle', r => { delete r.bundleSha256; }],
    ['wrong profile', r => { r.buildProfile.name = 'unverified'; }],
    ['wrong revision', r => { r.buildProfile.revision++; }],
    ['missing registry hash', r => { delete r.buildProfile.registrySha256; }],
    ['missing source', r => { delete r.evidence['scripts/test-secret-manager-extended.cjs']; }],
    ['malformed source hash', r => { r.evidence['scripts/secret-manager-evidence.cjs'] = 'unknown'; }],
    ['missing native input', r => { delete r.nativeInputs['fixtures/native/node_modules/@grpc/grpc-js/build/src/index.js']; }],
    ['missing installed input', r => { delete r.installedInputs['fixtures/google/node_modules/@grpc/grpc-js/dist/index.js']; }],
    ['invalid input hash', r => { r.installedInputs['fixtures/google/node_modules/@grpc/grpc-js/package.json'] = 'unknown'; }],
    ['input path traversal', r => { r.installedInputs['fixtures/google/node_modules/../package.json'] = 'a'.repeat(64); }],
    ['wrong fixture provenance', r => { r.nativeInputs['fixtures/google/node_modules/@grpc/grpc-js/package.json'] = 'a'.repeat(64); }],
    ['source identity false', r => { r.sameSharedSource = false; }],
    ['missing runtime source', r => { delete r.sourceHashes.workerd; }],
    ['changed worker source', r => { r.sourceHashes.workerd['secret-manager-extended.mjs'] = 'b'.repeat(64); }],
    ['extra shared helper', r => { r.sharedSourceHashes['unverified.mjs'] = 'a'.repeat(64); }],
    ['source hash unlinked', r => { r.evidence['fixtures/google/shared/secret-manager-extended.mjs'] = 'b'.repeat(64); }],
  ]);
});
