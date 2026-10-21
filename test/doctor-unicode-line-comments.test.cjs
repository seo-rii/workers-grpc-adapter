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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-line-comment-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const full = path.join(root, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
        return full;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
    const full = write('node_modules/sdk/index.cjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
    return { full, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const [name, newline] of [['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'], ['LS', '\u2028'], ['PS', '\u2029']]) {
    for (const [kind, comment] of [['slash', '// hidden'], ['hashbang', '#!/usr/bin/env node'],
        ['HTML open', '<!-- var require = () => {};'], ['HTML close', '--> var require = () => {};']]) {
        test(`DOCTOR ends ${kind} comments at ${name}`, t => {
            const source = `${comment}${newline}${load}`, calls = [];
            vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
            assert.deepEqual(calls, [missing]);
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
                ...site, file: 'node_modules/sdk/index.cjs', status: 'resolution-failed',
            }]);
        });
    }
    test(`DOCTOR preserves the HTML close-comment line boundary through ${name} block trivia`, () => {
        const source = `1; /* before${newline} */ --> var require = () => {};${newline}${load}`, calls = [];
        vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, [missing]);
        assert.deepEqual(literalImports(source), [site]);
    });
    test(`DOCTOR cooks escaped ${name} line continuations in literal specifiers`, () => {
        for (const quote of ['"', "'", '`']) {
            const source = `require(${quote}@grpc/grpc-\\${newline}js/missing${quote});`, calls = [];
            vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
            assert.deepEqual(calls, [missing]);
            assert.deepEqual(literalImports(source), [site]);
        }
    });
}

test('DOCTOR does not treat ordinary Unicode spaces or escaped separators as comment endings', () => {
    for (const space of ['\u00a0', '\u2003', '\ufeff', '\\u2028', '\\u2029']) {
        const source = `// comment ${space}${load}\n`, calls = [];
        vm.runInNewContext(source, { require: specifier => calls.push(specifier) }, { timeout: 1000 });
        assert.deepEqual(calls, []);
        assert.deepEqual(literalImports(source), []);
    }
});
