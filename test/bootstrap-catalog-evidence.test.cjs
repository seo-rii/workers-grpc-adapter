'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBootstrapCatalogReport, sources, caseIds, profiles, firstMethods, methods } = require('../scripts/bootstrap-catalog-evidence.cjs');
const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64);
// Synthetic mutation baseline only. Executed evidence is produced separately
// by the installed-package/native-oracle/workerd integration runner.
function fixture() {
  function accounting(token, paths) {
    return { beforeClose: true, resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 },
      fetches: paths.map((method, index) => ({ logicalCallId: `${token}-${index}`, method, contentType: 'application/grpc-web+proto', tokenSha256: hash })),
      calls: paths.map((method, index) => ({ logicalCallId: `${token}-${index}`, method, start: 1, terminal: 1, auth: 1, fetch: 1, status: 0,
        diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
        execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 } })) };
  }
  const app = { fields: [['label', 'string', 1], ['count', 'int64', 2]], wire: [10, 'application-owned', 16, '42'],
    codegen: 'EvalError', customSchemaAccepted: true, ownRootConstructor: true };
  const report = { status: 'passed', sourceBuild: false, independentNativeOracle: true, runtimeDisposed: true,
    liveGoogle: false, cloudflareTranslation: false, officialEmulator: false, failures: [], runtime: 'v22.0.0',
    compatibilityDate: '2026-09-21', workerd: '1.20260921.0', miniflare: '5.20260921.0-alpha',
    evidence: Object.fromEntries(sources.map(source => [source, hash])),
    cases: caseIds.map(id => ({ id, status: 'passed', profiles: Object.keys(profiles) })),
    catalogCases: caseIds.map(id => ({ id, status: 'passed', profiles: Object.keys(profiles), catalogMatch: true })), profiles: [] };
  for (const [id, spec] of Object.entries(profiles)) {
    const largeInteger = '9007199254740993';
    const applicationProbe = { ...app, largeIntegerRoundtrip: largeInteger, rootFromJSON: 'EvalError' };
    const profile = require(`../src/build/profiles/${id}.json`);
    const installedInputs = Object.fromEntries([...profile.packages.map(item => `${item.path}/package.json`),
      ...profile.files.map(item => item.path), ...profile.schemas.map(item => item.path), ...profile.codegenInputs.map(item => item.path)]
      .map(file => [file, hash]));
    const nativeInputs = { ...installedInputs };
    for (const file of ['package.json', 'dist/index.js', 'dist/build/index.cjs']) installedInputs[`node_modules/@grpc/grpc-js/${file}`] = hash;
    for (const file of ['package.json', 'build/src/index.js']) nativeInputs[`node_modules/@grpc/grpc-js/${file}`] = hash;
    const nativeSchemaSummary = profile.schemas.map((schema, index) => {
      const count = index === 0 ? spec.types - spec.schemas + 1 : 1;
      const typeNames = Array.from({ length: count }, (_, value) => `.Synthetic${value}`);
      return { path: schema.path, sourceSha256: hash, typeNames, protobufPath: `fixtures/${spec.nativeFixture}/node_modules/protobufjs/index.js`,
        namespaces: [{ name: '.SyntheticEnum', kind: 'enum', jsonSha256: hash }, { name: '.SyntheticService', kind: 'service', jsonSha256: hash }],
        matrix: typeNames.flatMap(type => ['required-defaults', 'populated', ...(type === '.Synthetic0' ? ['enum:mode:ON', 'oneof:kind:text'] : [])]
          .map(label => ({ type, label, oracle: index === 0 ? 'native-proto-loader' : 'native-protobuf-reflection', wireSha256: hash, objectSha256: hash }))) };
    });
    const closurePaths = ['/google.firestore.v1.Firestore/BatchGetDocuments', ...['gax-0', 'gax-1'].flatMap(() =>
      ['/google.longrunning.Operations/GetOperation', '/google.cloud.location.Locations/GetLocation', '/google.iam.v1.IAMPolicy/GetIamPolicy'])];
    const requestPaths = ['/google.datastore.v1.Datastore/Lookup', '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret'];
    const requests = ['seq-a', 'seq-b', 'parallel-a', 'parallel-b'].map((token, index) => ({ token, ordinal: index + 1,
      isolateId: 'synthetic-same-isolate-identity', peakRequests: index < 2 ? 1 : 2, entity: token,
      secret: `projects/bootstrap-project/secrets/${token}`, accounting: accounting(token, requestPaths) }));
    const closure = { highLevelConstructors: ['datastore', 'firestore'], gaxCopies: ['gax-0', 'gax-1'],
      highLevelInitialized: ['firestore-batch-get'],
      accounting: accounting('closure', closurePaths),
      rows: ['datastore', 'datastore-admin', 'secret-manager', 'gax-0', 'gax-1'].map(name => ({ name,
        initialized: true, memoized: true, grpcStub: true, ...(name.startsWith('gax-') ? {
          operations: `operations/${name}`, location: name, iam: `roles/${name}`, statusCode: 7 } : {}) })) };
    report.profiles.push({ id, fixture: spec.fixture, nativeFixture: spec.nativeFixture, revision: spec.revision, status: 'passed', runtimeDisposed: true,
      nativeGrpcVersion: '1.14.5', installedInputs, nativeInputs, bundleSha256: hash, oracleInputsSha256: hash,
      build: { profile: id, revision: spec.revision, profileSha256: hash, registrySha256: hash, nodeModulesModified: false, globalPrototypePatched: false },
      bundleInspection: { status: 'passed', bundleSha256: hash, stages: [{}, {}], nativeGrpcPackages: [], violations: [] },
      loaderResolution: { bundleIncluded: true, ...Object.fromEntries([['installed', spec.fixture], ['native', spec.nativeFixture]].map(([name, fixture]) => [name, {
        loaderEntry: `fixtures/${fixture}/node_modules/@grpc/proto-loader/build/src/index.js`,
        protobufEntry: `fixtures/${fixture}/node_modules/@grpc/proto-loader/node_modules/protobufjs/index.js`,
        loaderSha256: hash, protobufSha256: hash, protobufVersion: '7.6.6' }])) },
      schemaPaths: profile.schemas.map(item => item.path), sourcePaths: profile.files.map(item => item.path), nativeSchemaSummary,
      codecAudit: { calibration: { Function: 'EvalError', eval: 'EvalError' }, schemas: nativeSchemaSummary.map(schema => ({ path: schema.path,
        typeNames: [...schema.typeNames], first: Object.fromEntries(firstMethods.map(method => [method, [...schema.typeNames]])),
        reflected: [...schema.typeNames], methods: [...methods], namespaces: structuredClone(schema.namespaces), matrix: structuredClone(schema.matrix) })) },
      rejections: [['source-hash', profile.files], ['schema-hash', profile.schemas]].flatMap(([kind, inputs]) => inputs.map(input => ({ kind,
        path: input.path, originalSha256: hash, mutatedSha256: otherHash, code: 'WGA_SCHEMA_MISMATCH', outputCreated: false, installedUnchanged: true }))),
      application: { probe: structuredClone(applicationProbe), baseline: structuredClone(applicationProbe), independentCopies: true, prototypesUnchanged: true,
        sourceTreeUnchanged: true, includedIndependentInput: true, transformedIndependentInputs: 0, sourceTreeSha256: hash, baselineBundleSha256: hash,
        copiedPackageVersion: '7.6.6', precisionBoundary: { input: '9007199254740993', native: '9007199254740993',
          workerd: largeInteger, matchesNative: true, presetChangesBaseline: false } },
      closure, requests, receipts: [{ token: 'closure', accounting: closure.accounting }, ...requests].flatMap(value => value.accounting.fetches.map(fetch => ({
        ...fetch, token: value.token, requestSha256: hash, overlap: value.token.startsWith('parallel-') }))),
    });
  }
  return report;
}
function mutations(entries) {
  for (const [label, mutate] of entries) {
    const report = fixture(); mutate(report, report.profiles[0]);
    assert.throws(() => validateBootstrapCatalogReport(report), /WGA_EVIDENCE_INVALID/, label);
  }
}
test('EVIDENCE BOOT accepts the complete two-profile synthetic mutation baseline', () => {
  assert.equal(validateBootstrapCatalogReport(fixture()).profiles.length, 2);
});
test('EVIDENCE BOOT rejects missing installed provenance, runtime, profiles and cases', () => {
  mutations([
    ['source build', report => { report.sourceBuild = true; }],
    ['missing profile', report => { report.profiles.pop(); }],
    ['missing case', report => { report.cases.pop(); }],
    ['catalog case mismatch', report => { report.catalogCases[0].catalogMatch = false; }],
    ['missing source digest', report => { delete report.evidence[sources[0]]; }],
    ['cloud claim', report => { report.cloudflareTranslation = true; }],
    ['peer failure', report => { report.failures.push('unexpected'); }],
    ['unpinned revision', (_, row) => { row.revision++; }],
    ['changed native input', (_, row) => { row.nativeInputs[row.sourcePaths[0]] = otherHash; }],
    ['missing adapter build', (_, row) => { delete row.installedInputs['node_modules/@grpc/grpc-js/dist/build/index.cjs']; }],
    ['source oracle', (_, row) => { row.nativeSchemaSummary[0].protobufPath = 'src/protobuf/index.js'; }],
    ['invented loader protobuf pairing', (_, row) => { row.loaderResolution.installed.protobufEntry = 'src/protobuf/index.js'; }],
    ['loader protobuf not bundled', (_, row) => { row.loaderResolution.bundleIncluded = false; }],
    ['missing registry hash', (_, row) => { row.build.registrySha256 = ''; }],
    ['bundle differs', (_, row) => { row.bundleInspection.bundleSha256 = otherHash; }],
    ['native grpc survives', (_, row) => { row.bundleInspection.nativeGrpcPackages.push('@grpc/grpc-js'); }],
    ['runtime alive', (_, row) => { row.runtimeDisposed = false; }],
  ]);
});
test('EVIDENCE BOOT requires every fresh first codec, ordered reflection and native loader variant', () => {
  mutations([
    ['codegen allowed', (_, row) => { row.codecAudit.calibration.Function = 'unexpected-success'; }],
    ['missing schema', (_, row) => { row.codecAudit.schemas.pop(); }],
    ['missing first codec', (_, row) => { delete row.codecAudit.schemas[0].first.toObject; }],
    ['one type warmed instead of first', (_, row) => { row.codecAudit.schemas[0].first.decode.pop(); }],
    ['missing reflected type', (_, row) => { row.codecAudit.schemas[0].reflected.pop(); }],
    ['missing reflected service', (_, row) => { row.codecAudit.schemas[0].namespaces.pop(); }],
    ['missing delimited codec', (_, row) => { row.codecAudit.schemas[0].methods.splice(8, 1); }],
    ['changed enum value', (_, row) => { row.codecAudit.schemas[0].matrix[2].objectSha256 = otherHash; }],
    ['changed wire', (_, row) => { row.codecAudit.schemas[0].matrix[0].wireSha256 = otherHash; }],
    ['both matrices missing defaults', (_, row) => { row.nativeSchemaSummary[0].matrix.shift(); row.codecAudit.schemas[0].matrix.shift(); }],
    ['invented type', (_, row) => { row.nativeSchemaSummary[0].typeNames.push('.Invented'); }],
  ]);
});
test('EVIDENCE BOOT requires real isolated source/schema mutations and untouched independent app protobuf', () => {
  mutations([
    ['only schema mutation', (_, row) => { row.rejections = row.rejections.filter(value => value.kind !== 'source-hash'); }],
    ['mutation not applied', (_, row) => { row.rejections[0].mutatedSha256 = hash; }],
    ['build fallback emitted', (_, row) => { row.rejections[0].outputCreated = true; }],
    ['installed dependency edited', (_, row) => { row.rejections[0].installedUnchanged = false; }],
    ['same app protobuf copy', (_, row) => { row.application.independentCopies = false; }],
    ['app not bundled', (_, row) => { row.application.includedIndependentInput = false; }],
    ['app source transformed', (_, row) => { row.application.transformedIndependentInputs = 1; }],
    ['app behavior differs', (_, row) => { row.application.probe.wire[1] = 'changed'; }],
    ['global prototype changed', (_, row) => { row.application.prototypesUnchanged = false; }],
    ['app codegen unexpectedly works', (_, row) => { row.application.probe.codegen = row.application.baseline.codegen = 'unexpected-success'; }],
    ['precision mismatch hidden', (_, row) => { row.application.precisionBoundary.workerd = '9007199254740992'; }],
    ['precision comparison differs', (_, row) => { row.application.precisionBoundary.matchesNative = false; }],
  ]);
});
test('EVIDENCE BOOT requires common service closure and actual per-request IO/auth/Call isolation', () => {
  mutations([
    ['common GAX missing', (_, row) => { row.closure.gaxCopies.pop(); }],
    ['stub substituted', (_, row) => { row.closure.rows[0].grpcStub = false; }],
    ['operation wrong', (_, row) => { row.closure.rows[3].operations = 'operations/wrong'; }],
    ['IAM absent', (_, row) => { delete row.closure.rows[4].iam; }],
    ['status decoder absent', (_, row) => { row.closure.rows[3].statusCode = 0; }],
    ['different isolate', (_, row) => { row.requests[2].isolateId += 'other'; }],
    ['requests sequential', (_, row) => { row.requests[3].peakRequests = 1; }],
    ['peer overlap absent', (_, row) => { row.receipts.at(-1).overlap = false; }],
    ['auth crossed', (_, row) => { row.receipts.at(-1).tokenSha256 = otherHash; }],
    ['physical peer Call ID crossed', (_, row) => { row.receipts.at(-1).logicalCallId = 'different'; }],
    ['SDK result crossed', (_, row) => { row.requests[2].entity = row.requests[3].token; }],
    ['shared Call', (_, row) => { row.requests[3].accounting.calls[0].logicalCallId = row.requests[2].accounting.calls[0].logicalCallId; }],
    ['duplicate terminal', (_, row) => { row.requests[3].accounting.calls[0].terminal = 2; }],
    ['auth skipped', (_, row) => { row.requests[3].accounting.calls[0].auth = 0; }],
    ['extra Fetch', (_, row) => { row.requests[3].accounting.calls[0].fetch = 2; }],
    ['cleanup too late', (_, row) => { row.requests[3].accounting.beforeClose = false; }],
    ['active Call remains', (_, row) => { row.requests[3].accounting.resources.activeCalls = 1; }],
    ['asynchronous pump remains', (_, row) => { row.requests[3].accounting.calls[0].execution.activePumps = 1; }],
  ]);
});
