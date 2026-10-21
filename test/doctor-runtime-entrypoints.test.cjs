'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { inspectGoogleWorkerGraph } = require('../src/build/index.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    const manifest = extra => write('node_modules/sdk/package.json', {
        name: 'sdk', version: '1.0.0', main: 'index.cjs', dependencies: { 'google-gax': '*' }, ...extra,
    });
    write('package.json', { private: true });
    manifest();
    write('node_modules/sdk/index.cjs', 'module.exports = {};');
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    return { root, write, manifest, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}
const imports = report => report.results[0].graph.flatMap(item => item.grpcImports);
const missing = report => imports(report).filter(item => item.specifier === '@grpc/grpc-js/missing');

for (const suffix of ['', '.blob', '.cjs']) test(`DOCTOR checks a statically required runtime${suffix || ' without an extension'}`, t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.cjs', `module.exports = require("./runtime${suffix}");`);
    f.write(`node_modules/sdk/runtime${suffix}`, 'module.exports = require("@grpc/grpc-js/missing");');
    const executed = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', path.join(f.root, 'node_modules/sdk')], { encoding: 'utf8' });
    assert.notEqual(executed.status, 0);
    assert.match(executed.stderr, /MODULE_NOT_FOUND/);
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report).length, 1);
    assert.equal(missing(report)[0].file, `node_modules/sdk/runtime${suffix}`);
    assert.equal(missing(report)[0].status, 'resolution-failed');
    assert.equal(report.results[0].grpcImportCount, 2);
    f.write(`node_modules/sdk/runtime${suffix}`, 'require("@grpc/grpc-js");');
    assert.equal(f.inspect().passed, true);
});

test('DOCTOR follows chained extensionless sources and bounds file cycles', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.cjs', 'require("./first");');
    f.write('node_modules/sdk/first', 'require("./second");');
    f.write('node_modules/sdk/second', 'require("./first"); require("@grpc/grpc-js/missing");');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report).length, 1);
    assert.equal(missing(report)[0].file, 'node_modules/sdk/second');
});

for (const entry of ['main', 'exports-require', 'exports-import', 'node-bin']) test(`DOCTOR checks an extensionless ${entry} entry`, t => {
    const f = fixture(t);
    f.manifest(entry === 'main' ? { main: 'runtime' }
        : entry === 'node-bin' ? { bin: { sdk: 'runtime' } }
            : { exports: { '.': { [entry.endsWith('require') ? 'require' : 'import']: './runtime' } } });
    f.write('node_modules/sdk/runtime', `${entry === 'node-bin' ? '#!/usr/bin/env node\n' : ''}require("@grpc/grpc-js/missing");`);
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report).length, 1);
    assert.equal(missing(report)[0].file, 'node_modules/sdk/runtime');
});

for (const expression of ['require("./runtime")', '(require)(`./runtime`)', 'import("./runtime")']) test(`DOCTOR discovers relative runtime edges through ${expression}`, t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.cjs', `${expression};`);
    f.write('node_modules/sdk/runtime', 'require("@grpc/grpc-js/missing");');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report).length, 1);
});

test('DOCTOR resolves a relative directory load to its extensionless package main', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.cjs', 'require("./sub");');
    f.write('node_modules/sdk/sub/package.json', { main: 'runtime' });
    f.write('node_modules/sdk/sub/runtime', 'require("@grpc/grpc-js/missing");');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report)[0].file, 'node_modules/sdk/sub/runtime');
});

test('DOCTOR keeps a createRequire relative edge at its explicit foreign base', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.mjs', `import {createRequire} from 'node:module'; const require = createRequire(${JSON.stringify(path.join(f.root, 'foreign/loader.cjs'))}); require('./runtime');`);
    f.write('node_modules/sdk/runtime', 'require("@grpc/grpc-js");');
    f.write('foreign/runtime', 'require("@grpc/grpc-js/missing");');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report)[0].file, 'foreign/runtime');
});

test('DOCTOR resolves an extensionless source symlink from its physical location', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.cjs', 'require("./runtime");');
    const physical = f.write('generated/source', 'require("@grpc/grpc-js");');
    f.write('generated/node_modules/@grpc/grpc-js/package.json', { name: '@grpc/grpc-js', version: '1.14.5', main: 'index.cjs' });
    f.write('generated/node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    fs.symlinkSync(physical, path.join(f.root, 'node_modules/sdk/runtime'));
    const report = f.inspect();
    assert.equal(report.passed, false);
    const found = imports(report).filter(item => item.file === 'generated/source');
    assert.equal(found.length, 1);
    assert.equal(found[0].implementation, '@grpc/grpc-js');
});

