'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { validateSnapshot, validateMapping, tapResults, namedTests, pointer, validateRuntimeCopies, validateProfileManifest, validateEmulatorReport, validateSupplementalCases, validateLifecycleReport } = require('../scripts/test-evidence.cjs');

function fixture() {
    const catalog = { schemaVersion: 1, cases: [{ id: 'CASE-001' }, { id: 'CASE-002' }, { id: 'CASE-003' }] };
    const reference = { kind: 'tap', command: 'tests', source: 'test/sample.test.cjs', name: 'sample assertion' };
    const mapping = { schemaVersion: 1, releaseEligible: false, cases: [
        { id: 'CASE-001', coverage: 'covered', reason: 'The concrete assertion covers the planned behavior.', gaps: [], references: [reference] },
        { id: 'CASE-002', coverage: 'partial', reason: 'The assertion covers one of two planned behaviors.', gaps: ['Second behavior has no executable assertion.'], references: [reference] },
        { id: 'CASE-003', coverage: 'unimplemented', reason: 'There is no implementation for the planned case.', gaps: ['No executable evidence.'], references: [] },
    ] };
    mapping.cases.forEach((item, index) => item.catalogCaseSha256 = crypto.createHash('sha256').update(JSON.stringify(catalog.cases[index])).digest('hex'));
    const context = { inputs: { 'test/sample.test.cjs': 'source-hash' }, report: { commands: [{ id: 'tests', status: 'passed', exitCode: 0 }] },
        tap: tapResults('TAP version 13\n# Subtest: sample assertion\nok 1 - sample assertion\n'),
        text: () => "const {test}=require('node:test'); test('sample assertion', () => {});",
        json: () => ({ results: [{ id: 'scenario', status: 'passed', count: 1 }] }),
    };
    return { catalog, mapping, context };
}

test('EVIDENCE partial execution never becomes full planned coverage', () => {
    const f = fixture();
    const result = validateMapping(f.catalog, f.mapping, f.context);
    assert.deepEqual(result.map(item => [item.coverage, item.execution, item.satisfiesPlannedCase]), [
        ['covered', 'passed', true], ['partial', 'passed', false], ['unimplemented', 'not_run', false],
    ]);
});

test('EVIDENCE stale source, lock, candidate, profile and artifact hashes fail closed', () => {
    const expected = { 'src/call.ts': 'a', 'fixtures/google/package-lock.json': 'b', 'compatibility/candidates.json': 'c', 'src/build/profiles/google-static-v1.json': 'd', 'artifacts/package.tgz': 'e', '.github/workflows/local.yml': 'f' };
    validateSnapshot(expected, { ...expected }, 'test evidence');
    for (const file of Object.keys(expected)) {
        assert.throws(() => validateSnapshot(expected, { ...expected, [file]: 'modified' }, 'test evidence'), /stale or missing hashes/);
        const missing = { ...expected }; delete missing[file];
        assert.throws(() => validateSnapshot(expected, missing, 'test evidence'), /stale or missing hashes/);
    }
    assert.throws(() => validateSnapshot(expected, { ...expected, 'new-test.cjs': 'f' }, 'test evidence'), /stale or missing hashes/);
    assert.throws(() => validateSnapshot(undefined, expected, 'test evidence'), /missing pre-execution hashes/);
});

test('EVIDENCE installed runtime bytes and file sets match the tested root build', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-evidence-runtime-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directories = ['dist', 'fixtures/google/node_modules/@grpc/grpc-js/dist', 'fixtures/worker/node_modules/@grpc/grpc-js/dist', 'fixtures/modern/node_modules/@grpc/grpc-js/dist'];
    for (const directory of directories) {
        fs.mkdirSync(path.join(root, directory, 'build/profiles'), { recursive: true });
        fs.writeFileSync(path.join(root, directory, 'index.js'), 'original runtime');
        fs.writeFileSync(path.join(root, directory, 'build/profiles/profile.json'), '{}');
    }
    const before = validateRuntimeCopies(root);
    for (const directory of directories.slice(1)) {
        const entry = path.join(root, directory, 'index.js');
        fs.writeFileSync(entry, 'stale runtime');
        assert.throws(() => validateRuntimeCopies(root), /installed runtime.*stale or missing hashes/);
        fs.writeFileSync(entry, 'original runtime');
        fs.writeFileSync(path.join(root, directory, 'unexpected.js'), 'extra runtime');
        assert.throws(() => validateRuntimeCopies(root), /installed runtime.*stale or missing hashes/);
        fs.unlinkSync(path.join(root, directory, 'unexpected.js'));
        fs.unlinkSync(entry);
        assert.throws(() => validateRuntimeCopies(root), /installed runtime.*stale or missing hashes/);
        fs.writeFileSync(entry, 'original runtime');
    }
    for (const directory of directories) fs.writeFileSync(path.join(root, directory, 'index.js'), 'same post-verification mutation');
    const mutated = validateRuntimeCopies(root);
    assert.throws(() => validateSnapshot(before, mutated, 'saved runtime artifacts'), /stale or missing hashes/);
});

