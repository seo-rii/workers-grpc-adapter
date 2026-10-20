'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

function fixture(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-create-require-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    const file = write('node_modules/sdk/index.mjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'module.exports = { tag: "local" };');
    return { root, file, write, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const [name, setup] of [
    ['default node:module import', 'import Module from "node:module"; const require = Module.createRequire(import.meta.url);'],
    ['default module import', 'import Module from "module"; const require = Module.createRequire(import.meta.url);'],
    ['named default module import', 'import { default as Module } from "node:module"; const require = Module.createRequire(import.meta.url);'],
    ['combined default and named import', 'import Module, { createRequire } from "node:module"; const require = Module.createRequire(import.meta.url);'],
    ['parenthesized named factory', 'import { createRequire } from "node:module"; const require = (createRequire)(import.meta.url);'],
    ['nested parentheses around an imported alias', 'import { createRequire as make } from "node:module"; const require = ((make))(import.meta.url);'],
    ['parenthesized factory call', 'import { createRequire } from "node:module"; const require = (createRequire(import.meta.url));'],
    ['nested parentheses around a factory call', 'import { createRequire } from "node:module"; const require = (((createRequire)(import.meta.url)));'],
    ['parenthesized namespace factory', 'import * as Module from "node:module"; const require = (Module.createRequire)(import.meta.url);'],
    ['parenthesized namespace object', 'import * as Module from "node:module"; const require = (Module).createRequire(import.meta.url);'],
    ['nested parentheses around a default factory', 'import Module from "node:module"; const require = (((Module).createRequire))(import.meta.url);'],
    ['direct named factory control', 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'],
    ['direct namespace factory control', 'import * as Module from "node:module"; const require = Module.createRequire(import.meta.url);'],
]) {
    test(`DOCTOR recognizes a ${name}`, async t => {
        const source = `${setup} export function run() { return require("@grpc/grpc-js/missing"); }`;
        const f = fixture(t, source);
        const module = await import(pathToFileURL(f.file).href);
        assert.throws(() => module.run(), { code: 'MODULE_NOT_FOUND' });
        assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: '@grpc/grpc-js/missing' }]);
        const report = f.inspect();
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.status),
            ['resolution-failed']);
    });
}

for (const [name, setup] of [
    ['default namespace parameter', 'import Module from "node:module"; function run(Module) { const require = Module.createRequire(import.meta.url); require("@grpc/grpc-js/missing"); }'],
    ['default namespace block binding', 'import Module from "node:module"; { const Module = {}; const require = Module.createRequire(import.meta.url); require("@grpc/grpc-js/missing"); }'],
    ['parenthesized factory parameter', 'import { createRequire } from "node:module"; function run(createRequire) { const require = ((createRequire))(import.meta.url); require("@grpc/grpc-js/missing"); }'],
    ['parenthesized namespace parameter', 'import Module from "node:module"; function run(Module) { const require = ((Module).createRequire)(import.meta.url); require("@grpc/grpc-js/missing"); }'],
    ['default import from an unrelated package', 'import Module from "example-module"; const require = Module.createRequire(import.meta.url); require("@grpc/grpc-js/missing");'],
    ['arbitrary factory alias', 'import { createRequire } from "node:module"; const make = createRequire; const require = (make)(import.meta.url); require("@grpc/grpc-js/missing");'],
    ['computed factory property', 'import Module from "node:module"; const require = Module["createRequire"](import.meta.url); require("@grpc/grpc-js/missing");'],
    ['comma expression callee', 'import { createRequire } from "node:module"; const require = (0, createRequire)(import.meta.url); require("@grpc/grpc-js/missing");'],
    ['comma expression result', 'import { createRequire } from "node:module"; const require = (createRequire(import.meta.url), other); require("@grpc/grpc-js/missing");'],
    ['conditional expression result', 'import { createRequire } from "node:module"; const require = (createRequire(import.meta.url) || other); require("@grpc/grpc-js/missing");'],
]) {
    test(`DOCTOR ignores an unproven loader from a ${name}`, t => {
        assert.deepEqual(literalImports(setup), []);
        assert.equal(fixture(t, setup).inspect().passed, true);
    });
}

for (const [name, setup] of [
    ['default namespace', 'import Module from "node:module"; const require = Module.createRequire(BASE);'],
    ['parenthesized named factory', 'import { createRequire } from "node:module"; const require = ((createRequire))(BASE);'],
    ['parenthesized namespace factory', 'import Module from "node:module"; const require = ((Module).createRequire)(BASE);'],
]) {
    test(`DOCTOR preserves a foreign createRequire base for a ${name}`, async t => {
        const f = fixture(t, '');
        const foreign = path.join(f.root, 'foreign/loader.cjs');
        const source = `${setup.replace('BASE', JSON.stringify(foreign))} export function run() { return require("@grpc/grpc-js"); }`;
        f.write('node_modules/sdk/index.mjs', source);
        f.write('foreign/node_modules/@grpc/grpc-js/package.json', { name: '@grpc/grpc-js', version: '1.0.0', main: 'index.cjs' });
        f.write('foreign/node_modules/@grpc/grpc-js/index.cjs', 'module.exports = { tag: "foreign" };');
        const module = await import(pathToFileURL(f.file).href);
        assert.equal(module.run().tag, 'foreign');
        const report = f.inspect();
        assert.equal(report.passed, false);
        const imported = report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports[0];
        assert.equal(imported.implementation, '@grpc/grpc-js');
        assert.equal(imported.resolved, 'foreign/node_modules/@grpc/grpc-js/index.cjs');
    });
    test(`DOCTOR fails closed on an unproven base for a ${name}`, t => {
        const source = `${setup.replace('BASE', 'base')} require("@grpc/grpc-js");`;
        const report = fixture(t, source).inspect();
        assert.equal(report.passed, false);
        assert.equal(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports[0].status,
            'resolution-base-unverified');
    });
}
