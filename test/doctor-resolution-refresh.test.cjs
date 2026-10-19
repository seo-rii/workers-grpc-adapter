'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectGoogleWorkerGraph } = require('../src/build/index.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-refresh-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    const inspect = () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] });
    return { root, write, inspect };
}

test('DOCTOR repeated calls reject a removed CommonJS target and recover when restored', t => {
    const f = fixture(t), target = 'node_modules/@grpc/grpc-js/index.cjs';
    assert.equal(f.inspect().passed, true);
    fs.unlinkSync(path.join(f.root, target));
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(report.results[0].graph.flatMap(item => item.grpcImports)[0].status, 'resolution-failed');
    f.write(target, 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    assert.equal(f.inspect().passed, true);
});

test('DOCTOR repeated calls follow changed package main even when the old target still exists', t => {
    const f = fixture(t);
    assert.equal(f.inspect().passed, true);
    f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'replacement.cjs' });
    f.write('node_modules/@grpc/grpc-js/replacement.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.equal(report.results[0].graph.flatMap(item => item.grpcImports)[0].resolved, 'node_modules/@grpc/grpc-js/replacement.cjs');
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../src/build/doctor-cli.cjs'), f.root, '--sdk=sdk'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), report);
});

test('DOCTOR repeated calls follow a retargeted physical adapter installation', t => {
    const f = fixture(t), alias = path.join(f.root, 'node_modules/@grpc/grpc-js');
    fs.renameSync(alias, path.join(f.root, 'first'));
    fs.symlinkSync(path.join(f.root, 'first'), alias, 'dir');
    assert.equal(f.inspect().passed, true);
    f.write('second/package.json', { name: 'workers-grpc-adapter', version: '2.0.0', main: 'index.cjs' });
    f.write('second/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    fs.unlinkSync(alias);
    fs.symlinkSync(path.join(f.root, 'second'), alias, 'dir');
    const report = f.inspect();
    const entry = report.results[0].graph.flatMap(item => item.grpcImports)[0];
    assert.equal(report.passed, true);
    assert.equal(entry.resolved, 'second/index.cjs');
    assert.equal(entry.version, '2.0.0');
});
