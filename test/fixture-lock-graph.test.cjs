'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectGoogleWorkerGraph } = require('../src/build/doctor.cjs');
const { matchesFixtureLocks } = require('../scripts/fixture-lock-graph.cjs');

function fixture(t) {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-fixture-peer-lock-'));
    t.after(() => fs.rmSync(repository, { recursive: true, force: true }));
    const project = path.join(repository, 'fixtures/google');
    const write = (name, value) => {
        const file = path.join(repository, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    write('package.json', { private: true });
    write('fixtures/google/package.json', { private: true });
    const fixtureLock = { packages: {} }, repositoryLock = { packages: {} };
    const install = (name, manifest, source, ancestor = false) => {
        const directory = `node_modules/${name}`;
        const prefix = ancestor ? '' : 'fixtures/google/';
        write(prefix + directory + '/package.json', { name, version: '1.0.0', main: 'index.cjs', ...manifest });
        write(prefix + directory + '/index.cjs', source);
        (ancestor ? repositoryLock : fixtureLock).packages[directory] = { version: '1.0.0', integrity: `sha512-${name}` };
    };
    install('sdk', { dependencies: { 'google-gax': '*' } }, 'require("google-gax");');
    install('google-gax', { dependencies: { '@grpc/grpc-js': '*' } }, 'require("@grpc/grpc-js");');
    install('@grpc/grpc-js', { name: 'workers-grpc-adapter', peerDependencies: { tool: '*' },
        peerDependenciesMeta: { tool: { optional: true } } }, 'module.exports = {};');
    install('tool', { dependencies: { helper: '*' } }, 'module.exports = require("helper");', true);
    install('helper', {}, 'module.exports = {};', true);
    write('package-lock.json', repositoryLock);
    write('fixtures/google/package-lock.json', fixtureLock);
    const report = inspectGoogleWorkerGraph({ projectRoot: project, sdks: ['sdk'] });
    assert.equal(report.passed, true);
    assert.deepEqual(report.results[0].graph.filter(item => item.path.startsWith('../')).map(item => item.name).sort(), ['helper', 'tool']);
    const installedRepositoryLock = structuredClone(repositoryLock);
    const f = { repository, project, report, fixtureLock, repositoryLock, installedRepositoryLock,
        inspect: () => inspectGoogleWorkerGraph({ projectRoot: project, sdks: ['sdk'] }),
        matches: options => matchesFixtureLocks(f.report, project, fixtureLock, repository, repositoryLock, installedRepositoryLock, options) };
    return f;
}

test('fixture lock verification accepts installed ancestor peers covered by the root lock', t => {
    const f = fixture(t);
    assert.equal(f.report.results[0].graph.every(item => f.fixtureLock.packages[item.path]?.version === item.version), false,
        'the previous fixture-only check rejected the normal ancestor peer closure');
    assert.equal(f.matches(), true);
});

test('strict fixture lock verification accepts the locked ancestor peers omitted from fixture integrity metadata', t => {
    const f = fixture(t);
    assert.equal(f.report.results[0].graph.every(item => !!item.integrity), false,
        'the modern SDK gate previously rejected the ancestor peer metadata');
    assert.equal(f.matches({ requireIntegrity: true }), true);
});

for (const location of ['fixture', 'root']) for (const integrity of [undefined, '']) {
    test(`strict fixture lock verification rejects ${location} integrity ${integrity === undefined ? 'omission' : 'empty string'}`, t => {
        const f = fixture(t);
        if (location === 'fixture') {
            f.fixtureLock.packages['node_modules/sdk'].integrity = integrity;
            f.report.results[0].graph.find(item => item.name === 'sdk').integrity = integrity ?? null;
        } else {
            f.repositoryLock.packages['node_modules/tool'].integrity = integrity;
            f.installedRepositoryLock.packages['node_modules/tool'].integrity = integrity;
        }
        assert.equal(f.matches(), true, 'matching metadata alone does not require a recorded integrity');
        assert.equal(f.matches({ requireIntegrity: true }), false, 'the modern SDK gate still requires an integrity for every package');
    });
}

test('fixture lock verification uses the physical root node_modules directory', t => {
    const f = fixture(t);
    const physical = path.join(f.repository, 'physical/node_modules');
    fs.mkdirSync(path.dirname(physical));
    fs.renameSync(path.join(f.repository, 'node_modules'), physical);
    fs.symlinkSync(physical, path.join(f.repository, 'node_modules'), 'dir');
    f.report = f.inspect();
    assert.equal(f.report.passed, true);
    assert.equal(f.report.results[0].graph.some(item => item.path === '../../physical/node_modules/tool'), true);
    assert.equal(f.matches(), true);
});

for (const change of ['missing-root-peer', 'missing-transitive-peer', 'changed-root-version', 'changed-root-integrity', 'changed-installed-root-version', 'missing-installed-root-package', 'missing-local-package', 'changed-local-version', 'changed-local-integrity', 'unapproved-outside-path']) {
    test(`fixture lock verification rejects ${change}`, t => {
        const f = fixture(t);
        if (change === 'missing-root-peer') delete f.repositoryLock.packages['node_modules/tool'];
        if (change === 'missing-transitive-peer') delete f.repositoryLock.packages['node_modules/helper'];
        if (change === 'changed-root-version') f.repositoryLock.packages['node_modules/tool'].version = '2.0.0';
        if (change === 'changed-root-integrity') f.repositoryLock.packages['node_modules/tool'].integrity = 'sha512-changed';
        if (change === 'changed-installed-root-version') f.installedRepositoryLock.packages['node_modules/tool'].version = '2.0.0';
        if (change === 'missing-installed-root-package') delete f.installedRepositoryLock.packages['node_modules/tool'];
        if (change === 'missing-local-package') delete f.fixtureLock.packages['node_modules/sdk'];
        if (change === 'changed-local-version') f.fixtureLock.packages['node_modules/sdk'].version = '2.0.0';
        if (change === 'changed-local-integrity') f.fixtureLock.packages['node_modules/sdk'].integrity = 'sha512-changed';
        if (change === 'unapproved-outside-path') f.report.results[0].graph.find(item => item.name === 'tool').path = '../../../unapproved/node_modules/tool';
        assert.equal(f.matches(), false);
    });
}