test('EVIDENCE accepts the actual preset canonical profile hash and rejects semantic drift', t => {
    const root = path.resolve(__dirname, '..');
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-evidence-profile-'));
    t.after(() => fs.rmSync(outdir, { recursive: true, force: true }));
    const { createGoogleWorkerBuild } = require('../src/build/index.cjs');
    const preset = createGoogleWorkerBuild({ projectRoot: path.join(root, 'fixtures/google'), outdir, typescript: require('typescript') });
    const bytes = fs.readFileSync(path.join(root, 'src/build/profiles/google-static-v1.json'));
    const profile = JSON.parse(bytes);
    const manifest = preset.manifest();
    assert.notEqual(manifest.profileSha256, crypto.createHash('sha256').update(bytes).digest('hex'), 'fixture must distinguish raw-file and canonical-object hashing');
    validateProfileManifest(profile, manifest);
    validateProfileManifest(JSON.parse(JSON.stringify(profile, null, 4)), manifest);
    assert.throws(() => validateProfileManifest({ ...profile, revision: profile.revision + 1 }, manifest), /profile hash\/revision drift/);
    assert.throws(() => validateProfileManifest({ ...profile, schemas: [] }, manifest), /profile hash\/revision drift/);
    assert.throws(() => validateProfileManifest(profile, { ...manifest, loaderOptionsSha256: 'wrong' }), /loader options drift/);
    assert.throws(() => validateProfileManifest(profile, { ...manifest, cacheKey: 'wrong' }), /cache identity drift/);
    assert.throws(() => validateProfileManifest(profile, { ...manifest, inputSha256: 'wrong' }), /cache identity drift/);
    assert.throws(() => validateProfileManifest(profile, { ...manifest, capabilities: [] }), /declarative profile metadata drift/);
    assert.throws(() => validateProfileManifest(profile, { ...manifest, transformed: [{ path: profile.files[0].path, rules: [] }] }), /executed transform rules/);
});

test('EVIDENCE nonexistent named test, wrong source and unexecuted test are rejected', () => {
    for (const modify of [
        f => f.mapping.cases[0].references[0].name = 'invented test',
        f => f.mapping.cases[0].references[0].source = 'test/wrong.test.cjs',
        f => f.context.text = () => "// test('sample assertion', () => {});",
        f => f.context.tap.clear(),
        f => f.context.tap.set('sample assertion', 'not_run'),
        f => f.context.report.commands[0].exitCode = 1,
        f => f.context.report.commands[0].status = 'blocked',
    ]) {
        const f = fixture(); modify(f);
        assert.throws(() => validateMapping(f.catalog, f.mapping, f.context), /WGA_EVIDENCE_INVALID/);
    }
});

test('EVIDENCE invented coverage, missing IDs, duplicates and release overclaims are rejected', () => {
    for (const modify of [
        f => f.mapping.cases[1].coverage = 'covered',
        f => f.mapping.cases[2].coverage = 'covered',
        f => f.mapping.cases[0].coverage = 'passed',
        f => f.mapping.cases.pop(),
        f => f.mapping.cases.push(f.mapping.cases[0]),
        f => f.mapping.releaseEligible = true,
        f => f.mapping.schemaVersion = 99,
        f => f.catalog.cases[0].procedure = 'changed requirement',
        f => f.mapping.cases[1].gaps = [],
        f => f.mapping.cases[2].references = f.mapping.cases[0].references,
    ]) {
        const f = fixture(); modify(f);
        assert.throws(() => validateMapping(f.catalog, f.mapping, f.context), /WGA_EVIDENCE_INVALID/);
    }
});

