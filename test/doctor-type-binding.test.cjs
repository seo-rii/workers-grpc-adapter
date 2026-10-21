'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)})`;
const site = { kind: 'require', specifier: missing };
function fixture(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-type-binding-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.mjs', dependencies: { 'google-gax': '*' } });
    const file = write('node_modules/sdk/index.mjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'module.exports = {};');
    return { file, write, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const builtin of ['node:module', 'module']) for (const [name, clause, namespace] of [
    ['default type binding', 'type', 'type'],
    ['escaped default type binding', 't\\u0079pe', 'type'],
    ['combined default and named binding', 'type, { createRequire }', 'type'],
    ['combined default and namespace binding', 'type, * as Module', 'type'],
    ['ordinary default binding control', 'Module', 'Module'],
    ['named default binding control', '{ default as type }', 'type'],
]) {
    test(`DOCTOR tracks ${name} from ${builtin}`, async t => {
        const source = `import ${clause} from ${JSON.stringify(builtin)}; const require = ${namespace}.createRequire(import.meta.url); export function run() { return ${load}; }`;
        const f = fixture(t, source);
        const native = await import(pathToFileURL(f.file).href);
        assert.throws(() => native.run(), { code: 'MODULE_NOT_FOUND' });
        assert.deepEqual(literalImports(source, false, { sourceType: 'module' }), [site]);
        const report = f.inspect();
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
    });
}

for (const [name, source] of [
    ['parameter', `import type from "node:module"; export function run(type) { const require = type.createRequire(import.meta.url); return ${load}; }`],
    ['block binding', `import type from "node:module"; export function run(local) { const type = local; const require = type.createRequire(import.meta.url); return ${load}; }`],
    ['unrelated module', `import type from "./local.mjs"; export function run() { const require = type.createRequire(import.meta.url); return ${load}; }`],
]) {
    test(`DOCTOR keeps an ordinary type ${name} outside loader provenance`, async t => {
        const f = fixture(t, source);
        f.write('node_modules/sdk/local.mjs', 'export default { createRequire: () => () => 7 };');
        const native = await import(pathToFileURL(f.file).href);
        assert.equal(native.run({ createRequire: () => () => 7 }), 7);
        assert.deepEqual(literalImports(source, false, { sourceType: 'module' }), []);
        assert.equal(f.inspect().passed, true);
    });
}

for (const clause of ['type Client', 'type { Client }', 'type * as grpc']) {
    test(`DOCTOR retains declaration package checks for import ${clause}`, t => {
        const source = `import ${clause} from ${JSON.stringify(missing)}; export {};`;
        assert.deepEqual(literalImports(source, true, { sourceType: 'module' }), [{ kind: 'declaration', specifier: missing }]);
        const f = fixture(t, 'export {};');
        f.write('node_modules/sdk/index.d.mts', source);
        const report = f.inspect();
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => [item.kind, item.status]), [['declaration', 'resolution-failed']]);
    });
}
