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
const keywords = ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do'];
function check(source) {
    const calls = [];
    vm.runInNewContext(source, { require(specifier) { calls.push(specifier); return 3; } }, { timeout: 1000 });
    assert.deepEqual(calls, [missing]);
    assert.deepEqual(literalImports(source), [site]);
}
for (const keyword of keywords) for (const member of ['.', '?.']) {
    test(`DOCTOR scans division after ${member}${keyword}`, () => {
        check(`const obj = {${keyword}: 12}; obj${member}${keyword} / ${load} / 1;`);
    });
}
for (const keyword of ['return', 'in', 'await']) {
    test(`DOCTOR scans division after private #${keyword}`, () => {
        check(`class C { #${keyword} = 12; run() { return this.#${keyword} / ${load} / 1; } } new C().run();`);
    });
}
for (const separator of ['\n', '\r\n', '\u2028', ' /* comment */ ']) {
    test(`DOCTOR keeps keyword member division across ${JSON.stringify(separator)}`, () => {
        check(`const obj = {return: 12}; obj.${separator}return${separator}/ ${load} / 1;`);
    });
}
test('DOCTOR handles escaped keyword property identifiers', () => {
    check(`const obj = {return: 12}; obj.r\\u0065turn / ${load} / 1;`);
});
test('DOCTOR still treats genuine keyword regex operands as regular expressions', () => {
    const pattern = '/require("@grpc\\/grpc-js\\/regex-only")/';
    for (const source of [
        `function f() { return ${pattern}; } f(); ${load};`,
        `try { throw ${pattern}; } catch {} ${load};`,
        `void ${pattern}; ${load};`,
        `typeof ${pattern}; ${load};`,
        `switch ('value') { case ${pattern}: break; } ${load};`,
    ]) check(source);
});

test('DOCTOR API and built CLI reject a missing import in keyword member division', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-division-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    function write(file, contents) {
        const full = path.join(root, file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', `const obj = {return: 12}; obj.return / ${load} / 1;`);
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