test('EVIDENCE skipped and todo TAP cases cannot count as passed', () => {
    const tap = tapResults('ok 1 - good\nok 2 - unavailable # SKIP credentials\nok 3 - future # TODO\nnot ok 4 - failed\n');
    assert.deepEqual([...tap], [['good', 'passed'], ['unavailable', 'not_run'], ['future', 'not_run'], ['failed', 'failed']]);
    assert.throws(() => tapResults('ok 1 - duplicate\nok 2 - duplicate\n'), /duplicate TAP name/);
});

test('EVIDENCE report references require one concrete case with successful assertions', () => {
    const f = fixture();
    f.mapping.cases[0].references = [{ kind: 'json-case', command: 'tests', source: 'test/sample.test.cjs', report: 'verification/sample.json',
        anchor: 'sample assertion', array: '/results', where: { id: 'scenario' }, assertions: [{ pointer: '/status', equals: 'passed' }, { pointer: '/count', equals: 1 }] }];
    assert.equal(validateMapping(f.catalog, f.mapping, f.context)[0].execution, 'passed');
    for (const value of [
        { results: [] },
        { results: [{ id: 'scenario', status: 'blocked', count: 1 }] },
        { results: [{ id: 'scenario', status: 'passed', count: 2 }] },
        { results: [{ id: 'scenario', status: 'passed', count: 1 }, { id: 'scenario', status: 'passed', count: 1 }] },
    ]) {
        f.context.json = () => value;
        assert.throws(() => validateMapping(f.catalog, f.mapping, f.context), /WGA_EVIDENCE_INVALID/);
    }
});

test('EVIDENCE parses declared tests rather than matching comments or arbitrary strings', () => {
    assert.deepEqual(namedTests("// test('fake', fn);\nconst text=\"test('fake2', fn)\"; test('real', fn);", 'sample.cjs'), ['real']);
    assert.equal(pointer({ 'a/b': { '~value': 7 } }, '/a~1b/~0value'), 7);
    assert.throws(() => pointer({ a: null }, '/a/b'), /missing JSON pointer/);
});

test('EVIDENCE resolves literal table test names and still requires each successful TAP result', () => {
    const source = 'for (const [http, code] of [[400, 13], [503, 14]]) { test(`HTTP ${http}`, async () => check(code)); }';
    assert.deepEqual(namedTests(source, 'sample.cjs'), ['HTTP 400', 'HTTP 503']);
    assert.deepEqual(namedTests('for (const size of [1, 0xff, "small"]) it(`size=${size}`, fn);', 'sample.cjs'), ['size=1', 'size=255', 'size=small']);
    const f = fixture();
    f.context.text = () => source;
    f.context.tap = tapResults('ok 1 - HTTP 400\nok 2 - HTTP 503\n');
    f.mapping.cases[0].references[0].name = 'HTTP 503';
    assert.equal(validateMapping(f.catalog, f.mapping, f.context)[0].execution, 'passed');
    f.context.tap.set('HTTP 503', 'not_run');
    assert.throws(() => validateMapping(f.catalog, f.mapping, f.context), /named test did not pass/);
    f.context.tap.set('HTTP 504', 'passed');
    f.mapping.cases[0].references[0].name = 'HTTP 504';
    assert.throws(() => validateMapping(f.catalog, f.mapping, f.context), /named test does not exist/);
});

test('EVIDENCE refuses computed, mutable, shadowed and excessive test-name tables', () => {
    for (const source of [
        'for (let code of [400]) test(`HTTP ${code}`, fn);',
        'for (const code of codes) test(`HTTP ${code}`, fn);',
        'for (const code of [400, getCode()]) test(`HTTP ${code}`, fn);',
        'for (const code of [400]) test(`HTTP ${String(code)}`, fn);',
        'for (const code of [400]) test(`HTTP ${other}`, fn);',
        'for (const code of [400]) { const code=503; test(`HTTP ${code}`, fn); }',
        'for (const code of [400]) { { const code=503; test(`HTTP ${code}`, fn); } }',
        'for (const [code=400] of [[]]) test(`HTTP ${code}`, fn);',
        'for (const [...codes] of [[400]]) test(`HTTP ${codes}`, fn);',
        'for (const code of [400]) register(() => test(`HTTP ${code}`, fn));',
        `for (const code of [${Array(257).fill('400').join(',')}]) test(\`HTTP \${code}\`, fn);`,
    ]) assert.deepEqual(namedTests(source, 'sample.cjs'), [], source);
});

