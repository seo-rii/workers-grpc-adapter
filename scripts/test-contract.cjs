'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const { inventory } = require('./export-inventory.cjs');
const { inspectConsumerImports } = require('./consumer-imports.cjs');
const { reviewExports, compactInventory, checkReviewedSnapshot, reviewConsumerImports } = require('./export-contract.cjs');
const { inspect: inspectGraph } = require('./doctor.cjs');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function main() {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || args.length === 1 && args[0] === '--update', 'Usage: test-contract.cjs [--update]');
    const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
    const upstream = nativeRequire('@grpc/grpc-js');
    const adapter = require('../dist/index.js');
    const checkedFiles = new Set();
    function inspect(file) {
        if (checkedFiles.has(file)) return;
        checkedFiles.add(file);
        const text = fs.readFileSync(file, 'utf8');
        for (const [, specifier] of text.matchAll(/require\(["']([^"']+)["']\)/g)) {
            assert.ok(!/^(?:node:)?(?:http2|tls|net|dns)$/.test(specifier), `native transport in ${path.relative(root, file)}`);
            if (specifier.startsWith('.')) inspect(require.resolve(path.resolve(path.dirname(file), specifier)));
            else assert.ok(specifier.startsWith('node:') || ['buffer', 'events', 'stream', 'util', 'assert'].includes(specifier), `unexpected runtime dependency ${specifier}`);
        }
    }
    const identities = [];
    for (const [name, entry] of Object.entries(pkg.exports)) {
        if (typeof entry === 'string') continue;
        // This opt-in Node build tool is intentionally outside the Worker graph.
        if (name === './build') continue;
        const cjs = require(path.join(root, entry.require));
        const esm = await import(pathToFileURL(path.join(root, entry.import)).href);
        for (const key of Object.keys(cjs)) assert.strictEqual(esm[key], cjs[key], `${name}/${key}`);
        identities.push({ entry: name, exports: Object.keys(cjs).sort(), status: 'passed' });
        inspect(path.join(root, entry.require));
    }
    assert.strictEqual(require('../dist/client.js').Client, adapter.Client);
    for (const name of ['Client', 'Metadata', 'Channel', 'credentials', 'InterceptingCall', 'ListenerBuilder', 'RequesterBuilder', 'StatusBuilder', 'makeGenericClientConstructor', 'loadPackageDefinition']) {
        assert.equal(typeof adapter[name], typeof upstream[name], name);
    }
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/export-policy.json'), 'utf8'));
    const upstreamPackage = nativeRequire('@grpc/grpc-js/package.json');
    assert.equal(upstreamPackage.version, policy.upstream.version, 'installed upstream must match reviewed pin');
    const nativeRoot = path.dirname(nativeRequire.resolve('@grpc/grpc-js/package.json'));
    const nativeApi = inventory({ entry: path.join(nativeRoot, upstreamPackage.types), packageRoot: nativeRoot });
    const adapterApi = inventory({ entry: path.join(root, pkg.types), packageRoot: root });
    const subpaths = new Map(), subpathRuntime = new Map(), typeFiles = new Map();
    for (const [entry, target] of Object.entries(pkg.exports)) {
        if (entry === '.' || typeof target === 'string') continue;
        assert.equal(typeof target.types, 'string', `${entry} must declare its type entry`);
        if (!typeFiles.has(target.types)) typeFiles.set(target.types,
            inventory({ entry: path.join(root, target.types), packageRoot: root }));
        const api = typeFiles.get(target.types);
        subpathRuntime.set(entry, Object.keys(require(path.join(root, target.require))));
        subpaths.set(entry, api);
    }
    const classifications = reviewExports({ policy, upstream: nativeApi, adapter: adapterApi,
        upstreamRuntime: Object.keys(upstream), adapterRuntime: Object.keys(adapter), extensions: [...subpaths.keys()],
        subpaths, subpathRuntime });
    const consumers = [];
    for (const fixture of ['google', 'modern', 'native', 'modern-native']) {
        const base = path.join(root, 'fixtures', fixture);
        const expected = fixture.includes('native') ? '@grpc/grpc-js' : pkg.name;
        const graph = inspectGraph(base, undefined, expected);
        assert.equal(graph.passed, true, `${fixture} dependency graph resolution`);
        const files = new Map();
        for (const result of graph.results) for (const item of result.graph) for (const imported of item.grpcImports) {
            if (!files.has(imported.file)) files.set(imported.file, new Map());
            files.get(imported.file).set(imported.specifier, imported);
        }
        const imports = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, resolutions]) => {
            const bytes = fs.readFileSync(path.join(base, file));
            const records = reviewConsumerImports(inspectConsumerImports(bytes.toString('utf8'), file), policy, subpaths);
            assert.ok(records.length > 0, `no AST imports inventoried for ${fixture}/${file}`);
            for (const record of records) assert.ok(resolutions.has(record.specifier), `unresolved AST import ${file}:${record.specifier}`);
            return { file, sha256: hash(bytes), records, resolutions: [...resolutions.values()] };
        });
        consumers.push({ fixture, status: 'passed', imports });
    }
    const snapshot = { schemaVersion: 1, upstream: policy.upstream,
        root: { native: compactInventory(nativeApi), adapter: compactInventory(adapterApi) },
        subpaths: Object.fromEntries([...subpaths].map(([entry, api]) => [entry, compactInventory(api)])),
        consumers: consumers.map(({ fixture, imports }) => ({ fixture,
            imports: imports.map(({ file, records }) => ({ file, records })) })) };
    const snapshotPath = path.join(root, 'compatibility/public-api.snapshot.json');
    if (args[0] === '--update') fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
    else checkReviewedSnapshot(JSON.parse(fs.readFileSync(snapshotPath, 'utf8')), snapshot);
    const grades = Object.fromEntries(['S', 'I', 'T', 'U'].map(grade => [grade, classifications.filter(item => item.grade === grade).length]));
    const catalogCases = [{ id: 'PKG-013', status: 'passed', policyChecked: true, snapshotChecked: args.length === 0,
        rootNames: classifications.length, upstreamNames: nativeApi.exports.length, adapterNames: adapterApi.exports.length,
        grades, publicTypeSubpaths: subpaths.size, consumerFixtures: consumers.length,
        consumerFiles: consumers.reduce((n, item) => n + item.imports.length, 0),
        unresolvedNamespaceAccess: consumers.flatMap(item => item.imports).flatMap(item => item.records).filter(item => item.dynamicAccess).length,
        fullNativeExportParity: false, exhaustiveConsumerMemberAnalysis: false }];
    const report = { status: 'passed', upstream: { version: nativeRequire('@grpc/grpc-js/package.json').version,
        exports: Object.keys(upstream).sort() }, adapter: { version: pkg.version, exports: Object.keys(adapter).sort() },
        missingNativeExports: Object.keys(upstream).filter(key => !(key in adapter)).sort(),
        fullNativeExportParity: false, identities, catalogCases, classifications, consumers,
        policySha256: hash(fs.readFileSync(path.join(root, 'compatibility/export-policy.json'))),
        snapshotSha256: hash(fs.readFileSync(snapshotPath)),
        declarationSources: { upstream: nativeApi.sources, adapter: adapterApi.sources,
            subpaths: Object.fromEntries([...subpaths].map(([entry, api]) => [entry, api.sources])) },
        runtimeClosure: [...checkedFiles].sort().map(file => ({
            file: path.relative(root, file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        })) };
    fs.writeFileSync(path.join(root, 'compatibility/exports-contract.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, runtimeFiles: checkedFiles.size, entrypoints: identities.length, catalogCases }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
