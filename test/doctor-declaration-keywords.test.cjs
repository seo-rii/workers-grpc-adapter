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

const expressions = ['"in"', '"of"', 'object.in', 'object.of', '"x" in object', 'of'];
const setup = 'const object = { x: 1, in: 1, of: 1 }; const of = 1;';
const missing = '@grpc/grpc-js/missing';

for (const declaration of ['const', 'let', 'var']) for (const expression of expressions) {
    test(`DOCTOR retains ${declaration} bindings after initializer ${expression}`, () => {
        for (const initializer of [`(${expression})`, expression]) {
            const source = `(function () { ${setup} ${declaration} selected = ${initializer}, require = () => 'local';
                return require('${missing}'); })();`;
            const calls = [];
            assert.equal(vm.runInNewContext(source, { require: name => calls.push(name) }), 'local');
            assert.deepEqual(calls, []);
            assert.deepEqual(literalImports(source), []);
        }
    });
}

for (const declaration of ['const', 'let', 'var']) {
    test(`DOCTOR accepts ${declaration} binding named of before a local require`, () => {
        const source = `(function () { ${declaration} of = 1, require = () => 'local'; return require('${missing}'); })();`;
        assert.equal(vm.runInNewContext(source), 'local');
        assert.deepEqual(literalImports(source), []);
    });
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-declarations-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', type: 'module', main: 'index.mjs', dependencies: { 'google-gax': '*' } });
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'exports.identity = "replacement";');
    write('node_modules/sdk/native/base.mjs', '');
    write('node_modules/sdk/native/node_modules/@grpc/grpc-js/package.json', { name: '@grpc/grpc-js', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/sdk/native/node_modules/@grpc/grpc-js/index.cjs', 'exports.identity = "native";');
    return { root, write, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const expression of expressions) {
    test(`DOCTOR preserves createRequire base after initializer ${expression}`, t => {
        const f = fixture(t);
        const source = `import { createRequire } from 'node:module'; ${setup}
            const selected = ${expression}, require = createRequire(new URL('./native/base.mjs', import.meta.url));
            console.log(require('@grpc/grpc-js').identity);`;
        const file = f.write('node_modules/sdk/index.mjs', source);
        const native = spawnSync(process.execPath, [file], { encoding: 'utf8' });
        assert.equal(native.status, 0, native.stderr);
        assert.equal(native.stdout.trim(), 'native');
        const report = f.inspect();
        const imported = report.results[0].graph.find(item => item.name === 'sdk').grpcImports;
        assert.equal(report.passed, false, 'the native implementation must not be mistaken for the root replacement');
        assert.equal(imported.length, 1);
        assert.equal(imported[0].status, 'wrong-implementation');
        assert.equal(imported[0].implementation, '@grpc/grpc-js');
        assert.equal(imported[0].resolved, 'node_modules/sdk/native/node_modules/@grpc/grpc-js/index.cjs');
        if (expression === '"of"') {
            const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../src/build/doctor-cli.cjs'), f.root, '--sdk=sdk'], { encoding: 'utf8' });
            assert.equal(cli.status, 2, cli.stderr);
            assert.equal(JSON.parse(cli.stdout).passed, false);
        }
    });
}

test('DOCTOR API and CLI accept a local require after an in initializer', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.mjs', `${setup} const selected = 'x' in object, require = () => 'local'; require('${missing}');`);
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports, []);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../src/build/doctor-cli.cjs'), f.root, '--sdk=sdk'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).passed, true);
});

for (const [name, loop] of [
    ['for-in', 'for (const require in {}) ;'],
    ['for-of', 'for (const require of []) ;'],
    ['for-await-of', 'for await (const require of []) ;'],
    ['binding named of', 'for (const of of [1]) require("@grpc/grpc-js/inside");'],
    ['var for-in', 'var require = () => "local"; for (var require in {}) ;'],
]) test(`DOCTOR retains ${name} scope boundaries`, async () => {
    const local = name === 'var for-in';
    const source = `(async () => { ${loop} return require('${missing}'); })();`;
    const calls = [];
    await vm.runInNewContext(source, { require: value => { calls.push(value); return 'outer'; } });
    const expected = local ? [] : name === 'binding named of' ? ['@grpc/grpc-js/inside', missing] : [missing];
    assert.deepEqual(calls, expected);
    assert.deepEqual(literalImports(source), expected.map(specifier => ({ kind: 'require', specifier })));
});

for (const expression of ['"in"', '"of"', 'object.in', 'object.of', '("x" in object)', 'of']) {
    test(`DOCTOR retains classic for declaration after initializer ${expression}`, () => {
        const source = `(function () { ${setup} for (let selected = ${expression}, require = () => 'local'; selected; selected = 0)
            require('@grpc/grpc-js/local'); return require('${missing}'); })();`;
        const calls = [];
        assert.equal(vm.runInNewContext(source, { require: name => { calls.push(name); return 'outer'; } }), 'outer');
        assert.deepEqual(calls, [missing]);
        assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: missing }]);
    });
}

for (const initializer of ['function () { return "local"; }', 'object.of']) {
    test(`DOCTOR retains an Annex B var for-in initializer ${initializer}`, () => {
        const source = `(function () { const object = { of: () => 'local' };
            for (var require = ${initializer} in {}) ; return require('${missing}'); })();`;
        const calls = [];
        assert.equal(vm.runInNewContext(source, { require: name => calls.push(name) }), 'local');
        assert.deepEqual(calls, []);
        assert.deepEqual(literalImports(source), []);
    });
}

test('DOCTOR keeps the real loader after an Annex B var for-in initializer', () => {
    const source = `(function () { const object = { x: 1 }; for (var name = 'x' in object) ; return require('${missing}'); })();`;
    const calls = [];
    vm.runInNewContext(source, { require: name => calls.push(name) });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: missing }]);
});

for (const target of ['let', 'let.field']) for (const block of [false, true]) {
    test(`DOCTOR keeps contextual let for-in target ${target} block=${block}`, () => {
        for (const wrapped of [true, false]) {
            const body = `require('${missing}');`;
            const source = `(function () { var let = {}; const object = {}; for (${target} in ${wrapped ? '(object, require)' : 'object, require'})
                ${block ? `{ ${body} }` : body} })();`;
            const calls = [];
            const require = Object.assign(name => calls.push(name), { entry: true });
            vm.runInNewContext(source, { require });
            assert.deepEqual(calls, [missing]);
            assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: missing }]);
        }
    });
}

test('DOCTOR keeps contextual let in a classic for expression initializer', () => {
    const source = `(function () { var let = {}; var done = false;
        for (let instanceof Object, require; !done; done = true) require('${missing}'); })();`;
    const calls = [];
    vm.runInNewContext(source, { require: name => calls.push(name) });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: missing }]);
});