function emulatorFixture() {
    const toolchain = { schemaVersion: 1, firestore: { version: 'fixture-emulator', sha256: 'a'.repeat(64) }, java: { version: 'fixture-java', sha256: 'b'.repeat(64) } };
    const envoyPin = { version: 'fixture-envoy', sha256: 'c'.repeat(64) };
    const suite = { sdk: '@google-cloud/datastore', suite: 'example-emulator-suite' };
    const sources = Object.fromEntries(['assert.mjs', 'datastore.mjs', 'firestore.mjs', 'emulator-datastore.mjs', 'emulator-datastore-streams.mjs', 'emulator-firestore.mjs', 'emulator-suites.mjs'].map(file => [file, 'd'.repeat(64)]));
    const evidence = Object.fromEntries(['scripts/google-emulator-test.cjs', 'scripts/emulator-envoy.cjs', 'fixtures/google/emulator-worker.mjs',
        'fixtures/emulators/toolchain.json', 'fixtures/emulators/launcher.cjs', 'fixtures/emulators/download.cjs',
        'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'].map(file => [file, 'e'.repeat(64)]));
    const instances = Object.fromEntries([['datastore', 'datastore-mode'], ['firestore', 'firestore-native']].map(([name, mode]) => [name, {
        mode, status: 'stopped', exit: { code: 0, signal: null }, loopbackOnly: true, persistentData: false, imports: false, exports: false,
    }]));
    const report = {
        status: 'passed', realGoogleSDK: true, officialEmulators: true, liveGoogleApiExecuted: false, deployedCloudflareExecuted: false, releaseEligible: false,
        sameSharedFiles: true, businessEquivalent: true, wireEquivalent: true,
        emulators: { modeNames: ['firestore', 'datastore'], instances, officialEmulator: { ...toolchain.firestore }, java: { ...toolchain.java }, cloudServiceRpcRequests: false, credentialsPassed: false, gcloudConfigurationRead: false },
        envoy: { ...envoyPin, exit: { code: 0, signal: null }, observationPoint: 'router-upstream-access-log', firestoreSyntheticOwnerInjected: true },
        sourceHashes: { native: { ...sources }, replacement: { ...sources }, workerd: { ...sources } }, evidence,
        results: [], requests: [], wire: [], methodStatusCounts: {},
    };
    const method = '/google.datastore.v1.Datastore/Lookup';
    for (const runtime of ['native', 'replacement', 'workerd-first', 'workerd-second']) {
        report.results.push({ runtime, ...suite, status: 'passed', checks: ['found-entity'], grpcWebRequests: runtime === 'native' ? 0 : 1 });
        const transport = { runtime: runtime.startsWith('workerd-') ? 'workerd' : runtime, invocation: runtime.startsWith('workerd-') ? runtime.slice(8) : null };
        report.wire.push({ ...transport, method, httpStatus: 200, grpcStatus: 0, upstream: 'datastore', flags: '-' });
        report.methodStatusCounts[runtime] = { [`${method}#0`]: 1 };
        if (runtime !== 'native') report.requests.push({ ...transport, suite: suite.suite, method, requestContentType: 'application/grpc-web+proto', responseContentType: 'application/grpc-web+proto', httpStatus: 200 });
    }
    return { report, expected: { toolchain, envoyPin, suites: [suite] } };
}

