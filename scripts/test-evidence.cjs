'use strict';
/** Offline evidence validation. Coverage is reviewed explicitly; passing tests never imply full catalog coverage. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const ts = require('typescript');
const { validateWorkerdServerStreamingReport } = require('./server-streaming-evidence.cjs');
const { validateSdkBenchmarkReport } = require('./sdk-benchmark-evidence.cjs');
const { validateTransportBenchmarkReport, validateTransportBenchmarkArtifacts } = require('./transport-benchmark-evidence.cjs');
const { validateWorkerdTransportExtensionsReport } = require('./transport-extensions-evidence.cjs');
const { validateApiContractsReport } = require('./api-contract-evidence.cjs');
const { validateTypeContractReport } = require('./type-contract-evidence.cjs');
const { validateSecretManagerReport } = require('./secret-manager-evidence.cjs');
const { validateFirestoreReadReport } = require('./firestore-read-evidence.cjs');
const { validateDatastoreTransactionReport } = require('./datastore-transaction-evidence.cjs');
const { validateDatastoreLookupReport } = require('./datastore-lookup-evidence.cjs');
const { validateDatastorePaginationReport } = require('./datastore-pagination-evidence.cjs');
const { validateDatastoreMutationReport } = require('./datastore-mutation-evidence.cjs');
const { validateDatastoreEmulatorReport } = require('./datastore-emulator-evidence.cjs');
const { validateCallLifecycleReport } = require('./call-lifecycle-evidence.cjs');
const { validateFlowControlReport } = require('./flow-control-evidence.cjs');
const { validateWireCatalogReport } = require('./wire-catalog-evidence.cjs');
const ROOT = path.resolve(__dirname, '..');
const GENERATED_COMPATIBILITY = new Set(['exports-contract.json', 'google-graph.json', 'google-native-graph.json', 'google-types.json', 'google-local.json']);
const OUTPUTS = ['verification/report.json', 'verification/tests.tap', 'verification/build.json', 'verification/types.json',
    'verification/api-contracts.json',
    'verification/firestore-read-errors.json',
    'verification/datastore-transactions.json',
    'verification/datastore-mutations.json',
    'verification/call-lifecycle.json',
    'verification/flow-control.json',
    'verification/wire-catalog.json',
    'verification/benchmark.json',
    'verification/workerd-integration.json', 'verification/workerd-lifecycle.json', 'verification/workerd-observer.json', 'verification/fuzz-campaign-ci.json',
    'verification/workerd-server-streaming.json', 'verification/workerd-transport-extensions.json', 'verification/sdk-benchmark.json',
    'verification/packaging.json', 'verification/packaging-fixture.lock.json',
    'verification/packaging-google-static-v1.lock.json', 'verification/packaging-google-modern-v1.lock.json', 'verification/native-differential.json',
    'verification/google-auth.json', 'verification/workers.json', 'verification/workers-sdk.json',
    'verification/workers-gax-modes.json', 'verification/workers-lazy-sdk.json', 'verification/workers-auth.json',
    'verification/datastore-pagination.json', 'verification/workers-resilience.json',
    'verification/workers-federated-auth.json', 'verification/workers-legacy-auth.json', 'verification/secret-manager-extended.json',
    'verification/workers-fetcher.json',
    'verification/workers-compression.json', 'verification/workers-retries.json', 'verification/health.json', 'verification/workers-server.json', 'verification/modern-sdk.json', 'verification/request-streaming.json', 'verification/streaming-feasibility.json', 'verification/firestore-watch.json', 'verification/modern-firestore-watch.json', 'verification/firestore-recovery.json', 'verification/parent-calls.json',
    'verification/modern-firestore-recovery.json', 'verification/firestore-watch-errors.json', 'verification/datastore-lookup.json',
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
    const directories = ['dist', ...['google', 'worker', 'modern'].map(fixture => `fixtures/${fixture}/node_modules/@grpc/grpc-js/dist`)];
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
    const isTest = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && ['test', 'it'].includes(node.expression.text);
    const literal = node => ts.isStringLiteralLike(node) ? node.text
        : ts.isNumericLiteral(node) ? Number(node.text) : undefined;
    // Only expand direct tests in finite, literal const tables. Never evaluate
    // source, function calls, computed tables or arbitrary template expressions.
    function tableNames(node) {
        if (node.awaitModifier || !ts.isVariableDeclarationList(node.initializer)
            || !(node.initializer.flags & ts.NodeFlags.Const) || node.initializer.declarations.length !== 1
            || !ts.isArrayLiteralExpression(node.expression) || node.expression.elements.length > 256) return;
        const binding = node.initializer.declarations[0].name;
        let keys;
        if (ts.isIdentifier(binding)) keys = [binding.text];
        else if (ts.isArrayBindingPattern(binding) && binding.elements.every(item => ts.isBindingElement(item)
            && !item.dotDotDotToken && !item.initializer && ts.isIdentifier(item.name))) keys = binding.elements.map(item => item.name.text);
        else return;
        const rows = node.expression.elements.map(item => ts.isArrayBindingPattern(binding)
            ? ts.isArrayLiteralExpression(item) ? item.elements.map(literal) : [] : [literal(item)]);
        if (rows.some(row => row.length !== keys.length || row.some(value => value === undefined))) return;
        const statements = ts.isBlock(node.statement) ? node.statement.statements : [node.statement];
        // A loop body can legally shadow its own iteration binding. Limit this
        // form to registration statements so no intervening declaration changes it.
        if (!statements.every(statement => ts.isExpressionStatement(statement) && isTest(statement.expression))) return;
        for (const statement of statements) {
            const title = statement.expression.arguments[0];
            if (!title || !ts.isTemplateExpression(title)) continue;
            for (const row of rows) {
                let name = title.head.text;
                for (const span of title.templateSpans) {
                    const value = ts.isIdentifier(span.expression) ? row[keys.indexOf(span.expression.text)] : literal(span.expression);
                    if (value === undefined) { name = undefined; break; }
                    name += String(value) + span.literal.text;
                }
                if (name !== undefined) names.push(name);
            }
        }
    }
    function visit(node) {
        if (isTest(node)
            && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) names.push(node.arguments[0].text);
        if (ts.isForOfStatement(node)) tableNames(node);
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
    need(isDeepStrictEqual(build.packages, profile.packages) && isDeepStrictEqual(build.capabilities, profile.capabilities)
        && isDeepStrictEqual(build.requiredChecks, profile.requiredChecks), 'declarative profile metadata drift');
    need(build.transformer?.version === profile.transformerVersion && /^[a-f0-9]{64}$/.test(build.transformer?.sha256)
        && /^\d+\.\d+\.\d+/.test(build.transformer?.typescriptVersion), 'transformer identity missing');
    const inputs = digest(JSON.stringify({ packages: profile.packages.map(pkg => [pkg.path, pkg.packageJsonSha256]),
        sources: [...profile.files, ...profile.schemas, ...profile.codegenInputs].map(file => [file.path, file.sha256]) }));
    need(build.inputSha256 === inputs && build.cacheKey === digest(JSON.stringify({ profileSha256: build.profileSha256,
        transformer: build.transformer, inputSha256: inputs })), 'transformer/input cache identity drift');
    for (const file of build.transformed) {
        const declared = profile.files.find(entry => entry.path === file.path);
        need(declared && isDeepStrictEqual(file.rules, declared.transforms.map(rule => ({ rule: rule.rule, matches: rule.expectedMatches }))),
            'executed transform rules differ from declared profile');
    }
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
    validateDatastoreEmulatorReport(report);
    for (const [file, expected] of Object.entries({ ...report.installedInputs, ...report.nativeInputs })) {
        need(hash(root, file) === expected, `${file}: emulator installed input hash drift`);
    }
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
function validateWorkerdLifecycleReport(report) {
    need(report?.status === 'passed' && report.sourceBuild === false && report.liveCloud === false
        && report.serviceBindings === true && report.productionServerHandler === true && report.independentUploadPeer === true
        && report.incomingCloudflareTranslation === false && report.nativeHttp2 === false
        && report.runtimeDisposed === true && report.cleanupVerifiedBeforeDispose === true && report.externalRequests === 0,
        'workerd lifecycle integration is incomplete or used source/cloud execution');
    need(report.installedInputs && Object.keys(report.installedInputs).length > 0,
        'workerd lifecycle installed package hashes are missing');
    const required = ['scripts/test-workerd-lifecycle.cjs', 'fixtures/worker/lifecycle-client.mjs',
        'fixtures/worker/lifecycle-server.mjs', 'fixtures/worker/package-lock.json'];
    need(required.every(file => typeof report.evidence?.[file] === 'string'), 'workerd lifecycle source hashes are incomplete');
    need(report.runs?.length === 1, 'workerd lifecycle invocation is missing');
    const run = report.runs[0];
    need(run.status === 'passed' && run.results?.length >= 39 && run.results.every(item => typeof item.kind === 'string')
        && run.caseCount === run.results.length
        && report.caseCount === run.caseCount && run.coreCaseCount >= 31 && run.resourceCaseCount >= 8
        && run.coreCaseCount + run.resourceCaseCount === run.caseCount
        && report.coreCaseCount === run.coreCaseCount && report.resourceCaseCount === run.resourceCaseCount
        && run.rpcCount >= 70 && run.callReceipts?.length === run.rpcCount && report.rpcCount === run.rpcCount
        && run.fetchCount >= 54 && report.fetchCount === run.fetchCount && run.activeClientCalls === 0,
        'workerd lifecycle client completion or execution counts were not proven');
    need(run.callReceipts.every(item => item.statuses === 1 && [0, 1].includes(item.callbacks)
        && [0, 1].includes(item.fetchCount) && item.diagnostics?.terminal === true
        && item.diagnostics.fetchCount === item.fetchCount && item.diagnostics.requestBytes === 0
        && item.diagnostics.responseBytes === 0 && item.diagnostics.timerActive === false)
        && run.callReceipts.reduce((sum, item) => sum + item.fetchCount, 0) === run.fetchCount,
        'workerd lifecycle per-call terminal or buffer cleanup was not proven');
    need(run.backend?.active === 0 && run.backend.receipts?.length === run.fetchCount
        && run.backend.receipts.every(item => item.finalized === true && item.active === false)
        && report.backendAbortCount >= 4 && run.backend.receipts.filter(item => item.aborted).length === report.backendAbortCount,
        'workerd lifecycle backend cleanup was not proven before disposal');
    const uploads = run.backend.receipts.filter(item => item.uploadEOF);
    need(uploads.length === 2 && uploads.every(item => item.readerReleased === true && item.input?.length === 3),
        'workerd lifecycle upload readers or EOF were not verified');
    need(report.responseReaderCount === run.fetchCount && run.cleanup?.length === run.fetchCount
        && run.cleanup.every(item => item.released === true && item.bodyLocked === false && item.sourceLocked === false
            && typeof item.ended === 'boolean' && item.cancellations === (item.ended ? 0 : 1))
        && report.cancelledResponseReaderCount >= 6
        && run.cleanup.filter(item => item.cancellations === 1).length === report.cancelledResponseReaderCount,
        'workerd lifecycle response reader cleanup was not proven');
    const resources = run.results.filter(item => item.kind.startsWith('resource-'));
    need(resources.length === run.resourceCaseCount, 'workerd resource case count drifted');
    for (const mode of ['cloudflare', 'grpc-web']) {
        for (const kind of ['resource-admission', 'resource-send-budget', 'resource-receive-budget', 'resource-slow-compressed']) {
            need(resources.filter(item => item.mode === mode && item.kind === kind).length === 1,
                `${mode}/${kind}: required workerd resource case missing or duplicated`);
        }
    }
    need(resources.every(item => item.usage?.activeCalls === 0 && item.usage.queuedCalls === 0
        && item.usage.bufferedBytes === 0 && item.usage.peakBufferedBytes <= item.limits?.maxBufferedBytes && item.recovered === true),
        'workerd shared resource budget cleanup or recovery was not proven');
    for (const item of resources) {
        if (item.kind === 'resource-admission') need(item.usage.peakActiveCalls === 1 && item.usage.peakQueuedCalls === 1
            && item.overloadCode === 8 && item.queuedFetches === 0 && item.sharedClients >= 2
            && isDeepStrictEqual(item.queuedTerminalCodes, [1, 4]), 'workerd shared admission or queue termination was not proven');
        if (item.kind === 'resource-slow-compressed') need(item.peakReadableLength === 1 && item.messages === 8
            && item.compressed === true && item.peerDuringAuth === true && item.usage.peakActiveCalls === 2,
            'workerd slow-reader compression/authentication concurrency was not proven');
        if (item.kind === 'resource-send-budget' || item.kind === 'resource-receive-budget') need(item.code === 8
            && (item.kind !== 'resource-receive-budget' || item.compressed === true), 'workerd byte budget rejection was not proven');
    }
}
function validateWorkerdObserverReport(report) {
    need(report?.status === 'passed' && report.sourceBuild === false && report.liveCloud === false
        && report.incomingCloudflareTranslation === false && report.nativeHttp2 === false && report.serviceBindings === false
        && report.controlledPeer === true && report.runtimeDisposed === true && report.cleanupVerifiedBeforeDispose === true
        && report.externalRequests === 0, 'workerd observer execution is incomplete or misrepresents its scope');
    need(report.installedInputs && Object.keys(report.installedInputs).length > 0
        && Object.entries(report.installedInputs).every(([file, value]) => file.startsWith('fixtures/worker/node_modules/@grpc/grpc-js/')
            && /^[a-f0-9]{64}$/.test(value)), 'workerd observer installed package hashes are missing');
    const required = ['scripts/test-workerd-observer.cjs', 'fixtures/worker/observer.mjs', 'fixtures/worker/package-lock.json'];
    need(required.every(file => /^[a-f0-9]{64}$/.test(report.evidence?.[file])), 'workerd observer source hashes are incomplete');
    need(report.runs?.length === 1, 'workerd observer invocation is missing');
    const run = report.runs[0];
    need(run.status === 'passed' && run.activeClientCalls === 0 && run.resourcesIdle === true
        && run.caseCount === 14 && report.caseCount === 14 && run.results?.length === 14
        && run.rpcCount === 18 && report.rpcCount === 18 && run.attemptCount === 16 && report.attemptCount === 16
        && run.fetchCount === 14 && report.fetchCount === 14, 'workerd observer matrix or cleanup is incomplete');
    const fields = {
        'call-start': [], 'call-admitted': ['queueMs'], 'attempt-start': ['attempt'],
        'auth-end': ['attempt', 'durationMs', 'statusCode'], 'fetch-start': ['attempt'],
        'response-headers': ['attempt'], 'first-message': ['attempt'],
        'attempt-end': ['attempt', 'durationMs', 'authDurationMs', 'fetchStarted', 'statusCode', 'sentBytes', 'receivedBytes', 'responseMessages', 'responseMessageBytes'],
        'retry-scheduled': ['attempt', 'delayMs', 'statusCode'],
        'call-end': ['attemptCount', 'fetchCount', 'queueMs', 'statusCode', 'sentBytes', 'receivedBytes', 'responseMessages', 'responseMessageBytes'],
    };
    const matrix = { retry: [[0], [2], [2]], 'queue-terminal': [[0, 1, 4], [1, 0, 0], [1, 0, 0]],
        'auth-cancel': [[1], [1], [0]], 'stream-destroy': [[1], [1], [1]],
        'observer-throw': [[0], [1], [1]], 'observer-reject': [[0], [1], [1]], recovery: [[0], [1], [1]] };
    const ids = new Set(); let events = 0, attempts = 0, fetches = 0, sentBytes = 0, receivedBytes = 0;
    for (const mode of ['cloudflare', 'grpc-web']) for (const [kind, [codes, attemptCounts, fetchCounts]] of Object.entries(matrix)) {
        const selected = run.results.filter(item => item.mode === mode && item.kind === kind);
        need(selected.length === 1, `${mode}/${kind}: workerd observer case missing or duplicated`);
        const row = selected[0];
        need(row.privacyVerified === true && row.frozenEvents === true && row.calls?.length === codes.length,
            `${mode}/${kind}: workerd observer event privacy or call receipts missing`);
        row.calls.forEach((call, index) => {
            need(typeof call.logicalCallId === 'string' && /^wga-[1-9][0-9]*$/.test(call.logicalCallId) && !ids.has(call.logicalCallId)
                && call.terminalCode === codes[index] && call.attemptCount === attemptCounts[index] && call.fetchCount === fetchCounts[index]
                && call.statuses === 1 && Array.isArray(call.events), 'workerd observer logical call identity or terminal counts drifted');
            ids.add(call.logicalCallId); let elapsed = 0;
            for (const event of call.events) {
                need(event && Object.hasOwn(fields, event.type) && event.logicalCallId === call.logicalCallId
                    && isDeepStrictEqual(Object.keys(event).sort(), ['type', 'logicalCallId', 'elapsedMs', ...fields[event.type]].sort())
                    && Number.isFinite(event.elapsedMs) && event.elapsedMs >= elapsed, 'workerd observer event fields or clock order drifted');
                elapsed = event.elapsedMs;
                for (const key of fields[event.type]) need(key === 'fetchStarted' ? typeof event[key] === 'boolean'
                    : Number.isFinite(event[key]) && event[key] >= 0, 'workerd observer counter or duration is invalid');
            }
            const of = type => call.events.filter(event => event.type === type);
            const ends = of('call-end'), starts = of('call-start'), attemptEnds = of('attempt-end');
            need(starts.length === 1 && call.events[0] === starts[0] && ends.length === 1 && call.events.at(-1) === ends[0]
                && of('attempt-start').length === call.attemptCount && of('auth-end').length === call.attemptCount
                && of('fetch-start').length === call.fetchCount && attemptEnds.length === call.attemptCount
                && isDeepStrictEqual(attemptEnds.map(event => event.attempt), Array.from({ length: call.attemptCount }, (_, i) => i + 1)),
                'workerd observer start/attempt/terminal event counts drifted');
            const end = ends[0];
            need(end.statusCode === call.terminalCode && end.attemptCount === call.attemptCount && end.fetchCount === call.fetchCount,
                'workerd observer terminal event differs from RPC receipt');
            for (const event of call.events.filter(item => item.attempt !== undefined)) need(Number.isSafeInteger(event.attempt)
                && event.attempt >= 1 && event.attempt <= call.attemptCount, 'workerd observer attempt identity drifted');
            for (const attempt of attemptEnds) {
                const matching = type => call.events.filter(event => event.type === type && event.attempt === attempt.attempt);
                const begin = matching('attempt-start'), auth = matching('auth-end'), fetch = matching('fetch-start'), headers = matching('response-headers');
                const at = event => call.events.indexOf(event);
                need(begin.length === 1 && auth.length === 1 && at(begin[0]) < at(auth[0]) && at(auth[0]) < at(attempt)
                    && fetch.length === (attempt.fetchStarted ? 1 : 0) && headers.length === fetch.length
                    && attempt.durationMs >= attempt.authDurationMs
                    && attempt.statusCode === (kind === 'retry' && attempt.attempt === 1 ? 14 : call.terminalCode),
                    'workerd observer attempt phases or status drifted');
                if (attempt.fetchStarted) need(at(auth[0]) < at(fetch[0]) && at(fetch[0]) < at(headers[0]) && at(headers[0]) < at(attempt),
                    'workerd observer authentication/Fetch/header ordering drifted');
                else need(attempt.sentBytes === 0 && attempt.receivedBytes === 0 && attempt.responseMessages === 0,
                    'workerd observer attempt without Fetch reported transport traffic');
            }
            for (const key of ['sentBytes', 'receivedBytes', 'responseMessages', 'responseMessageBytes']) need(Number.isSafeInteger(end[key])
                && end[key] === attemptEnds.reduce((sum, event) => sum + event[key], 0), 'workerd observer cumulative traffic is inconsistent');
            if (kind === 'retry') need(of('retry-scheduled').length === 1
                && isDeepStrictEqual(attemptEnds.map(event => event.statusCode), [14, 0])
                && isDeepStrictEqual(attemptEnds.map(event => event.responseMessages), [0, 1]) && row.authCalls === 2 && row.retryCount === 1,
                'workerd observer retry identity/authentication was not proven');
            if (kind === 'queue-terminal' && index > 0) need(end.sentBytes === 0 && end.receivedBytes === 0
                && of('call-admitted').length === 0 && row.queuedFetches === 0, 'workerd queued termination started transport work');
            if (kind === 'auth-cancel') need(row.lateEvents === 0 && end.sentBytes === 0 && end.receivedBytes === 0,
                'workerd cancelled authentication produced late observer events');
            if (kind === 'stream-destroy') need(row.messages === 1 && row.bytesVerified === true && end.responseMessages === 1
                && end.responseMessageBytes > 0 && end.receivedBytes === end.responseMessageBytes + 5 && of('first-message').length === 1,
                'workerd stream observer traffic or cancellation was not proven');
            if (kind.startsWith('observer-')) need(row.rpcUnaffected === true, 'workerd observer failure affected RPC');
            events += call.events.length; attempts += call.attemptCount; fetches += call.fetchCount;
            sentBytes += end.sentBytes; receivedBytes += end.receivedBytes;
        });
    }
    need(ids.size === run.rpcCount && attempts === run.attemptCount && fetches === run.fetchCount
        && events === run.eventCount && events === report.eventCount, 'workerd observer aggregate counts drifted');
    need(run.cleanup?.length === run.fetchCount && run.cleanup.every(item => item.bodyLocked === false
        && typeof item.ended === 'boolean' && item.cancellations === (item.ended ? 0 : 1)
        && Number.isSafeInteger(item.deliveredBytes) && item.deliveredBytes > 0)
        && run.cleanup.filter(item => item.cancellations === 1).length === 2
        && run.peerReceipts?.length === run.fetchCount
        && run.peerReceipts.every(item => Number.isSafeInteger(item.sentBytes) && item.sentBytes > 0)
        && run.peerReceipts.reduce((sum, item) => sum + item.sentBytes, 0) === sentBytes
        && run.cleanup.reduce((sum, item) => sum + item.deliveredBytes, 0) === receivedBytes,
        'workerd observer response cleanup or independent traffic accounting was not proven');
}
function validateProvenance(root, report) {
    const pkg = read(root, 'package.json');
    need(report.package === pkg.name && report.version === pkg.version, 'package/report version drift');
    need(report.releaseEligible === false && report.liveGoogleApiExecuted === false && report.deployedCloudflareExecuted === false && report.fullDropInCertified === false, 'local evidence cannot claim cloud or release certification');
    const embedded = [['build', 'verification/build.json'], ['declarations', 'verification/types.json'], ['packaging', 'verification/packaging.json'],
        ['workerdIntegration', 'verification/workerd-integration.json'], ['workerdLifecycle', 'verification/workerd-lifecycle.json'], ['callLifecycle', 'verification/call-lifecycle.json'], ['flowControl', 'verification/flow-control.json'], ['wireCatalog', 'verification/wire-catalog.json'], ['workerdObserver', 'verification/workerd-observer.json'], ['fuzzCampaign', 'verification/fuzz-campaign-ci.json'],
        ['workerdServerStreaming', 'verification/workerd-server-streaming.json'], ['workerdTransportExtensions', 'verification/workerd-transport-extensions.json'], ['transportBenchmark', 'verification/benchmark.json'], ['sdkBenchmark', 'verification/sdk-benchmark.json'],
        ['nativeDifferential', 'verification/native-differential.json'], ['apiContracts', 'verification/api-contracts.json'], ['googleAuth', 'verification/google-auth.json'], ['workers', 'verification/workers.json'],
        ['workersSdk', 'verification/workers-sdk.json'], ['workersGaxModes', 'verification/workers-gax-modes.json'], ['workersLazySdk', 'verification/workers-lazy-sdk.json'],
        ['workersAuth', 'verification/workers-auth.json'], ['datastorePagination', 'verification/datastore-pagination.json'], ['workersResilience', 'verification/workers-resilience.json'],
        ['workersFederatedAuth', 'verification/workers-federated-auth.json'], ['workersLegacyAuth', 'verification/workers-legacy-auth.json'], ['secretManagerExtended', 'verification/secret-manager-extended.json'],
        ['workersFetcher', 'verification/workers-fetcher.json'],
        ['workersCompression', 'verification/workers-compression.json'], ['workersRetries', 'verification/workers-retries.json'], ['health', 'verification/health.json'], ['workersServer', 'verification/workers-server.json'], ['modernSdk', 'verification/modern-sdk.json'], ['requestStreaming', 'verification/request-streaming.json'], ['streamingFeasibility', 'verification/streaming-feasibility.json'], ['firestoreWatch', 'verification/firestore-watch.json'], ['modernFirestoreWatch', 'verification/modern-firestore-watch.json'], ['firestoreRecovery', 'verification/firestore-recovery.json'], ['parentCalls', 'verification/parent-calls.json'],
        ['modernFirestoreRecovery', 'verification/modern-firestore-recovery.json'], ['firestoreWatchErrors', 'verification/firestore-watch-errors.json'], ['firestoreReadErrors', 'verification/firestore-read-errors.json'], ['datastoreLookup', 'verification/datastore-lookup.json'], ['datastoreTransactions', 'verification/datastore-transactions.json'],
        ['datastoreMutations', 'verification/datastore-mutations.json'],
        ['workersShared', 'verification/workers-shared.json'], ['googleEmulators', 'verification/google-emulators.json'], ['emulatorLifecycle', 'verification/emulator-lifecycle.json'], ['envoy', 'verification/envoy.json'], ['googlePreflight', 'verification/google-preflight.json']];
    for (const [key, file] of embedded) need(isDeepStrictEqual(report[key], read(root, file)), `${file}: aggregate report drift`);
    const campaign = report.fuzzCampaign;
    need(report.workerdIntegration?.status === 'passed' && report.workerdIntegration.sourceBuild === false
        && report.workerdIntegration.serviceBindings === true && report.workerdIntegration.runtimeDisposed === true
        && report.workerdIntegration.cleanupVerifiedBeforeDispose === true, 'two-Worker integration is incomplete');
    for (const [file, expected] of Object.entries(report.workerdIntegration.installedInputs || {})) {
        need(hash(root, file) === expected, `${file}: integration package drift`);
    }
    validateWorkerdLifecycleReport(report.workerdLifecycle);
    need(report.commands.some(command => command.id === 'workerd-lifecycle' && command.status === 'passed' && command.exitCode === 0),
        'workerd lifecycle command did not pass');
    for (const [file, expected] of Object.entries(report.workerdLifecycle.installedInputs)) {
        need(hash(root, file) === expected, `${file}: lifecycle package drift`);
    }
    for (const [file, expected] of Object.entries(report.workerdLifecycle.evidence)) {
        need(hash(root, file) === expected, `${file}: lifecycle execution input drift`);
    }
    validateWorkerdObserverReport(report.workerdObserver);
    need(report.commands.some(command => command.id === 'workerd-observer' && command.status === 'passed' && command.exitCode === 0),
        'workerd observer command did not pass');
    for (const [file, expected] of Object.entries({ ...report.workerdObserver.installedInputs, ...report.workerdObserver.evidence })) {
        need(hash(root, file) === expected, `${file}: observer execution input drift`);
    }
    validateWorkerdServerStreamingReport(report.workerdServerStreaming);
    validateSdkBenchmarkReport(report.sdkBenchmark);
    validateTransportBenchmarkReport(report.transportBenchmark);
    validateTransportBenchmarkArtifacts(report.transportBenchmark, root);
    validateWorkerdTransportExtensionsReport(report.workerdTransportExtensions);
    validateApiContractsReport(report.apiContracts);
    validateSecretManagerReport(report.secretManagerExtended);
    validateFirestoreReadReport(report.firestoreReadErrors);
    validateDatastoreTransactionReport(report.datastoreTransactions);
    validateDatastoreMutationReport(report.datastoreMutations);
    validateDatastoreLookupReport(report.datastoreLookup);
    validateDatastorePaginationReport(report.datastorePagination);
    validateCallLifecycleReport(report.callLifecycle);
    validateFlowControlReport(report.flowControl);
    validateWireCatalogReport(report.wireCatalog);
    for (const [id, result] of [['api-contracts', report.apiContracts], ['workerd-server-streaming', report.workerdServerStreaming],
        ['workerd-transport-extensions', report.workerdTransportExtensions], ['transport-benchmark', report.transportBenchmark], ['sdk-benchmark', report.sdkBenchmark],
        ['secret-manager-extended', report.secretManagerExtended], ['firestore-read-errors', report.firestoreReadErrors],
        ['datastore-transactions', report.datastoreTransactions], ['datastore-lookup', report.datastoreLookup],
        ['datastore-mutations', report.datastoreMutations],
        ['datastore-pagination', report.datastorePagination],
        ['call-lifecycle', report.callLifecycle], ['flow-control', report.flowControl], ['wire-catalog', report.wireCatalog]]) {
        need(report.commands.some(command => command.id === id && command.status === 'passed' && command.exitCode === 0), `${id}: required command did not pass`);
        for (const [file, expected] of Object.entries({ ...result.evidence, ...result.installedInputs,
            ...result.nativeInputs, ...result.generatedArtifacts })) {
            need(hash(root, file) === expected, `${file}: ${id} execution input drift`);
        }
    }
    for (const graph of report.sdkBenchmark.graphs) {
        for (const [file, expected] of Object.entries(graph.installedInputs)) need(hash(root, file) === expected, `${file}: benchmark installed SDK input drift`);
    }
    need(campaign?.status === 'passed' && campaign.profile === 'ci' && campaign.liveCloud === false
        && campaign.runs?.length === 4, 'required Node/workerd fuzz campaign is incomplete');
    need(campaign.nodeGeneratedRuns === 32000 && campaign.workerGeneratedRuns === 1200 && campaign.workerRpcCalls === 5168,
        'required fuzz campaign execution counts drifted');
    for (const run of campaign.runs) {
        need(run.exitCode === 0 && run.result?.status === 'passed', 'fuzz subprocess did not pass');
        need(hash(root, run.report) === run.sha256 && isDeepStrictEqual(read(root, run.report), run.result), `${run.report}: fuzz receipt drift`);
        if (run.kind === 'node') need(run.result.expectedProperties === 16 && run.result.properties?.length === 16
            && run.result.generatedRuns === 16000, 'required Node fuzz properties are incomplete');
    }
    for (const [key, file] of [['graph', 'google-graph'], ['declarations', 'google-types'], ['local', 'google-local']]) need(isDeepStrictEqual(report.googleSdk?.[key], read(root, `compatibility/${file}.json`)), `${file}: aggregate report drift`);
    validateTypeContractReport(report.googleSdk.declarations);
    for (const [file, expected] of Object.entries({ ...report.googleSdk.declarations.evidence,
        ...report.googleSdk.declarations.installedInputs, ...report.googleSdk.declarations.generatedArtifacts })) {
        need(hash(root, file) === expected, `${file}: type contract execution input/artifact drift`);
    }
    const packaging = report.packaging;
    const artifact = `artifacts/${packaging.actualReplacementTarball}`;
    const bytes = fs.readFileSync(location(root, artifact));
    need(digest(bytes) === packaging.sha256, 'packaged artifact hash drift');
    validateRuntimeCopies(root);
    const sri = 'sha512-' + digest(bytes, 'sha512', 'base64');
    for (const profile of packaging.profiles) {
        need(hash(root, profile.lockArtifact) === profile.installedLockSha256
            && hash(root, `${profile.fixture}/package-lock.json`) === profile.inputLockSha256
            && profile.artifactIntegrity === sri, 'standalone packaging lock or tarball provenance drift');
    }
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
    need(build.transformer.sha256 === hash(root, 'src/build/index.cjs'), 'executed transformer source drift');
    need(hash(root, 'fixtures/google/node_modules/@grpc/grpc-js/dist/build/profiles/google-static-v1.json') === hash(root, profileFile), 'installed build profile drift');
    for (const entry of [...profile.files, ...profile.schemas, ...profile.codegenInputs]) need(hash(root, `fixtures/google/${entry.path}`) === entry.sha256, `${entry.path}: pinned source/schema drift`);
    for (const entry of profile.packages) need(read(root, `fixtures/google/${entry.path}/package.json`).version === entry.version
        && hash(root, `fixtures/google/${entry.path}/package.json`) === entry.packageJsonSha256, `${entry.path}: profile package drift`);
    for (const entry of build.schemas) need(hash(root, `fixtures/google/${entry.path}`) === entry.sourceSha256, `${entry.path}: executed schema drift`);
    for (const [file, expected] of Object.entries(report.workersSdk.evidence || {})) need(hash(root, file) === expected, `${file}: Workers execution input drift`);
    for (const sdk of [report.workersSdk, report.modernSdk]) {
        const inspection = sdk.bundleInspection;
        need(inspection?.status === 'passed' && inspection.bundleSha256 === sdk.bundleSha256
            && inspection.scope === 'included-package-provenance-and-static-executable-imports'
            && isDeepStrictEqual(inspection.stages.map(stage => stage.name), ['sdk-preset', 'wrangler'])
            && inspection.stages.every(stage => Number.isSafeInteger(stage.bundledInputs) && stage.bundledInputs > 0)
            && inspection.nativeGrpcPackages.length === 0 && inspection.violations.length === 0,
            'SDK bundle transport inspection is missing or differs from executed JavaScript');
    }
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
    need(report.tests?.fail === 0 && report.tests?.skipped === 0 && report.tests?.cancelled === 0
        && report.tests?.todo === 0 && report.tests.pass === report.tests.tests, 'aggregate local tests must pass without skips or TODO');
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
    const artifacts = [...OUTPUTS, provenance.artifact, ...Object.keys(validateRuntimeCopies(root)),
        ...Object.keys(report.googleSdk.declarations.generatedArtifacts || {}), ...Object.keys(report.apiContracts.generatedArtifacts || {}),
        ...Object.keys(report.transportBenchmark.generatedArtifacts),
        ...report.commands.map(command => `verification/${command.log}`),
        ...report.fuzzCampaign.runs.flatMap(run => [run.report, run.log, ...(run.kind === 'node' ? [run.result.log] : [])])];
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
module.exports = { captureInputs, writeEvidence, checkEvidence, validateSnapshot, validateMapping, tapResults, namedTests, pointer, validateProvenance, validateRuntimeCopies, validateProfileManifest, validateEmulatorReport, validateEmulatorArtifacts, validateSupplementalCases, validateLifecycleReport, validateLifecycleArtifacts, validateWorkerdLifecycleReport, validateWorkerdObserverReport };
if (require.main === module) {
    try {
        need(process.argv.length <= 3 && [undefined, '--check', '--record'].includes(process.argv[2]), 'usage: node scripts/test-evidence.cjs [--check|--record]');
        const evidence = process.argv[2] === '--record' ? writeEvidence() : checkEvidence();
        console.log(JSON.stringify({ status: evidence.status, ...evidence.summary, releaseEligible: false }, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
