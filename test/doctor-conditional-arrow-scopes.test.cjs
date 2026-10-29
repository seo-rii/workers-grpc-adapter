'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)})`;
const site = { kind: 'require', specifier: missing };
const outerCases = [
    ['single parameter', `const result = false ? require => 0 : ${load};`],
    ['parenthesized parameter', `const result = false ? (require) => 0 : ${load};`],
    ['destructured parameter', `const result = false ? ({require}) => 0 : ${load};`],
    ['async arrow', `const result = false ? async require => 0 : ${load};`],
    ['inner conditional', `const result = false ? require => true ? 1 : 2 : ${load};`],
    ['nested arrows', `const result = false ? require => () => 0 : ${load};`],
    ['nested arrow in inner conditional', `const result = false ? require => true ? value => value : 2 : ${load};`],
    ['conditional arrow in inner alternate', `const result = false ? require => false ? 0 : value => value : ${load};`],
    ['object body', `const result = false ? require => ({value: 1}) : ${load};`],
    ['array element', `const result = [false ? require => 0 : ${load}];`],
    ['object value', `const result = {value: false ? require => 0 : ${load}};`],
    ['line break', `const result = false ? require => 0\n: ${load};`],
    ['parenthesized arrow control', `const result = false ? (require => 0) : ${load};`],
    ['block arrow control', `const result = false ? require => {} : ${load};`],
    ['unshadowed parameter control', `const result = false ? value => 0 : ${load};`],
    ['alternate arrow control', `const result = true ? ${load} : require => 0;`],
];
for (const [name, source] of outerCases) test(`DOCTOR keeps the outer loader after conditional ${name}`, () => {
    const calls = [];
    vm.runInNewContext(`(function(require) { ${source} })(require);`, {
        require(specifier) { calls.push(specifier); return 3; },
    }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
});

for (const [name, expression] of [
    ['consequent', `true ? ${load} : 0`],
    ['alternate', `false ? 0 : ${load}`],
    ['nested conditional', `false ? 0 : true ? ${load} : 0`],
    ['nested arrow consequent', `true ? (() => ${load})() : 0`],
    ['nested arrow alternate', `false ? 0 : (() => ${load})()`],
    ['arrow body with conditional', `(() => false ? 0 : ${load})()`],
    ['object property', `({value: ${load}}).value`],
    ['conditional across lines', `true\n? ${load}\n: 0`],
    ['literal question mark', `'?' ? ${load} : 0`],
    ['literal colon', `':' ? ${load} : 0`],
    ['nested arrows in branches', `(true ? () => ${load} : () => 0)()`],
]) test(`DOCTOR preserves the local arrow loader in its ${name}`, () => {
    const source = `const run = require => ${expression}; run(value => value);`;
    const calls = [];
    const result = vm.runInNewContext(`(function(require) { ${source} })(require);`, {
        require(specifier) { calls.push(specifier); },
    }, { timeout: 1000 });
    assert.equal(result, undefined);
    assert.deepEqual(calls, []);
    assert.deepEqual(literalImports(source), []);
});

test('DOCTOR API and CLI reject missing imports after conditional arrows', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-conditional-arrow-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    for (const [name, source] of outerCases.slice(0, 12)) {
        const file = write('node_modules/sdk/index.cjs', source);
        const runtime = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 10000 });
        assert.equal(runtime.status, 1, name);
        assert.match(runtime.stderr, /MODULE_NOT_FOUND/, name);
        const report = inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
        assert.equal(report.passed, false, name);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(entry => entry.status), ['resolution-failed']);
        const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/build/doctor-cli.cjs'), root, '--sdk=sdk'], {
            encoding: 'utf8', timeout: 10000,
        });
        assert.equal(cli.status, 2, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).passed, false);
    }
});
