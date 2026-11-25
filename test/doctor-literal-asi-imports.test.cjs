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
const literals = ['"."', '"?."', '`.`', '`?.`'];
for (const literal of literals) {
    test(`DOCTOR finds require after ASI-terminated ${literal}`, () => {
        for (const separator of ['\n', '\r\n', '\u2028', '\u2029', ' /* comment */\n', '\n// comment\n']) {
            const source = `${literal}${separator}require('${missing}');`;
            const calls = [];
            vm.runInNewContext(source, { require(specifier) { calls.push(specifier); } }, { timeout: 1000 });
            assert.deepEqual(calls, [missing]);
            assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: missing }], source);
        }
    });
    test(`DOCTOR finds dynamic import and local require after ${literal}`, () => {
        assert.deepEqual(literalImports(`${literal}\nimport('${missing}');`, false, { sourceType: 'module' }),
            [{ kind: 'import', specifier: missing }]);
        assert.deepEqual(literalImports(`${literal}\nrequire('./local.cjs');`, false, { includeLocal: true }),
            [{ kind: 'require', specifier: './local.cjs' }]);
    });
    test(`DOCTOR API and built CLI fail on a missing import after ${literal}`, t => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-literal-asi-'));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        function write(file, value) {
            const full = path.join(root, file);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
            return full;
        }
        write('package.json', { private: true });
        write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
        const entry = write('node_modules/sdk/index.cjs', `${literal}\nrequire('${missing}');`);
        write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
        write('node_modules/google-gax/index.cjs', "require('@grpc/grpc-js');");
        write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
        write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("DOCTOR_MUST_NOT_EXECUTE_SOURCE");');
        const runtime = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 10000 });
        assert.equal(runtime.status, 1);
        assert.match(runtime.stderr, /MODULE_NOT_FOUND/);
        const report = inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
        assert.equal(report.passed, false);
        assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports.map(item => item.status), ['resolution-failed']);
        const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/build/doctor-cli.cjs'), root, '--sdk=sdk'],
            { encoding: 'utf8', timeout: 10000 });
        assert.equal(cli.status, 2, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).passed, false);
    });
}

test('DOCTOR still excludes actual member calls and shadowed require bindings', () => {
    for (const member of ['.', '?.']) {
        const source = `const obj = { require() {}, import() {} }; obj${member}require('${missing}'); obj${member}import('${missing}');`;
        vm.runInNewContext(source, {}, { timeout: 1000 });
        assert.deepEqual(literalImports(source), []);
    }
    for (const literal of literals) {
        const source = `function run(require) { ${literal}\nrequire('${missing}'); } run(() => {});`;
        vm.runInNewContext(source, {}, { timeout: 1000 });
        assert.deepEqual(literalImports(source), []);
    }
});
