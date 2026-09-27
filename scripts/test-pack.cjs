'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const crypto = require('node:crypto'), cp = require('node:child_process'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-pack-'));
const registryPackages = new Map(), tarballs = new Map();
function pack(directory, destination) {
    const text = cp.execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], { cwd: directory, encoding: 'utf8' });
    return path.join(destination, JSON.parse(text)[0].filename);
}
function addPackage(metadata, file) {
    registryPackages.set(metadata.name, metadata);
    tarballs.set(metadata.name, fs.readFileSync(file));
}
function fake(name, version, dependencies, code) {
    const dir = path.join(temp, name.replace(/[^a-z0-9]/gi, '_'));
    fs.mkdirSync(dir, { recursive: true });
    const metadata = { name, version, main: 'index.cjs', dependencies };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(dir, 'index.cjs'), code);
    addPackage(metadata, pack(dir, temp));
}
function run(command, args, cwd, env = {}) {
    return new Promise((resolve, reject) => {
        const proc = cp.spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = '';
        proc.stdout.on('data', x => text += x);
        proc.stderr.on('data', x => text += x);
        proc.on('error', reject);
        proc.on('close', code => code === 0 ? resolve(text) : reject(new Error(`${command} exited ${code}\n${text}`)));
    });
}
async function main() {
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts, { recursive: true });
    const actualTarball = pack(root, artifacts);
    addPackage(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))), actualTarball);
    fake('@grpc/grpc-js', '1.14.0', {}, "module.exports={nativeMock:true};\n");
    fake('wga-fixture-gax', '1.0.0', { '@grpc/grpc-js': '^1.14.0' }, "exports.grpc=require('@grpc/grpc-js');exports.metadata=require('@grpc/grpc-js/package.json');\n");
    fake('wga-fixture-sdk', '1.0.0', { 'wga-fixture-gax': '1.0.0' }, "module.exports=require('wga-fixture-gax');\n");
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const name = decodeURIComponent(url.pathname.slice(1));
        if (name.startsWith('tarballs/')) {
            const pkg = decodeURIComponent(name.slice(9));
            const bytes = tarballs.get(pkg);
            if (!bytes) {
                res.writeHead(404);
                res.end();
                return;
            }
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            res.end(bytes);
            return;
        }
        const metadata = registryPackages.get(name);
        if (!metadata) {
            res.writeHead(404);
            res.end('{}');
            return;
        }
        const origin = `http://127.0.0.1:${server.address().port}`;
        const bytes = tarballs.get(name);
        const version = { ...metadata, dist: { tarball: `${origin}/tarballs/${encodeURIComponent(name)}`, integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') } };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name, 'dist-tags': { latest: metadata.version }, versions: { [metadata.version]: version } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const registry = `http://127.0.0.1:${server.address().port}`;
    const installArgs = ['--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=0', '--fetch-timeout=10000', '--registry', registry, '--cache', path.join(temp, 'cache')];
    const checks = [];
    try {
        for (const override of [false, true]) {
            const fixture = path.join(temp, override ? 'positive' : 'negative');
            fs.mkdirSync(fixture);
            const pkg = { name: override ? 'positive-consumer' : 'negative-consumer', version: '1.0.0', private: true,
                dependencies: { '@grpc/grpc-js': 'npm:workers-grpc-adapter@0.0.0-prototype.1', 'wga-fixture-sdk': '1.0.0' },
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
            if (override) {
                await run('npm', ['ci', ...installArgs], fixture);
                await run(process.execPath, ['-e', assertion], fixture);
                checks.push({ id: 'npm-ci-reproducible-resolution', status: 'passed' });
                fs.copyFileSync(path.join(fixture, 'package-lock.json'), path.join(root, 'verification', 'packaging-fixture.lock.json'));
            }
        }
        const report = { status: 'passed', node: process.version, npm: cp.execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
            registry: 'ephemeral-loopback-registry', actualReplacementTarball: path.basename(actualTarball),
            sha256: crypto.createHash('sha256').update(fs.readFileSync(actualTarball)).digest('hex'),
            realGoogleSDK: false, realUpstreamGrpcJs: false, checks };
        fs.writeFileSync(path.join(root, 'verification/packaging.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
    }
    finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
main().catch(error => {
    console.error(error);
    fs.rmSync(temp, { recursive: true, force: true });
    process.exitCode = 1;
});
