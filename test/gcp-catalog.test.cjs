'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ids, extraSuites, SOURCE_FILES, summarize, environmentGate } = require('../scripts/gcp-catalog.cjs');
function fixture() {
    const suites = ['datastore-crud', 'datastore-transaction', ...extraSuites];
    return { run: 'synthetic', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z',
        results: ['grpc-web', 'cloudflare'].flatMap(mode => [
            ...suites.map(suite => ({ route: `/gcp/${mode}/${suite}`, httpStatus: 200, body: { suite, mode, status: 'passed' } })),
            ...['unary', 'stream', 'error', 'cancel'].map(name => ({ route: `/echo/${mode}/${name}`, httpStatus: 200, body: { name, mode, passed: true } })),
        ]), nativeGoogle: { suites: suites.slice(0, 2).map(suite => ({ suite, status: 'passed' })) },
        nativeCatalog: { suites: extraSuites.map(suite => ({ suite, status: 'passed' })) },
        echoControls: { nativeGrpcPassed: true }, restrictedPrincipal: { status: 'ready' },
        resources: [{ owned: true }], allCreatedResourcesDeleted: true, existingResourcesUnchanged: true,
        error: 'INTENTIONAL_CATALOG_E2E_FAILURE' };
}
test('live catalog preserves all ten cases and the dedicated-project constraint', () => {
    const result = summarize(fixture());
    assert.deepEqual(result.cases.map(row => row.id), ids);
    assert.ok(result.cases.every(row => row.behavior === 'passed'));
    assert.equal(result.cases.find(row => row.id === 'DS-019').catalogMatch, true);
    assert.ok(result.cases.filter(row => row.id.startsWith('CLOUD-')).every(row => !row.catalogMatch && row.reasons.includes('dedicated-project-unconfirmed')));
    assert.equal(result.certificationPassed, false);
    assert.equal(result.releaseEligible, false);
});
test('missing or duplicate live suite and native baseline cannot become pass', () => {
    for (const mutate of [
        row => row.results.splice(row.results.findIndex(item => item.route === '/gcp/cloudflare/datastore-typed'), 1),
        row => row.results.push(row.results.find(item => item.route === '/gcp/cloudflare/datastore-typed')),
        row => { row.nativeCatalog.suites.find(item => item.suite === 'datastore-typed').status = 'failed'; },
    ]) {
        const report = fixture(); mutate(report);
        const row = summarize(report).cases.find(item => item.id === 'CLOUD-003');
        assert.notEqual(row.behavior, 'passed'); assert.equal(row.catalogMatch, false);
    }
});
test('live suites require HTTP 200 and exact body suite and mode identities', () => {
    for (const mutate of [row => { row.httpStatus = 500; }, row => { delete row.httpStatus; }, row => { row.httpStatus = '200'; },
        row => { row.body.suite = 'datastore-crud'; }, row => { delete row.body.suite; },
        row => { row.body.mode = 'grpc-web'; }, row => { delete row.body.mode; }, row => { row.body.status = true; }]) {
        const report = fixture(); report.dedicatedProject = true;
        mutate(report.results.find(row => row.route === '/gcp/cloudflare/datastore-typed'));
        const result = summarize(report).cases.find(row => row.id === 'CLOUD-003');
        assert.equal(result.behavior, 'failed'); assert.equal(result.catalogMatch, false);
    }
});
test('live echo controls require HTTP 200 and exact body name and mode identities', () => {
    for (const mutate of [row => { row.httpStatus = 500; }, row => { delete row.httpStatus; }, row => { row.httpStatus = '200'; },
        row => { row.body.name = 'unary'; }, row => { delete row.body.name; },
        row => { row.body.mode = 'grpc-web'; }, row => { delete row.body.mode; }, row => { row.body.passed = 'true'; }]) {
        const report = fixture(); report.dedicatedProject = true;
        mutate(report.results.find(row => row.route === '/echo/cloudflare/cancel'));
        const result = summarize(report).cases.find(row => row.id === 'CLOUD-001');
        assert.notEqual(result.behavior, 'passed'); assert.equal(result.catalogMatch, false);
    }
    const report = fixture(); report.echoControls.nativeGrpcPassed = 'true';
    assert.notEqual(summarize(report).cases.find(row => row.id === 'CLOUD-001').behavior, 'passed');
});
test('environment policy controls remain local even without any deployed receipt', () => {
    const result = summarize({ run: 'no-network' });
    const policy = result.cases.find(row => row.id === 'CLOUD-008');
    assert.equal(policy.executionLayer, 'local-policy'); assert.equal(policy.catalogMatch, false);
    assert.ok(policy.reasons.includes('environment-gate-exercised-locally'));
    assert.ok(result.cases.filter(row => row.id !== 'CLOUD-008').every(row => row.executionLayer === 'live' && row.behavior !== 'passed'));
});
test('cloud provenance exports the exact frozen fourteen-source manifest', () => {
    assert.ok(Object.isFrozen(SOURCE_FILES));
    assert.deepEqual(SOURCE_FILES, ['scripts/gcp-cloud-probe.cjs', 'scripts/gcp-native-probe.cjs', 'scripts/gcp-catalog.cjs',
        'scripts/gcp-soak.cjs', 'scripts/gcp-owned-iam.cjs',
        'fixtures/google/gcp-probe.mjs', 'fixtures/google/gcp-echo-probe.mjs', 'fixtures/google/shared/cloud-catalog.mjs',
        'fixtures/google/shared/datastore.mjs', 'fixtures/google/shared/secret-manager.mjs', 'fixtures/cloud-run-probe/images.json',
        'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json']);
});
test('live failure cleanup requires the primary error, owned resources and unchanged inventory', () => {
    for (const key of ['error', 'resources', 'allCreatedResourcesDeleted', 'existingResourcesUnchanged']) {
        const report = fixture(); delete report[key];
        assert.notEqual(summarize(report).cases.find(row => row.id === 'CLOUD-009').behavior, 'passed');
    }
});
test('missing beta credentials or permissions block cloud certification individually', () => {
    const ready = { credentials: true, conversion: true, permissions: true, dedicatedProject: true };
    assert.equal(environmentGate(ready).certificationPassed, true);
    for (const key of Object.keys(ready)) {
        const result = environmentGate({ ...ready, [key]: false });
        assert.equal(result.status, 'blocked'); assert.equal(result.certificationPassed, false);
        assert.equal(result.reasons.length, 1);
    }
});
test('cloud catalog projections never copy arbitrary error or payload fields', () => {
    const report = fixture(), marker = 'sensitive-fixture-marker';
    report.results[0].body.payload = marker;
    report.nativeCatalog.suites[0].error = marker;
    report.restrictedPrincipal.token = marker;
    assert.equal(JSON.stringify(summarize(report)).includes(marker), false);
});
