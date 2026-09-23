'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { toolchain } = require('./toolchain.cjs');
const { inspect } = require('./doctor.cjs');
const root = path.resolve(__dirname, '..');
const { ts, typeRoots, nodeTypes } = toolchain();
const source = fs.readFileSync(path.join(root, 'fixtures/google/types/consumer.mts'));
const common = { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], strict: true, skipLibCheck: false, esModuleInterop: true, noEmit: true, types: ['node'], typeRoots };
const results = [];
for (const runtime of ['native', 'replacement']) {
    const fixture = path.join(root, 'fixtures', runtime === 'native' ? 'native' : 'google');
    const temporary = fs.mkdtempSync(path.join(fixture, '.types-'));
    try {
        const files = ['consumer.mts', 'consumer.cts'].map(file => {
            const destination = path.join(temporary, file);
            fs.writeFileSync(destination, file.endsWith('.cts') ? source.toString().replace('@grpc/grpc-js/build/src/client.js', '@grpc/grpc-js/build/src/client') : source);
            return destination;
        });
        for (const [mode, module, moduleResolution] of [['node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], ['nodenext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
            const program = ts.createProgram(files, { ...common, module, moduleResolution });
            const diagnostics = ts.getPreEmitDiagnostics(program);
            const details = diagnostics.map(item => ({ code: item.code, file: item.file ? path.relative(fixture, item.file.fileName).replace(/\.types-[^/]+\//, 'types/') : null, message: ts.flattenDiagnosticMessageText(item.messageText, '\n') }));
            results.push({ runtime, mode, status: diagnostics.length ? 'failed' : 'passed', diagnostics: details, strict: true, skipLibCheck: false, consumers: ['esm', 'commonjs'] });
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
const failed = !graphPassed || !dependencyProfilesMatch || results.some(item => item.status === 'failed');
const report = { scope: 'installed real Google SDK declarations and identical root/deep grpc-js ESM/CommonJS consumers', runtime: process.version, typescript: ts.version, nodeTypes: JSON.parse(fs.readFileSync(nodeTypes)).version, graphPassed, dependencyProfilesMatch, dependencyProfiles, status: failed ? 'failed' : 'passed', results };
fs.mkdirSync(path.join(root, 'compatibility'), { recursive: true });
fs.writeFileSync(path.join(root, 'compatibility/google-types.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = failed ? 1 : 0;
