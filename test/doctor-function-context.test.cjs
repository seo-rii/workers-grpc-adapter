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
function inspect(t, source, extension = 'cjs') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-function-context-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: `index.${extension}`, dependencies: { 'google-gax': '*' } });
    write(`node_modules/sdk/index.${extension}`, source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    return inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
}

for (const [name, setup, call] of [
    ['ordinary call', 'const noop = () => {};', 'noop(require)'],
    ['property call', 'const object = { noop() {} };', 'object.noop(require)'],
    ['optional call', 'const noop = () => {};', 'noop?.(require)'],
    ['computed call', 'const object = { noop() {} };', 'object["noop"](require)'],
    ['catch property call', 'const object = { catch() {} };', 'object.catch(require)'],
    ['for property call', 'const object = { for() {} };', 'object.for(require)'],
    ['function property call', 'const object = { function() {} };', 'object.function(require)'],
    ['optional function property call', 'const object = { function() {} };', 'object?.function(require)'],
    ['optional call of function property', 'const object = { function() {} };', 'object.function?.(require)'],
    ['computed function property call', 'const object = { function() {} };', 'object["function"](require)'],
    ['constructor call', 'function Noop() {}', 'new Noop(require)'],
    ['parenthesized call', '', '(function () {})(require)'],
]) for (const separator of ['\n', ';\n']) {
    test(`DOCTOR preserves the outer loader after ${name} and ${JSON.stringify(separator)}`, t => {
        const source = `(function () { ${setup} ${call}${separator}{ return ${load}; } })();`;
        const calls = [];
        vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, [missing]);
        assert.deepEqual(literalImports(source), [site]);
        const report = inspect(t, source);
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
    });
}

for (const name of ['if', 'while', 'for', 'with', 'switch', 'catch', 'function', 'return', 'method']) {
    for (const container of ['object', 'class']) {
        for (const modifier of ['', '*', 'async ', 'async *']) {
            test(`DOCTOR retains ${container} ${modifier}${name} method parameters`, async t => {
                const definition = `{ ${modifier}${name}(require) { return ${load}; } }`;
                const object = container === 'object' ? `(${definition})` : `(new (class ${definition}))`;
                const invoke = modifier.includes('*') ? '.next()' : '';
                const source = `(async function () { return await ${object}.${name}(() => 7)${invoke}; })();`;
                const calls = [];
                const result = await vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
                assert.equal(modifier.includes('*') ? result.value : result, 7);
                assert.deepEqual(calls, []);
                assert.deepEqual(literalImports(source), []);
                assert.equal(inspect(t, source).passed, true);
            });
        }
    }
}

for (const [name, source] of [
    ['quoted object method', `({ "if"(require) { return ${load}; } }).if(() => 7);`],
    ['computed object method', `({ ["while"](require) { return ${load}; } }).while(() => 7);`],
    ['numeric object method', `({ 1(require) { return ${load}; } })[1](() => 7);`],
    ['static class method', `class Box { static for(require) { return ${load}; } } Box.for(() => 7);`],
    ['computed class method', `class Box { ["while"](require) { return ${load}; } } new Box().while(() => 7);`],
    ['private class method', `class Box { #if(require) { return ${load}; } run() { return this.#if(() => 7); } } new Box().run();`],
    ['setter', `let result; const object = { set if(require) { result = ${load}; } }; object.if = () => 7; result;`],
    ['ordinary function', `(function (require) { return ${load}; })(() => 7);`],
    ['named function', `(function run(require) { return ${load}; })(() => 7);`],
    ['catch binding', `try { throw () => 7; } catch (require) { ${load}; }`],
    ['returned object', `(function () { return { if(require) { return ${load}; } }; })().if(() => 7);`],
    ['conditional object', `(true ? { if(require) { return ${load}; } } : null).if(() => 7);`],
    ['array element object', `[{ if(require) { return ${load}; } }][0].if(() => 7);`],
]) test(`DOCTOR preserves local loader scope in a ${name}`, t => {
    const calls = [];
    assert.equal(vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 }), 7);
    assert.deepEqual(calls, []);
    assert.deepEqual(literalImports(source), []);
    assert.equal(inspect(t, source).passed, true);
});

for (const [name, source] of [
    ['if block', `if (require) { ${load}; }`],
    ['while block', `while (require) { ${load}; break; }`],
    ['for block', `for (; require;) { ${load}; break; }`],
    ['switch block', `switch (require) { default: ${load}; }`],
    ['ordinary block', `{ ${load}; }`],
    ['object nested in a function', `(function () { ({ method() {} }); return ${load}; })();`],
    ['class heritage call', `class Box extends (() => Object)(require) { method() { return ${load}; } } new Box().method();`],
    ['object class heritage call', `function base(value) { return Object; } const object = { Box: class extends base(require) { method() { return ${load}; } } }; new object.Box().method();`],
    ['class field heritage call', `function base(value) { return Object; } class Outer { static Box = class extends base(require) { method() { return ${load}; } }; } new Outer.Box().method();`],
]) test(`DOCTOR does not invent parameter bindings for a ${name}`, t => {
    const calls = [];
    vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
    assert.equal(inspect(t, source).passed, false);
});

test('DOCTOR recognizes methods of an object after export default', t => {
    const source = `const object = { if(require) { return ${load}; } }; export default { while(require) { return ${load}; } }; if (object.if(() => 7) !== 7) throw new Error("CONTROL_NOT_EXECUTED");`;
    const native = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(native.status, 0, native.stderr);
    assert.deepEqual(literalImports(source, false, { sourceType: 'module' }), []);
    assert.equal(inspect(t, source, 'mjs').passed, true);
});
