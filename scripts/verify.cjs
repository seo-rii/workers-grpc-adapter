'use strict';
/** Local verification only. This command cannot opt into Google API calls. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'verification');
fs.mkdirSync(output, { recursive: true });
const commands = [];
const safeEnv = { ...process.env, WGA_RUN_GOOGLE_TESTS: '0', WGA_ALLOW_TEST_WRITES: '0' };
function run(name, args, allowed = [0]) {
    const logPath = path.join(output, `${name}.log`);
    const log = fs.openSync(logPath, 'w', 0o600);
    fs.fchmodSync(log, 0o600);
    let result;
    try {
        result = cp.spawnSync(process.execPath, args, { cwd: root, env: safeEnv, stdio: ['ignore', log, log], timeout: 300000 });
    } finally { fs.closeSync(log); }
    const text = fs.readFileSync(logPath, 'utf8');
    commands.push({ id: name, exitCode: result.status, status: result.status === 0 ? 'passed' : result.status === 2 && allowed.includes(2) ? 'blocked' : 'failed', log: `${name}.log` });
    if (result.error || !allowed.includes(result.status)) {
        throw new Error(`Local step ${name} failed. See verification/${name}.log.`);
    }
    console.log(`${name}: ${commands.at(-1).status}`);
    return text;
}
function filesIn(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const name = path.join(dir, entry.name);
        return entry.isDirectory() ? ['node_modules', '.wrangler', '.git', '.cache', '.wga-build'].includes(entry.name) ? [] : filesIn(name) : [name];
    });
}
function hash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function read(name) {
    return JSON.parse(fs.readFileSync(path.join(output, name), 'utf8'));
}
function main() {
    const { captureInputs, writeEvidence, checkEvidence } = require('./test-evidence.cjs');
    const evidenceInputHashes = captureInputs(root);
    run('build', ['scripts/build.cjs']);
    const testFiles = filesIn(path.join(root, 'test')).filter(p => p.endsWith('.test.cjs')).sort();
    const tap = run('tests', ['--test', '--test-reporter=tap', ...testFiles]);
    fs.writeFileSync(path.join(output, 'tests.tap'), tap);
    const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
    if (!Number.isInteger(totals.tests) || totals.tests === 0 || totals.fail !== 0 || totals.skipped !== 0 || totals.cancelled !== 0) {
        throw new Error('Unexpected local test totals.');
    }
    run('types', ['scripts/test-types.cjs']);
    run('vendor', ['vendor/verify.cjs']);
    run('exports-contract', ['scripts/test-contract.cjs']);
    run('native-differential', ['test/native-differential.cjs']);
    run('sdk-types', ['scripts/test-sdk-types.cjs']);
    run('sdk-local', ['scripts/google-local-test.cjs']);
    run('google-auth', ['scripts/test-google-auth.cjs']);
    const syntaxFiles = ['scripts', 'test', 'fixtures'].flatMap(dir => filesIn(path.join(root, dir))).filter(p => /\.(mjs|cjs)$/.test(p) && !p.includes(`${path.sep}node_modules${path.sep}`));
    for (const file of syntaxFiles) {
        const result = cp.spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8', timeout: 10000 });
        if (result.status !== 0) {
            throw new Error(`Syntax check failed for ${path.relative(root, file)}: ${result.stderr}`);
        }
    }
    const syntax = { status: 'passed', fileCount: syntaxFiles.length, includesGoogleFixtures: true, sdkExecution: false };
    fs.writeFileSync(path.join(output, 'syntax.json'), JSON.stringify(syntax, null, 2) + '\n');
    run('packaging', ['scripts/test-pack.cjs']);
    run('workers-preflight', ['scripts/workers-test.cjs']);
    run('workers-sdk', ['scripts/workers-sdk-test.cjs']);
    run('workers-gax-modes', ['scripts/test-gax-mode-isolation.cjs']);
    run('workers-lazy-sdk', ['scripts/test-workers-lazy-sdk.cjs']);
    run('workers-auth', ['scripts/test-workers-auth.cjs']);
    run('workers-federated-auth', ['scripts/test-workers-federated-auth.cjs']);
    run('workers-legacy-auth', ['scripts/test-workers-legacy-auth.cjs']);
    run('workers-fetcher', ['scripts/test-workers-fetcher.cjs']);
    run('workers-compression', ['scripts/test-workers-compression.cjs']);
    run('workers-retries', ['scripts/test-workers-retries.cjs']);
    run('health', ['scripts/test-health.cjs']);
    run('secret-manager-extended', ['scripts/test-secret-manager-extended.cjs']);
    run('datastore-pagination', ['scripts/test-datastore-pagination.cjs']);
    run('workers-resilience', ['scripts/test-workers-resilience.cjs']);
    run('google-worker-build', ['scripts/test-google-worker-build.cjs']);
    run('gcp-probe-build', ['scripts/test-gcp-probe.cjs']);
    run('gcp-probe-readiness', ['scripts/test-gcp-readiness.cjs']);
    run('gcp-probe-conversion', ['scripts/test-gcp-conversion-probe.cjs']);
    run('google-conversion-wire', ['scripts/test-google-conversion-wire.cjs']);
    run('gcp-probe-cleanup', ['scripts/test-gcp-cleanup.cjs']);
    run('workers-shared', ['scripts/workers-shared-test.cjs']);
    run('envoy', ['scripts/envoy-test.cjs'], [0, 2]);
    run('google-emulators', ['scripts/google-emulator-test.cjs']);
    run('emulator-lifecycle', ['fixtures/emulators/lifecycle.cjs']);
    // Forces live flag off even if the caller's environment opted in.
    run('google-preflight', ['scripts/google-test.cjs'], [0, 2]);
    const sdkLocal = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/google-local.json')));
    const sdkTypes = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/google-types.json')));
    const sdkGraph = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/google-graph.json')));
    const googleEmulators = read('google-emulators.json');
    const datastorePagination = read('datastore-pagination.json');
    const secretManagerExtended = read('secret-manager-extended.json');
    const shared = filesIn(path.join(root, 'fixtures/google/shared')).filter(p => p.endsWith('.mjs')).map(file => ({ file: path.relative(root, file), sha256: hash(file),
        nativeBaselineCompared: Boolean((sdkLocal.sameSharedFiles && sdkLocal.sourceHashes.native[path.basename(file)] === hash(file))
            || (googleEmulators.sameSharedFiles && googleEmulators.sourceHashes.native[path.basename(file)] === hash(file))
            || (datastorePagination.sameSharedSource && datastorePagination.sourceHashes.native[path.basename(file)] === hash(file))
            || (secretManagerExtended.sameSharedSource && secretManagerExtended.sourceHashes.native[path.basename(file)] === hash(file))) }));
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/test-catalog.json')));
    const sourceFiles = ['src', 'scripts', 'test', 'fixtures'].flatMap(dir => filesIn(path.join(root, dir))).filter(p => /\.(ts|cts|mts|mjs|cjs|proto|json|jsonc|yaml)$/.test(p));
    const sourceHashes = Object.fromEntries(sourceFiles.sort().map(file => [path.relative(root, file), hash(file)]));
    const report = {
        generatedAt: new Date().toISOString(), package: require('../package.json').name, version: require('../package.json').version,
        status: sdkTypes.status === 'passed' ? 'local-gates-passed-cloud-certification-blocked' : 'local-runtime-gates-passed-upstream-types-and-cloud-blocked', releaseEligible: false,
        environment: { node: process.version, platform: process.platform, arch: process.arch, npm: cp.execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim() },
        build: read('build.json'), tests: { ...totals, sdkTestsIncluded: false, googleHarnessOnlyTestsIncluded: true, actualLoopbackHttp2InteropIncluded: true, upstreamGrpcJsOracle: true },
        declarations: read('types.json'), packaging: read('packaging.json'), syntax,
        googleSdk: { graph: sdkGraph, declarations: sdkTypes, local: sdkLocal },
        googleAuth: read('google-auth.json'),
        googleEmulators, emulatorLifecycle: read('emulator-lifecycle.json'),
        nativeDifferential: read('native-differential.json'),
        workers: read('workers.json'), workersSdk: read('workers-sdk.json'), workersGaxModes: read('workers-gax-modes.json'),
        workersLazySdk: read('workers-lazy-sdk.json'), workersAuth: read('workers-auth.json'),
        workersFederatedAuth: read('workers-federated-auth.json'), workersLegacyAuth: read('workers-legacy-auth.json'), workersFetcher: read('workers-fetcher.json'), workersCompression: read('workers-compression.json'), workersRetries: read('workers-retries.json'), health: read('health.json'), secretManagerExtended,
        datastorePagination, workersResilience: read('workers-resilience.json'),
        workersShared: read('workers-shared.json'), envoy: read('envoy.json'), googlePreflight: read('google-preflight.json'),
        liveGoogleApiExecuted: false, deployedCloudflareExecuted: false, fullDropInCertified: false,
        originalSpecCatalog: { plannedCases: catalog.cases.length, allSatisfied: false, evidence: 'evidence.json' },
        evidenceInputHashes,
        sharedBusinessFiles: shared, sourceHashes, commands,
        blockers: [...(sdkTypes.status !== 'passed' ? ['Google SDK Node16 declarations fail identically in the native baseline; see compatibility/google-types.json.'] : []), 'This local gate excludes deployed Cloudflare conversion and live Google E2E; see the separate gcp-cloud-probe receipt.', 'The full 189-case catalog, full grpc-js API parity and production performance certification remain release gates.'],
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    writeEvidence(root);
    checkEvidence(root);
    console.log(JSON.stringify({ localTests: totals, packaging: 'passed', declarations: 'passed', syntax: 'passed', workers: report.workers.status, liveGoogleApiExecuted: false, releaseEligible: false }, null, 2));
}
try {
    main();
}
catch (error) {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', releaseEligible: false, error: error.message, commands }, null, 2) + '\n');
    console.error(error.message);
    process.exitCode = 1;
}
