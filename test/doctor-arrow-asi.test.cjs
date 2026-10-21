'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
const load = `require(${JSON.stringify(missing)})`;
const site = { kind: 'require', specifier: missing };
function inspect(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-arrow-asi-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    return inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
}

for (const separator of ['\n', '\r', '\u2028', '\u2029', ' /*\ncomment*/ ']) {
    for (const [name, after] of [
        ['return', `return ${load};`],
        ['declaration', `const loaded = ${load}; return loaded;`],
        ['assignment', `let loaded; loaded = ${load}; return loaded;`],
        ['direct call', `${load};`],
    ]) test(`DOCTOR ends a concise arrow before ${name} across ${JSON.stringify(separator)}`, t => {
        const source = `(function () { const callback = require => require${separator}${after} })();`;
        const calls = [];
        vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, [missing]);
        assert.deepEqual(literalImports(source), [site]);
        const report = inspect(t, source);
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
    });
}

for (const [name, expression] of [
    ['call', `require\n(${JSON.stringify(missing)})`],
    ['optional call', `require\n?.(${JSON.stringify(missing)})`],
    ['member call', `require\n.call(null, ${JSON.stringify(missing)})`],
    ['computed member', `require\n["call"](null, ${JSON.stringify(missing)})`],
    ['logical operator before line break', `true &&\n${load}`],
    ['logical operator after line break', `true\n&& ${load}`],
    ['conditional', `true\n? ${load}\n: 0`],
    ['await prefix', `await\n${load}`],
    ['void prefix', `void\n${load}`],
    ['template tag', 'require\n`@grpc/grpc-js/missing`'],
    ['dynamic template tag', 'require\n`value ${require("@grpc/grpc-js/missing")}`'],
    ['parenthesized expression', `(true\n&& ${load})`],
    ['nested arrow', `other => other\n&& ${load}`],
]) test(`DOCTOR preserves a concise arrow's multiline ${name}`, async t => {
    const asyncPrefix = name === 'await prefix' ? 'async ' : '';
    const invoke = name === 'nested arrow' ? '(true)' : '';
    const source = `(async function () { const callback = ${asyncPrefix}require => ${expression}; await callback(() => 7)${invoke}; })();`;
    const calls = [];
    await vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, []);
    assert.deepEqual(literalImports(source), []);
    assert.equal(inspect(t, source).passed, true);
});

for (const [name, arrow] of [
    ['explicit semicolon', 'require => require;'],
    ['unrelated parameter', 'value => value'],
    ['block body', 'require => { return require; }'],
    ['parenthesized body', 'require => (require)'],
    ['postfix update boundary', 'require => require'],
]) test(`DOCTOR detects the outer loader after ${name}`, t => {
    const next = name === 'postfix update boundary' ? 'let value = 0; ++value;' : '';
    const source = `(function () { const callback = ${arrow}\n${next} return ${load}; })();`;
    const calls = [];
    vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
    assert.equal(inspect(t, source).passed, false);
});

for (const keyword of ['await', 'yield']) for (const next of [`return ${load};`, `${load};`]) {
    test(`DOCTOR treats ${keyword} as an ordinary concise-arrow identifier before ${next}`, t => {
        const source = `(function () { const ${keyword} = 7; const callback = require => ${keyword}\n${next} })();`;
        const calls = [];
        vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, [missing]);
        assert.deepEqual(literalImports(source), [site]);
        assert.equal(inspect(t, source).passed, false);
    });
}

for (const params of ['value', '(value)']) {
    test(`DOCTOR preserves a nested async ${params} arrow across await's line break`, async t => {
        const source = `(async function () { const callback = require => async ${params} => await\n${load}; return await callback(() => 7)(0); })();`;
        const calls = [];
        assert.equal(await vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 }), 7);
        assert.deepEqual(calls, []);
        assert.deepEqual(literalImports(source), []);
        assert.equal(inspect(t, source).passed, true);
    });
}
