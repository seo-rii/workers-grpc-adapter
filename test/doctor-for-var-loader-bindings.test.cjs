'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

const missing = '@grpc/grpc-js/missing';
function fixture(t, source, entryName = 'index.cjs') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-for-var-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: entryName, dependencies: { 'google-gax': '*' } });
    const entry = write(`node_modules/sdk/${entryName}`, source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    return {
        run: () => spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000 }),
        inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }),
    };
}

for (const header of ['of [null]', 'in { key: 1 }']) {
    for (const [name, body] of [
        ['direct declaration', `var require = createRequire(import.meta.url); require("${missing}");`],
        ['nested block declaration', `{ var require = createRequire(import.meta.url); } require("${missing}");`],
    ]) {
        test(`DOCTOR retains a createRequire ${name} inside for-${header}`, t => {
            const source = `import {createRequire} from "node:module"; for (var require ${header}) { ${body} }`;
            const f = fixture(t, source, 'index.mjs'), actual = f.run();
            assert.equal(actual.status, 1);
            assert.match(actual.stderr, /MODULE_NOT_FOUND/);
            assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: missing }]);
            const report = f.inspect();
            assert.equal(report.passed, false);
            assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
        });
    }
}

for (const [name, source] of [
    ['earlier initializer', `import {createRequire} from "node:module"; var require = createRequire(import.meta.url); for (var require of [value => value]) require("${missing}");`],
    ['inner function initializer', `import {createRequire} from "node:module"; for (var require of [value => value]) { (() => { var require = createRequire(import.meta.url); })(); require("${missing}"); }`],
]) {
    test(`DOCTOR keeps an iteration-assigned binding despite an ${name}`, t => {
        const f = fixture(t, source, 'index.mjs'), actual = f.run();
        assert.equal(actual.status, 0, actual.stderr);
        assert.deepEqual(literalImports(source), []);
        assert.equal(f.inspect().passed, true);
    });
}

for (const [name, source] of [
    ['for-of expression body', `for (var require of [value => value]) require("${missing}");`],
    ['for-of block body', `for (var require of [value => value]) { require("${missing}"); }`],
    ['for-of in an ordinary block', `{ for (var require of [value => value]) require("${missing}"); }`],
    ['for-of continue', `for (var require of [value => value]) { require("${missing}"); continue; }`],
    ['nested for-of body', `for (const item of [1]) for (var require of [value => value]) require("${missing}");`],
    ['for-of conditional body', `for (var require of [value => value]) if (false) void 0; else require("${missing}");`],
    ['for-in body', `for (var require in { key: 1 }) { if (typeof require === 'function') require("${missing}"); }`],
    ['nested for-in body', `for (const item of [1]) for (var require in { key: 1 }) if (typeof require === 'function') require("${missing}");`],
    ['destructured for-of control', `for (var [require] of [[value => value]]) require("${missing}");`],
    ['function-scoped for-of control', `(function () { for (var require of [value => value]); require("${missing}"); })();`],
    ['for-await control', `(async () => { for await (var require of [value => value]); require("${missing}"); })();`],
]) {
    test(`DOCTOR excludes an iteration-assigned require in the ${name}`, t => {
        const f = fixture(t, source), actual = f.run();
        assert.equal(actual.status, 0, actual.stderr);
        assert.deepEqual(literalImports(source), []);
        const report = f.inspect();
        assert.equal(report.passed, true);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports, []);
    });
}

for (const [name, source] of [
    ['ordinary var redeclaration', `var require; require("${missing}");`],
    ['classic for header', `for (var require; false;); require("${missing}");`],
    ['classic for body', `for (var require; true;) { require("${missing}"); break; }`],
    ['var in a for-of body', `for (const item of [1]) { var require; } require("${missing}");`],
    ['loader before for-of', `require("${missing}"); for (var require of [value => value]) void require;`],
    ['for-of iterable expression', `for (var require of require("${missing}")) void require;`],
    ['for-in object expression', `for (var require in require("${missing}")) void require;`],
    ['empty for-of', `for (var require of []); require("${missing}");`],
    ['empty for-in', `for (var require in {}); require("${missing}");`],
    ['empty for-of before a conditional body', `for (var require of []) if (false) void 0; else void require; require("${missing}");`],
    ['empty nested for-of', `for (const item of [1]) for (var require of []) void require; require("${missing}");`],
]) {
    test(`DOCTOR retains the CJS loader for an uninitialized ${name}`, t => {
        const f = fixture(t, source), actual = f.run();
        assert.equal(actual.status, 1);
        assert.match(actual.stderr, /MODULE_NOT_FOUND/);
        assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: missing }]);
        const report = f.inspect();
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
    });
}