test('DOCTOR re-resolves extensionless runtime edges after a symlink target changes', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.cjs', 'require("./runtime");');
    const first = f.write('node_modules/sdk/first', 'require("@grpc/grpc-js");');
    const second = f.write('node_modules/sdk/second', 'require("@grpc/grpc-js/missing");');
    const link = path.join(f.root, 'node_modules/sdk/runtime');
    fs.symlinkSync(first, link);
    assert.equal(f.inspect().passed, true);
    fs.unlinkSync(link);
    fs.symlinkSync(second, link);
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report)[0].file, 'node_modules/sdk/second');
});

test('DOCTOR does not scan unreferenced extensionless data or execute discovered sources', t => {
    const f = fixture(t), marker = path.join(f.root, 'executed');
    f.write('node_modules/sdk/index.cjs', 'require("./runtime"); const fs = require("node:fs"); fs.readFileSync(__dirname + "/README");');
    f.write('node_modules/sdk/runtime', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); require('@grpc/grpc-js');`);
    f.write('node_modules/sdk/README', 'require("@grpc/grpc-js/missing");');
    f.write('node_modules/sdk/data', 'import("@grpc/grpc-js/missing");');
    f.write('node_modules/sdk/binary', Buffer.from([0, 255, ...Buffer.from('require("@grpc/grpc-js/missing");')]));
    f.write('node_modules/sdk/value.json', { text: 'require("@grpc/grpc-js/missing")' });
    f.write('node_modules/sdk/shell', '#!/bin/sh\nrequire("@grpc/grpc-js/missing");');
    f.write('node_modules/sdk/other-bin', '#!/usr/bin/not-node\nrequire("@grpc/grpc-js/missing");');
    f.manifest({ bin: { shell: 'shell', other: 'other-bin' } });
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.equal(missing(report).length, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(imports(report).filter(item => item.file === 'node_modules/sdk/runtime').length, 1);
});

test('DOCTOR ignores shadowed loaders, quoted relative examples and unproven bases', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.mjs', `
        import {createRequire} from 'node:module';
        function example(require) { require('./runtime'); }
        const quoted = 'require("./runtime")';
        const require = createRequire(getUnprovenBase());
        require('./runtime');
        require('@grpc/grpc-js');
    `);
    f.write('node_modules/sdk/runtime', 'require("@grpc/grpc-js/missing");');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report).length, 0);
    assert.equal(imports(report).find(item => item.file.endsWith('/index.mjs')).status, 'resolution-base-unverified');
});

test('DOCTOR keeps ESM directory and CommonJS file resolution distinct for discovery', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.mjs', 'import "./sub";');
    f.write('node_modules/sdk/sub/package.json', { main: 'runtime' });
    f.write('node_modules/sdk/sub/runtime', 'require("@grpc/grpc-js/missing");');
    const report = f.inspect();
    assert.equal(report.passed, true, 'an ESM directory target is not a loadable runtime source');
    assert.equal(missing(report).length, 0);
});

test('DOCTOR discovers an extensionless runtime selected through a literal file URL import', t => {
    const f = fixture(t);
    const target = f.write('generated/runtime', 'require("@grpc/grpc-js/missing");');
    f.write('node_modules/sdk/index.mjs', `import ${JSON.stringify(pathToFileURL(target).href)};`);
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(missing(report)[0].file, 'generated/runtime');
});

test('DOCTOR fails closed when the runtime discovery resolver cannot complete', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/index.cjs', 'require("./runtime");');
    f.write('node_modules/sdk/runtime', 'require("@grpc/grpc-js/missing");');
    const child = spawnSync(process.execPath, ['-e', `
        const childProcess = require('node:child_process');
        const original = childProcess.spawnSync;
        childProcess.spawnSync = (...args) => args[2]?.input?.includes('./runtime')
            ? { status: 1, stderr: 'INSPECTION_MUST_NOT_EXPOSE_CHILD_STDERR' } : original(...args);
        const {inspectGoogleWorkerGraph} = require(process.argv[1]);
        console.log(JSON.stringify(inspectGoogleWorkerGraph({projectRoot:process.argv[2],sdks:['sdk']})));
    `, path.resolve(__dirname, '../src/build/doctor.cjs'), f.root], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.includes('INSPECTION_MUST_NOT_EXPOSE_CHILD_STDERR'), false);
    const report = JSON.parse(child.stdout);
    assert.equal(report.passed, false);
    assert.equal(report.results[0].status, 'blocked');
    assert.equal(report.results[0].reason, 'resolution-failed');
});
