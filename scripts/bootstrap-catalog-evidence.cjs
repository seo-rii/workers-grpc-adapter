'use strict';
const { isDeepStrictEqual } = require('node:util');
const caseIds = ['BOOT-002', 'BOOT-005', 'BOOT-006', 'BOOT-007', 'BOOT-008', 'BOOT-009', 'BOOT-011'];
const sources = ['scripts/test-bootstrap-catalog.cjs', 'scripts/bootstrap-catalog-evidence.cjs', 'scripts/sdk-bundle-inspection.cjs',
  'fixtures/worker/bootstrap-catalog.mjs', 'fixtures/worker/bootstrap-app-probe.mjs',
  'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/modern/package-lock.json',
  'fixtures/modern-native/package-lock.json', 'fixtures/worker/package-lock.json'];
const profiles = { 'google-static-v1': { revision: 5, fixture: 'google', nativeFixture: 'native', types: 764, schemas: 14 },
  'google-modern-v1': { revision: 2, fixture: 'modern', nativeFixture: 'modern-native', types: 1069, schemas: 15 } };
const firstMethods = ['fromObject', 'toObject', 'encode', 'decode'];
const methods = ['ctor', 'create', 'verify', 'fromObject', 'toObject', 'encode', 'decode', 'encodeDelimited', 'decodeDelimited',
  'lookup', 'lookupType', 'lookupTypeOrEnum', 'lookupEnum', 'lookupService', 'getEnum', 'get',
  'fieldsArray', 'fieldsById', 'oneofsArray', 'resolve', 'resolveAll', 'toJSON'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function need(value, label) { if (!value) throw Object.assign(new Error(`WGA_EVIDENCE_INVALID: bootstrap ${label}`), { code: 'WGA_EVIDENCE_INVALID' }); }
function same(actual, expected, label) { need(isDeepStrictEqual(actual, expected), label); }
function accounting(value, count) {
  need(value?.beforeClose === true, 'resources measured before SDK close');
  same(value.resources, { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }, 'no request-owned resources');
  need(value.calls?.length === count && value.fetches?.length === count, 'exact SDK Call and Fetch counts');
  for (const call of value.calls) {
    need(typeof call.logicalCallId === 'string' && call.logicalCallId.length > 0
      && typeof call.method === 'string' && call.start === 1 && call.terminal === 1 && call.auth === 1 && call.fetch === 1 && call.status === 0,
    'independent Call lifecycle');
    same(call.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }, 'actual Call state released');
    same(call.execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
      parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 }, 'actual asynchronous Call execution released');
    need(value.fetches.filter(fetch => fetch.logicalCallId === call.logicalCallId && fetch.method === call.method).length === 1,
      'Call identity tied to one actual Fetch');
  }
  for (const fetch of value.fetches) need(fetch.contentType === 'application/grpc-web+proto' && hash(fetch.tokenSha256)
    && typeof fetch.logicalCallId === 'string', 'binary gRPC and auth receipt');
  same(value.calls.map(call => call.method).sort(), value.fetches.map(fetch => fetch.method).sort(), 'Call/IO method identity');
}
function validateBootstrapCatalogReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false && report.independentNativeOracle === true && report.runtimeDisposed === true,
    'complete installed/native/workerd execution');
  for (const flag of ['liveGoogle', 'cloudflareTranslation', 'officialEmulator']) need(report[flag] === false, `${flag} boundary`);
  same(report.failures, [], 'peer failures');
  need(/^v\d+\.\d+\.\d+/.test(report.runtime) && report.compatibilityDate === '2026-09-21'
    && typeof report.workerd === 'string' && report.workerd.length > 0 && typeof report.miniflare === 'string' && report.miniflare.length > 0,
  'pinned runtime provenance');
  need(sources.every(file => hash(report.evidence?.[file])), 'complete source provenance');
  same(report.cases, caseIds.map(id => ({ id, status: 'passed', profiles: Object.keys(profiles) })), 'all seven case outcomes');
  same(report.catalogCases, caseIds.map(id => ({ id, status: 'passed', profiles: Object.keys(profiles), catalogMatch: true })), 'all seven exact catalog matches');
  same(report.profiles?.map(row => row.id), Object.keys(profiles), 'both exact profiles');
  for (const row of report.profiles) {
    const expected = profiles[row.id];
    need(row.status === 'passed' && row.runtimeDisposed === true && row.revision === expected.revision
      && row.fixture === expected.fixture && row.nativeFixture === expected.nativeFixture && row.nativeGrpcVersion === '1.14.5', 'profile pins and execution');
    need(hash(row.bundleSha256) && hash(row.oracleInputsSha256) && row.build?.profile === row.id && row.build.revision === expected.revision
      && hash(row.build.profileSha256) && hash(row.build.registrySha256) && row.build.nodeModulesModified === false && row.build.globalPrototypePatched === false,
    'installed registry provenance');
    need(row.bundleInspection?.status === 'passed' && row.bundleInspection.bundleSha256 === row.bundleSha256
      && row.bundleInspection.stages?.length === 2, 'two-stage actual bundle inspection');
    same(row.bundleInspection.nativeGrpcPackages, [], 'no native gRPC bundle'); same(row.bundleInspection.violations, [], 'no forbidden imports');
    need(Object.values(row.installedInputs || {}).length > 30 && Object.values(row.installedInputs).every(hash)
      && Object.values(row.nativeInputs || {}).length > 30 && Object.values(row.nativeInputs).every(hash), 'installed input hashes');
    for (const [file, digest] of Object.entries(row.installedInputs)) if (!file.startsWith('node_modules/@grpc/grpc-js/')) same(row.nativeInputs[file], digest, 'native oracle exact package/source/schema/codegen identity');
    for (const file of ['package.json', 'dist/index.js', 'dist/build/index.cjs']) need(hash(row.installedInputs[`node_modules/@grpc/grpc-js/${file}`]), 'installed adapter identity');
    for (const file of ['package.json', 'build/src/index.js']) need(hash(row.nativeInputs[`node_modules/@grpc/grpc-js/${file}`]), 'native grpc identity');
    need(row.loaderResolution?.bundleIncluded === true, 'actual loader/protobuf entries included in Worker');
    for (const [name, fixture] of [['installed', expected.fixture], ['native', expected.nativeFixture]]) {
      const pair = row.loaderResolution[name], prefix = `fixtures/${fixture}/`;
      need(pair?.loaderEntry === `${prefix}node_modules/@grpc/proto-loader/build/src/index.js`
        && typeof pair.protobufEntry === 'string' && pair.protobufEntry.startsWith(prefix) && pair.protobufEntry.endsWith('/protobufjs/index.js')
        && hash(pair.loaderSha256) && hash(pair.protobufSha256) && pair.protobufVersion === '7.6.6', 'proven actual loader to protobuf resolution');
      same(pair.loaderSha256, name === 'installed' ? row.installedInputs['node_modules/@grpc/proto-loader/build/src/index.js']
        : row.nativeInputs['node_modules/@grpc/proto-loader/build/src/index.js'], 'resolved loader source hash');
    }
    same(row.loaderResolution.installed.protobufSha256, row.loaderResolution.native.protobufSha256, 'independent native loader runtime bytes');
    same(row.codecAudit?.calibration, { Function: 'EvalError', eval: 'EvalError' }, 'actual workerd runtime codegen restrictions');
    need(row.schemaPaths?.length === expected.schemas && new Set(row.schemaPaths).size === expected.schemas, 'complete pinned schema list');
    same(row.codecAudit.schemas.map(schema => schema.path), row.schemaPaths, 'all runtime schemas');
    same(row.nativeSchemaSummary?.map(schema => schema.path), row.schemaPaths, 'all independent native schemas');
    let types = 0, enums = 0, oneofs = 0, loaderVariants = 0, reflectedVariants = 0;
    for (let index = 0; index < row.schemaPaths.length; index++) {
      const native = row.nativeSchemaSummary[index], observed = row.codecAudit.schemas[index];
      need(hash(native.sourceSha256) && native.sourceSha256 === row.installedInputs[native.path]
        && typeof native.protobufPath === 'string' && native.protobufPath.startsWith(`fixtures/${expected.nativeFixture}/node_modules/`), 'native schema provenance');
      need(native.typeNames.length > 0 && new Set(native.typeNames).size === native.typeNames.length, 'nonempty unique schema type inventory');
      same(observed.typeNames, native.typeNames, 'runtime/native type inventory');
      same(Object.keys(observed.first), firstMethods, 'every cold first entrypoint');
      for (const method of firstMethods) same(observed.first[method], native.typeNames, `fresh-root first ${method} coverage`);
      same(observed.reflected, native.typeNames, 'ctor-first reflection/codec type coverage'); same(observed.methods, methods, 'complete ordered methods');
      need(Array.isArray(native.namespaces) && native.namespaces.every(item => ['enum', 'service'].includes(item.kind)
        && typeof item.name === 'string' && hash(item.jsonSha256)), 'native enum/service reflection inventory');
      same(observed.namespaces, native.namespaces, 'enum/service lookup/get/reflection methods');
      same(observed.matrix, native.matrix, 'native pinned-loader wire/object matrix');
      need(new Set(native.matrix.map(item => `${item.type}/${item.label}`)).size === native.matrix.length, 'unique loader matrix variants');
      for (const name of native.typeNames) for (const label of ['required-defaults', 'populated']) need(native.matrix.some(item => item.type === name && item.label === label), 'default and populated object per type');
      for (const item of native.matrix) {
        need(native.typeNames.includes(item.type) && hash(item.wireSha256) && hash(item.objectSha256), 'oracle byte/object evidence');
        need(['native-proto-loader', 'native-protobuf-reflection'].includes(item.oracle), 'actual oracle export surface');
        if (item.oracle === 'native-proto-loader') loaderVariants++; else reflectedVariants++;
        if (item.label.startsWith('enum:')) enums++;
        if (item.label.startsWith('oneof:')) oneofs++;
      }
      types += native.typeNames.length;
    }
    need(types === expected.types && enums > 0 && oneofs > 0 && loaderVariants > 0 && reflectedVariants > 0, 'complete type and options matrix');
    need(row.sourcePaths?.length > 10 && new Set(row.sourcePaths).size === row.sourcePaths.length, 'actual pinned source inventory');
    same(row.rejections.map(value => [value.kind, value.path]), [...row.sourcePaths.map(file => ['source-hash', file]),
      ...row.schemaPaths.map(file => ['schema-hash', file])], 'every pinned source/schema mutation');
    for (const mutation of row.rejections) need(mutation.code === 'WGA_SCHEMA_MISMATCH' && hash(mutation.originalSha256)
      && mutation.originalSha256 === row.installedInputs[mutation.path] && hash(mutation.mutatedSha256) && mutation.mutatedSha256 !== mutation.originalSha256
      && mutation.outputCreated === false && mutation.installedUnchanged === true, 'isolated actual mutation rejected before build output');
    const application = row.application;
    need(application?.independentCopies === true && application.prototypesUnchanged === true && application.sourceTreeUnchanged === true
      && application.includedIndependentInput === true && application.transformedIndependentInputs === 0
      && hash(application.sourceTreeSha256) && hash(application.baselineBundleSha256), 'application-owned physical protobuf isolation');
    same(application.probe, application.baseline, 'same app behavior with/without preset');
    const largeInteger = '9007199254740993';
    need(application.copiedPackageVersion === '7.6.6', 'independent application protobuf version');
    same(application.probe, { fields: [['label', 'string', 1], ['count', 'int64', 2]],
      wire: [10, 'application-owned', 16, '42'], codegen: 'EvalError', largeIntegerRoundtrip: largeInteger,
      rootFromJSON: 'EvalError',
      customSchemaAccepted: true, ownRootConstructor: true },
    'reflection/writer work and app codegen rejection remains intact');
    same(application.precisionBoundary, { input: '9007199254740993', native: '9007199254740993', workerd: largeInteger,
      matchesNative: true, presetChangesBaseline: false }, 'unmodified application protobuf precision boundary preserved');
    same(row.closure?.highLevelConstructors, ['datastore', 'firestore'], 'high-level constructor closure');
    same(row.closure.highLevelInitialized, ['firestore-batch-get'], 'high-level Firestore lazy stub closure');
    same(row.closure.gaxCopies, ['gax-0', 'gax-1'], 'both GAX copies');
    same(row.closure.rows.map(value => value.name), ['datastore', 'datastore-admin', 'secret-manager', 'gax-0', 'gax-1'], 'SDK and common service closure');
    for (const closure of row.closure.rows) {
      need(closure.initialized === true && closure.memoized === true && closure.grpcStub === true, 'real constructor and memoized lazy stub');
      if (closure.name.startsWith('gax-')) need(closure.operations === `operations/${closure.name}` && closure.location === closure.name
        && closure.iam === `roles/${closure.name}` && closure.statusCode === 7, 'operations/locations/IAM/status common schemas execute');
    }
    accounting(row.closure.accounting, 7);
    same(row.requests?.map(value => value.token), ['seq-a', 'seq-b', 'parallel-a', 'parallel-b'], 'sequential and parallel requests');
    same(row.requests.map(value => value.ordinal), [1, 2, 3, 4], 'one isolate request sequence');
    need(new Set(row.requests.map(value => value.isolateId)).size === 1 && typeof row.requests[0].isolateId === 'string'
      && row.requests[0].isolateId.length > 10 && row.requests[3].peakRequests === 2, 'actual same-isolate overlap');
    for (const request of row.requests) {
      need(request.entity === request.token && request.secret === `projects/bootstrap-project/secrets/${request.token}`, 'request result isolation');
      accounting(request.accounting, 2);
    }
    const calls = [...row.closure.accounting.calls, ...row.requests.flatMap(request => request.accounting.calls)];
    need(new Set(calls.map(call => call.logicalCallId)).size === calls.length, 'all Calls have independent identities');
    need(row.receipts?.length === 15 && row.receipts.filter(receipt => receipt.overlap).length === 4, 'exact native peer and concurrent receipt counts');
    for (const token of ['closure', 'seq-a', 'seq-b', 'parallel-a', 'parallel-b']) {
      const receipts = row.receipts.filter(receipt => receipt.token === token), count = token === 'closure' ? 7 : 2;
      need(receipts.length === count && receipts.every(receipt => receipt.contentType === 'application/grpc-web+proto'
        && hash(receipt.requestSha256) && hash(receipt.tokenSha256) && receipt.overlap === token.startsWith('parallel-')), 'per-request independent binary IO');
      const observed = token === 'closure' ? row.closure.accounting : row.requests.find(request => request.token === token).accounting;
      same(receipts.map(({ logicalCallId, method, contentType, tokenSha256 }) => ({ logicalCallId, method, contentType, tokenSha256 })).sort((a, b) => a.method.localeCompare(b.method)),
        [...observed.fetches].sort((a, b) => a.method.localeCompare(b.method)), 'physical peer/auth receipt matches request-owned Fetches');
    }
  }
  return report;
}
module.exports = { validateBootstrapCatalogReport, sources, caseIds, profiles, firstMethods, methods };
