'use strict';
// Copied into each isolated installation; all package/type resolution starts there.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const base = process.cwd();
const req = createRequire(path.join(base, 'package.json'));
const relative = file => path.relative(base, file).split(path.sep).join('/');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function inside(file) {
    const resolved = fs.realpathSync(file);
    assert.ok(resolved.startsWith(base + path.sep), `Resolution escaped standalone consumer: ${relative(resolved)}`);
    return relative(resolved);
}
async function runtime() {
    const manifest = req('@grpc/grpc-js/package.json');
    const grpc = req('@grpc/grpc-js');
    const esm = await import('@grpc/grpc-js');
    const adapterRoot = path.dirname(req.resolve('@grpc/grpc-js/package.json'));
    assert.equal(manifest.name, 'workers-grpc-adapter');
    for (const key of ['Client', 'Metadata', 'ChannelCredentials', 'CallCredentials']) assert.strictEqual(esm[key], grpc[key]);
    assert.strictEqual(esm.credentials, grpc.credentials);
    assert.strictEqual(req('@grpc/grpc-js/build/src/client').Client, grpc.Client);
    assert.strictEqual(req('@grpc/grpc-js/build/src/client.js').Client, grpc.Client);
    const exports = [];
    for (const [key, value] of Object.entries(manifest.exports)) {
        const specifier = key === '.' ? '@grpc/grpc-js' : '@grpc/grpc-js' + key.slice(1);
        const targets = typeof value === 'string' ? { require: value } : value;
        for (const [condition, file] of Object.entries(targets)) {
            assert.ok(fs.statSync(path.join(adapterRoot, file)).isFile());
            inside(path.join(adapterRoot, file));
            exports.push({ specifier, condition, path: relative(path.join(adapterRoot, file)), sha256: hash(fs.readFileSync(path.join(adapterRoot, file))) });
        }
        req(specifier);
        if (targets.import) await import(specifier);
    }
    assert.throws(() => req('@grpc/grpc-js/build/src/channel'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    await assert.rejects(import('@grpc/grpc-js/build/src/channel'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    const lock = req('./package-lock.json');
    const consumers = [];
    const gax = [];
    for (const [location, entry] of Object.entries(lock.packages)) {
        if (!location) continue;
        const full = path.join(base, location, 'package.json');
        if (entry.optional && !fs.existsSync(full)) continue;
        const packageJson = JSON.parse(fs.readFileSync(full));
        assert.notEqual(packageJson.name, '@grpc/grpc-js', 'Native transport remains in alias graph');
        inside(full);
        assert.equal(fs.lstatSync(path.join(base, location)).isSymbolicLink(), false);
        if (packageJson.name === 'google-gax' || packageJson.name.startsWith('@google-cloud/')) {
            const from = createRequire(full);
            const resolved = from('@grpc/grpc-js');
            assert.strictEqual(resolved, grpc);
            const metadata = from('@grpc/grpc-js/package.json');
            assert.equal(metadata.name, manifest.name);
            assert.equal(metadata.version, manifest.version);
            const item = { consumer: location, name: packageJson.name, version: packageJson.version,
                grpc: inside(from.resolve('@grpc/grpc-js')), packageJson: inside(from.resolve('@grpc/grpc-js/package.json')),
                implementation: metadata.name, implementationVersion: metadata.version, sameClient: resolved.Client === esm.Client,
                sameMetadata: resolved.Metadata === esm.Metadata, sameCredentials: resolved.credentials === esm.credentials };
            consumers.push(item);
            if (packageJson.name === 'google-gax') {
                gax.push(item);
                const gaxClient = new (from('./build/src/grpc.js').GrpcClient)();
                assert.strictEqual(gaxClient.grpc.Client, esm.Client);
                assert.strictEqual(gaxClient.grpc.Metadata, esm.Metadata);
                assert.strictEqual(gaxClient.grpc.credentials, esm.credentials);
                const credentials = grpc.credentials.combineChannelCredentials(esm.credentials.createSsl(),
                    resolved.credentials.createFromMetadataGenerator((_options, callback) => callback(null, new esm.Metadata())));
                assert.ok(credentials instanceof grpc.ChannelCredentials);
            }
        }
    }
    assert.ok(gax.length >= 2, 'Requires distinct installed GAX copies');
    assert.ok(new Set(gax.map(item => item.version)).size >= 2, 'Requires different real GAX versions');
    const profile = process.argv[3];
    const diagnostics = req('@grpc/grpc-js/build').inspectGoogleWorkerProfile({ projectRoot: base, profile });
    assert.equal(diagnostics.passed, true, JSON.stringify(diagnostics.diagnostics));
    const inventory = req('./expected-inventory.json');
    const files = inventory.map(({ path: name, sha256 }) => {
        const file = path.join(adapterRoot, name);
        assert.equal(hash(fs.readFileSync(file)), sha256, `Packed file mismatch: ${name}`);
        inside(file);
        return name;
    });
    for (const required of ['LICENSE', 'NOTICE', 'vendor/LICENSE', 'vendor/NOTICE', 'vendor/UPSTREAM.json',
        'dist/build/profiles/google-static-v1.json', 'dist/build/profiles/google-modern-v1.json']) assert.ok(files.includes(required));
    for (const name of manifest.files) assert.ok(files.some(file => file === name || file.startsWith(name + '/')), `Missing published asset: ${name}`);
    return { consumers, gax, exports, packedFiles: files.length, inventorySha256: hash(JSON.stringify(inventory)),
        noNativeGrpcPackage: true, noWorkspaceResolution: true, esmCjsIdentity: true, credentialComposition: true, unsupportedDeepImportsRejected: true,
        buildProfile: { id: diagnostics.profile, revision: diagnostics.revision, passed: diagnostics.passed, transformationsChecked: diagnostics.transformationsChecked } };
}
function types() {
    const ts = req('typescript');
    const results = [];
    const files = fs.readdirSync(base).filter(name => /\.[mc]ts$/.test(name)).map(name => path.join(base, name));
    assert.ok(files.length >= 2);
    for (const [mode, module, moduleResolution] of [['node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16],
        ['nodenext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
        const options = { target: ts.ScriptTarget.ES2022, lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'], strict: true, skipLibCheck: false,
            esModuleInterop: true, noEmit: true, types: ['node'], module, moduleResolution };
        assert.equal('typeRoots' in options, false);
        const program = ts.createProgram(files, options);
        const diagnostics = ts.getPreEmitDiagnostics(program);
        assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: file => file, getCurrentDirectory: () => base, getNewLine: () => '\n',
        }));
        const resolvedFiles = program.getSourceFiles().map(file => inside(file.fileName)).sort();
        assert.ok(resolvedFiles.some(file => file.startsWith('node_modules/typescript/lib/')));
        assert.ok(resolvedFiles.some(file => file.startsWith('node_modules/@types/node/')));
        results.push({ mode, status: 'passed', strict: true, skipLibCheck: false, customTypeRoots: false,
            workspaceSymlinks: false, allCompilerInputsInsideConsumer: true, sourceFiles: files.length,
            resolvedFiles: resolvedFiles.length, resolutionSha256: hash(JSON.stringify(resolvedFiles)) });
    }
    return { typescript: ts.version, nodeTypes: req('@types/node/package.json').version, results };
}
function offline() {
    const Module = require('node:module');
    const counters = { network: 0, fetch: 0, auth: 0, runtimeImports: 0, credentialReads: 0 };
    const denied = () => { counters.network++; throw new Error('NETWORK_DENIED'); };
    globalThis.fetch = () => { counters.fetch++; throw new Error('FETCH_DENIED'); };
    for (const name of ['node:http', 'node:https']) { const module = require(name); module.request = module.get = denied; }
    require('node:http2').connect = denied;
    const net = require('node:net'); net.connect = net.createConnection = net.Socket.prototype.connect = denied;
    require('node:tls').connect = denied;
    const dns = require('node:dns');
    for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[key] = dns.promises[key] = denied;
    const cp = require('node:child_process');
    for (const key of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) cp[key] = denied;
    const load = Module._load;
    Module._load = function(specifier, parent, isMain) {
        if (specifier === 'google-auth-library' || specifier.startsWith('google-auth-library/')) {
            counters.auth++; throw new Error('AUTH_DENIED');
        }
        const resolved = Module._resolveFilename(specifier, parent, isMain);
        if (resolved.startsWith(base + path.sep)) { counters.runtimeImports++; throw new Error('INSPECTED_RUNTIME_IMPORT_DENIED'); }
        return load.call(this, specifier, parent, isMain);
    };
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
        if (/application_default_credentials\.json|[/\\]gcloud[/\\]/.test(String(file))) {
            counters.credentialReads++; throw new Error('CREDENTIAL_READ_DENIED');
        }
        return read.call(this, file, ...args);
    };
    assert.deepEqual(Object.keys(process.env).filter(key => /^(GOOGLE_|GCLOUD_|GCE_|CLOUDSDK_)/.test(key)), []);
    const result = require(process.argv[3]).inspect(base);
    assert.equal(result.passed, true);
    assert.deepEqual(counters, { network: 0, fetch: 0, auth: 0, runtimeImports: 0, credentialReads: 0 });
    return { status: 'passed', doctorPassed: true, credentialsEnvironmentAbsent: true, networkDenied: true,
        counters, graphSha256: result.graphSha256, identity: result.identity.status };
}
(async () => {
    const result = process.argv[2] === 'types' ? types() : process.argv[2] === 'offline' ? offline() : await runtime();
    process.stdout.write(JSON.stringify(result) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
