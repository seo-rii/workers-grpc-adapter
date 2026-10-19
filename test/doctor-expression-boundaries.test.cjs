'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const load = 'require("@grpc/grpc-js/missing")';
const pattern = '/[require("@grpc/grpc-js/missing")]/.test("")';
function inspect(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-expression-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_MUST_NOT_EXECUTE");');
    return inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
}

for (const [name, source] of [
    ['anonymous class', `const n = class {} / ${load};`],
    ['named class', `const n = class Value {} / ${load};`],
    ['class heritage', `const n = class extends Object {} / ${load};`],
    ['named class heritage', `const n = class Value extends Object {} / ${load};`],
    ['parenthesized class heritage', `const n = class extends (class {}) {} / ${load};`],
    ['nested class heritage', `const n = class extends class {} {} / ${load};`],
    ['function heritage', `const n = class extends function () {} {} / ${load};`],
    ['property heritage', `const n = class extends ({ Base: class {} }).Base {} / ${load};`],
    ['heritage with a class property name', `const n = class extends ({ class: Object }).class {} / ${load};`],
    ['heritage with a constructor call', `const n = class extends new Proxy(Object, {}) {} / ${load};`],
    ['factory heritage', `const n = class extends (() => class {})() {} / ${load};`],
    ['conditional heritage', `const n = class extends (true ? class {} : Object) {} / ${load};`],
    ['async function', `const n = async function () {} / ${load};`],
    ['named async function', `const n = async function Value() {} / ${load};`],
    ['generator', `const n = function* () {} / ${load};`],
    ['async generator', `const n = async function* Value() {} / ${load};`],
    ['unary class operand', `const n = void class {} / ${load};`],
    ['unary function operand', `const n = !async function () {} / ${load};`],
    ['typeof function operand', `const n = typeof function () {} / ${load};`],
    ['binary class operand', `const n = 1 + class {} / ${load};`],
    ['logical-or class operand', `const n = 0 || class {} / ${load};`],
    ['logical-and function operand', `const n = true && function () {} / ${load};`],
    ['nullish class operand', `const n = null ?? class {} / ${load};`],
    ['conditional class consequent', `const n = true ? class {} / ${load} : 0;`],
    ['conditional async function alternate', `const n = false ? 0 : async function () {} / ${load};`],
    ['class return value', `function run() { return class {} / ${load}; } run();`],
    ['generator yielded class', `function* run() { yield class {} / ${load}; } run().next();`],
    ['new class operand', `const n = new class {} / ${load};`],
    ['array element', `const n = [class {} / ${load}];`],
    ['object property', `const n = { value: class {} / ${load} };`],
    ['parenthesized operand', `const n = (class {} / ${load});`],
    ['template interpolation', 'const n = `${class {} / ' + load + '}`;'],
    ['conditional class in a switch body', `switch (1) { case 1: const n = false ? 0 : class {} / ${load}; }`],
]) {
    test(`DOCTOR keeps division after ${name}`, t => {
        const calls = [];
        vm.runInNewContext(source, { require: specifier => { calls.push(specifier); return 2; } }, { timeout: 1000 });
        assert.deepEqual(calls, ['@grpc/grpc-js/missing'], 'The fixture must execute the literal loader site');
        assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: '@grpc/grpc-js/missing' }]);
        const report = inspect(t, source);
        assert.equal(report.passed, false);
        assert.equal(report.results[0].graph.find(item => item.name === 'sdk').grpcImports[0].status, 'resolution-failed');
    });
}

for (const [name, source] of [
    ['case class declaration', `switch (1) { case 1: class Value {} ${pattern}; }`],
    ['default class declaration', `switch (1) { default: class Value {} ${pattern}; }`],
    ['conditional case expression', `switch (1) { case true ? 1 : 2: class Value {} ${pattern}; }`],
    ['case function declaration', `switch (1) { case 1: function value() {} ${pattern}; }`],
]) {
    test(`DOCTOR distinguishes a regex after ${name}`, t => {
        const calls = [];
        vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, []);
        assert.deepEqual(literalImports(source), []);
        assert.equal(inspect(t, source).passed, true);
    });
}

for (const [name, declaration] of [
    ['class declaration', 'class Value {}'],
    ['class declaration with heritage', 'class Value extends Object {}'],
    ['class declaration with nested heritage', 'class Value extends class {} {}'],
    ['class declaration with function heritage', 'class Value extends function () {} {}'],
    ['class declaration with factory heritage', 'class Value extends (() => class {})() {}'],
    ['class declaration with a keyword property heritage', 'class Value extends ({ class: Object }).class {}'],
    ['class declaration with constructor heritage', 'class Value extends new Proxy(Object, {}) {}'],
    ['class declaration with a class-named method', 'class Value { class() {} }'],
    ['class declaration with a class-named field', 'class Value { static class = Object; }'],
    ['function declaration', 'function value() {}'],
    ['generator declaration', 'function* value() {}'],
    ['async function declaration', 'async function value() {}'],
    ['async generator declaration', 'async function* value() {}'],
    ['function declaration after an async identifier', 'const async = 1; async\nfunction value() {}'],
    ['object with a class-named method', 'const value = { class() {} };'],
    ['block containing a class', '{ class Value {} }'],
    ['control block containing a class', 'if (true) { class Value {} }'],
]) {
    test(`DOCTOR ignores a regex following ${name}`, t => {
        const source = `${declaration}\n${pattern};`, calls = [];
        vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, []);
        assert.deepEqual(literalImports(source), []);
        assert.equal(inspect(t, source).passed, true);
    });
}
