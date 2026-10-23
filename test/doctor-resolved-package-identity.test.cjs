'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectGoogleWorkerGraph } = require('../src/build/index.cjs');

function fixture(t, kind = 'require') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-owner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write(`node_modules/google-gax/index.${kind === 'require' ? 'cjs' : 'mjs'}`,
        kind === 'require' ? 'require("@grpc/grpc-js");' : 'import "@grpc/grpc-js";');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    return { root, write, alias: path.join(root, 'node_modules/@grpc/grpc-js'),
        inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}
const imported = report => report.results[0].graph.find(item => item.name === 'google-gax').grpcImports[0];

for (const kind of ['require', 'import']) for (const link of ['file', 'directory']) {
    test(`DOCTOR identifies the native package owning a resolved ${link} symlink (${kind})`, t => {
        const f = fixture(t, kind);
        f.write('foreign/package.json', { name: '@grpc/grpc-js', version: '1.14.5' });
        const source = f.write('foreign/runtime/index.cjs', 'module.exports = "native-symlink";');
        if (link === 'file') {
            fs.unlinkSync(path.join(f.alias, 'index.cjs'));
            fs.symlinkSync(source, path.join(f.alias, 'index.cjs'));
        } else {
            f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'runtime/index.cjs' });
            fs.symlinkSync(path.dirname(source), path.join(f.alias, 'runtime'), 'dir');
        }
        const report = f.inspect();
        const runtime = spawnSync(process.execPath, ['--input-type=module', '--eval',
            `import {createRequire} from 'node:module'; console.log(createRequire(${JSON.stringify(path.join(f.root, 'package.json'))})('@grpc/grpc-js'));`],
        { encoding: 'utf8' });
        assert.equal(runtime.status, 0, runtime.stderr);
        assert.equal(runtime.stdout.trim(), 'native-symlink');
        assert.equal(report.passed, false);
        assert.equal(imported(report).status, 'wrong-implementation');
        assert.equal(imported(report).implementation, '@grpc/grpc-js');
        assert.equal(imported(report).version, '1.14.5');
        assert.equal(imported(report).resolved, 'foreign/runtime/index.cjs');
    });
}

test('DOCTOR keeps whole-package directory symlinks and unnamed nested module scopes supported', t => {
    const f = fixture(t);
    fs.renameSync(f.alias, path.join(f.root, 'physical-adapter'));
    f.write('physical-adapter/package.json', { name: 'workers-grpc-adapter', version: '2.0.0', main: 'runtime/index.cjs' });
    f.write('physical-adapter/runtime/package.json', { type: 'commonjs' });
    f.write('physical-adapter/runtime/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    fs.symlinkSync(path.join(f.root, 'physical-adapter'), f.alias, 'dir');
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.equal(imported(report).implementation, 'workers-grpc-adapter');
    assert.equal(imported(report).version, '2.0.0');
    assert.equal(report.identity.status, 'single-installation');
    assert.equal(report.identity.installations[0].path, 'physical-adapter');
});

test('DOCTOR records a second physical adapter reached through an entrypoint symlink', t => {
    const f = fixture(t);
    f.write('second-adapter/package.json', { name: 'workers-grpc-adapter', version: '2.0.0' });
    const source = f.write('second-adapter/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    fs.unlinkSync(path.join(f.alias, 'index.cjs'));
    fs.symlinkSync(source, path.join(f.alias, 'index.cjs'));
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(imported(report).version, '2.0.0');
    assert.equal(report.identity.status, 'duplicate-installations');
    assert.deepEqual(report.identity.installations.map(item => item.path), ['node_modules/@grpc/grpc-js', 'second-adapter']);
});

test('DOCTOR does not borrow the alias manifest for a target with no package owner', t => {
    const f = fixture(t);
    const source = f.write('unowned/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    fs.unlinkSync(path.join(f.alias, 'index.cjs'));
    fs.symlinkSync(source, path.join(f.alias, 'index.cjs'));
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(imported(report).status, 'resolution-failed');
});
