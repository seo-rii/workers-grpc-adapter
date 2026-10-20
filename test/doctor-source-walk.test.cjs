'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectGoogleWorkerGraph } = require('../src/build/index.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-walk-'));
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
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    return { root, write, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const kind of ['hidden-directory', 'hidden-file', 'symlink-file', 'symlink-directory']) {
    test(`DOCTOR inspects ${kind} runtime imports`, t => {
        const f = fixture(t);
        const source = kind === 'hidden-directory' ? 'node_modules/sdk/.runtime/client.cjs'
            : kind === 'hidden-file' ? 'node_modules/sdk/.client.cjs' : 'generated/client.cjs';
        const physical = f.write(source, 'require("@grpc/grpc-js/missing");');
        if (kind === 'symlink-file') fs.symlinkSync(physical, path.join(f.root, 'node_modules/sdk/client.cjs'));
        if (kind === 'symlink-directory') fs.symlinkSync(path.dirname(physical), path.join(f.root, 'node_modules/sdk/generated'), 'dir');
        const report = f.inspect();
        assert.equal(report.passed, false);
        const imports = report.results[0].graph.flatMap(item => item.grpcImports);
        assert.equal(imports.filter(item => item.specifier === '@grpc/grpc-js/missing').length, 1);
        assert.equal(imports.find(item => item.specifier.endsWith('/missing')).status, 'resolution-failed');
        f.write(source, 'require("@grpc/grpc-js");');
        assert.equal(f.inspect().passed, true);
    });
}

test('DOCTOR follows symlink sources from their physical importer and terminates cycles', t => {
    const f = fixture(t);
    const file = f.write('generated/client.cjs', 'require("@grpc/grpc-js");');
    f.write('generated/node_modules/@grpc/grpc-js/package.json', { name: '@grpc/grpc-js', version: '1.14.0', main: 'index.cjs' });
    f.write('generated/node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    fs.symlinkSync(path.dirname(file), path.join(f.root, 'node_modules/sdk/generated'), 'dir');
    fs.symlinkSync(file, path.join(f.root, 'node_modules/sdk/alias.cjs'));
    fs.symlinkSync(path.join(f.root, 'node_modules/sdk'), path.join(f.root, 'generated/cycle'), 'dir');
    const report = f.inspect();
    const imports = report.results[0].graph.flatMap(item => item.grpcImports).filter(item => item.file === 'generated/client.cjs');
    assert.equal(report.passed, false);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].implementation, '@grpc/grpc-js');
    assert.equal(imports[0].resolved, 'generated/node_modules/@grpc/grpc-js/index.cjs');
});

for (const suffix of ['', '.blob']) {
    test(`DOCTOR inspects a runtime source alias with a ${suffix || 'missing'} target extension`, t => {
        const f = fixture(t);
        const source = `generated/source${suffix}`;
        const file = f.write(source, 'require("@grpc/grpc-js/missing");');
        fs.symlinkSync(file, path.join(f.root, 'node_modules/sdk/client.cjs'));
        const report = f.inspect();
        assert.equal(report.passed, false);
        const imported = report.results[0].graph.flatMap(item => item.grpcImports)
            .find(item => item.file === source);
        assert.equal(imported.status, 'resolution-failed');
        assert.equal(imported.kind, 'require');
        f.write(source, 'require("@grpc/grpc-js");');
        assert.equal(f.inspect().passed, true);
    });
}

test('DOCTOR skips version-control internals while retaining hidden runtime source', t => {
    const f = fixture(t);
    f.write('node_modules/sdk/.git/ignored.cjs', 'require("@grpc/grpc-js/missing");');
    f.write('node_modules/sdk/.runtime/client.cjs', 'require("@grpc/grpc-js");');
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.ok(report.results[0].graph.flatMap(item => item.grpcImports).some(item => item.file.includes('.runtime')));
});
