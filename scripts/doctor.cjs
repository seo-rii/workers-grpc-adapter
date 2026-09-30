'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const sdksDefault = ['@google-cloud/datastore', '@google-cloud/firestore', '@google-cloud/secret-manager'];
const adapterName = 'workers-grpc-adapter';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function packageFor(req, name) {
    // Resolve the package directory even if its exports hide package.json or its main is types-only.
    for (const base of req.resolve.paths('__wga_dependency__') || []) {
        const candidate = path.join(base, name, 'package.json');
        if (fs.existsSync(candidate)) return fs.realpathSync(candidate);
    }
    throw Object.assign(new Error('dependency-not-installed'), { code: 'MODULE_NOT_FOUND' });
}
function inspect(base, sdks = sdksDefault, expected = 'workers-grpc-adapter', buildOptions) {
    base = path.resolve(base);
    const successStatus = expected === '@grpc/grpc-js' ? 'resolved-to-native' : 'resolved-to-replacement';
    const rel = value => path.relative(base, value).split(path.sep).join('/');
    const rootRequire = createRequire(path.join(base, 'package.json'));
    const lockPath = path.join(base, 'package-lock.json');
    const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : undefined;
    const allPackages = new Map();
    const adapterInstallations = new Map();
    const recordResolution = (manifestPath, consumer, specifier) => {
        // Module identity follows physical paths, not package names or matching versions.
        // Read manifests only: requiring an inspected package could authenticate or fetch.
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.name !== adapterName) return;
        const directory = fs.realpathSync(path.dirname(manifestPath));
        let installation = adapterInstallations.get(directory);
        if (!installation) {
            installation = { path: rel(directory), version: manifest.version, resolvedBy: [] };
            adapterInstallations.set(directory, installation);
        }
        if (!installation.resolvedBy.some(item => item.consumer === consumer && item.specifier === specifier)) {
            installation.resolvedBy.push({ consumer, specifier });
        }
    };
    // An application may import the adapter's own name while its SDK imports the alias.
    // Neither root resolution needs to occur in the SDK's declared dependency closure.
    for (const specifier of [adapterName, '@grpc/grpc-js']) {
        try { recordResolution(packageFor(rootRequire, specifier), '.', specifier); }
        catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
    const readPackage = manifestPath => {
        const directory = path.dirname(manifestPath);
        if (allPackages.has(directory)) return allPackages.get(directory);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const record = { name: manifest.name, version: manifest.version, path: rel(directory), integrity: lock?.packages?.[rel(directory)]?.integrity ?? null, dependencies: [], grpcImports: [] };
        allPackages.set(directory, record);
        const req = createRequire(manifestPath);
        for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
            try {
                const dependencyManifest = packageFor(req, name);
                recordResolution(dependencyManifest, rel(directory), name);
                const child = readPackage(dependencyManifest);
                record.dependencies.push({ name, path: child.path });
            } catch (error) {
                record.dependencies.push({ name, missing: true, optional: !!manifest.optionalDependencies?.[name] });
            }
        }
        // Inspect all installed runtime and declaration imports, not only one GAX selected at the root.
        const pending = [directory];
        while (pending.length) {
            const current = pending.pop();
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
                const full = path.join(current, entry.name);
                if (entry.isDirectory()) pending.push(full);
                else if (entry.isFile() && /\.(?:[cm]?js|d\.ts)$/.test(entry.name)) {
                    const source = fs.readFileSync(full, 'utf8');
                    const imports = new Set([...source.matchAll(/(?:require\s*\(\s*|from\s+|import\s*\(\s*|import\s*)['"](@grpc\/grpc-js(?:\/[^'"]*)?)['"]/g)].map(match => match[1]));
                    for (const specifier of imports) {
                        try {
                            const fromFile = createRequire(full);
                            const resolved = fromFile.resolve(specifier);
                            const grpcManifestPath = packageFor(fromFile, '@grpc/grpc-js');
                            recordResolution(grpcManifestPath, rel(full), specifier);
                            const grpcManifest = JSON.parse(fs.readFileSync(grpcManifestPath, 'utf8'));
                            record.grpcImports.push({ file: rel(full), specifier, resolved: rel(resolved), implementation: grpcManifest.name, version: grpcManifest.version, status: grpcManifest.name === expected ? successStatus : 'wrong-implementation' });
                        } catch {
                            record.grpcImports.push({ file: rel(full), specifier, status: 'resolution-failed' });
                        }
                    }
                }
            }
        }
        record.grpcImports.sort((a, b) => `${a.file}:${a.specifier}`.localeCompare(`${b.file}:${b.specifier}`));
        return record;
    };
    const results = [];
    for (const sdk of sdks) {
        try {
            const first = readPackage(packageFor(rootRequire, sdk));
            const byPath = new Map([...allPackages.values()].map(item => [item.path, item]));
            const closure = new Map();
            const visit = node => {
                if (!node || closure.has(node.path)) return;
                closure.set(node.path, node);
                for (const dependency of node.dependencies) if (dependency.path) visit(byPath.get(dependency.path));
            };
            visit(first);
            const graph = [...closure.values()].sort((a, b) => a.path.localeCompare(b.path));
            const gax = graph.filter(item => item.name === 'google-gax');
            const grpc = graph.filter(item => item.name === expected || item.name === '@grpc/grpc-js');
            const unresolved = graph.flatMap(item => item.dependencies.filter(edge => edge.missing && !edge.optional).map(edge => `${item.path}:${edge.name}`));
            const imports = graph.flatMap(item => item.grpcImports);
            const passed = gax.length > 0 && grpc.length > 0 && grpc.every(item => item.name === expected) && imports.length > 0 && imports.every(item => item.status === successStatus) && unresolved.length === 0;
            results.push({ sdk, version: first.version, status: passed ? successStatus : 'wrong-implementation', gax: gax.map(item => ({ path: item.path, version: item.version })), grpc: grpc.map(item => ({ path: item.path, implementation: item.name, version: item.version })), grpcImportCount: imports.length, prerelease: graph.filter(item => /\d-/.test(item.version)).map(item => ({ name: item.name, version: item.version, expected: item.name === expected })), unresolved, graph });
        } catch (error) {
            results.push({ sdk, status: 'blocked', reason: error.code === 'MODULE_NOT_FOUND' ? 'dependency-not-installed' : 'resolution-failed' });
        }
    }
    const installations = [...adapterInstallations.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const installation of installations) installation.resolvedBy.sort((a, b) => `${a.consumer}:${a.specifier}`.localeCompare(`${b.consumer}:${b.specifier}`));
    const identity = { status: installations.length > 1 ? 'duplicate-installations' : installations.length ? 'single-installation' : 'not-installed', installations };
    const diagnostics = installations.length > 1 ? [{
        code: 'WGA_DUPLICATE_ADAPTER_INSTALLATIONS',
        message: 'Multiple physical adapter installations can split Metadata, client, credential and configuration identity. Resolve application imports and every SDK alias to one installation.',
        paths: installations.map(item => item.path),
    }] : [];
    const buildProfile = buildOptions ? require('../src/build/index.cjs').inspectGoogleWorkerProfile({ projectRoot: base, ...buildOptions }) : undefined;
    return { ...(buildProfile ? { buildProfile } : {}), scope: 'installed dependency graph, runtime/declaration grpc-js import resolution and physical adapter identity; graph inspection performs no runtime imports, authentication or network requests', expectedImplementation: expected, environment: { node: process.version, platform: process.platform, arch: process.arch }, lockfileVersion: lock?.lockfileVersion ?? null, lockfileSha256: lock ? hash(fs.readFileSync(lockPath)) : null, graphSha256: hash(JSON.stringify({ results, identity })), identity, diagnostics, results, passed: diagnostics.length === 0 && results.every(item => item.status === successStatus) && (!buildProfile || buildProfile.passed) };
}
if (require.main === module) {
    const args = process.argv.slice(2), profileFlag = args.find(arg => arg.startsWith('--profile='));
    if (args.some(arg => arg.startsWith('--') && arg !== profileFlag)) throw new Error('Usage: doctor.cjs [projectRoot] [report.json] [--profile=google-static-v1|google-modern-v1]');
    const positional = args.filter(arg => !arg.startsWith('--'));
    const profile = profileFlag?.slice('--profile='.length) ?? (positional.length ? undefined : 'google-static-v1');
    const report = inspect(positional[0] || path.resolve(__dirname, '../fixtures/google'), undefined, undefined,
      profile ? { profile, typescript: require('typescript') } : undefined);
    if (positional[1]) fs.writeFileSync(path.resolve(positional[1]), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(positional[1] ? { ...report, results: report.results.map(({ graph, ...item }) => ({ ...item, packageCount: graph?.length ?? 0 })) } : report, null, 2));
    process.exitCode = report.passed ? 0 : 2;
}
module.exports = { inspect };
