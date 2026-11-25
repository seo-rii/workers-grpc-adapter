'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');

function fixture(t, declarations = { peerDependencies: { helper: '*' } }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-peers-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', main: 'index.cjs',
        ...declarations, dependencies: { 'google-gax': '*', ...declarations.dependencies } });
    write('node_modules/sdk/index.cjs', 'module.exports = require("helper");');
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', main: 'index.cjs',
        dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'module.exports = require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'module.exports = { tag: "replacement" };');
    const installHelper = (manifest = {}) => {
        write('node_modules/helper/package.json', { name: 'helper', version: '1.0.0', main: 'index.cjs', ...manifest });
        write('node_modules/helper/index.cjs', 'module.exports = require("@grpc/grpc-js");');
    };
    return { root, write, installHelper, load: createRequire(path.join(root, 'package.json')),
        inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}

for (const optional of [false, true]) for (const implementation of ['@grpc/grpc-js', 'workers-grpc-adapter']) {
    test(`DOCTOR inspects ${optional ? 'optional' : 'required'} peer closure containing ${implementation}`, t => {
        const f = fixture(t, { peerDependencies: { helper: '*' }, peerDependenciesMeta: { helper: { optional } } });
        f.installHelper({ dependencies: { '@grpc/grpc-js': '*' } });
        f.write('node_modules/helper/node_modules/@grpc/grpc-js/package.json', { name: implementation, version: '1.0.0', main: 'index.cjs' });
        f.write('node_modules/helper/node_modules/@grpc/grpc-js/index.cjs', 'module.exports = { tag: "private-runtime" };');
        assert.equal(f.load('sdk').tag, 'private-runtime', 'the SDK actually uses the peer dependency runtime');
        const report = f.inspect();
        assert.equal(report.passed, false);
        const helper = report.results[0].graph.find(item => item.name === 'helper');
        assert.equal(helper.grpcImports[0].implementation, implementation);
        assert.equal(helper.grpcImports[0].resolved, 'node_modules/helper/node_modules/@grpc/grpc-js/index.cjs');
        if (implementation === 'workers-grpc-adapter') assert.equal(report.identity.status, 'duplicate-installations');
        else assert.equal(helper.grpcImports[0].status, 'wrong-implementation');
    });
}

for (const optional of [false, true]) {
    test(`DOCTOR ${optional ? 'allows' : 'rejects'} an absent ${optional ? 'optional' : 'required'} peer`, t => {
        const f = fixture(t, { peerDependencies: { helper: '*' }, peerDependenciesMeta: { helper: { optional } } });
        assert.throws(() => f.load('helper'), { code: 'MODULE_NOT_FOUND' });
        const report = f.inspect();
        assert.equal(report.passed, optional);
        assert.deepEqual(report.results[0].graph.find(item => item.name === 'sdk').dependencies.find(edge => edge.name === 'helper'),
            { name: 'helper', missing: true, optional });
        assert.deepEqual(report.results[0].unresolved, optional ? [] : ['node_modules/sdk:helper']);
    });
}

test('DOCTOR accepts a peer using the shared replacement without executing it', t => {
    const f = fixture(t);
    f.installHelper({ peerDependencies: { '@grpc/grpc-js': '*' } });
    const marker = path.join(f.root, 'executed');
    f.write('node_modules/helper/index.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); module.exports = require('@grpc/grpc-js');`);
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.equal(fs.existsSync(marker), false, 'inspection must not execute the peer');
    assert.equal(report.results[0].graph.find(item => item.name === 'helper').grpcImports[0].status, 'resolved-to-replacement');
    assert.equal(f.load('sdk').tag, 'replacement');
    assert.equal(fs.existsSync(marker), true, 'the runtime control actually executes the peer');
});

test('DOCTOR blocks an installed optional peer with a malformed manifest', t => {
    const f = fixture(t, { peerDependencies: { helper: '*' }, peerDependenciesMeta: { helper: { optional: true } } });
    f.installHelper();
    f.write('node_modules/helper/package.json', '{');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(report.results[0].status, 'blocked');
    assert.equal(report.results[0].reason, 'resolution-failed');
});

for (const [role, declarations, optional] of [
    ['required dependency and optional peer', { dependencies: { helper: '*' }, peerDependencies: { helper: '*' }, peerDependenciesMeta: { helper: { optional: true } } }, false],
    ['optional dependency and required peer', { optionalDependencies: { helper: '*' }, peerDependencies: { helper: '*' } }, true],
    ['all three declarations', { dependencies: { helper: '*' }, optionalDependencies: { helper: '*' }, peerDependencies: { helper: '*' } }, true],
]) {
    test(`DOCTOR deduplicates ${role} and preserves dependency optionality`, t => {
        const f = fixture(t, declarations);
        const missing = f.inspect();
        assert.equal(missing.passed, optional);
        assert.deepEqual(missing.results[0].graph.find(item => item.name === 'sdk').dependencies.filter(edge => edge.name === 'helper'),
            [{ name: 'helper', missing: true, optional }]);
        f.installHelper();
        const installed = f.inspect();
        assert.equal(installed.passed, true);
        assert.equal(installed.results[0].graph.filter(item => item.name === 'helper').length, 1);
        assert.equal(installed.results[0].graph.find(item => item.name === 'sdk').dependencies.filter(edge => edge.name === 'helper').length, 1);
    });
}

test('DOCTOR completes peer dependency cycles once per physical package', t => {
    const f = fixture(t);
    f.installHelper({ peerDependencies: { cycle: '*' } });
    f.write('node_modules/helper/index.cjs', 'module.exports = require("@grpc/grpc-js"); require("cycle");');
    f.write('node_modules/cycle/package.json', { name: 'cycle', version: '1.0.0', main: 'index.cjs', peerDependencies: { helper: '*' } });
    f.write('node_modules/cycle/index.cjs', 'module.exports = require("helper");');
    assert.equal(f.load('sdk').tag, 'replacement');
    const report = f.inspect();
    assert.equal(report.passed, true);
    assert.deepEqual(report.results[0].graph.map(item => item.name).sort(), ['cycle', 'google-gax', 'helper', 'sdk', 'workers-grpc-adapter']);
    assert.deepEqual(report.results[0].graph.find(item => item.name === 'cycle').dependencies, [{ name: 'helper', path: 'node_modules/helper' }]);
});
