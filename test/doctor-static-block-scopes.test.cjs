'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

for (const definition of [
    'class Example { static { var require = () => 1; require("@grpc/grpc-js/local"); } }',
    'const Example = class { static { var require = () => 1; } };',
    'class Example { static { var require; } }',
    'class Example { static { { var require = () => 1; } } }',
    'class Example { static { var { loader: require } = { loader: () => 1 }; } }',
    'class Example { static { var require = () => 1; } static { var require = () => 2; } }',
    'class Example extends (class Base { static { var require = () => 1; } }) { static { var require = () => 2; } }',
    'class Example { field = { nested: class { static { var require = () => 1; } } }; }',
]) test(`DOCTOR contains var bindings in static blocks: ${definition}`, () => {
    const source = `(function () { ${definition} return require("@grpc/grpc-js/missing"); })();`;
    const calls = [];
    vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, ['@grpc/grpc-js/missing']);
    assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: '@grpc/grpc-js/missing' }]);
});

test('DOCTOR keeps a genuine CommonJS loader inside a static block', () => {
    assert.deepEqual(literalImports('class Example { static { require("@grpc/grpc-js/inside"); } }'), [
        { kind: 'require', specifier: '@grpc/grpc-js/inside' },
    ]);
    assert.deepEqual(literalImports('import { createRequire } from "node:module"; class Example { static { var require = createRequire(import.meta.url); require("@grpc/grpc-js/inside"); } }'), [
        { kind: 'require', specifier: '@grpc/grpc-js/inside' },
    ]);
});

test('DOCTOR preserves ordinary function/block var shadowing', () => {
    assert.deepEqual(literalImports('(function () { { var require = () => 1; } return require("@grpc/grpc-js/local"); })();'), []);
    assert.deepEqual(literalImports('class Example { static run() { var require = () => 1; require("@grpc/grpc-js/local"); } } require("@grpc/grpc-js/outside");'), [
        { kind: 'require', specifier: '@grpc/grpc-js/outside' },
    ]);
});

test('DOCTOR API and CLI reject an unresolved loader outside the class static block', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-static-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', 'class Example { static { var require = () => 1; require("@grpc/grpc-js/local"); } } require("@grpc/grpc-js/missing");');
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_CODE_MUST_NOT_RUN");');
    const report = inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
    assert.equal(report.passed, false);
    assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports.map(item => item.specifier), ['@grpc/grpc-js/missing']);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../src/build/doctor-cli.cjs'), root, '--sdk=sdk'], { encoding: 'utf8' });
    assert.equal(cli.status, 2, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).passed, false);
});
