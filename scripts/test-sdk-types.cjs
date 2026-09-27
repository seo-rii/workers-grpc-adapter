'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { toolchain } = require('./toolchain.cjs');
const { inspect } = require('./doctor.cjs');
const { validateTypeContractReport } = require('./type-contract-evidence.cjs');
const root = path.resolve(__dirname, '..');
const { ts, typeRoots, nodeTypes } = toolchain();
const source = fs.readFileSync(path.join(root, 'fixtures/google/types/consumer.mts'));
const common = { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], strict: true, skipLibCheck: false, esModuleInterop: true, noEmit: true, types: ['node'], typeRoots };
const results = [];
const catalogCases = [];
const evidence = {};
const installedInputs = {};
const generatedArtifacts = {};
const artifactRoot = path.join(root, 'verification/type-contracts');
fs.rmSync(artifactRoot, { recursive: true, force: true });
fs.mkdirSync(artifactRoot, { recursive: true });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, file).split(path.sep).join('/');
function artifact(name, content) {
    const file = path.join(artifactRoot, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
    generatedArtifacts[relative(file)] = hash(content); return relative(file);
}
for (const name of ['scripts/test-sdk-types.cjs', 'fixtures/google/types/consumer.mts', 'fixtures/interop/echo.proto',
    ...['sdk', 'rpc', 'config', 'server-only'].map(name => `test/types-catalog-${name}.cts`)]) evidence[name] = hash(fs.readFileSync(path.join(root, name)));
const generator = path.join(root, 'fixtures/native/node_modules/@grpc/proto-loader/build/bin/proto-loader-gen-types.js');
installedInputs[relative(generator)] = hash(fs.readFileSync(generator));
const generation = fs.mkdtempSync(path.join(root, 'fixtures/native/.types-generator-'));
let generated;
try {
    cp.execFileSync(process.execPath, [generator, '--grpcLib=@grpc/grpc-js', '--defaults', '--importFileExtension=.js', '--outDir=' + generation, 'fixtures/interop/echo.proto'], { cwd: root, stdio: 'pipe' });
    const original = fs.readFileSync(path.join(generation, 'demo/Echo.ts'), 'utf8');
    const parsed = ts.createSourceFile('Echo.ts', original, ts.ScriptTarget.Latest, true);
    const clientNodes = parsed.statements.filter(node => ts.isImportDeclaration(node) || (ts.isInterfaceDeclaration(node) && node.name.text === 'EchoClient'));
    assert.equal(clientNodes.filter(ts.isInterfaceDeclaration).length, 1, 'Generator must emit exactly one EchoClient interface');
    const client = clientNodes.map(node => node.getFullText(parsed)).join('\n') + '\n';
    const message = fs.readFileSync(path.join(generation, 'demo/Message.ts'), 'utf8');
    generated = { client, message, report: { package: '@grpc/proto-loader', version: require(path.join(root, 'fixtures/native/node_modules/@grpc/proto-loader/package.json')).version,
        sourceSha256: hash(fs.readFileSync(generator)), protoSha256: evidence['fixtures/interop/echo.proto'], fullServiceSha256: hash(original), fullServicePath: artifact('generated/Echo.full.d.ts', original),
        clientSha256: hash(client), clientPath: artifact('generated/Echo.client.d.ts', client), messageSha256: hash(message), messagePath: artifact('generated/Message.d.ts', message),
        extraction: 'Original import nodes and EchoClient interface, without textual type rewrites or assertions',
        excluded: 'Native server handler and service definition interfaces are outside this client consumer contract' } };
} finally { fs.rmSync(generation, { recursive: true, force: true }); }
function diagnosticsFor(program, fixture) {
    return ts.getPreEmitDiagnostics(program).map(item => ({ code: item.code, file: item.file ? path.relative(fixture, item.file.fileName).replace(/\.types-[^/]+\//, 'types/') : null,
        line: item.file && item.start !== undefined ? item.file.getLineAndCharacterOfPosition(item.start).line + 1 : null,
        message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }));
}
function recordInstalled(program, fixture) {
    for (const source of program.getSourceFiles()) {
        if (source.fileName.startsWith(path.join(fixture, 'node_modules') + path.sep)) installedInputs[relative(source.fileName)] = hash(fs.readFileSync(source.fileName));
    }
    for (const name of ['package.json', 'package-lock.json', 'node_modules/@grpc/grpc-js/package.json']) {
        const file = path.join(fixture, name); installedInputs[relative(file)] = hash(fs.readFileSync(file));
    }
}

for (const runtime of ['native', 'replacement']) {
    const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
    const temporary = fs.mkdtempSync(path.join(fixture, '.types-'));
    try {
        fs.mkdirSync(path.join(temporary, 'generated/demo'), { recursive: true });
        fs.writeFileSync(path.join(temporary, 'generated/package.json'), JSON.stringify({ type: 'commonjs' }));
        fs.writeFileSync(path.join(temporary, 'generated/demo/Echo.ts'), generated.client);
        fs.writeFileSync(path.join(temporary, 'generated/demo/Message.ts'), generated.message);
        const sources = { consumer: source.toString(), sdk: fs.readFileSync(path.join(root, 'test/types-catalog-sdk.cts'), 'utf8'),
            rpc: fs.readFileSync(path.join(root, 'test/types-catalog-rpc.cts'), 'utf8'),
            serverOnly: fs.readFileSync(path.join(root, 'test/types-catalog-server-only.cts'), 'utf8'),
            ...(runtime === 'replacement' ? { config: fs.readFileSync(path.join(root, 'test/types-catalog-config.cts'), 'utf8') } : {}) };
        const files = Object.entries(sources).flatMap(([name, content]) => ['mts', 'cts'].map(extension => {
            const destination = path.join(temporary, `${name}.${extension}`);
            fs.writeFileSync(destination, name === 'consumer' && extension === 'cts' ? content.replace('@grpc/grpc-js/build/src/client.js', '@grpc/grpc-js/build/src/client') : content);
            return destination;
        }));
        let expectedNegatives = [];
        if (runtime === 'replacement') {
            const negativeSource = sources.config.replace(/@ts-expect-error/g, 'catalog-expected-error');
            const negative = path.join(temporary, 'negative-config.cts'); fs.writeFileSync(negative, negativeSource); files.push(negative);
            expectedNegatives = [...negativeSource.matchAll(/catalog-negative:([a-z-]+)/g)].map(match => ({ name: match[1], line: negativeSource.slice(0, match.index).split('\n').length + 1 }));
        }
        for (const [mode, module, moduleResolution] of [['node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], ['nodenext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
            const program = ts.createProgram(files, { ...common, module, moduleResolution, noEmit: false, outDir: path.join(temporary, 'emitted-' + mode) });
            const allDiagnostics = diagnosticsFor(program, fixture);
            const negativeDiagnostics = allDiagnostics.filter(item => item.file === 'types/negative-config.cts');
            const details = allDiagnostics.filter(item => item.file !== 'types/negative-config.cts');
            recordInstalled(program, fixture);
            const passed = details.length === 0;
            results.push({ runtime, mode, status: passed ? 'passed' : 'failed', diagnostics: details, strict: true, skipLibCheck: false, consumers: ['esm', 'commonjs'],
                contracts: { installedPackage: true, rootAndDeep: true, config: runtime === 'replacement', sdkTupleKeyTransactionQuery: true,
                    directUnaryCallShapes: 4, generatedUnaryCallShapes: 4, directReadableCallShapes: 4, generatedReadableCallShapes: 4,
                    typedMessageInferredMetadataStatus: true, explicitMessageListener: true, explicitServiceErrorListener: true, upstreamEventEmitterFallbackPreserved: true } });
            const caseBase = { runtime, mode, status: passed ? 'passed' : 'failed', strict: true, skipLibCheck: false, consumers: ['esm', 'commonjs'], diagnostics: details };
            const modeCase = { node16: 'TYPE-001', nodenext: 'TYPE-002', bundler: 'TYPE-003' }[mode];
            catalogCases.push({ ...caseBase, id: modeCase, checks: ['installed-root-and-deep', 'sdk-tuple-key-transaction-query', ...(runtime === 'replacement' ? ['adapter-config'] : [])] });
            catalogCases.push({ ...caseBase, id: 'TYPE-004', directCallShapes: 4, generatedCallShapes: 4, invalidCallsRejected: true });
            catalogCases.push({ ...caseBase, id: 'TYPE-005', directCallShapes: 4, generatedCallShapes: 4, typedMessageInferredMetadataStatus: true, explicitMessageListener: true, explicitServiceErrorListener: true, cancel: true,
                upstreamBoundary: 'EventEmitter permits fallback listener signatures; message/error listeners are explicitly annotated, metadata/status inferred' });
            if (runtime === 'replacement') {
                const witnesses = expectedNegatives.map(item => ({ ...item, codes: negativeDiagnostics.filter(d => d.file === 'types/negative-config.cts' && d.line === item.line).map(d => d.code) }));
                const rejected = witnesses.every(item => item.codes.length > 0) && negativeDiagnostics.every(d => d.file === 'types/negative-config.cts' && witnesses.some(item => item.line === d.line));
                catalogCases.push({ ...caseBase, id: 'TYPE-006', status: passed && rejected ? 'passed' : 'failed', rejectedCases: witnesses, negativeDiagnostics });
            }
            const emitted = [];
            const serverDiagnostics = details;
            const writeEmitted = (file, text) => {
                if (!/\.[mc]?js$/.test(file)) return;
                const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
                let runtimeImports = 0;
                function visit(node) {
                    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
                        (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword))) runtimeImports++;
                    ts.forEachChild(node, visit);
                }
                visit(ast);
                emitted.push({ file: path.basename(file), path: artifact(`${runtime}/${mode}/${path.basename(file)}`, text), sha256: hash(text), runtimeImports, sentinelPreserved: text.includes('server-types-erased') });
            };
            const emits = files.filter(file => /serverOnly\.[mc]ts$/.test(file)).map(file => program.emit(program.getSourceFile(file), writeEmitted));
            catalogCases.push({ ...caseBase, id: 'TYPE-007', status: passed && !serverDiagnostics.length && emits.every(result => !result.emitSkipped && !result.diagnostics.length) && emitted.length === 2 && emitted.every(item => item.runtimeImports === 0 && item.sentinelPreserved) ? 'passed' : 'failed',
                declarations: ['Datastore', 'DeepClient', 'Server', 'ServerCredentials', 'ServerMethodDefinition'], emitted, diagnostics: serverDiagnostics,
                scope: 'Supported root server type surface, not native server handler implementation parity' });
        }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
// The native oracle and replacement use the same official Google Auth release.
// Its internal token implementation avoids gtoken 8's broken Node16 declarations.
// Every compiler diagnostic is now a failure, including a regression to TS1479.
const dependencyProfiles = [];
for (const [runtime, fixtureName, expected] of [['native', 'native', '@grpc/grpc-js'], ['replacement', 'google', 'workers-grpc-adapter']]) {
    const fixture = path.join(root, 'fixtures', fixtureName);
    const graph = inspect(fixture, undefined, expected);
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json')));
    const authPackages = [...new Map(graph.results.flatMap(item => item.graph || []).filter(item => item.name === 'google-auth-library').map(item => [item.path, { path: item.path, version: item.version, integrity: item.integrity }])).values()];
    const override = manifest.overrides?.['google-auth-library@10.5.0'];
    dependencyProfiles.push({ runtime, graphPassed: graph.passed, googleAuthOverride: { 'google-auth-library@10.5.0': override }, googleAuth: authPackages, officialReleasePinned: typeof override === 'string' && /^\d+\.\d+\.\d+$/.test(override) && authPackages.some(item => item.version === override) && authPackages.every(item => item.version !== '10.5.0' && item.integrity) });
}
const graphPassed = dependencyProfiles.every(item => item.graphPassed && item.officialReleasePinned);
const authIdentities = dependencyProfiles.map(item => [...new Set(item.googleAuth.map(pkg => `${pkg.version}:${pkg.integrity}`))].sort());
const dependencyProfilesMatch = JSON.stringify(dependencyProfiles[0].googleAuthOverride) === JSON.stringify(dependencyProfiles[1].googleAuthOverride) && JSON.stringify(authIdentities[0]) === JSON.stringify(authIdentities[1]);
const failed = !graphPassed || !dependencyProfilesMatch || results.some(item => item.status === 'failed') || catalogCases.some(item => item.status !== 'passed');
const report = { scope: 'installed real Google SDK declarations and identical root/deep grpc-js ESM/CommonJS consumers', runtime: process.version, typescript: ts.version, nodeTypes: JSON.parse(fs.readFileSync(nodeTypes)).version, graphPassed, dependencyProfilesMatch, dependencyProfiles, generatedClient: generated.report, generatedArtifacts, evidence, installedInputs, catalogCases, status: failed ? 'failed' : 'passed', results };
if (!failed) validateTypeContractReport(report);
fs.mkdirSync(path.join(root, 'compatibility'), { recursive: true });
fs.writeFileSync(path.join(root, 'compatibility/google-types.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, installedInputs: { count: Object.keys(installedInputs).length } }, null, 2));
process.exitCode = failed ? 1 : 0;
