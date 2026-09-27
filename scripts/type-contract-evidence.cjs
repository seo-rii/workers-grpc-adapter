'use strict';
const assert = require('node:assert/strict');
const MODES = ['node16', 'nodenext', 'bundler'];
const RUNTIMES = ['native', 'replacement'];
const NEGATIVES = ['missing-mode', 'missing-mapping', 'numeric-timeout', 'numeric-send', 'numeric-receive', 'readonly-mode', 'readonly-timeout', 'readonly-mapping', 'readonly-resources', 'cloudflare-mapping'];
const SHA = /^[a-f0-9]{64}$/;
function validateTypeContractReport(report) {
    const need = (condition, message) => assert.ok(condition, 'Type contract evidence: ' + message);
    need(report?.status === 'passed' && report.graphPassed === true && report.dependencyProfilesMatch === true, 'installed dependency/type gate did not pass');
    need(report.results?.length === 6 && report.catalogCases?.length === 27, 'matrix cardinality');
    for (const runtime of RUNTIMES) for (const mode of MODES) {
        const rows = report.results.filter(row => row.runtime === runtime && row.mode === mode);
        need(rows.length === 1, `duplicate/missing ${runtime}/${mode}`);
        const row = rows[0];
        need(row.status === 'passed' && row.strict === true && row.skipLibCheck === false && row.diagnostics?.length === 0, `compiler contract ${runtime}/${mode}`);
        need(JSON.stringify(row.consumers) === JSON.stringify(['esm', 'commonjs']), 'both module forms required');
        const contracts = row.contracts;
        need(contracts?.installedPackage === true && contracts.rootAndDeep === true && contracts.sdkTupleKeyTransactionQuery === true && contracts.config === (runtime === 'replacement'), 'installed SDK/root/config/deep contracts');
        for (const field of ['directUnaryCallShapes', 'generatedUnaryCallShapes', 'directReadableCallShapes', 'generatedReadableCallShapes']) need(contracts[field] === 4, field);
        need(contracts.typedMessageInferredMetadataStatus === true && contracts.explicitMessageListener === true && contracts.explicitServiceErrorListener === true && contracts.upstreamEventEmitterFallbackPreserved === true, 'listener boundary');
        const ids = [{ node16: 'TYPE-001', nodenext: 'TYPE-002', bundler: 'TYPE-003' }[mode], 'TYPE-004', 'TYPE-005', 'TYPE-007', ...(runtime === 'replacement' ? ['TYPE-006'] : [])];
        for (const id of ids) {
            const cases = report.catalogCases.filter(item => item.id === id && item.runtime === runtime && item.mode === mode);
            need(cases.length === 1, `duplicate/missing ${id}/${runtime}/${mode}`);
            const item = cases[0];
            need(item.status === 'passed' && item.strict === true && item.skipLibCheck === false && item.diagnostics?.length === 0, `${id} compiler failed`);
            need(JSON.stringify(item.consumers) === JSON.stringify(['esm', 'commonjs']), `${id} module forms`);
            if (['TYPE-001', 'TYPE-002', 'TYPE-003'].includes(id)) need(JSON.stringify(item.checks) === JSON.stringify(['installed-root-and-deep', 'sdk-tuple-key-transaction-query', ...(runtime === 'replacement' ? ['adapter-config'] : [])]), `${id} SDK contracts`);
            if (id === 'TYPE-004' || id === 'TYPE-005') need(item.directCallShapes === 4 && item.generatedCallShapes === 4, `${id} call shapes`);
            if (id === 'TYPE-004') need(item.invalidCallsRejected === true, 'unary negatives');
            if (id === 'TYPE-005') need(item.typedMessageInferredMetadataStatus === true && item.explicitMessageListener === true && item.explicitServiceErrorListener === true && item.cancel === true && item.upstreamBoundary === 'EventEmitter permits fallback listener signatures; message/error listeners are explicitly annotated, metadata/status inferred', 'readable listener/cancel contract');
            if (id === 'TYPE-006') {
                need(item.rejectedCases?.length === NEGATIVES.length, 'configuration negatives cardinality');
                for (const name of NEGATIVES) {
                    const witnesses = item.rejectedCases.filter(x => x.name === name);
                    need(witnesses.length === 1 && Number.isSafeInteger(witnesses[0].line) && witnesses[0].codes.length > 0, `missing negative ${name}`);
                    for (const code of witnesses[0].codes) need([2322, 2345, 2540, 2542].includes(code), `unexpected diagnostic for ${name}`);
                }
                need(item.negativeDiagnostics?.length === item.rejectedCases.reduce((count, witness) => count + witness.codes.length, 0), 'negative diagnostic count');
                for (const diagnostic of item.negativeDiagnostics) need(diagnostic.file === 'types/negative-config.cts' && item.rejectedCases.some(witness => witness.line === diagnostic.line && witness.codes.includes(diagnostic.code)), 'unmatched negative diagnostic');
            }
            if (id === 'TYPE-007') {
                need(JSON.stringify(item.declarations) === JSON.stringify(['Datastore', 'DeepClient', 'Server', 'ServerCredentials', 'ServerMethodDefinition']), 'supported server declaration contract');
                need(item.emitted?.length === 2 && new Set(item.emitted.map(x => x.file)).size === 2, 'two emitted server modules required');
                need(item.emitted.some(x => x.file === 'serverOnly.mjs') && item.emitted.some(x => x.file === 'serverOnly.cjs'), 'ESM/CommonJS emission required');
                for (const emitted of item.emitted) need(emitted.path === `verification/type-contracts/${runtime}/${mode}/${emitted.file}` && report.generatedArtifacts?.[emitted.path] === emitted.sha256 && emitted.runtimeImports === 0 && emitted.sentinelPreserved === true && SHA.test(emitted.sha256), 'type-only server runtime erasure');
                need(item.scope === 'Supported root server type surface, not native server handler implementation parity', 'server type scope');
            }
        }
    }
    need(Object.keys(report.generatedArtifacts || {}).length === 15, 'generated artifact cardinality');
    for (const [file, hash] of Object.entries(report.generatedArtifacts)) need(/^verification\/type-contracts\//.test(file) && !file.split('/').includes('..') && SHA.test(hash), 'generated artifact path/hash');
    const generated = report.generatedClient;
    need(generated?.package === '@grpc/proto-loader' && /^\d+\.\d+\.\d+$/.test(generated.version), 'pinned generated client identity');
    for (const field of ['sourceSha256', 'protoSha256', 'fullServiceSha256', 'clientSha256', 'messageSha256']) need(SHA.test(generated[field]), `generated ${field}`);
    for (const prefix of ['fullService', 'client', 'message']) need(report.generatedArtifacts[generated[prefix + 'Path']] === generated[prefix + 'Sha256'], 'generated artifact identity ' + prefix);
    need(generated.extraction === 'Original import nodes and EchoClient interface, without textual type rewrites or assertions', 'generated extraction boundary');
    need(generated.excluded === 'Native server handler and service definition interfaces are outside this client consumer contract', 'generated server boundary');
    for (const name of ['scripts/test-sdk-types.cjs', 'fixtures/google/types/consumer.mts', 'fixtures/interop/echo.proto', ...['sdk', 'rpc', 'config', 'server-only'].map(name => `test/types-catalog-${name}.cts`)]) need(SHA.test(report.evidence?.[name]), `source provenance ${name}`);
    need(generated.protoSha256 === report.evidence['fixtures/interop/echo.proto'], 'proto hash mismatch');
    need(generated.sourceSha256 === report.installedInputs?.['fixtures/native/node_modules/@grpc/proto-loader/build/bin/proto-loader-gen-types.js'], 'generator hash mismatch');
    for (const [file, hash] of Object.entries(report.installedInputs || {})) need(/^fixtures\/(native|google)\//.test(file) && !file.split('/').includes('..') && SHA.test(hash), 'invalid installed provenance');
    for (const fixture of ['native', 'google']) {
        for (const suffix of ['package.json', 'package-lock.json', 'node_modules/@grpc/grpc-js/package.json']) need(SHA.test(report.installedInputs[`fixtures/${fixture}/${suffix}`]), `installed package ${fixture}/${suffix}`);
        need(Object.keys(report.installedInputs).some(file => file.startsWith(`fixtures/${fixture}/node_modules/@grpc/grpc-js/`) && file.endsWith('.d.ts')), `resolved installed grpc declarations ${fixture}`);
        for (const sdk of ['datastore', 'firestore', 'secret-manager']) need(Object.keys(report.installedInputs).some(file => file.startsWith(`fixtures/${fixture}/node_modules/@google-cloud/${sdk}/`) && file.endsWith('.d.ts')), `resolved installed SDK declarations ${fixture}/${sdk}`);
    }
    return true;
}
module.exports = { validateTypeContractReport };