test('EVIDENCE official emulator gate requires actual runtime matrix, source identity and clean process exits', () => {
    const good = emulatorFixture();
    validateEmulatorReport(good.report, good.expected);
    for (const mutate of [
        f => f.report.status = 'failed',
        f => f.report.liveGoogleApiExecuted = true,
        f => f.report.releaseEligible = true,
        f => f.report.cleanupErrors = [{ message: 'cleanup failed' }],
        f => f.report.emulators.officialEmulator.sha256 = 'wrong',
        f => f.report.emulators.java.version = 'wrong',
        f => f.report.envoy.sha256 = 'wrong',
        f => f.report.envoy.observationPoint = 'downstream-filter',
        f => f.report.envoy.exit.code = 1,
        f => f.report.emulators.instances.datastore.exit.signal = 'SIGTERM',
        f => f.report.emulators.instances.firestore.status = 'running',
        f => f.report.emulators.credentialsPassed = true,
        f => delete f.report.evidence['fixtures/google/package-lock.json'],
        f => f.report.sourceHashes.workerd['emulator-datastore.mjs'] = 'f'.repeat(64),
        f => { for (const sources of Object.values(f.report.sourceHashes)) delete sources['emulator-datastore-streams.mjs']; },
        f => f.report.results.pop(),
        f => f.report.results[3] = { ...f.report.results[2] },
        f => f.report.results[2].status = 'skipped',
        f => f.report.results[2].checks = ['different-behavior'],
    ]) {
        const f = emulatorFixture(); mutate(f);
        assert.throws(() => validateEmulatorReport(f.report, f.expected), /WGA_EVIDENCE_INVALID/);
    }
});

test('EVIDENCE emulator RPC counts are derived from arrivals and per-suite fetch records', () => {
    for (const mutate of [
        f => f.report.wire[2].grpcStatus = 2,
        f => f.report.wire[2].grpcStatus = null,
        f => delete f.report.wire[2].grpcStatus,
        f => f.report.wire[2].upstream = 'firestore',
        f => f.report.wire[2].flags = 'UH',
        f => f.report.wire[2].invocation = 'unrecorded',
        f => f.report.methodStatusCounts.replacement['/google.datastore.v1.Datastore/Lookup#0'] = 2,
        f => f.report.requests.pop(),
        f => f.report.requests[0].requestContentType = 'application/json',
        f => f.report.requests[0].suite = 'unknown-suite',
        f => f.report.results[0].grpcWebRequests = 1,
        f => f.report.results[1].grpcWebRequests = 2,
    ]) {
        const f = emulatorFixture(); mutate(f);
        assert.throws(() => validateEmulatorReport(f.report, f.expected), /WGA_EVIDENCE_INVALID/);
    }
});

test('EVIDENCE emulator error suites require non-OK upstream statuses even when edited totals agree', () => {
    for (const [suite, service, codes] of [
        ['datastore-emulator-errors', 'datastore.v1.Datastore', [5, 6]],
        ['firestore-emulator-errors', 'firestore.v1.Firestore', [5, 6, 9]],
    ]) {
        const f = emulatorFixture();
        const sdk = `@google-cloud/${service.split('.')[0]}`;
        const method = `/google.${service}/Commit`;
        f.expected.suites = [{ sdk, suite }];
        f.report.wire = []; f.report.requests = [];
        for (const row of f.report.results) {
            Object.assign(row, { sdk, suite, checks: ['remote-errors-preserved'], grpcWebRequests: row.runtime === 'native' ? 0 : codes.length });
            const transport = { runtime: row.runtime.startsWith('workerd-') ? 'workerd' : row.runtime, invocation: row.runtime.startsWith('workerd-') ? row.runtime.slice(8) : null };
            f.report.methodStatusCounts[row.runtime] = {};
            for (const code of codes) {
                f.report.wire.push({ ...transport, method, httpStatus: 200, grpcStatus: code, upstream: service.split('.')[0], flags: '-' });
                f.report.methodStatusCounts[row.runtime][`${method}#${code}`] = 1;
                if (row.runtime !== 'native') f.report.requests.push({ ...transport, suite, method, requestContentType: 'application/grpc-web+proto', responseContentType: 'application/grpc-web+proto', httpStatus: 200 });
            }
        }
        validateEmulatorReport(f.report, f.expected);
        for (const missing of codes) {
            const edited = structuredClone(f.report);
            for (const arrival of edited.wire) if (arrival.grpcStatus === missing) arrival.grpcStatus = 0;
            for (const counts of Object.values(edited.methodStatusCounts)) {
                counts[`${method}#0`] = counts[`${method}#${missing}`];
                delete counts[`${method}#${missing}`];
            }
            assert.throws(() => validateEmulatorReport(edited, f.expected), /missing upstream Commit status/);
        }
    }
});

