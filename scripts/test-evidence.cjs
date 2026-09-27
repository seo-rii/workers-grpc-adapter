'use strict';
/** Offline evidence validation. Coverage is reviewed explicitly; passing tests never imply full catalog coverage. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const ts = require('typescript');
const ROOT = path.resolve(__dirname, '..');
const GENERATED_COMPATIBILITY = new Set(['exports-contract.json', 'google-graph.json', 'google-native-graph.json', 'google-types.json', 'google-local.json']);
const OUTPUTS = ['verification/report.json', 'verification/tests.tap', 'verification/build.json', 'verification/types.json',
    'verification/packaging.json', 'verification/packaging-fixture.lock.json', 'verification/native-differential.json',
    'verification/google-auth.json', 'verification/workers.json', 'verification/workers-sdk.json',
    'verification/workers-gax-modes.json', 'verification/workers-lazy-sdk.json', 'verification/workers-auth.json',
    'verification/datastore-pagination.json', 'verification/workers-resilience.json',
    'verification/workers-federated-auth.json', 'verification/workers-legacy-auth.json', 'verification/secret-manager-extended.json',
    'verification/workers-fetcher.json',
    'verification/workers-compression.json', 'verification/workers-retries.json',
    'verification/workers-sdk-build.json', 'verification/workers-shared.json', 'verification/google-emulators.json', 'verification/emulator-lifecycle.json', 'verification/envoy.json', 'verification/google-preflight.json',
    ...[...GENERATED_COMPATIBILITY].map(file => `compatibility/${file}`)];
function fail(message) { throw new Error(`WGA_EVIDENCE_INVALID: ${message}`); }
function need(condition, message) { if (!condition) fail(message); }
function location(root, relative) {
    need(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), `invalid relative path: ${relative}`);
    return path.join(root, relative);
}
function digest(bytes, algorithm = 'sha256', encoding = 'hex') { return crypto.createHash(algorithm).update(bytes).digest(encoding); }
function hash(root, file) { return digest(fs.readFileSync(location(root, file))); }
function read(root, file) { return JSON.parse(fs.readFileSync(location(root, file), 'utf8')); }
function walk(root, dir) {
    return fs.readdirSync(location(root, dir), { withFileTypes: true }).flatMap(entry => {
        if (entry.name.startsWith('.') || ['node_modules', 'dist', 'artifacts'].includes(entry.name)) return [];
        const file = `${dir}/${entry.name}`;
        return entry.isDirectory() ? walk(root, file) : [file];
    });
}
function captureInputs(root = ROOT) {
    const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'PLAN.md', 'LICENSE', 'NOTICE', '.github/workflows/local.yml',
        ...['src', 'scripts', 'test', 'fixtures', 'docs', 'vendor'].flatMap(dir => walk(root, dir)),
        ...walk(root, 'compatibility').filter(file => !GENERATED_COMPATIBILITY.has(path.basename(file)))];
    return Object.fromEntries([...new Set(files)].sort().map(file => [file, hash(root, file)]));
}
function validateSnapshot(expected, actual, label) {
    need(expected && typeof expected === 'object' && Object.keys(expected).length > 0, `${label}: missing pre-execution hashes`);
    const changed = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].filter(file => expected[file] !== actual[file]);
    need(changed.length === 0, `${label}: stale or missing hashes: ${changed.slice(0, 5).join(', ')}`);
}
function runtimeFiles(root, directory) {
    function collect(relative) {
        return fs.readdirSync(location(root, relative), { withFileTypes: true }).flatMap(entry => {
            const file = `${relative}/${entry.name}`;
            if (entry.isDirectory()) return collect(file);
            need(entry.isFile(), `${file}: runtime artifact must be a regular file`);
            return [file];
        });
    }
    return collect(directory).sort();
}
function validateRuntimeCopies(root) {
    const directories = ['dist', ...['google', 'worker'].map(fixture => `fixtures/${fixture}/node_modules/@grpc/grpc-js/dist`)];
    const artifacts = {};
    let expected;
    for (const directory of directories) {
        const current = {};
        for (const file of runtimeFiles(root, directory)) {
            const value = hash(root, file);
            current[file.slice(directory.length + 1)] = value;
            artifacts[file] = value;
        }
        if (expected) validateSnapshot(expected, current, `${directory}: installed runtime`);
        else { need(Object.keys(current).length > 0, 'runtime build is empty'); expected = current; }
    }
    return artifacts;
}
function namedTests(source, file) {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const names = [];
    function visit(node) {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['test', 'it'].includes(node.expression.text)
            && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) names.push(node.arguments[0].text);
        ts.forEachChild(node, visit);
    }
    visit(ast);
    return names;
}
function tapResults(tap) {
    const results = new Map();
    for (const line of tap.split('\n')) {
        const match = /^(not ok|ok) \d+ - (.*?)(?: #\s*(SKIP|TODO)\b.*)?$/.exec(line);
        if (match) {
            const name = match[2].replace(/\\#/g, '#');
            need(!results.has(name), `duplicate TAP name: ${name}`);
            results.set(name, match[1] === 'ok' && !match[3] ? 'passed' : match[3] ? 'not_run' : 'failed');
        }
    }
    return results;
}
function pointer(value, expression) {
    need(typeof expression === 'string' && (expression === '' || expression.startsWith('/')), 'invalid JSON pointer');
    for (const raw of expression.split('/').slice(1)) {
        const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        need(value !== null && typeof value === 'object' && Object.hasOwn(value, key), `missing JSON pointer ${expression}`);
        value = value[key];
    }
    return value;
}
function validateReferences(item, context) {
    return item.references.map(ref => {
        need(typeof ref.source === 'string' && context.inputs[ref.source], `${item.id}: reference source is absent from execution inputs`);
        const command = context.report.commands.find(entry => entry.id === ref.command);
        need(command?.status === 'passed' && command.exitCode === 0, `${item.id}: command ${ref.command} did not pass`);
        if (ref.kind === 'tap') {
            need(namedTests(context.text(ref.source), ref.source).includes(ref.name), `${item.id}: named test does not exist in ${ref.source}: ${ref.name}`);
            need(context.tap.get(ref.name) === 'passed', `${item.id}: named test did not pass: ${ref.name}`);
        } else if (ref.kind === 'json-case') {
            need(typeof ref.anchor === 'string' && ref.anchor.length > 3 && context.text(ref.source).includes(ref.anchor), `${item.id}: report case source anchor is missing`);
            const report = context.json(ref.report);
            const values = pointer(report, ref.array);
            need(Array.isArray(values), `${item.id}: report case selector is not an array`);
            need(ref.where && Object.keys(ref.where).length > 0, `${item.id}: report reference needs a specific case selector`);
            const selected = values.filter(value => Object.entries(ref.where).every(([key, expected]) => isDeepStrictEqual(key === '$value' ? value : value?.[key], expected)));
            need(selected.length === 1, `${item.id}: report case selector must match exactly once`);
            if (selected[0] && typeof selected[0] === 'object' && Object.hasOwn(selected[0], 'status')) need(selected[0].status === 'passed', `${item.id}: report case did not pass`);
            need(Array.isArray(ref.assertions) && ref.assertions.length > 0, `${item.id}: report case needs assertions`);
            for (const assertion of ref.assertions) need(isDeepStrictEqual(pointer(selected[0], assertion.pointer), assertion.equals), `${item.id}: report case assertion failed at ${assertion.pointer}`);
        } else fail(`${item.id}: unknown evidence reference kind`);
        return ref;
    });
}
function validateMapping(catalog, mapping, context) {
    need(catalog.schemaVersion === 1 && mapping.schemaVersion === 1, 'unknown catalog/mapping schema');
    const ids = catalog.cases.map(item => item.id);
    need(new Set(ids).size === ids.length && isDeepStrictEqual(mapping.cases.map(item => item.id).sort(), [...ids].sort()), 'mapping must enumerate every catalog ID exactly once');
    need(mapping.releaseEligible === false, 'mapping cannot certify release eligibility');
    const output = [];
    for (const item of mapping.cases) {
        const spec = catalog.cases.find(entry => entry.id === item.id);
        need(item.catalogCaseSha256 === digest(JSON.stringify(spec)), `${item.id}: catalog definition changed without a coverage review`);
        need(['covered', 'partial', 'unimplemented'].includes(item.coverage), `${item.id}: invalid coverage`);
        need(Array.isArray(item.references) && Array.isArray(item.gaps) && typeof item.reason === 'string' && item.reason.length > 15, `${item.id}: missing coverage rationale`);
        need(item.coverage !== 'covered' || item.references.length > 0 && item.gaps.length === 0, `${item.id}: full coverage cannot retain gaps or lack evidence`);
        need(item.coverage !== 'partial' || item.references.length > 0 && item.gaps.length > 0, `${item.id}: partial coverage needs evidence and explicit gaps`);
        need(item.coverage !== 'unimplemented' || item.references.length === 0 && item.gaps.length > 0, `${item.id}: unimplemented case must be explicitly not run`);
        const checked = validateReferences(item, context);
        output.push({ id: item.id, coverage: item.coverage, execution: checked.length ? 'passed' : 'not_run', satisfiesPlannedCase: item.coverage === 'covered', reason: item.reason, gaps: item.gaps, references: checked });
    }
    return output;
}
function validateProfileManifest(profile, build) {
    // createGoogleWorkerBuild hashes its parsed JSON object. The raw profile
    // file has a separate input snapshot and installed-file comparison.
    need(build.profile === profile.id && build.revision === profile.revision && build.profileSha256 === digest(JSON.stringify(profile)), 'Workers profile hash/revision drift');
    need(isDeepStrictEqual(build.loaderOptions, profile.loaderOptions) && build.loaderOptionsSha256 === digest(JSON.stringify(profile.loaderOptions)), 'loader options drift');
}
function validateSupplementalCases(mapping, context) {
    const items = mapping.supplementalCases || [];
    need(Array.isArray(items) && new Set(items.map(item => item.id)).size === items.length, 'duplicate supplemental evidence ID');
    return items.map(item => {
        need(item.appliesToOriginalCatalog === false && !mapping.cases.some(planned => planned.id === item.id), 'supplemental execution cannot claim a planned catalog case');
        need(typeof item.reason === 'string' && item.reason.length > 15 && item.references?.length > 0, 'supplemental execution needs a scope and concrete references');
        return { ...item, execution: 'passed', references: validateReferences(item, context) };
    });
}
const EMULATOR_SHARED_FILES = ['assert.mjs', 'datastore.mjs', 'firestore.mjs', 'emulator-datastore.mjs', 'emulator-datastore-streams.mjs', 'emulator-firestore.mjs', 'emulator-suites.mjs'];
const EMULATOR_INPUTS = ['scripts/google-emulator-test.cjs', 'scripts/emulator-envoy.cjs', 'fixtures/google/emulator-worker.mjs',
    'fixtures/emulators/toolchain.json', 'fixtures/emulators/launcher.cjs', 'fixtures/emulators/download.cjs',
    'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'];
function emulatorSuites(root) {
    const suites = [];
    for (const file of ['emulator-suites.mjs', 'emulator-datastore.mjs', 'emulator-datastore-streams.mjs', 'emulator-firestore.mjs']) {
        const ast = ts.createSourceFile(file, fs.readFileSync(location(root, `fixtures/google/shared/${file}`), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
        function visit(node) {
            if (ts.isObjectLiteralExpression(node)) {
                const fields = Object.fromEntries(node.properties.filter(property => ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)).map(property => [property.name.getText(ast).replace(/^['"]|['"]$/g, ''), property.initializer.text]));
                if (fields.sdk && fields.suite) suites.push({ sdk: fields.sdk, suite: fields.suite });
            }
            ts.forEachChild(node, visit);
        }
        visit(ast);
    }
    need(suites.length > 0 && new Set(suites.map(item => item.suite)).size === suites.length, 'emulator suite registry is missing or ambiguous');
    return suites;
}
function validateEmulatorReport(report, { toolchain, envoyPin, suites }) {
    need(report?.status === 'passed' && report.realGoogleSDK === true && report.officialEmulators === true, 'official emulator execution did not pass');
    need(report.liveGoogleApiExecuted === false && report.deployedCloudflareExecuted === false && report.releaseEligible === false, 'emulator results cannot certify live cloud or release');
    need(report.sameSharedFiles === true && report.businessEquivalent === true && report.wireEquivalent === true, 'emulator equivalence was not established');
    need(!report.error && !report.interrupted && !report.cleanupErrors?.length, 'emulator report contains an execution or cleanup failure');
    const metadata = report.emulators;
    need(metadata && toolchain.schemaVersion === 1 && isDeepStrictEqual(metadata.officialEmulator, toolchain.firestore) && isDeepStrictEqual(metadata.java, toolchain.java), 'official emulator/Java provenance pin drift');
    need(metadata.cloudServiceRpcRequests === false && metadata.credentialsPassed === false && metadata.gcloudConfigurationRead === false, 'emulator execution scope drift');
    need(isDeepStrictEqual([...metadata.modeNames].sort(), ['datastore', 'firestore']), 'both official emulator modes are required');
    for (const [name, mode] of [['datastore', 'datastore-mode'], ['firestore', 'firestore-native']]) {
        const instance = metadata.instances?.[name];
        need(instance?.mode === mode && instance.status === 'stopped' && instance.exit?.code === 0 && instance.exit.signal === null, `${name}: emulator did not exit cleanly`);
        need(instance.loopbackOnly === true && instance.persistentData === false && instance.imports === false && instance.exports === false, `${name}: emulator isolation drift`);
    }
    need(report.envoy?.version === envoyPin.version && report.envoy.sha256 === envoyPin.sha256, 'emulator Envoy provenance pin drift');
    need(report.envoy.exit?.code === 0 && report.envoy.exit.signal === null, 'emulator Envoy did not exit cleanly');
    need(report.envoy.observationPoint === 'router-upstream-access-log' && report.envoy.firestoreSyntheticOwnerInjected === true, 'emulator Envoy observation or synthetic authentication contract drift');
    const sources = report.sourceHashes;
    need(sources?.native && EMULATOR_SHARED_FILES.every(file => /^[a-f0-9]{64}$/.test(sources.native[file] || '')), 'emulator shared source hashes are incomplete');
    need(isDeepStrictEqual(sources.native, sources.replacement) && isDeepStrictEqual(sources.native, sources.workerd), 'emulator shared business sources differ');
    need(EMULATOR_INPUTS.every(file => /^[a-f0-9]{64}$/.test(report.evidence?.[file] || '')), 'emulator execution input hashes are incomplete');
    const runtimes = ['native', 'replacement', 'workerd-first', 'workerd-second'];
    need(Array.isArray(report.results) && report.results.length === suites.length * runtimes.length, 'emulator suite/runtime matrix is incomplete');
    need(Array.isArray(report.wire) && Array.isArray(report.requests) && report.wire.length > 0, 'emulator wire evidence is missing');
    need(report.wire.every(item => ['native', 'replacement', 'workerd'].includes(item.runtime)), 'unknown emulator wire runtime');
    need(report.requests.every(item => ['replacement', 'workerd'].includes(item.runtime) && suites.some(suite => suite.suite === item.suite)), 'unknown emulator request runtime or suite');
    const rows = {};
    let assignedArrivals = 0, assignedRequests = 0;
    for (const runtime of runtimes) {
        rows[runtime] = suites.map(({ sdk, suite }) => {
            const results = report.results.filter(item => item.runtime === runtime && item.sdk === sdk && item.suite === suite);
            need(results.length === 1 && results[0].status === 'passed' && Array.isArray(results[0].checks) && results[0].checks.length > 0, `${runtime}/${suite}: emulator case did not pass exactly once`);
            return results[0];
        });
        const matchesRuntime = item => runtime.startsWith('workerd-') ? item.runtime === 'workerd' && item.invocation === runtime.slice(8) : item.runtime === runtime;
        const arrivals = report.wire.filter(matchesRuntime), requests = report.requests.filter(matchesRuntime);
        assignedArrivals += arrivals.length;
        assignedRequests += requests.length;
        const counts = {};
        for (const arrival of arrivals) {
            need(/^\/google\.(datastore\.v1\.Datastore|firestore\.v1\.Firestore)\/[A-Za-z]+$/.test(arrival.method) && Number(arrival.httpStatus) === 200
                && /^\d+$/.test(String(arrival.grpcStatus)) && Number(arrival.grpcStatus) <= 16, 'invalid emulator RPC/status evidence');
            need(arrival.upstream === (arrival.method.startsWith('/google.datastore.') ? 'datastore' : 'firestore') && arrival.flags === '-', 'invalid emulator upstream/response-flags evidence');
            const key = `${arrival.method}#${arrival.grpcStatus}`;
            counts[key] = (counts[key] || 0) + 1;
        }
        need(Object.keys(counts).length > 0 && isDeepStrictEqual(counts, report.methodStatusCounts?.[runtime]), `${runtime}: emulator RPC/status totals drift`);
        // Error suites must have real upstream failures in every runtime. These
        // service-level observations do not certify individual Call attempts.
        for (const [suite, service, codes] of [
            ['datastore-emulator-errors', 'datastore.v1.Datastore', [5, 6]],
            ['firestore-emulator-errors', 'firestore.v1.Firestore', [5, 6, 9]],
        ]) {
            if (suites.some(item => item.suite === suite)) {
                for (const code of codes) need(counts[`/google.${service}/Commit#${code}`] > 0, `${runtime}/${suite}: missing upstream Commit status ${code}`);
            }
        }
        if (runtime !== 'native') {
            need(isDeepStrictEqual(counts, report.methodStatusCounts.native), `${runtime}: native emulator RPC/status totals differ`);
            need(arrivals.length === requests.length && requests.every(item => item.requestContentType === 'application/grpc-web+proto' && /^application\/grpc-web(?:\+proto)?(?:;|$)/.test(item.responseContentType || '') && Number(item.httpStatus) === 200), `${runtime}: emulator fetch/arrival evidence differs`);
        }
        for (const row of rows[runtime]) {
            need(row.grpcWebRequests === requests.filter(item => item.suite === row.suite).length, `${runtime}/${row.suite}: per-suite emulator fetch count drift`);
        }
    }
    need(assignedArrivals === report.wire.length && assignedRequests === report.requests.length, 'unknown emulator invocation in wire evidence');
    const business = row => ({ sdk: row.sdk, suite: row.suite, status: row.status, checks: row.checks });
    for (const runtime of runtimes.slice(1)) need(isDeepStrictEqual(rows[runtime].map(business), rows.native.map(business)), `${runtime}: emulator business assertions differ`);
}
function validateEmulatorArtifacts(root, report) {
    const toolchain = read(root, 'fixtures/emulators/toolchain.json'), envoyPin = read(root, 'fixtures/envoy/binary.json');
    validateEmulatorReport(report, { toolchain, envoyPin, suites: emulatorSuites(root) });
    validateProfileManifest(read(root, 'src/build/profiles/google-static-v1.json'), report.build);
    for (const [file, expected] of Object.entries(report.evidence)) need(hash(root, file) === expected, `${file}: emulator input hash drift`);
    for (const [file, expected] of Object.entries(report.sourceHashes.native)) need(hash(root, `fixtures/google/shared/${file}`) === expected, `${file}: emulator business source hash drift`);
    for (const schema of report.build.schemas) need(hash(root, `fixtures/google/${schema.path}`) === schema.sourceSha256, `${schema.path}: emulator schema hash drift`);
    const artifactHashes = {};
    for (const [file, pin] of [[`fixtures/emulators/.cache/${toolchain.firestore.filename}`, toolchain.firestore], [`fixtures/emulators/.cache/${toolchain.java.filename}`, toolchain.java], [`fixtures/envoy/.cache/envoy-${envoyPin.version}`, envoyPin]]) {
        need(fs.statSync(location(root, file)).size === pin.size, `${file}: emulator artifact size drift`);
        // The jar and Java archive are large; hash them with a bounded buffer.
        const digest = crypto.createHash('sha256'), fd = fs.openSync(location(root, file), 'r'), buffer = Buffer.alloc(1024 * 1024);
        try { let count; while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, count)); }
        finally { fs.closeSync(fd); }
        artifactHashes[file] = digest.digest('hex');
        need(artifactHashes[file] === pin.sha256, `${file}: emulator artifact checksum drift`);
    }
    const externalArtifactHashes = {};
    const receipt = (file, expected) => externalReceipt(file, expected, externalArtifactHashes);
    for (const instance of Object.values(report.emulators.instances)) {
        receipt(instance.statusFile, instance.exit);
        receipt(instance.log);
    }
    receipt(report.envoy.exitFile, report.envoy.exit);
    receipt(report.envoy.log);
    const accessBytes = receipt(report.envoy.accessLog);
    need(accessBytes.length <= 8 * 1024 * 1024, 'emulator access receipt exceeds its fixture bound');
    const observedWire = accessBytes.toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    need(isDeepStrictEqual(observedWire, report.wire), 'emulator access receipt disagrees with recorded wire evidence');
    return { artifactHashes, externalArtifactHashes };
}
function externalReceipt(file, expected, hashes) {
    const logDirectory = fs.realpathSync(path.join(os.homedir(), 'logs')) + path.sep;
    need(typeof file === 'string' && fs.realpathSync(file).startsWith(logDirectory), 'emulator receipt is outside the private log directory');
    need(fs.statSync(file).size <= 8 * 1024 * 1024, 'emulator receipt exceeds its fixture bound');
    const bytes = fs.readFileSync(file);
    if (expected) need(isDeepStrictEqual(JSON.parse(bytes), expected), 'emulator exit receipt disagrees with the report');
    hashes[file] = digest(bytes);
    return bytes;
}
function validateLifecycleReport(report, toolchain) {
    need(report?.status === 'passed' && report.officialEmulator === true && report.externalServiceRpcRequests === false && !report.error, 'emulator lifecycle execution did not pass locally');
    need(isDeepStrictEqual(report.toolchain?.firestore, toolchain.firestore) && isDeepStrictEqual(report.toolchain?.java, toolchain.java), 'emulator lifecycle toolchain pin drift');
    const scenarios = [
        ['ready-sigterm', 'ready', 'SIGTERM', ['firestore']], ['ready-sigint', 'ready', 'SIGINT', ['datastore']],
        ['startup-sigterm', 'spawned', 'SIGTERM', ['firestore']], ['idempotent-stop', 'ready', null, ['firestore', 'datastore']],
    ];
    need(Array.isArray(report.results) && report.results.length === scenarios.length, 'emulator lifecycle case matrix is incomplete');
    for (const [id, phase, signal, modes] of scenarios) {
        const selected = report.results.filter(item => item.id === id);
        need(selected.length === 1 && selected[0].status === 'passed', `${id}: lifecycle case did not pass exactly once`);
        const result = selected[0];
        need(result.phase === phase && result.signal === signal && isDeepStrictEqual(result.modes, modes), `${id}: lifecycle signal/phase drift`);
        need(result.exit?.pid === result.pid && result.exit.code === (signal ? null : 0) && result.exit.signal === signal, `${id}: lifecycle supervisor exit drift`);
        need(Array.isArray(result.children) && result.children.length === modes.length, `${id}: lifecycle child receipts incomplete`);
        const expectedModes = modes.map(name => name === 'firestore' ? 'firestore-native' : 'datastore-mode').sort();
        need(isDeepStrictEqual(result.children.map(child => child.mode).sort(), expectedModes), `${id}: lifecycle child mode drift`);
        for (const child of result.children) {
            need(child.pidGone === true && child.workingDirectoryRemoved === true && child.exit?.pid === child.pid, `${id}: lifecycle child cleanup was not proven`);
            if (signal) need(child.exit.parentSignal === signal, `${id}: lifecycle child signal propagation drift`);
            need(phase === 'ready' ? child.exit.code === 0 : child.exit.code === 0 || child.exit.code === 143 || child.exit.signal === 'SIGTERM', `${id}: lifecycle child exit was unexpected`);
        }
        if (!signal) need(result.stopEvidence?.concurrentStopSharedPromise === true && result.stopEvidence.repeatedStopAfterExit === true, 'idempotent-stop: stop completion invariants missing');
    }
}
function validateLifecycleArtifacts(root, report) {
    validateLifecycleReport(report, read(root, 'fixtures/emulators/toolchain.json'));
    const required = ['lifecycle.cjs', 'launcher.cjs', 'download.cjs', 'toolchain.json'].map(name => `fixtures/emulators/${name}`);
    need(required.every(file => typeof report.sourceHashes?.[file] === 'string'), 'emulator lifecycle source hashes are incomplete');
    for (const [file, expected] of Object.entries(report.sourceHashes)) need(hash(root, file) === expected, `${file}: emulator lifecycle source hash drift`);
    const artifacts = {};
    for (const result of report.results) {
        externalReceipt(result.statusFile, result.exit, artifacts);
        externalReceipt(result.log, undefined, artifacts);
        for (const child of result.children) {
            externalReceipt(child.statusFile, child.exit, artifacts);
            externalReceipt(child.log, undefined, artifacts);
        }
    }
    return artifacts;
}
function validateProvenance(root, report) {
    const pkg = read(root, 'package.json');
    need(report.package === pkg.name && report.version === pkg.version, 'package/report version drift');
    need(report.releaseEligible === false && report.liveGoogleApiExecuted === false && report.deployedCloudflareExecuted === false && report.fullDropInCertified === false, 'local evidence cannot claim cloud or release certification');
    const embedded = [['build', 'verification/build.json'], ['declarations', 'verification/types.json'], ['packaging', 'verification/packaging.json'],
        ['nativeDifferential', 'verification/native-differential.json'], ['googleAuth', 'verification/google-auth.json'], ['workers', 'verification/workers.json'],
        ['workersSdk', 'verification/workers-sdk.json'], ['workersGaxModes', 'verification/workers-gax-modes.json'], ['workersLazySdk', 'verification/workers-lazy-sdk.json'],
        ['workersAuth', 'verification/workers-auth.json'], ['datastorePagination', 'verification/datastore-pagination.json'], ['workersResilience', 'verification/workers-resilience.json'],
        ['workersFederatedAuth', 'verification/workers-federated-auth.json'], ['workersLegacyAuth', 'verification/workers-legacy-auth.json'], ['secretManagerExtended', 'verification/secret-manager-extended.json'],
        ['workersFetcher', 'verification/workers-fetcher.json'],
        ['workersCompression', 'verification/workers-compression.json'], ['workersRetries', 'verification/workers-retries.json'],
        ['workersShared', 'verification/workers-shared.json'], ['googleEmulators', 'verification/google-emulators.json'], ['emulatorLifecycle', 'verification/emulator-lifecycle.json'], ['envoy', 'verification/envoy.json'], ['googlePreflight', 'verification/google-preflight.json']];
    for (const [key, file] of embedded) need(isDeepStrictEqual(report[key], read(root, file)), `${file}: aggregate report drift`);
    for (const [key, file] of [['graph', 'google-graph'], ['declarations', 'google-types'], ['local', 'google-local']]) need(isDeepStrictEqual(report.googleSdk?.[key], read(root, `compatibility/${file}.json`)), `${file}: aggregate report drift`);
    const packaging = report.packaging;
    const artifact = `artifacts/${packaging.actualReplacementTarball}`;
    const bytes = fs.readFileSync(location(root, artifact));
    need(digest(bytes) === packaging.sha256, 'packaged artifact hash drift');
    validateRuntimeCopies(root);
    const sri = 'sha512-' + digest(bytes, 'sha512', 'base64');
    for (const fixture of ['google', 'worker']) {
        const lock = read(root, `fixtures/${fixture}/package-lock.json`);
        need(lock.packages?.['node_modules/@grpc/grpc-js']?.integrity === sri, `${fixture}: installed tarball lock integrity drift`);
    }
    for (const [file, fixture] of [['google-graph', 'google'], ['google-native-graph', 'native']]) {
        const graph = read(root, `compatibility/${file}.json`);
        need(graph.lockfileSha256 === hash(root, `fixtures/${fixture}/package-lock.json`), `${fixture}: dependency graph lock hash drift`);
    }
    const candidates = read(root, 'compatibility/candidates.json');
    for (const candidate of candidates.sdkCandidates) {
        for (const fixture of ['google', 'native']) {
            const lock = read(root, `fixtures/${fixture}/package-lock.json`).packages[`node_modules/${candidate.package}`];
            const installed = read(root, `fixtures/${fixture}/node_modules/${candidate.package}/package.json`);
            need(lock?.version === candidate.version && installed.version === candidate.version && lock.integrity === candidate.npmIntegrity, `${candidate.package}: candidate version/integrity drift in ${fixture}`);
        }
    }
    const upstream = read(root, 'vendor/UPSTREAM.json');
    need(candidates.grpcJsReference.version === upstream.version && candidates.grpcJsReference.integrity === upstream.integrity && candidates.grpcJsReference.gitHead === upstream.gitHead, 'native reference provenance drift');
    const nativeLock = read(root, 'fixtures/native/package-lock.json').packages['node_modules/@grpc/grpc-js'];
    need(nativeLock.version === upstream.version && nativeLock.integrity === upstream.integrity, 'native baseline lock drift');
    need(hash(root, 'vendor/LICENSE') === upstream.licenseSha256, 'upstream license hash drift');
    for (const file of upstream.files) {
        need(hash(root, file.source) === file.sha256 && hash(root, file.target) === file.patchedSha256, `${file.target}: upstream source/patch provenance drift`);
        if (file.patch) need(hash(root, file.patch) === file.patchSha256, `${file.patch}: patch provenance drift`);
    }
    const profileFile = 'src/build/profiles/google-static-v1.json';
    const profile = read(root, profileFile), build = read(root, 'verification/workers-sdk-build.json');
    validateProfileManifest(profile, build);
    need(hash(root, 'fixtures/google/node_modules/@grpc/grpc-js/dist/build/profiles/google-static-v1.json') === hash(root, profileFile), 'installed build profile drift');
    for (const entry of [...profile.files, ...profile.schemas, ...profile.codegenInputs]) need(hash(root, `fixtures/google/${entry.path}`) === entry.sha256, `${entry.path}: pinned source/schema drift`);
    for (const entry of profile.packages) need(read(root, `fixtures/google/${entry.path}/package.json`).version === entry.version, `${entry.path}: profile package drift`);
    for (const entry of build.schemas) need(hash(root, `fixtures/google/${entry.path}`) === entry.sourceSha256, `${entry.path}: executed schema drift`);
    for (const [file, expected] of Object.entries(report.workersSdk.evidence || {})) need(hash(root, file) === expected, `${file}: Workers execution input drift`);
    for (const [file, expected] of Object.entries(report.workersShared.evidence || {})) need(hash(root, file) === expected, `${file}: shared Worker execution input drift`);
    for (const [runtime, hashes] of Object.entries(report.workersShared.sourceHashes || {})) {
        for (const [file, expected] of Object.entries(hashes)) need(hash(root, `fixtures/google/shared/${file}`) === expected, `${runtime}/${file}: shared business source drift`);
    }
    need(read(root, 'compatibility/status.json').releaseEligible === false, 'compatibility status overclaims release eligibility');
    return { artifact, artifactSha256: packaging.sha256, upstreamVersion: upstream.version, profile: profile.id, profileSha256: build.profileSha256 };
}
function assemble(root = ROOT) {
    const report = read(root, 'verification/report.json');
    need(Array.isArray(report.commands), 'verification report has no completed commands');
    const inputs = captureInputs(root);
    validateSnapshot(report.evidenceInputHashes, inputs, 'verification inputs');
    need(report.sourceHashes && Object.keys(report.sourceHashes).length > 0, 'missing aggregate source hashes');
    for (const [file, expected] of Object.entries(report.sourceHashes)) need(hash(root, file) === expected, `${file}: aggregate source hash drift`);
    need(report.tests?.fail === 0 && report.tests?.skipped === 0 && report.tests?.cancelled === 0, 'aggregate local tests must pass without skips');
    const tap = fs.readFileSync(location(root, 'verification/tests.tap'), 'utf8');
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) need(Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1]) === report.tests[key], `TAP aggregate ${key} drift`);
    const mapping = read(root, 'compatibility/test-evidence.json');
    const context = {
        inputs, report, tap: tapResults(tap), text: file => fs.readFileSync(location(root, file), 'utf8'), json: file => read(root, file),
    };
    const cases = validateMapping(read(root, 'compatibility/test-catalog.json'), mapping, context);
    const supplementalCases = validateSupplementalCases(mapping, context);
    const provenance = validateProvenance(root, report);
    const emulatorArtifacts = validateEmulatorArtifacts(root, report.googleEmulators);
    const lifecycleArtifacts = validateLifecycleArtifacts(root, report.emulatorLifecycle);
    const artifacts = [...OUTPUTS, provenance.artifact, ...Object.keys(validateRuntimeCopies(root)), ...report.commands.map(command => `verification/${command.log}`)];
    return { schemaVersion: 1, status: 'passed', scope: 'offline provenance and reviewed case evidence; not full release certification',
        releaseEligible: false, inputs, artifactHashes: { ...Object.fromEntries([...new Set(artifacts)].sort().map(file => [file, hash(root, file)])), ...emulatorArtifacts.artifactHashes }, externalArtifactHashes: { ...emulatorArtifacts.externalArtifactHashes, ...lifecycleArtifacts }, provenance,
        summary: { planned: cases.length, covered: cases.filter(item => item.coverage === 'covered').length, partial: cases.filter(item => item.coverage === 'partial').length,
            unimplemented: cases.filter(item => item.coverage === 'unimplemented').length, notRun: cases.filter(item => item.execution === 'not_run').length,
            allPlannedCasesSatisfied: cases.every(item => item.satisfiesPlannedCase), supplementalExecutedCases: supplementalCases.length }, cases, supplementalCases };
}
function writeEvidence(root = ROOT) {
    const evidence = { generatedAt: new Date().toISOString(), ...assemble(root) };
    fs.writeFileSync(location(root, 'verification/evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    return evidence;
}
function checkEvidence(root = ROOT) {
    const saved = read(root, 'verification/evidence.json');
    const current = assemble(root);
    const { generatedAt, ...rest } = saved;
    need(typeof generatedAt === 'string' && isDeepStrictEqual(rest, current), 'recorded evidence is stale or its coverage/status was edited');
    return saved;
}
module.exports = { captureInputs, writeEvidence, checkEvidence, validateSnapshot, validateMapping, tapResults, namedTests, pointer, validateProvenance, validateRuntimeCopies, validateProfileManifest, validateEmulatorReport, validateEmulatorArtifacts, validateSupplementalCases, validateLifecycleReport, validateLifecycleArtifacts };
if (require.main === module) {
    try {
        need(process.argv.length <= 3 && [undefined, '--check', '--record'].includes(process.argv[2]), 'usage: node scripts/test-evidence.cjs [--check|--record]');
        const evidence = process.argv[2] === '--record' ? writeEvidence() : checkEvidence();
        console.log(JSON.stringify({ status: evidence.status, ...evidence.summary, releaseEligible: false }, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
