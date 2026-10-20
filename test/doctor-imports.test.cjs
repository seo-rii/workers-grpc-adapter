'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

function fixture(t, source, extension = 'cjs') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-imports-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const write = (relative, value) => {
        const file = path.join(directory, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/example-sdk/package.json', { name: 'example-sdk', version: '1.0.0', dependencies: { 'google-gax': '1.0.0' } });
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '1.0.0' } });
    write('node_modules/google-gax/index.js', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.js' });
    write('node_modules/@grpc/grpc-js/index.js', 'throw new Error("INSPECTED_MODULE_MUST_NOT_EXECUTE");');
    const file = `node_modules/example-sdk/index.${extension}`;
    write(file, source);
    const report = inspectGoogleWorkerGraph({ projectRoot: directory, sdks: ['example-sdk'] });
    return { report, imports: report.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.file === file) };
}

for (const [name, source, kind = 'require', extension = 'cjs'] of [
    ['comment-separated require', 'require(/* loader */ "@grpc/grpc-js/missing");'],
    ['static template require', 'require(`@grpc/grpc-js/missing`);'],
    ['escaped module string', String.raw`require('\x40grpc/gr\u0070c-js/missing');`],
    ['line continuation', "require('@grpc/\\\ngrpc-js/missing');"],
    ['optional require call', 'require?.("@grpc/grpc-js/missing");'],
    ['parenthesized require', '(require)("@grpc/grpc-js/missing");'],
    ['division expression', 'const n = 12 / (require("@grpc/grpc-js/missing"), 2);'],
    ['division after a function expression', 'const n = function () {} / require("@grpc/grpc-js/missing");'],
    ['template expression', 'const value = `raw require("ignore") ${require("@grpc/grpc-js/missing")}`;'],
    ['nested template expression', 'const value = `${`nested ${require("@grpc/grpc-js/missing")}`}`;'],
    ['dynamic import', 'import(/* loader */ `@grpc/grpc-js/missing`);', 'import'],
    ['static import', 'import { Client } from /* module */ "@grpc/grpc-js/missing";', 'import', 'mjs'],
    ['default import named from', 'import from from "@grpc/grpc-js/missing";', 'import', 'mjs'],
    ['static re-export', 'export { Client } from /* module */ "@grpc/grpc-js/missing";', 'import', 'mjs'],
    ['namespace re-export', 'export * as grpc from /* module */ "@grpc/grpc-js/missing";', 'import', 'mjs'],
    ['createRequire import', 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); require("@grpc/grpc-js/missing");', 'require', 'mjs'],
    ['aliased createRequire import', 'import { createRequire as makeRequire } from "node:module"; const require = makeRequire(import.meta.url); require("@grpc/grpc-js/missing");', 'require', 'mjs'],
    ['namespace createRequire import', 'import * as module from "node:module"; const require = module.createRequire(import.meta.url); require("@grpc/grpc-js/missing");', 'require', 'mjs'],
    ['nonbinding property in a parameter', 'function run({ require: other }) { require("@grpc/grpc-js/missing"); }'],
    ['outer require after a shadowed block', '{ let require = () => 1; require("ignored"); } require("@grpc/grpc-js/missing");'],
    ['outer require after a shadowed arrow', 'const run = require => require("ignored"); require("@grpc/grpc-js/missing");'],
    ['uninitialized wrapper var redeclaration', 'var require; require("@grpc/grpc-js/missing");'],
    ['comma expression after implicit semicolon', 'const value = 1\nrequire("@grpc/grpc-js/missing"), require("@grpc/grpc-js/missing");'],
]) {
    test(`DOCTOR recognizes ${name}`, t => {
        const { report, imports } = fixture(t, source, extension);
        assert.equal(report.passed, false);
        assert.deepEqual(imports.map(item => [item.kind, item.specifier, item.status]),
            [[kind, '@grpc/grpc-js/missing', 'resolution-failed']]);
    });
}

