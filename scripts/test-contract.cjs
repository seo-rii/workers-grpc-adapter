'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
async function main() {
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
    const report = { status: 'passed', upstream: { version: nativeRequire('@grpc/grpc-js/package.json').version,
        exports: Object.keys(upstream).sort() }, adapter: { version: pkg.version, exports: Object.keys(adapter).sort() },
        missingNativeExports: Object.keys(upstream).filter(key => !(key in adapter)).sort(),
        fullNativeExportParity: false, identities, runtimeClosure: [...checkedFiles].sort().map(file => ({
            file: path.relative(root, file), sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        })) };
    fs.writeFileSync(path.join(root, 'compatibility/exports-contract.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, runtimeFiles: checkedFiles.size, entrypoints: identities.length }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
