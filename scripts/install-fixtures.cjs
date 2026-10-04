'use strict';
// Run under the workspace's background/log runner. No credentials or cloud APIs are used.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const { inspect } = require('./doctor.cjs');
const root = path.resolve(__dirname, '..');
function npm(args, cwd = root) {
    cp.execFileSync('npm', args, { cwd, stdio: 'inherit' });
}
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
cp.execFileSync(process.execPath, ['vendor/fetch-upstream.cjs'], { cwd: root, stdio: 'inherit' });
npm(['pack', '--pack-destination', 'artifacts']);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const tarball = path.join(root, 'artifacts', `${manifest.name}-${manifest.version}.tgz`);
const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64');
function refreshLock(fixture) {
    const lockPath = path.join(fixture, 'package-lock.json');
    if (!fs.existsSync(lockPath)) npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], fixture);
    const lock = JSON.parse(fs.readFileSync(lockPath));
    const entry = lock.packages['node_modules/@grpc/grpc-js'];
    if (!entry || entry.name !== manifest.name || !entry.resolved.startsWith('file:')) throw new Error('Fixture must lock the local replacement tarball');
    // The development artifact keeps its version; bind the existing graph to these exact bytes.
    entry.version = manifest.version;
    entry.integrity = integrity;
    for (const key of ['license', 'engines', 'dependencies', 'peerDependencies', 'peerDependenciesMeta']) {
        if (manifest[key]) entry[key] = manifest[key];
        else delete entry[key];
    }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
    return lock;
}
const fixture = path.join(root, 'fixtures/google');
const lock = refreshLock(fixture);
const before = inspect(fixture);
npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], fixture);
const after = inspect(fixture);
if (!after.passed) throw new Error('Installed Google SDK graph does not resolve the replacement');
const identities = report => report.results.map(result => result.graph.map(({ name, version, path, integrity }) => ({ name, version, path, integrity })));
const reproduced = before.passed
    ? JSON.stringify(identities(before)) === JSON.stringify(identities(after))
    : after.results.every(result => result.graph.every(item => lock.packages[item.path]?.version === item.version && (lock.packages[item.path]?.integrity ?? null) === item.integrity));
if (!reproduced) throw new Error('npm ci changed the locked SDK graph');
fs.writeFileSync(path.join(root, 'compatibility/google-graph.json'), JSON.stringify({ ...after, installation: { npmCiPassed: true, graphReproduced: reproduced, tarballIntegrity: integrity } }, null, 2) + '\n');
const native = path.join(root, 'fixtures/native');
npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], native);
const baseline = inspect(native, undefined, '@grpc/grpc-js');
if (!baseline.passed) throw new Error('Native baseline dependency graph failed');
fs.writeFileSync(path.join(root, 'compatibility/google-native-graph.json'), JSON.stringify(baseline, null, 2) + '\n');
const worker = path.join(root, 'fixtures/worker');
refreshLock(worker);
npm(['ci', '--no-audit', '--no-fund'], worker);
const modern = path.join(root, 'fixtures/modern');
refreshLock(modern);
npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], modern);
if (!inspect(modern).passed) throw new Error('Modern SDK graph failed replacement resolution');
const modernNative = path.join(root, 'fixtures/modern-native');
npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], modernNative);
if (!inspect(modernNative, undefined, '@grpc/grpc-js').passed) throw new Error('Modern native baseline graph failed');
console.log(JSON.stringify({ status: 'passed', modernInstalled: true, graphReproduced: reproduced, native: baseline.passed, workerInstalled: true, tarballIntegrity: integrity }));
