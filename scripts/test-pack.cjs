'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const crypto = require('node:crypto'), cp = require('node:child_process'), assert = require('node:assert/strict');
const { inspect } = require('./doctor.cjs');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-pack-'));
const registryPackages = new Map(), tarballs = new Map();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
const json = file => JSON.parse(fs.readFileSync(file));
function pack(directory, destination) {
    const text = cp.execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: directory, encoding: 'utf8' });
    const packed = JSON.parse(text)[0];
    return { file: path.join(destination, packed.filename), files: packed.files };
}
function addPackage(metadata, file, expectedIntegrity = integrity(fs.readFileSync(file))) {
    const key = `${metadata.name}@${metadata.version}`;
    let versions = registryPackages.get(metadata.name);
    if (!versions) registryPackages.set(metadata.name, versions = new Map());
    versions.set(metadata.version, { metadata, integrity: expectedIntegrity });
    tarballs.set(key, file);
}
function fake(name, version, dependencies, code) {
    const dir = path.join(temp, name.replace(/[^a-z0-9]/gi, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const metadata = { name, version, main: 'index.cjs', dependencies };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(dir, 'index.cjs'), code);
    addPackage(metadata, pack(dir, temp).file);
}
function run(command, args, cwd, env = process.env) {
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(command, args, { cwd, env: { ...env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_update_notifier: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '';
        const timer = setTimeout(() => proc.kill('SIGKILL'), 180000);
        const collect = x => { text += x; if (text.length > 2 * 1024 * 1024) proc.kill('SIGKILL'); };
        proc.stdout.on('data', collect); proc.stderr.on('data', collect);
        proc.on('error', error => { clearTimeout(timer); reject(error); });
        proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve(text) : reject(new Error(`${command} exited ${code}\n${text}`)); });
    });
}
// Serve original locked archives, never reconstructed node_modules packages. Cache is
// only a fast path: verify the lock's SRI before using it and use the pinned URL on a miss.
async function prepareLockedPackages() {
    const npmCache = cp.execFileSync('npm', ['config', 'get', 'cache'], { encoding: 'utf8' }).trim();
    const inputs = ['fixtures/google', 'fixtures/modern', 'fixtures/native', 'fixtures/worker', '.'];
    let cached = 0, downloaded = 0;
    for (const fixture of inputs) {
        const base = path.join(root, fixture), lock = json(path.join(base, 'package-lock.json'));
        for (const [location, entry] of Object.entries(lock.packages)) {
            if (!location || entry.resolved?.startsWith('file:')) continue;
            if (fixture === 'fixtures/worker' && location !== 'node_modules/esbuild' && location !== `node_modules/@esbuild/${process.platform}-${process.arch}`) continue;
            if (fixture === '.' && !['node_modules/typescript', 'node_modules/@types/node', 'node_modules/undici-types'].includes(location)) continue;
            const metadata = json(path.join(base, location, 'package.json'));
            const key = `${metadata.name}@${metadata.version}`;
            if (tarballs.has(key)) continue;
            assert.equal(metadata.version, entry.version);
            const match = /^(sha512|sha1)-([A-Za-z0-9+/]+={0,2})$/.exec(entry.integrity);
            assert.ok(match, `Missing pinned integrity: ${key}`);
            const hex = Buffer.from(match[2], 'base64').toString('hex');
            let file = path.join(npmCache, '_cacache/content-v2', match[1], hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
            let bytes = fs.existsSync(file) && fs.statSync(file).size < 32 * 1024 * 1024 ? fs.readFileSync(file) : undefined;
            if (!bytes || crypto.createHash(match[1]).update(bytes).digest('base64') !== match[2]) {
                const url = new URL(entry.resolved);
                assert.equal(url.origin, 'https://registry.npmjs.org');
                const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
                assert.equal(response.status, 200);
                assert.ok(Number(response.headers.get('content-length')) < 32 * 1024 * 1024);
                const chunks = []; let size = 0;
                for await (const chunk of response.body) {
                    size += chunk.byteLength;
                    assert.ok(size < 32 * 1024 * 1024, 'Locked archive exceeds the packaging download bound');
                    chunks.push(chunk);
                }
                bytes = Buffer.concat(chunks, size);
                assert.equal(crypto.createHash(match[1]).update(bytes).digest('base64'), match[2], `Archive integrity mismatch: ${key}`);
                file = path.join(temp, `upstream-${hash(key)}.tgz`); fs.writeFileSync(file, bytes); downloaded++;
            } else cached++;
            addPackage(metadata, file, entry.integrity);
        }
    }
    return { cached, downloaded, originalArchives: cached + downloaded, allPinnedIntegritiesVerified: true };
}
async function main() {
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    const packed = pack(root, path.join(root, 'artifacts')), actualTarball = packed.file;
    const manifest = json(path.join(root, 'package.json'));
    addPackage(manifest, actualTarball);
    const upstream = await prepareLockedPackages();
    const nativeGrpcMetadata = registryPackages.get('@grpc/grpc-js').get('1.14.0');
    const nativeGrpcArchive = tarballs.get('@grpc/grpc-js@1.14.0');
    fake('@grpc/grpc-js', '1.14.0', {}, "module.exports={nativeMock:true};\n");
    fake('wga-fixture-gax', '1.0.0', { '@grpc/grpc-js': '^1.14.0' }, "exports.grpc=require('@grpc/grpc-js');exports.metadata=require('@grpc/grpc-js/package.json');\n");
    fake('wga-fixture-sdk', '1.0.0', { 'wga-fixture-gax': '1.0.0' }, "module.exports=require('wga-fixture-gax');\n");
    const registryMisses = [];
    const server = http.createServer((req, res) => {
        const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
        if (name.startsWith('tarballs/')) {
            const file = tarballs.get(name.slice(9));
            if (!file) { registryMisses.push(name); res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': 'application/octet-stream' }); fs.createReadStream(file).pipe(res); return;
        }
        const versions = registryPackages.get(name);
        if (!versions) { registryMisses.push(name); res.writeHead(404); res.end('{}'); return; }
        const origin = `http://127.0.0.1:${server.address().port}`;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name, 'dist-tags': { latest: [...versions.keys()].at(-1) }, versions: Object.fromEntries([...versions].map(([version, entry]) => [version,
            { ...entry.metadata, dist: { tarball: `${origin}/tarballs/${encodeURIComponent(`${name}@${version}`)}`, integrity: entry.integrity } }])) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const registry = `http://127.0.0.1:${server.address().port}`;
    const installArgs = ['--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=10000', '--registry', registry, '--cache', path.join(temp, 'cache')];
    const checks = [], profiles = [];
    const alias = `npm:${manifest.name}@${manifest.version}`;
    try {
        for (const override of [false, true]) {
            const fixture = path.join(temp, override ? 'positive' : 'negative'); fs.mkdirSync(fixture);
            const pkg = { name: override ? 'positive-consumer' : 'negative-consumer', version: '1.0.0', private: true,
                dependencies: { '@grpc/grpc-js': alias, 'wga-fixture-sdk': '1.0.0' },
                ...(override ? { overrides: { '@grpc/grpc-js': '$@grpc/grpc-js' } } : {}) };
            fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg, null, 2));
            await run('npm', ['install', ...installArgs], fixture);
            const assertion = override ?
                "const a=require('node:assert/strict'),g=require('@grpc/grpc-js'),s=require('wga-fixture-sdk');a.strictEqual(g,s.grpc);a.strictEqual(g.Client,require('@grpc/grpc-js/build/src/client').Client);a.equal(s.metadata.name,'workers-grpc-adapter');import('@grpc/grpc-js').then(m=>a.strictEqual(m.Metadata,g.Metadata));" :
                "const a=require('node:assert/strict');a.equal(require('@grpc/grpc-js/package.json').name,'workers-grpc-adapter');a.equal(require('wga-fixture-sdk').grpc.nativeMock,true);";
            await run(process.execPath, ['-e', assertion], fixture);
            if (override) {
                await run(process.execPath, ['-e', "const a=require('node:assert/strict');const c=require('@grpc/grpc-js/status-details');import('@grpc/grpc-js/status-details').then(m=>{a.strictEqual(m.decodeGrpcStatusDetails,c.decodeGrpcStatusDetails);const s={code:7,details:'denied',metadata:{get:()=>[]}};a.strictEqual(m.decodeGrpcStatusDetails(s).status,s);});"], fixture);
                const invoke = `const a=require('node:assert/strict'),g=require('@grpc/grpc-js');let n=0,completed=false;process.on('exit',()=>a.equal(completed,true));globalThis.fetch=async()=>{n++;return new Response(Buffer.concat([Buffer.from([0,0,0,0,2,8,1]),Buffer.from([128,0,0,0,16]),Buffer.from('grpc-status: 0\\r\\n')]),{headers:{'content-type':'application/grpc-web+proto'}});};const c=new g.Client('fixture.example',g.credentials.createSsl());c.makeUnaryRequest('/example.Service/Unary',x=>x,x=>x,Buffer.from([8,1]),(e,v)=>{a.equal(e,null);a.deepEqual(v,Buffer.from([8,1]));a.equal(n,1);c.close();completed=true;});`;
                await run(process.execPath, ['-e', invoke], fixture);
            }
            checks.push({ id: override ? 'alias-with-root-override' : 'alias-only-negative-control', status: 'passed' });
        }
        addPackage(nativeGrpcMetadata.metadata, nativeGrpcArchive, nativeGrpcMetadata.integrity);
        const negative = path.join(temp, 'real-sdk-negative'); fs.mkdirSync(negative);
        const negativeManifest = json(path.join(root, 'fixtures/google/package.json'));
        negativeManifest.dependencies['@grpc/grpc-js'] = alias;
        delete negativeManifest.overrides['@grpc/grpc-js'];
        fs.writeFileSync(path.join(negative, 'package.json'), JSON.stringify(negativeManifest, null, 2));
        const negativeArgs = installArgs.slice(); negativeArgs[negativeArgs.length - 1] = path.join(temp, 'native-negative-cache');
        await run('npm', ['install', ...negativeArgs], negative);
        const rejectedGraph = inspect(negative);
        assert.equal(rejectedGraph.passed, false);
        const nativeResolutions = rejectedGraph.results.flatMap(item => item.graph.flatMap(pkg => pkg.grpcImports)).filter(item => item.status === 'wrong-implementation');
        assert.ok(nativeResolutions.length > 0);
        assert.ok(nativeResolutions.every(item => item.implementation === '@grpc/grpc-js'));
        const negativeLock = json(path.join(negative, 'package-lock.json'));
        const nativeMainSha256 = hash(fs.readFileSync(path.join(root, 'fixtures/native/node_modules/@grpc/grpc-js', nativeGrpcMetadata.metadata.main)));
        const nativePackages = [...new Map(rejectedGraph.results.flatMap(item => item.graph).filter(item => item.name === '@grpc/grpc-js').map(item => [item.path, item])).values()].map(item => {
            assert.equal(negativeLock.packages[item.path].integrity, nativeGrpcMetadata.integrity);
            const runtimeEntrySha256 = hash(fs.readFileSync(path.join(negative, item.path, nativeGrpcMetadata.metadata.main)));
            assert.equal(runtimeEntrySha256, nativeMainSha256);
            return { path: item.path, version: item.version, integrity: nativeGrpcMetadata.integrity, runtimeEntrySha256 };
        });
        assert.ok(nativePackages.length > 0);
        checks.push({ id: 'real-sdk-alias-only-negative-control', status: 'passed', nativeResolutions: nativeResolutions.length });
        const negativeControl = { status: 'passed', doctorPassed: rejectedGraph.passed, identity: rejectedGraph.identity,
            graphSha256: rejectedGraph.graphSha256, nativeSRIAndEntryChecked: true, separateNpmCache: true, nativePackages, consumers: rejectedGraph.results.map(({ graph, ...item }) => item), nativeResolutions };
        const inventory = packed.files.map(({ path: name }) => ({ path: name, sha256: hash(fs.readFileSync(path.join(root, name))) }));
        const rootLock = json(path.join(root, 'package-lock.json'));
        const workerLock = json(path.join(root, 'fixtures/worker/package-lock.json'));
        const esbuildEntries = Object.entries(workerLock.packages).filter(([location]) => location === 'node_modules/esbuild' || location.startsWith('node_modules/@esbuild/'));
        for (const [fixtureName, profile] of [['google', 'google-static-v1'], ['modern', 'google-modern-v1']]) {
            const fixture = path.join(temp, profile), fresh = path.join(temp, profile + '-ci');
            fs.mkdirSync(fixture); fs.mkdirSync(fresh);
            const lock = json(path.join(root, 'fixtures', fixtureName, 'package-lock.json'));
            const pkg = { name: `wga-pack-${profile}`, version: '1.0.0', private: true,
                dependencies: { ...lock.packages[''].dependencies, '@grpc/grpc-js': alias },
                devDependencies: { esbuild: workerLock.packages['node_modules/esbuild'].version, typescript: rootLock.packages['node_modules/typescript'].version, '@types/node': rootLock.packages['node_modules/@types/node'].version },
                overrides: { '@grpc/grpc-js': '$@grpc/grpc-js', 'google-auth-library@10.5.0': '10.9.1' } };
            lock.name = pkg.name; lock.version = pkg.version;
            lock.packages[''] = { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies };
            for (const location of ['node_modules/typescript', 'node_modules/@types/node', 'node_modules/undici-types']) {
                lock.packages[location] = structuredClone(rootLock.packages[location]);
                // @types/node and undici are also transitive SDK type dependencies.
                if (location !== 'node_modules/typescript') delete lock.packages[location].dev;
            }
            for (const [location, entry] of esbuildEntries) lock.packages[location] = structuredClone(entry);
            const replacement = lock.packages['node_modules/@grpc/grpc-js'];
            Object.assign(replacement, { name: manifest.name, version: manifest.version, integrity: integrity(fs.readFileSync(actualTarball)) });
            for (const key of ['license', 'engines', 'dependencies', 'peerDependencies', 'peerDependenciesMeta']) {
                if (manifest[key]) replacement[key] = manifest[key]; else delete replacement[key];
            }
            for (const [location, entry] of Object.entries(lock.packages)) {
                if (!location) continue;
                const packageName = entry.name ?? location.slice(location.lastIndexOf('node_modules/') + 13);
                assert.ok(tarballs.has(`${packageName}@${entry.version}`) || (entry.optional && packageName.startsWith('@esbuild/')), `Unserved locked package: ${packageName}@${entry.version}`);
                entry.resolved = `${registry}/tarballs/${encodeURIComponent(`${packageName}@${entry.version}`)}`;
            }
            fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
            fs.writeFileSync(path.join(fixture, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
            await run('npm', ['install', ...installArgs], fixture);
            const installedLock = fs.readFileSync(path.join(fixture, 'package-lock.json'));
            const installed = JSON.parse(installedLock);
            assert.deepEqual(Object.keys(installed.packages).sort(), Object.keys(lock.packages).sort(), 'npm install changed the pinned package locations');
            for (const [location, entry] of Object.entries(lock.packages)) {
                if (!location) continue;
                assert.equal(installed.packages[location]?.version, entry.version, `Changed pinned graph: ${location}`);
                assert.equal(installed.packages[location]?.integrity, entry.integrity, `Changed locked integrity: ${location}`);
            }
            for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(fixture, name), path.join(fresh, name));
            assert.equal(fs.existsSync(path.join(fresh, 'node_modules')), false);
            await run('npm', ['ci', ...installArgs], fresh);
            assert.deepEqual(fs.readFileSync(path.join(fresh, 'package-lock.json')), installedLock);
            const outcomes = [];
            for (const directory of [fixture, fresh]) {
                fs.copyFileSync(path.join(root, 'scripts/pack-consumer.cjs'), path.join(directory, 'consumer-check.cjs'));
                fs.writeFileSync(path.join(directory, 'expected-inventory.json'), JSON.stringify(inventory));
                const result = JSON.parse(await run(process.execPath, ['consumer-check.cjs', 'runtime', profile], directory));
                outcomes.push(result);
            }
            assert.deepEqual(outcomes[1], outcomes[0]);
            const graph = inspect(fresh);
            assert.equal(graph.passed, true);
            assert.equal(graph.identity.status, 'single-installation');
            for (const extension of ['mts', 'cts']) {
                for (const [name, source] of [['sdk-consumer', 'fixtures/google/types/consumer.mts'], ['sdk-contract', 'test/types-catalog-sdk.cts'],
                    ['adapter-config', 'test/types-catalog-config.cts'], ['adapter-server', 'test/types-server-streaming.cts']]) {
                    fs.copyFileSync(path.join(root, source), path.join(fresh, `${name}.${extension}`));
                }
            }
            const exportTypes = Object.entries(manifest.exports).filter(([, value]) => value.types).map(([key], index) =>
                `import type * as Export${index} from '${key === '.' ? '@grpc/grpc-js' : '@grpc/grpc-js' + key.slice(1)}';\ntype Keys${index} = keyof typeof Export${index};`).join('\n');
            for (const extension of ['mts', 'cts']) fs.writeFileSync(path.join(fresh, `export-types.${extension}`), exportTypes);
            const declarations = JSON.parse(await run(process.execPath, ['consumer-check.cjs', 'types'], fresh));
            const offlineDoctor = JSON.parse(await run(process.execPath, ['consumer-check.cjs', 'offline', path.join(root, 'scripts/doctor.cjs')], fresh, {}));
            const evidenceLock = `verification/packaging-${profile}.lock.json`;
            fs.writeFileSync(path.join(root, evidenceLock), installedLock);
            profiles.push({ profile, fixture: `fixtures/${fixtureName}`, status: 'passed', install: 'npm install --ignore-scripts',
                reinstall: 'npm ci --ignore-scripts in a separate empty directory', alias, override: '$@grpc/grpc-js',
                artifactIntegrity: replacement.integrity, inputLockSha256: hash(fs.readFileSync(path.join(root, 'fixtures', fixtureName, 'package-lock.json'))),
                installedLockSha256: hash(installedLock), lockArtifact: evidenceLock, packageCount: Object.keys(installed.packages).length - 1,
                freshDirectory: true, lockUnchanged: true, resolutionIdentityReproduced: true, graphSha256: graph.graphSha256,
                ...outcomes[0], declarations, offlineDoctor });
            fs.rmSync(fixture, { recursive: true }); fs.rmSync(fresh, { recursive: true });
        }
        checks.push({ id: 'real-sdk-alias-with-root-override', status: 'passed', profiles: profiles.length });
        checks.push({ id: 'real-sdk-nested-gax-resolution', status: 'passed', profiles: profiles.length });
        checks.push({ id: 'npm-ci-reproducible-resolution', status: 'passed', freshDirectories: profiles.length });
        checks.push({ id: 'packed-exports-types-assets-license', status: 'passed', files: inventory.length });
        checks.push({ id: 'real-gax-package-json-provenance', status: 'passed' });
        checks.push({ id: 'packed-deep-client-runtime-and-types', status: 'passed' });
        checks.push({ id: 'packed-unsupported-deep-import-rejected', status: 'passed' });
        checks.push({ id: 'real-gax-esm-cjs-credential-identity', status: 'passed' });
        checks.push({ id: 'real-sdk-offline-doctor', status: 'passed', profiles: profiles.length });
        checks.push({ id: 'standalone-packed-types', status: 'passed', profiles: profiles.length, modesPerProfile: 3 });
        fs.copyFileSync(path.join(root, 'verification/packaging-google-static-v1.lock.json'), path.join(root, 'verification/packaging-fixture.lock.json'));
        const duplicates = [];
        const otherVersion = '0.0.0-packaging-duplicate.1';
        const altered = path.join(temp, 'altered-adapter'); fs.mkdirSync(altered);
        cp.execFileSync('tar', ['-xzf', actualTarball, '--strip-components=1', '-C', altered]);
        const alteredManifest = { ...manifest, version: otherVersion };
        fs.writeFileSync(path.join(altered, 'package.json'), JSON.stringify(alteredManifest, null, 2) + '\n');
        addPackage(alteredManifest, pack(altered, temp).file);
        for (const version of [manifest.version, otherVersion]) {
            const fixture = path.join(temp, `duplicate-${version}`); fs.mkdirSync(fixture);
            fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'duplicate-consumer', version: '1.0.0', private: true,
                dependencies: { '@grpc/grpc-js': alias, [manifest.name]: version }, overrides: { '@grpc/grpc-js': '$@grpc/grpc-js' } }));
            await run('npm', ['install', ...installArgs], fixture);
            await run(process.execPath, ['-e', "const a=require('node:assert/strict'),x=require('@grpc/grpc-js'),y=require('workers-grpc-adapter');for(const k of ['Client','Metadata','ChannelCredentials','CallCredentials'])a.notStrictEqual(x[k],y[k]);"], fixture);
            const diagnostic = inspect(fixture, []);
            assert.equal(diagnostic.passed, false);
            assert.equal(diagnostic.identity.status, 'duplicate-installations');
            assert.equal(diagnostic.identity.installations.length, 2);
            assert.equal(diagnostic.diagnostics[0].code, 'WGA_DUPLICATE_ADAPTER_INSTALLATIONS');
            duplicates.push({ versions: [manifest.version, version], classSplit: true, status: 'passed', identity: diagnostic.identity, diagnostics: diagnostic.diagnostics });
        }
        checks.push({ id: 'packed-duplicate-adapter-detection', status: 'passed', cases: duplicates.length });
        assert.ok(registryMisses.every(name => name === 'esbuild' || name.startsWith('@esbuild/')), 'Unexpected unserved registry package: ' + registryMisses.filter(name => name !== 'esbuild' && !name.startsWith('@esbuild/')).join(','));
        const report = { status: 'passed', node: process.version, npm: cp.execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
            registry: 'ephemeral-loopback-registry', actualReplacementTarball: path.basename(actualTarball), sha256: hash(fs.readFileSync(actualTarball)),
            realGoogleSDK: true, realUpstreamGrpcJs: true, upstream, optionalPeerMetadataMisses: registryMisses.length, negativeControl, profiles, duplicates, checks };
        fs.writeFileSync(path.join(root, 'verification/packaging.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ status: report.status, realGoogleSDK: true, profiles: profiles.map(item => ({ profile: item.profile, packages: item.packageCount, gax: item.gax.length })), checks }, null, 2));
    } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); fs.rmSync(temp, { recursive: true, force: true }); process.exitCode = 1; });
