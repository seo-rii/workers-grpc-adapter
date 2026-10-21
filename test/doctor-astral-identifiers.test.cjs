'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../dist/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)});`;
const site = { kind: 'require', specifier: missing };
function fixture(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-identifier-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const full = path.join(root, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
        return full;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.mjs', dependencies: { 'google-gax': '*' } });
    const full = write('node_modules/sdk/index.mjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    return { full, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const alias of ['𐐀', 'factory𐐀', 'factory𝟘', '\\u{10400}', 'λ', 'factory\u200c𐐀', 'factory\u200d𐐀']) {
    for (const [form, source] of [
        ['named', `import {createRequire as ${alias}} from "node:module"; const require=${alias}(import.meta.url); ${load}`],
        ['namespace', `import * as ${alias} from "node:module"; const require=${alias}.createRequire(import.meta.url); ${load}`],
        ['default', `import ${alias} from "node:module"; const require=(${alias}.createRequire)(import.meta.url); ${load}`],
    ]) test(`DOCTOR preserves ${form} createRequire provenance for identifier ${alias}`, t => {
        assert.deepEqual(literalImports(source), [site]);
        const f = fixture(t, source);
        const syntax = spawnSync(process.execPath, ['--check', f.full], { encoding: 'utf8' });
        assert.equal(syntax.status, 0, syntax.stderr);
        const actual = spawnSync(process.execPath, [f.full], { encoding: 'utf8' });
        assert.equal(actual.status, 1);
        assert.match(actual.stderr, /MODULE_NOT_FOUND/);
        const report = f.inspect();
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports, [{
            file: 'node_modules/sdk/index.mjs', kind: 'require', specifier: missing, status: 'resolution-failed',
        }]);
    });
}

for (const alias of ['𐐀', 'factory𝟘', 'λ', 'factory\u200c𐐀']) {
    test(`DOCTOR keeps local ${alias} factory shadows outside loader inspection`, t => {
        const source = `import {createRequire as ${alias}} from "node:module";
            function run(${alias}) { const require=${alias}(import.meta.url); return require(${JSON.stringify(missing)}); }
            if (run(() => () => 42) !== 42) throw new Error("CONTROL_NOT_EXECUTED");`;
        assert.deepEqual(literalImports(source), []);
        const f = fixture(t, source);
        const actual = spawnSync(process.execPath, [f.full], { encoding: 'utf8' });
        assert.equal(actual.status, 0, actual.stderr);
        assert.equal(f.inspect().passed, true);
    });
}

test('DOCTOR keeps astral identifiers whole beside property calls, templates and regexes', () => {
    for (const source of [
        `const 𐐀require=()=>42; 𐐀require(${JSON.stringify(missing)});`,
        `const 𐐀={require:()=>42}; 𐐀.require(${JSON.stringify(missing)});`,
        `const pattern=/[𐐀require("@grpc/grpc-js/missing")]/u;`,
        `const value=\`𐐀require("@grpc/grpc-js/missing")\`;`,
    ]) {
        vm.runInNewContext(source, {}, { timeout: 1000 });
        assert.deepEqual(literalImports(source), []);
    }
});

test('DOCTOR handles long astral factory names without splitting or losing the following loader', () => {
    const alias = `factory${'𐐀'.repeat(4096)}`;
    const source = `import {createRequire as ${alias}} from "node:module"; const require=${alias}(import.meta.url); ${load}`;
    assert.deepEqual(literalImports(source), [site]);
});
