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
const real = '@grpc/grpc-js';
const localCall = `require(${JSON.stringify(missing)})`;
const realCall = `require(${JSON.stringify(real)})`;
function check(source) {
    const calls = [];
    // Preserve the CommonJS wrapper parameter when testing Annex B functions.
    vm.runInNewContext(`(function(require) { ${source} })(require);`, {
        require(specifier) { calls.push(specifier); return 3; },
    }, { timeout: 1000 });
    assert.deepEqual(calls, [real]);
    assert.deepEqual(literalImports(source), [{ kind: 'require', specifier: real }]);
}
const literal = (value, template) => template ? `\`${value}\`` : JSON.stringify(value);
for (const value of [',', ';', ')', ']', '}', '{', '=>']) for (const template of [false, true]) {
    const text = literal(value, template);
    test(`DOCTOR retains arrow parameters across literal ${text}`, () =>
        check(`const run = require => ${text} + ${localCall}; run(value => value); ${realCall};`));
}
for (const value of [';', '}', 'else', 'return', 'break', 'continue', 'debugger']) for (const template of [false, true]) {
    const text = literal(value, template);
    test(`DOCTOR retains loop bindings across literal ${text}`, () => {
        check(`for (let require of [value => value]) ${text} + ${localCall}; ${realCall};`);
        check(`for (let require of [value => value]) ${text}\n + ${localCall}; ${realCall};`);
    });
}
for (const value of ['=', '(', '[', ',', ':', '?', '=>', '+', 'new', 'await', 'return', 'yield']) {
    for (const template of [false, true]) for (const strict of [false, true]) {
        const text = literal(value, template);
        test(`DOCTOR retains ${strict ? 'strict' : 'sloppy'} function declarations after ${text}`, () =>
            check(`${strict ? "'use strict';" : ''} { ${text}\nfunction require(value) { return value; } ${localCall}; } ${realCall};`));
    }
}
for (const value of ['+', 'in', 'instanceof', '=', '?', ':']) {
    test(`DOCTOR ends a concise arrow before an ASI string ${JSON.stringify(value)}`, () =>
        check(`const run = require => 0\n${JSON.stringify(value)}\n${realCall};`));
}
for (const [name, source] of [
    ['ordinary arrow expression', `const run = require => 'ok' + ${localCall}; run(value => value); ${realCall};`],
    ['parenthesized arrow literal', `const run = require => (';') + ${localCall}; run(value => value); ${realCall};`],
    ['dynamic template arrow', `const run = require => \`;\${0}\` + ${localCall}; run(value => value); ${realCall};`],
    ['block loop', `for (let require of [value => value]) { ';' + ${localCall}; } ${realCall};`],
    ['parenthesized loop literal', `for (let require of [value => value]) ('else') + ${localCall}; ${realCall};`],
    ['ordinary declaration prefix', `{ 'ok'\nfunction require(value) { return value; } ${localCall}; } ${realCall};`],
    ['explicit declaration separator', `{ '+'; function require(value) { return value; } ${localCall}; } ${realCall};`],
]) test(`DOCTOR preserves ${name}`, () => check(source));

test('DOCTOR API and CLI accept literal scope boundaries without inventing imports', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-literal-scopes-'));
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
    write('node_modules/google-gax/index.cjs', `${realCall};`);
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'module.exports = 3;');
    for (const source of [
        `const run = require => ';' + ${localCall}; run(value => value); ${realCall};`,
        `const run = require => \`{\` + ${localCall}; run(value => value); ${realCall};`,
        `for (let require of [value => value]) 'else' + ${localCall}; ${realCall};`,
        `'use strict'; { '+'\nfunction require(value) { return value; } ${localCall}; } ${realCall};`,
    ]) {
        const file = write('node_modules/sdk/index.cjs', source);
        const runtime = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 10000 });
        assert.equal(runtime.status, 0, runtime.stderr);
        const report = inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
        assert.equal(report.passed, true);
        assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports.map(item => item.specifier), [real]);
        const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../dist/build/doctor-cli.cjs'), root, '--sdk=sdk'], { encoding: 'utf8', timeout: 10000 });
        assert.equal(cli.status, 0, cli.stderr);
        assert.equal(JSON.parse(cli.stdout).passed, true);
    }
});