function lifecycleFixture() {
    const { expected: { toolchain } } = emulatorFixture();
    const report = { status: 'passed', officialEmulator: true, externalServiceRpcRequests: false,
        toolchain: { firestore: { ...toolchain.firestore }, java: { ...toolchain.java } }, results: [] };
    for (const [id, phase, signal, modes] of [
        ['ready-sigterm', 'ready', 'SIGTERM', ['firestore']], ['ready-sigint', 'ready', 'SIGINT', ['datastore']],
        ['startup-sigterm', 'spawned', 'SIGTERM', ['firestore']], ['idempotent-stop', 'ready', null, ['firestore', 'datastore']],
    ]) {
        const pid = 1000 + report.results.length;
        report.results.push({ id, status: 'passed', phase, signal, modes, pid, exit: { pid, code: signal ? null : 0, signal },
            children: modes.map((mode, index) => ({ mode: mode === 'firestore' ? 'firestore-native' : 'datastore-mode', pid: pid + 100 + index,
                pidGone: true, workingDirectoryRemoved: true, exit: { pid: pid + 100 + index, code: phase === 'ready' ? 0 : 143, signal: null, ...(signal ? { parentSignal: signal } : {}) } })),
            ...(signal ? {} : { stopEvidence: { concurrentStopSharedPromise: true, repeatedStopAfterExit: true } }),
        });
    }
    return { report, toolchain };
}

test('EVIDENCE lifecycle receipts require signal-specific exits and completed child cleanup', () => {
    const good = lifecycleFixture();
    validateLifecycleReport(good.report, good.toolchain);
    for (const mutate of [
        f => f.report.results.pop(),
        f => f.report.results[0].status = 'skipped',
        f => f.report.results[0].signal = 'SIGINT',
        f => f.report.results[0].exit.code = 0,
        f => f.report.results[0].children[0].exit.code = 143,
        f => f.report.results[0].children[0].exit.parentSignal = 'SIGINT',
        f => f.report.results[0].children[0].pidGone = false,
        f => f.report.results[0].children[0].workingDirectoryRemoved = false,
        f => f.report.results[1].children = [],
        f => f.report.results[2].children[0].exit.code = 9,
        f => f.report.results[3].stopEvidence.repeatedStopAfterExit = false,
        f => f.report.toolchain.java.version = 'wrong',
        f => f.report.externalServiceRpcRequests = true,
    ]) {
        const f = lifecycleFixture(); mutate(f);
        assert.throws(() => validateLifecycleReport(f.report, f.toolchain), /WGA_EVIDENCE_INVALID/);
    }
});

test('EVIDENCE supplemental execution cannot inflate original catalog satisfaction', () => {
    const f = fixture();
    f.mapping.supplementalCases = [{ id: 'EXTRA-001', appliesToOriginalCatalog: false, reason: 'Additional runtime behavior outside the original catalog.', references: f.mapping.cases[0].references }];
    const planned = validateMapping(f.catalog, f.mapping, f.context);
    const extra = validateSupplementalCases(f.mapping, f.context);
    assert.equal(planned.length, 3);
    assert.equal(planned.filter(item => item.satisfiesPlannedCase).length, 1);
    assert.equal(extra[0].execution, 'passed');
    f.mapping.supplementalCases[0].appliesToOriginalCatalog = true;
    assert.throws(() => validateSupplementalCases(f.mapping, f.context), /cannot claim a planned catalog case/);
});

test('EVIDENCE mapping enumerates all 189 original cases with real source references', () => {
    const root = path.resolve(__dirname, '..');
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/test-catalog.json')));
    const mapping = JSON.parse(fs.readFileSync(path.join(root, 'compatibility/test-evidence.json')));
    assert.equal(catalog.cases.length, 189);
    assert.equal(catalog.actualAdapterTestsRun, false);
    assert.deepEqual(mapping.cases.map(item => item.id), catalog.cases.map(item => item.id));
    for (const item of [...mapping.cases, ...(mapping.supplementalCases || [])]) {
        for (const ref of item.references) {
            const source = fs.readFileSync(path.join(root, ref.source), 'utf8');
            if (ref.kind === 'tap') assert.ok(namedTests(source, ref.source).includes(ref.name), `${item.id}: ${ref.name}`);
            else assert.ok(source.includes(ref.anchor), `${item.id}: ${ref.anchor}`);
        }
    }
});