for (const [name, source, extension = 'cjs'] of [
    ['line comment', '// require("@grpc/grpc-js/missing")\nmodule.exports = {};'],
    ['block comment', '/* import("@grpc/grpc-js/missing") */ module.exports = {};'],
    ['quoted source text', `const source = 'require("@grpc/grpc-js/missing")';`],
    ['template raw text', 'const source = `require("@grpc/grpc-js/missing")`;'],
    ['regex literal', 'const pattern = /[require("@grpc/grpc-js/missing")]/;'],
    ['regex after a control condition', 'if (true) /[require("@grpc/grpc-js/missing")]/.test("");'],
    ['property require', 'const api = { require() {} }; api.require("@grpc/grpc-js/missing");'],
    ['optional property require', 'const api = { require() {} }; api?.require("@grpc/grpc-js/missing");'],
    ['function parameter', 'function run(require) { require("@grpc/grpc-js/missing"); }'],
    ['destructured parameter', 'function run({ loader: require }) { require("@grpc/grpc-js/missing"); }'],
    ['array parameter', 'function run([require]) { require("@grpc/grpc-js/missing"); }'],
    ['arrow parameter', 'const run = require => require("@grpc/grpc-js/missing");'],
    ['arrow destructured parameter', 'const run = ({ loader: require }) => require("@grpc/grpc-js/missing");'],
    ['method parameter', 'const api = { run(require) { require("@grpc/grpc-js/missing"); } };'],
    ['block binding', '{ const require = () => 1; require("@grpc/grpc-js/missing"); }'],
    ['function var binding', 'function run() { var require = () => 1; require("@grpc/grpc-js/missing"); }'],
    ['catch binding', 'try { throw () => 1; } catch (require) { require("@grpc/grpc-js/missing"); }'],
    ['named function expression', 'const run = function require() { require("@grpc/grpc-js/missing"); };'],
    ['require binding hoisted from a later declaration', 'function run() { require("@grpc/grpc-js/missing"); var require; }'],
    ['ordinary object from property', 'const value = { from: "@grpc/grpc-js/missing" };'],
    ['shadowed createRequire factory', 'import { createRequire } from "node:module"; function run(createRequire) { const require = createRequire(); require("@grpc/grpc-js/missing"); }', 'mjs'],
    ['shadowed aliased createRequire factory', 'import { createRequire as cr } from "node:module"; function run(cr) { const require = cr(); require("@grpc/grpc-js/missing"); }', 'mjs'],
    ['shadowed createRequire namespace', 'import * as module from "node:module"; function run(module) { const require = module.createRequire(); require("@grpc/grpc-js/missing"); }', 'mjs'],
]) {
    test(`DOCTOR ignores ${name}`, t => {
        const { report, imports } = fixture(t, source, extension);
        assert.equal(report.passed, true);
        assert.deepEqual(imports, []);
    });
}

for (const extension of ['d.ts', 'd.cts', 'd.mts']) {
    test(`DOCTOR recognizes commented and escaped .${extension} declarations without loading TypeScript`, t => {
        const load = Module._load;
        Module._load = function (id, ...args) {
            assert.notEqual(id, 'typescript', 'Graph-only inspection keeps the compiler optional');
            return load.call(this, id, ...args);
        };
        try {
            const { report, imports } = fixture(t, String.raw`
                /* import("@grpc/grpc-js/ignored") */
                export { Client } from /* module */ '\x40grpc/grpc-js/missing';
                import grpc = require(/* module */ '@grpc/grpc-js/missing');
                type Other = import(/* module */ '@grpc/grpc-js/missing').Client;
            `, extension);
            assert.equal(report.passed, false);
            assert.deepEqual(imports.map(item => [item.kind, item.specifier]), [['declaration', '@grpc/grpc-js/missing']]);
        } finally { Module._load = load; }
    });
}
