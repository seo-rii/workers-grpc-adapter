'use strict';
const { isDeepStrictEqual } = require('node:util');
const runtimes = ['native', 'adapter-grpc-web', 'adapter-cloudflare', 'workerd-grpc-web', 'workerd-cloudflare'];
const sources = ['scripts/test-secret-manager-extended.cjs', 'scripts/secret-manager-evidence.cjs',
  'fixtures/google/shared/secret-manager-extended.mjs', 'fixtures/google/shared/assert.mjs',
  'fixtures/google/secret-manager-worker.mjs', 'fixtures/google/package-lock.json',
  'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'];
const helpers = ['secret-manager-extended.mjs', 'assert.mjs'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, reason) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: secret-manager ${reason}`); }

// Keep the independent oracle here, not in the SDK fixture: a changed fixture
// cannot certify its own reduced scenario set or relaxed expected result.
const scenarios = ['list-manual-promise', 'list-manual-callback', 'list-auto', 'list-async', 'list-async-break',
  'access-promise', 'access-callback', 'access-empty', 'access-bad-crc', 'access-not-found', 'access-denied'];
for (const [prefix, codes] of [['get', [3, 5, 7]], ['list', [3, 7, 8, 14]], ['access', [3, 5, 7, 9, 14]]]) {
  for (const code of codes) for (const shape of ['promise', 'callback']) scenarios.push(`${prefix}-error-${code}-${shape}`);
}
for (const shape of ['manual-promise', 'manual-callback', 'auto-promise', 'auto-callback', 'async']) scenarios.push(`list-page-error-${shape}`);

function expectation(scenario) {
  const errorMatch = /^(get|list|access)-error-(3|5|7|8|9|14)-(promise|callback)$/.exec(scenario);
  const pageError = scenario.startsWith('list-page-error-');
  const legacyError = ['access-not-found', 'access-denied'].includes(scenario);
  const failed = Boolean(errorMatch) || pageError || legacyError;
  const pages = pageError ? 2 : errorMatch?.[1] === 'list' ? 1
    : scenario.startsWith('list-') ? scenario === 'list-async-break' ? 1 : 3 : 0;
  const method = pages ? 'ListSecrets' : errorMatch?.[1] === 'get' ? 'GetSecret' : 'AccessSecretVersion';
  const errorCode = pageError ? 14 : legacyError ? scenario === 'access-not-found' ? 5 : 7 : errorMatch ? Number(errorMatch[2]) : 0;
  const trace = pages ? Array.from({ length: pages }, (_, index) => ({ method, pageToken: index ? `page-${index}` : '' })) : [{ method }];
  if (pages || failed) trace.push({ method: 'GetSecret' });
  const codes = trace.map((_, index) => failed && index === trace.length - 2 ? errorCode : 0);
  let result;
  if (failed) {
    const callback = scenario.endsWith('callback') || scenario === 'access-denied';
    const manualPageError = pageError && scenario.includes('-manual-');
    result = { scenario, errorCode, errorMetadata: true, detailsPreserved: true,
      repeatedTextMetadata: true, repeatedBinaryMetadata: true,
      callbackCount: callback ? manualPageError ? 2 : 1 : 0, rejectionCount: callback ? 0 : 1,
      resolutionCount: manualPageError ? 1 : 0,
      resultAbsent: true, clientReuse: true };
    if (pageError) {
      const partial = !scenario.includes('-auto-');
      Object.assign(result, { deliveredItems: partial ? 2 : 0, completedPages: partial ? 1 : 0, nextPageSuppressed: true });
    }
  } else if (pages) result = { scenario, items: scenario === 'list-async-break' ? 1 : 6,
    manualPages: scenario.startsWith('list-manual-') ? 3 : 0, clientReuse: true };
  else result = { scenario, bytesChecked: scenario === 'access-callback' ? 65536 : scenario === 'access-empty' ? 0
    : scenario === 'access-bad-crc' ? 257 : 1024, sdkReturnedPayload: true,
  checksumMatches: scenario !== 'access-bad-crc', consumerRejectedChecksum: scenario === 'access-bad-crc' };
  const contract = { kind: pageError ? 'page-error' : failed ? 'error' : 'success', method, pages, rpcCount: trace.length };
  if (failed) Object.assign(contract, { errorCode, shape: pageError ? scenario.slice('list-page-error-'.length)
    : scenario.endsWith('callback') || scenario === 'access-denied' ? 'callback' : 'promise' });
  return { trace, codes, result, contract };
}

function validateSecretManagerReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false, 'installed execution');
  const reportKeys = ['status', 'startedAt', 'finishedAt', 'liveGoogle', 'cloudflareTranslation', 'officialEmulator',
    'controlledNativeGrpcServer', 'scope', 'sourceBuild', 'retryDisabled', 'installedInputs', 'nativeInputs',
    'payloadsRecorded', 'sdkValidatesChecksum', 'consumerChecksumValidationTested', 'sameSharedSource', 'sourceHashes',
    'runtime', 'nativeGrpcVersion', 'sdkVersion', 'results', 'checks', 'evidence', 'contracts', 'sharedSourceHashes',
    'buildProfile', 'bundleSha256', 'caseCount', 'rpcCount', 'grpcWebRequests', 'runtimeDisposed', 'resourcesCheckedBeforeClientClose'];
  need(Object.keys(report).every(key => reportKeys.includes(key)), 'safe report fields');
  for (const key of ['liveGoogle', 'cloudflareTranslation', 'officialEmulator', 'payloadsRecorded', 'sdkValidatesChecksum']) {
    need(report[key] === false, `${key} execution boundary`);
  }
  for (const key of ['controlledNativeGrpcServer', 'consumerChecksumValidationTested', 'sameSharedSource', 'retryDisabled', 'runtimeDisposed',
    'resourcesCheckedBeforeClientClose']) {
    need(report[key] === true, `${key} execution boundary`);
  }
  need(report.nativeGrpcVersion === '1.14.0' && report.sdkVersion === '7.1.0'
    && typeof report.runtime === 'string' && /^v\d+\.\d+\.\d+/.test(report.runtime), 'pinned runtime identity');
  need(hash(report.bundleSha256) && report.buildProfile?.name === 'google-static-v1' && report.buildProfile.revision === 4
    && hash(report.buildProfile.sha256) && hash(report.buildProfile.registrySha256), 'worker bundle/profile identity');
  need(sources.every(file => hash(report.evidence?.[file])), 'source evidence');
  need(isDeepStrictEqual(Object.keys(report.sharedSourceHashes || {}).sort(), [...helpers].sort()), 'shared helper set');
  need(isDeepStrictEqual(Object.keys(report.sourceHashes || {}).sort(), ['adapter', 'native', 'workerd']), 'runtime source hash set');
  for (const helper of helpers) {
    need(hash(report.sharedSourceHashes[helper])
      && report.sharedSourceHashes[helper] === report.evidence[`fixtures/google/shared/${helper}`], 'shared source hash');
  }
  for (const runtime of ['native', 'adapter', 'workerd']) {
    need(isDeepStrictEqual(report.sourceHashes[runtime], report.sharedSourceHashes), 'byte-identical runtime sources');
  }
  for (const [mapName, fixture, grpcEntry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
    const inputs = report[mapName];
    const required = [`@grpc/grpc-js/package.json`, `@grpc/grpc-js/${grpcEntry}`,
      '@google-cloud/secret-manager/package.json', '@google-cloud/secret-manager/build/src/v1/secret_manager_service_client.js',
      '@google-cloud/secret-manager/build/protos/protos.json'];
    need(inputs && required.every(file => hash(inputs[`fixtures/${fixture}/node_modules/${file}`])), `${mapName} package provenance`);
    need(Object.entries(inputs).every(([file, value]) => file.startsWith(`fixtures/${fixture}/node_modules/`)
      && !file.split('/').includes('..') && hash(value)), `${mapName} hash records`);
  }
  need(report.caseCount === 200 && report.rpcCount === 445 && report.grpcWebRequests === 356
    && Array.isArray(report.results) && report.results.length === 200, 'aggregate matrix/counts');
  need(isDeepStrictEqual(report.contracts, Object.fromEntries(scenarios.map(scenario => [scenario, expectation(scenario).contract]))),
    'independent scenario contracts');
  let rpcCount = 0, fetchCount = 0;
  for (const runtime of runtimes) for (const scenario of scenarios) {
    const rows = report.results.filter(row => row?.runtime === runtime && row.scenario === scenario);
    need(rows.length === 1, `exact matrix ${runtime}/${scenario}`);
    const row = rows[0], expected = expectation(scenario);
    need(isDeepStrictEqual(Object.keys(row).sort(), ['runtime', 'scenario', 'status', 'rpcCount', 'grpcWebRequests',
      'trace', 'metadataChecks', 'authMetadataChecks', 'observer', 'result'].sort()), 'safe row fields');
    need(row.status === 'passed' && row.rpcCount === expected.trace.length
      && row.grpcWebRequests === (runtime === 'native' ? 0 : expected.trace.length), 'scenario RPC/fetch accounting');
    need(row.metadataChecks === expected.trace.length && row.authMetadataChecks === (runtime === 'native' ? 0 : expected.trace.length),
      'request routing/quota/authentication metadata checks');
    need(isDeepStrictEqual(row.trace, expected.trace), 'method/page/recovery order');
    // An exact safe result object also excludes raw exceptions, metadata,
    // credentials, secret bytes, checksums and response objects from evidence.
    need(isDeepStrictEqual(row.result, expected.result), 'safe result/metadata/callback contract');
    if (runtime === 'native') need(row.observer === null, 'native observer boundary');
    else {
      need(isDeepStrictEqual(Object.keys(row.observer || {}).sort(), ['calls', 'resources'])
        && isDeepStrictEqual(row.observer.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }), 'released transport resources');
      need(Array.isArray(row.observer.calls) && row.observer.calls.length === expected.trace.length, 'observed call count');
      const ids = new Set();
      row.observer.calls.forEach((call, index) => {
        need(typeof call?.logicalCallId === 'string' && /^wga-\d+$/.test(call.logicalCallId)
          && !ids.has(call.logicalCallId), 'unique observed logical calls');
        ids.add(call.logicalCallId);
        need(isDeepStrictEqual(call, { logicalCallId: call.logicalCallId, startCount: 1, terminalCount: 1,
          attemptCount: 1, fetchCount: 1, statusCode: expected.codes[index] }), 'one terminal/attempt/fetch and exact status');
      });
    }
    rpcCount += row.rpcCount; fetchCount += row.grpcWebRequests;
  }
  need(rpcCount === report.rpcCount && fetchCount === report.grpcWebRequests, 'summed counts');
}
module.exports = { validateSecretManagerReport };
