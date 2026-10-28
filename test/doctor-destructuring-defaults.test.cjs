'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)})`;
const site = { kind: 'require', specifier: missing };
const outerCases = [
    ['shorthand default', `const {x = true ? 1 : require} = {}; ${load};`],
    ['aliased default', `const {x: y = true ? 1 : require} = {}; ${load};`],
    ['nested conditional', `const {x = false ? require : true ? 1 : require} = {}; ${load};`],
    ['nested object', `const {outer: {x = true ? 1 : require} = {}} = {}; ${load};`],
    ['object inside array', `const [{x = true ? 1 : require} = {}] = []; ${load};`],
    ['computed property', `const {['x']: y = true ? 1 : require} = {}; ${load};`],
    ['quoted property', `const {'x': y = true ? 1 : require} = {}; ${load};`],
    ['multiple properties', `const {x = true ? 1 : require, y = false ? require : 2} = {}; ${load};`],
    ['function parameter', `function run({x = true ? 1 : require} = {}) { ${load}; } run();`],
    ['arrow parameter', `(({x = true ? 1 : require} = {}) => ${load})();`],
    ['catch parameter', `try { throw {}; } catch ({x = true ? 1 : require}) { ${load}; }`],
    ['iteration binding', `for (const {x = true ? 1 : require} of [{}]) ${load};`],
    ['parenthesized control', `const {x = (true ? 1 : require)} = {}; ${load};`],
    ['default containing a load', `const {x = true ? ${load} : 1} = {};`],
];
for (const [name, source] of outerCases) test(`DOCTOR keeps the outer require in a ${name}`, () => {
    const calls = [];
    vm.runInNewContext(source, { require(specifier) { calls.push(specifier); return 3; } }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
});

for (const [name, source] of [
    ['shorthand', `const {require = true ? x => x : () => 0} = {}; ${load};`],
    ['alias', `const {x: require = true ? x => x : () => 0} = {}; ${load};`],
    ['nested alias', `const {x: {y: require = true ? x => x : () => 0} = {}} = {}; ${load};`],
    ['array alias', `const [{x: require = true ? x => x : () => 0} = {}] = []; ${load};`],
    ['parameter alias', `function run({x: require = true ? x => x : () => 0} = {}) { ${load}; } run();`],
    ...['=', ',', ':'].flatMap(key => [
        [`quoted ${key} key`, `const {${JSON.stringify(key)}: require} = {${JSON.stringify(key)}: x => x}; ${load};`],
        [`quoted ${key} default`, `const {${JSON.stringify(key)}: require = x => x} = {}; ${load};`],
        [`quoted ${key} parameter`, `function run({${JSON.stringify(key)}: require = x => x} = {}) { ${load}; } run();`],
        [`quoted ${key} nested key`, `const {outer: {${JSON.stringify(key)}: require = x => x} = {}} = {}; ${load};`],
    ]),
]) test(`DOCTOR retains actual require shadowing in a ${name} default`, () => {
    const calls = [];
    vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, []);
    assert.deepEqual(literalImports(source), []);
});

for (const name of ['shorthand default', 'function parameter']) test(`DOCTOR API and built CLI reject a missing import after ${name}`, t => {
    const source = outerCases.find(([entry]) => entry === name)[1];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-default-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function write(file, contents) {
        const full = path.join(root, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', "require('@grpc/grpc-js');");
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    const runtime = spawnSync(process.execPath, [path.join(root, 'node_modules/sdk/index.cjs')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(runtime.status, 1);
    assert.match(runtime.stderr, /MODULE_NOT_FOUND/);
    const report = inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
    assert.equal(report.passed, false);
    assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/build/doctor-cli.cjs'), root, '--sdk=sdk'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(cli.status, 2, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).passed, false);
});
