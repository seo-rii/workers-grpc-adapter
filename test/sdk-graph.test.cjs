'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { inspect } = require('../scripts/doctor.cjs');
function packageAt(base, relative, manifest, source = '') {
    const directory = path.join(base, relative);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.0.0', main: 'index.js', ...manifest }));
    fs.writeFileSync(path.join(directory, 'index.js'), source);
}
function fixture(t) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    packageAt(base, '.', { name: 'consumer' });
    packageAt(base, 'node_modules/example-sdk', { name: 'example-sdk', dependencies: { 'google-gax': '*', helper: '*' } });
    packageAt(base, 'node_modules/google-gax', { name: 'google-gax', dependencies: { '@grpc/grpc-js': '*' } }, "require('@grpc/grpc-js');");
    packageAt(base, 'node_modules/helper', { name: 'helper', dependencies: { 'google-gax': '*' } });
    packageAt(base, 'node_modules/helper/node_modules/google-gax', { name: 'google-gax', version: '2.0.0', dependencies: { '@grpc/grpc-js': '*' } }, "require('@grpc/grpc-js');");
    packageAt(base, 'node_modules/@grpc/grpc-js', { name: 'workers-grpc-adapter' });
    return base;
}
test('SDK doctor visits every GAX in an SDK transitive closure', t => {
    const report = inspect(fixture(t), ['example-sdk']);
    assert.equal(report.passed, true);
    assert.deepEqual(report.results[0].gax.map(item => item.version).sort(), ['1.0.0', '2.0.0']);
    assert.equal(report.results[0].grpcImportCount, 2);
});
test('SDK doctor rejects a native grpc shadowed under a second GAX', t => {
    const base = fixture(t);
    packageAt(base, 'node_modules/helper/node_modules/@grpc/grpc-js', { name: '@grpc/grpc-js', version: '1.14.0' });
    const report = inspect(base, ['example-sdk']);
    assert.equal(report.passed, false);
    const wrong = report.results[0].graph.flatMap(item => item.grpcImports).filter(item => item.status === 'wrong-implementation');
    assert.equal(wrong.length, 1);
    assert.match(wrong[0].resolved, /helper\/node_modules\/@grpc/);
});
test('SDK doctor verifies deep imports instead of checking only package name', t => {
    const base = fixture(t);
    fs.writeFileSync(path.join(base, 'node_modules/google-gax/index.js'), "require('@grpc/grpc-js/build/src/missing');");
    const report = inspect(base, ['example-sdk']);
    assert.equal(report.passed, false);
    assert.ok(report.results[0].graph.some(item => item.grpcImports.some(entry => entry.status === 'resolution-failed')));
});
