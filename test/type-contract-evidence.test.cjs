'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateTypeContractReport } = require('../scripts/type-contract-evidence.cjs');
function fixture() {
    const sha = 'a'.repeat(64);
    const report = { status: 'passed', graphPassed: true, dependencyProfilesMatch: true, results: [], catalogCases: [], evidence: {}, installedInputs: {}, generatedArtifacts: {},
        generatedClient: { package: '@grpc/proto-loader', version: '0.8.0', sourceSha256: sha, protoSha256: sha, fullServiceSha256: sha, clientSha256: sha, messageSha256: sha,
            extraction: 'Original import nodes and EchoClient interface, without textual type rewrites or assertions', excluded: 'Native server handler and service definition interfaces are outside this client consumer contract' } };
    for (const [prefix, name] of [['fullService', 'Echo.full.d.ts'], ['client', 'Echo.client.d.ts'], ['message', 'Message.d.ts']]) {
        const path = 'verification/type-contracts/generated/' + name; report.generatedClient[prefix + 'Path'] = path; report.generatedArtifacts[path] = sha;
    }
    for (const name of ['scripts/test-sdk-types.cjs', 'fixtures/google/types/consumer.mts', 'fixtures/interop/echo.proto', ...['sdk', 'rpc', 'config', 'server-only'].map(name => `test/types-catalog-${name}.cts`)]) report.evidence[name] = sha;
    report.installedInputs['fixtures/native/node_modules/@grpc/proto-loader/build/bin/proto-loader-gen-types.js'] = sha;
    for (const folder of ['native', 'google']) {
        for (const suffix of ['package.json', 'package-lock.json', 'node_modules/@grpc/grpc-js/package.json', 'node_modules/@grpc/grpc-js/index.d.ts', ...['datastore', 'firestore', 'secret-manager'].map(sdk => `node_modules/@google-cloud/${sdk}/index.d.ts`)]) report.installedInputs[`fixtures/${folder}/${suffix}`] = sha;
    }
    for (const runtime of ['native', 'replacement']) for (const mode of ['node16', 'nodenext', 'bundler']) {
        const base = { runtime, mode, status: 'passed', strict: true, skipLibCheck: false, consumers: ['esm', 'commonjs'], diagnostics: [] };
        report.results.push({ ...base, contracts: { installedPackage: true, rootAndDeep: true, config: runtime === 'replacement', sdkTupleKeyTransactionQuery: true,
            directUnaryCallShapes: 4, generatedUnaryCallShapes: 4, directReadableCallShapes: 4, generatedReadableCallShapes: 4,
            typedMessageInferredMetadataStatus: true, explicitMessageListener: true, explicitServiceErrorListener: true, upstreamEventEmitterFallbackPreserved: true } });
        report.catalogCases.push({ ...base, id: { node16: 'TYPE-001', nodenext: 'TYPE-002', bundler: 'TYPE-003' }[mode], checks: ['installed-root-and-deep', 'sdk-tuple-key-transaction-query', ...(runtime === 'replacement' ? ['adapter-config'] : [])] });
        report.catalogCases.push({ ...base, id: 'TYPE-004', directCallShapes: 4, generatedCallShapes: 4, invalidCallsRejected: true });
        report.catalogCases.push({ ...base, id: 'TYPE-005', directCallShapes: 4, generatedCallShapes: 4, typedMessageInferredMetadataStatus: true, explicitMessageListener: true, explicitServiceErrorListener: true, cancel: true,
            upstreamBoundary: 'EventEmitter permits fallback listener signatures; message/error listeners are explicitly annotated, metadata/status inferred' });
        report.catalogCases.push({ ...base, id: 'TYPE-007', declarations: ['Datastore', 'DeepClient', 'Server', 'ServerCredentials', 'ServerMethodDefinition'],
            emitted: ['serverOnly.mjs', 'serverOnly.cjs'].map(file => { const path = `verification/type-contracts/${runtime}/${mode}/${file}`; report.generatedArtifacts[path] = sha; return { file, path, sha256: sha, runtimeImports: 0, sentinelPreserved: true }; }), scope: 'Supported root server type surface, not native server handler implementation parity' });
        if (runtime === 'replacement') {
            const names = ['missing-mode', 'missing-mapping', 'numeric-timeout', 'numeric-send', 'numeric-receive', 'readonly-mode', 'readonly-timeout', 'readonly-mapping', 'readonly-resources', 'cloudflare-mapping'];
            report.catalogCases.push({ ...base, id: 'TYPE-006', rejectedCases: names.map((name, index) => ({ name, line: index + 1, codes: [2322] })),
                negativeDiagnostics: names.map((name, index) => ({ file: 'types/negative-config.cts', line: index + 1, code: 2322 })) });
        }
    }
    return report;
}
test('type catalog evidence requires every installed compiler/module/case combination', () => {
    assert.equal(validateTypeContractReport(fixture()), true);
    for (const mutate of [
        report => report.results.pop(),
        report => report.results[0] = report.results[1],
        report => report.results[0].skipLibCheck = true,
        report => report.results[0].consumers.pop(),
        report => report.results[0].contracts.generatedUnaryCallShapes = 3,
        report => report.catalogCases.pop(),
        report => report.catalogCases[0] = report.catalogCases[1],
        report => report.catalogCases.find(x => x.id === 'TYPE-004').invalidCallsRejected = false,
        report => report.catalogCases.find(x => x.id === 'TYPE-005').typedMessageInferredMetadataStatus = false,
        report => report.catalogCases.find(x => x.id === 'TYPE-006').rejectedCases.pop(),
        report => report.catalogCases.find(x => x.id === 'TYPE-006').rejectedCases[0].codes = [],
        report => report.catalogCases.find(x => x.id === 'TYPE-006').negativeDiagnostics[0].code = 2307,
        report => report.catalogCases.find(x => x.id === 'TYPE-007').emitted[0].runtimeImports = 1,
        report => report.catalogCases.find(x => x.id === 'TYPE-007').emitted[0].file = 'serverOnly.cjs',
        report => report.catalogCases.find(x => x.id === 'TYPE-007').emitted[0].sentinelPreserved = false,
        report => report.generatedClient.protoSha256 = 'b'.repeat(64),
        report => report.generatedClient.sourceSha256 = 'b'.repeat(64),
        report => report.generatedClient.clientSha256 = 'missing',
        report => report.generatedClient.clientSha256 = 'b'.repeat(64),
        report => report.catalogCases.find(x => x.id === 'TYPE-007').emitted[0].sha256 = 'b'.repeat(64),
        report => delete report.generatedArtifacts[report.generatedClient.messagePath],
        report => delete report.evidence['test/types-catalog-rpc.cts'],
        report => delete report.installedInputs['fixtures/native/node_modules/@grpc/grpc-js/index.d.ts'],
        report => report.installedInputs['../outside.d.ts'] = 'a'.repeat(64),
    ]) {
        const report = fixture(); mutate(report);
        assert.throws(() => validateTypeContractReport(report), /Type contract evidence/);
    }
});
