'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { literalImports } = require('../src/build/imports.cjs');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

function fixture(t, source) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-literal-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', main: 'index.cjs', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    write('node_modules/sdk/index.cjs', source);
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'module.exports = require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'module.exports = {};');
    return { root, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const [kind, source] of [
    ['require', 'require(("@grpc/grpc-js/missing"))'],
    ['require', 'require(((/* literal */ "@grpc/grpc-js/missing")))'],
    ['require', 'require((`@grpc/grpc-js/missing`), "unused")'],
    ['require', '(require)(("@grpc/grpc-js/missing"))'],
    ['require', 'require?.(("@grpc/grpc-js/missing"))'],
    ['import', 'import(("@grpc/grpc-js/missing"))'],
    ['import', 'import((`@grpc/grpc-js/missing`), { with: { type: "json" } })'],
]) {
    test(`DOCTOR inspects a transparently parenthesized literal: ${source}`, () => {
        assert.deepEqual(literalImports(source), [{ kind, specifier: '@grpc/grpc-js/missing' }]);
    });
}

test('DOCTOR keeps computed arguments and local/property require calls outside literal inspection', () => {
    for (const source of [
        'require(("@grpc/grpc-js/" + suffix))',
        'import((sideEffect(), "@grpc/grpc-js/missing"))',
        'object.require(("@grpc/grpc-js/missing"))',
        'function local(require) { return require(("@grpc/grpc-js/missing")); }',
    ]) assert.deepEqual(literalImports(source), [], source);
});

for (const [kind, expression] of [
    ['require', 'require(("@grpc/grpc-js/missing"))'],
    ['import', 'import(("@grpc/grpc-js/missing"))'],
]) test(`DOCTOR API and CLI reject the actual unresolved ${kind} target`, async t => {
    const f = fixture(t, `exports.run = async () => ${expression};`);
    const sdk = createRequire(path.join(f.root, 'package.json'))('sdk');
    await assert.rejects(sdk.run(), { code: kind === 'require' ? 'MODULE_NOT_FOUND' : 'ERR_MODULE_NOT_FOUND' });
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').grpcImports, [{
        file: 'node_modules/sdk/index.cjs', kind, specifier: '@grpc/grpc-js/missing', status: 'resolution-failed',
    }]);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../src/build/doctor-cli.cjs'), f.root, '--sdk=sdk'], { encoding: 'utf8' });
    assert.equal(cli.status, 2, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).passed, false);
});

test('DOCTOR accepts a parenthesized literal resolving to the replacement', t => {
    const f = fixture(t, 'module.exports = require(("@grpc/grpc-js"));');
    assert.equal(f.inspect().passed, true);
});
