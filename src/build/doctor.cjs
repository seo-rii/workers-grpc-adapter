'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { literalImports } = require('./imports.cjs');
const sdksDefault = ['@google-cloud/datastore', '@google-cloud/firestore', '@google-cloud/secret-manager'];
const adapterName = 'workers-grpc-adapter';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function packageFor(req, name) {
    // Resolve the package directory even if its exports hide package.json or its main is types-only.
    for (const base of req.resolve.paths('__wga_dependency__') || []) {
        const directory = path.join(base, name);
        const candidate = path.join(directory, 'package.json');
        // Legacy CommonJS resolution tries these files before a directory's
        // main (and before searching ancestor node_modules directories). An
        // exports map takes precedence over that legacy load-as-file step.
        const bareFile = ['.js', '.json', '.node'].some(extension => {
            const file = directory + extension;
            return fs.existsSync(file) && fs.statSync(file).isFile();
        });
        if (fs.existsSync(candidate) && (!bareFile || JSON.parse(fs.readFileSync(candidate, 'utf8')).exports != null)) return fs.realpathSync(candidate);
        // Node can load an installed directory's index.js without a manifest.
        // Do not call it absent or substitute an ancestor's package: either
        // would skip inspection of the installation the SDK actually loads.
        if (fs.existsSync(directory) || bareFile) throw Object.assign(new Error('dependency-manifest-missing'), { code: 'WGA_DOCTOR_MANIFEST_MISSING' });
    }
    throw Object.assign(new Error('dependency-not-installed'), { code: 'MODULE_NOT_FOUND' });
}
function resolveImports(imports) {
    if (!imports.length) return [];
    // Resolve each inspection in a clean process. CommonJS caches paths and
    // package metadata across createRequire instances, so a long-lived doctor
    // must not reuse the previous installation's resolution results.
    const source = `
        import { readFileSync, realpathSync, statSync } from 'node:fs';
        import { fileURLToPath } from 'node:url';
        import { createRequire } from 'node:module';
        const requests = JSON.parse(readFileSync(0, 'utf8'));
        const results = requests.map(([specifier, parent, kind]) => {
            try {
                const file = kind === 'import' ? fileURLToPath(import.meta.resolve(specifier, parent))
                    : createRequire(parent).resolve(specifier);
                // import.meta.resolve can return URLs for missing files and
                // directories. Neither is a loadable ESM file.
                return statSync(file).isFile() ? realpathSync(file) : null;
            } catch { return null; }
        });
        process.stdout.write(JSON.stringify(results));
    `;
    const result = spawnSync(process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '--eval', source], {
        encoding: 'utf8', input: JSON.stringify(imports.map(({ parent, entry }) => [entry.specifier, parent, entry.kind])),
        env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    });
    // A resolver failure leaves every import unresolved. Never fall back to
    // CommonJS resolution or include child stderr/environment in the report.
    if (result.error || result.status !== 0) return [];
    try {
        const resolved = JSON.parse(result.stdout);
        return Array.isArray(resolved) && resolved.length === imports.length
            && resolved.every(value => value === null || typeof value === 'string') ? resolved : [];
    } catch { return []; }
}
function inspect(base, sdks = sdksDefault, expected = 'workers-grpc-adapter', buildOptions) {
    base = path.resolve(base);
    const successStatus = expected === '@grpc/grpc-js' ? 'resolved-to-native' : 'resolved-to-replacement';
    const rel = value => path.relative(base, value).split(path.sep).join('/');
    const rootRequire = createRequire(path.join(base, 'package.json'));
    const lockPath = path.join(base, 'package-lock.json');
    const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, 'utf8')) : undefined;
    const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'].filter(file => fs.existsSync(path.join(base, file)))
        .map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(base, file))) }));
    const projectManifest = fs.existsSync(path.join(base, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(base, 'package.json'))) : {};
    const allPackages = new Map();
    const packageFailures = new Map();
    const pendingImports = [];
    const pendingRuntimeImports = [];
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
    const resolvedImport = (entry, full, resolved) => {
        // Resolution follows entrypoint and directory symlinks. The alias's
        // manifest cannot establish which package owns the resulting file.
        // Ignore unnamed package scopes used only to select CJS/ESM syntax.
        let directory = path.dirname(resolved), grpcManifestPath, grpcManifest;
        for (;;) {
            if (path.basename(directory) === 'node_modules') throw new Error('resolved-package-owner-missing');
            const candidate = path.join(directory, 'package.json');
            try {
                const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                if (typeof manifest.name === 'string' && manifest.name) {
                    grpcManifestPath = candidate; grpcManifest = manifest; break;
                }
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const parent = path.dirname(directory);
            if (parent === directory) throw new Error('resolved-package-owner-missing');
            directory = parent;
        }
        recordResolution(grpcManifestPath, rel(full), entry.specifier);
        Object.assign(entry, { resolved: rel(resolved), implementation: grpcManifest.name, version: grpcManifest.version,
            status: grpcManifest.name === expected ? successStatus : 'wrong-implementation' });
    };
    const sourceGoals = new Map();
    const sourceGoal = file => {
        if (/\.(?:mjs|d\.[cm]?ts)$/.test(file)) return 'module';
        if (file.endsWith('.cjs')) return 'script';
        // Node assigns .js files the nearest physical package scope. Source
        // symlinks and nested package.json files can differ from the package
        // whose dependency graph we are currently inspecting.
        const visited = [];
        let directory = path.dirname(file), goal = 'script';
        for (;;) {
            if (sourceGoals.has(directory)) { goal = sourceGoals.get(directory); break; }
            if (path.basename(directory) === 'node_modules') break;
            visited.push(directory);
            try {
                goal = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).type === 'module' ? 'module' : 'script';
                break;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            const parent = path.dirname(directory);
            if (parent === directory) break;
            directory = parent;
        }
        for (const directory of visited) sourceGoals.set(directory, goal);
        return goal;
    };
    const inspectSource = (state, full, declaration = false, nodeBin = false) => {
        if (state.visitedFiles.has(full)) return;
        const source = fs.readFileSync(full, 'utf8');
        // npm bins may be shell scripts or native programs. Only a Node
        // shebang makes an otherwise unknown bin file a JavaScript source.
        if (nodeBin && !/^#!(?:[^\r\n]*[\/\t ])?node(?:\s|$)/.test(source)) return;
        state.visitedFiles.add(full);
        for (const { kind, specifier, base: loaderBase } of literalImports(source, declaration, { includeLocal: !declaration, sourceType: sourceGoal(full) })) {
            let parent = pathToFileURL(full).href;
            if (loaderBase === null) parent = null;
            else if (loaderBase?.kind === 'literal') parent = loaderBase.value;
            else if (loaderBase?.kind === 'url') {
                try { parent = new URL(loaderBase.value, loaderBase.relative ? parent : undefined).href; }
                catch { parent = null; }
            }
            if (/^@grpc\/grpc-js(?:\/|$)/.test(specifier)) {
                const imported = { file: rel(full), specifier, kind, status: parent === null ? 'resolution-base-unverified' : 'resolution-failed' };
                state.record.grpcImports.push(imported);
                pendingImports.push({ full, entry: imported, parent });
            } else pendingRuntimeImports.push({ state, entry: { kind, specifier }, parent });
        }
    };
    const readPackage = manifestPath => {
        const directory = path.dirname(manifestPath);
        if (packageFailures.has(directory)) throw packageFailures.get(directory);
        try { return inspectPackage(manifestPath); }
        catch (error) { packageFailures.set(directory, error); throw error; }
    };
    const inspectPackage = manifestPath => {
        const directory = path.dirname(manifestPath);
        if (allPackages.has(directory)) return allPackages.get(directory);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const record = { name: manifest.name, version: manifest.version, path: rel(directory), integrity: lock?.packages?.[rel(directory)]?.integrity ?? null, dependencies: [], grpcImports: [] };
        allPackages.set(directory, record);
        const req = createRequire(manifestPath);
        for (const name of Object.keys({ ...manifest.peerDependencies, ...manifest.dependencies, ...manifest.optionalDependencies }).sort()) {
            let dependencyManifest;
            try {
                dependencyManifest = packageFor(req, name);
            } catch (error) {
                if (error.code !== 'MODULE_NOT_FOUND') throw error;
                // Peer metadata applies only to peer-only declarations. A
                // required direct dependency cannot become optional merely
                // because it is also advertised as an optional peer.
                const onlyPeer = !Object.hasOwn(manifest.dependencies || {}, name)
                    && !Object.hasOwn(manifest.optionalDependencies || {}, name);
                record.dependencies.push({ name, missing: true, optional: !!manifest.optionalDependencies?.[name]
                    || onlyPeer && manifest.peerDependenciesMeta?.[name]?.optional === true });
                continue;
            }
            // Optional means the package may be absent. An installed package
            // still has to pass manifest parsing and the complete source walk.
            recordResolution(dependencyManifest, rel(directory), name);
            const child = readPackage(dependencyManifest);
            record.dependencies.push({ name, path: child.path });
        }
        // Inspect all installed runtime and declaration imports, not only one GAX selected at the root.
        const pending = [directory];
        const visitedDirectories = new Set();
        const state = { directory, record, visitedFiles: new Set() };
        while (pending.length) {
            const current = fs.realpathSync(pending.pop());
            if (visitedDirectories.has(current)) continue;
            visitedDirectories.add(current);
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (['node_modules', '.git', '.hg', '.svn'].includes(entry.name)) continue;
                // Node follows source symlinks before resolving their imports.
                // Track physical directories/files to bound cycles and aliases,
                // but do not discard generated dot-directories or dot-files.
                const full = fs.realpathSync(path.join(current, entry.name));
                const info = entry.isSymbolicLink() ? fs.statSync(full) : entry;
                if (info.isDirectory()) pending.push(full);
                else if (info.isFile() && [full, entry.name].some(name => /\.(?:[cm]?js|d\.[cm]?ts)$/.test(name))) {
                    inspectSource(state, full, [full, entry.name].some(name => /\.d\.[cm]?ts$/.test(name)));
                }
            }
        }
        const seed = (specifier, kind = 'require', nodeBin = false) => {
            if (typeof specifier !== 'string' || !specifier) return;
            pendingRuntimeImports.push({ state, entry: { kind, specifier: path.isAbsolute(specifier) || specifier.startsWith('./') ? specifier : './' + specifier },
                parent: pathToFileURL(manifestPath).href, nodeBin });
        };
        seed(manifest.main);
        // Literal package targets are exact files, not CommonJS extension or
        // directory searches. Use the same ESM file resolver for discovery.
        const targets = [manifest.exports, manifest.imports];
        while (targets.length) {
            const target = targets.pop();
            if (typeof target === 'string') {
                if (target.startsWith('./') && !target.includes('*')) seed(target, 'import');
            } else if (target && typeof target === 'object') targets.push(...Object.values(target));
        }
        for (const bin of typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin || {})) seed(bin, 'require', true);
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
                // A completed member of a cycle can refer to another member
                // whose later source walk failed. Do not reuse that partial graph.
                const failure = packageFailures.get(path.resolve(base, node.path));
                if (failure) throw failure;
                closure.set(node.path, node);
                for (const dependency of node.dependencies) if (dependency.path) visit(byPath.get(dependency.path));
            };
            visit(first);
            const graph = [...closure.values()].sort((a, b) => a.path.localeCompare(b.path));
            const gax = graph.filter(item => item.name === 'google-gax');
            const grpc = graph.filter(item => item.name === expected || item.name === '@grpc/grpc-js');
            const unresolved = graph.flatMap(item => item.dependencies.filter(edge => edge.missing && !edge.optional).map(edge => `${item.path}:${edge.name}`));
            const imports = graph.flatMap(item => item.grpcImports);
            results.push({ sdk, version: first.version, status: 'wrong-implementation', gax: gax.map(item => ({ path: item.path, version: item.version })), grpc: grpc.map(item => ({ path: item.path, implementation: item.name, version: item.version })), grpcImportCount: imports.length, prerelease: graph.filter(item => /\d-/.test(item.version)).map(item => ({ name: item.name, version: item.version, expected: item.name === expected })), unresolved, graph });
        } catch (error) {
            results.push({ sdk, status: 'blocked', reason: error.code === 'MODULE_NOT_FOUND' ? 'dependency-not-installed' : 'resolution-failed' });
        }
    }
    // Batch local edges across the graph. Only resolved module targets enter
    // this walk, so README/data files do not become code based on their text.
    // Each physical file is visited once per owning package, bounding cycles.
    for (let next = 0; next < pendingRuntimeImports.length;) {
        const batch = pendingRuntimeImports.slice(next);
        next = pendingRuntimeImports.length;
        const runtimeFiles = resolveImports(batch);
        if (runtimeFiles.length !== batch.length) {
            for (const { state } of batch) packageFailures.set(state.directory, new Error('WGA_DOCTOR_RUNTIME_RESOLUTION'));
            continue;
        }
        for (let index = 0; index < batch.length; index++) {
            const full = runtimeFiles[index];
            if (!full || /\.(?:json|node)$/.test(full)) continue;
            const { state, entry, nodeBin } = batch[index];
            try { inspectSource(state, full, [full, entry.specifier].some(name => /\.d\.[cm]?ts$/.test(name)), nodeBin); }
            catch (error) { packageFailures.set(state.directory, error); }
        }
    }
    for (const record of allPackages.values()) record.grpcImports.sort((a, b) => `${a.file}:${a.specifier}:${a.kind}`.localeCompare(`${b.file}:${b.specifier}:${b.kind}`));
    const resolved = resolveImports(pendingImports);
    for (let index = 0; index < pendingImports.length; index++) if (resolved[index]) {
        const { full, entry } = pendingImports[index];
        try { resolvedImport(entry, full, resolved[index]); } catch { /* Keep the unresolved diagnostic. */ }
    }
    for (const result of results) if (result.graph) {
        if (result.graph.some(item => packageFailures.has(path.resolve(base, item.path)))) {
            result.status = 'blocked'; result.reason = 'resolution-failed'; continue;
        }
        result.grpcImportCount = result.graph.reduce((count, item) => count + item.grpcImports.length, 0);
        const passed = result.gax.length > 0 && result.grpc.length > 0 && result.grpc.every(item => item.implementation === expected)
            && result.grpcImportCount > 0 && result.graph.every(item => item.grpcImports.every(entry => entry.status === successStatus))
            && result.unresolved.length === 0;
        result.status = passed ? successStatus : 'wrong-implementation';
    }
    const installations = [...adapterInstallations.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const installation of installations) installation.resolvedBy.sort((a, b) => `${a.consumer}:${a.specifier}`.localeCompare(`${b.consumer}:${b.specifier}`));
    const identity = { status: installations.length > 1 ? 'duplicate-installations' : installations.length ? 'single-installation' : 'not-installed', installations };
    const diagnostics = installations.length > 1 ? [{
        code: 'WGA_DUPLICATE_ADAPTER_INSTALLATIONS',
        message: 'Multiple physical adapter installations can split Metadata, client, credential and configuration identity. Resolve application imports and every SDK alias to one installation.',
        paths: installations.map(item => item.path),
    }] : [];
    const buildProfile = buildOptions ? require('./index.cjs').inspectGoogleWorkerProfile({ projectRoot: base, ...buildOptions }) : undefined;
    return { ...(buildProfile ? { buildProfile } : {}), scope: 'installed dependency graph, default Node import/require resolution, declaration package-entry availability and physical adapter identity; no TypeScript semantic checks, inspected module execution, authentication or network requests', expectedImplementation: expected, environment: { node: process.version, platform: process.platform, arch: process.arch, packageManager: projectManifest.packageManager ?? null }, lockfiles, lockfileVersion: lock?.lockfileVersion ?? null, lockfileSha256: lock ? hash(fs.readFileSync(lockPath)) : null, graphSha256: hash(JSON.stringify({ results, identity })), identity, diagnostics, results, passed: diagnostics.length === 0 && results.every(item => item.status === successStatus) && (!buildProfile || buildProfile.passed) };
}
/** Read-only installed graph and physical runtime identity inspection. */
function inspectGoogleWorkerGraph(options) {
    if (!options || typeof options.projectRoot !== 'string' || !options.projectRoot
        || (options.sdks !== undefined && (!Array.isArray(options.sdks) || options.sdks.length === 0 || options.sdks.some(name => typeof name !== 'string' || !name)))
        || (options.expectedImplementation !== undefined && !['workers-grpc-adapter', '@grpc/grpc-js'].includes(options.expectedImplementation))) {
        throw new TypeError('WGA_DOCTOR_OPTIONS');
    }
    return inspect(options.projectRoot, options.sdks, options.expectedImplementation,
        options.profile === undefined ? undefined : { profile: options.profile, typescript: options.typescript });
}
module.exports = { inspect, inspectGoogleWorkerGraph };
