'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const catalog = require('../scripts/gcp-catalog.cjs');
const { summarize, writeCampaign, validateDecisions, campaignIds, local, differences } = require('../scripts/verification-status.cjs');
const decisions = require('../compatibility/behavior-decisions.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
    const original = require('../compatibility/test-catalog.json');
    return { releaseEligible: false, summary: { planned: 189 }, supplementalCases:
        ['sdk-query-cancellation', 'sdk-call-cancellation'].map(id => ({ id, execution: 'passed',
            appliesToOriginalCatalog: false, references: [{ report: 'verification/sdk-cancellation.json' }] })),
    cases: original.cases.map(({ id }) => ({
        id, coverage: local.includes(id) ? 'covered' : differences[id] ? 'partial' : 'unimplemented',
        execution: local.includes(id) || differences[id] ? 'passed' : 'not_run',
        satisfiesPlannedCase: local.includes(id), references: [{ report: decisions.decisions.find(row => row.id === id)?.report || 'synthetic-receipt.json' }],
    })) };
}
function rawFixture() {
    const suites = ['datastore-crud', 'datastore-transaction', ...catalog.extraSuites];
    return { run: 'synthetic', catalogRequested: true, dedicatedProject: false,
        startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z',
        results: ['grpc-web', 'cloudflare'].flatMap(mode => [
            ...suites.map(suite => ({ route: `/gcp/${mode}/${suite}`, httpStatus: 200, body: { suite, mode, status: 'passed' } })),
            ...['unary', 'stream', 'error', 'cancel'].map(name => ({ route: `/echo/${mode}/${name}`, httpStatus: 200, body: { name, mode, passed: true } })),
        ]), nativeGoogle: { suites: suites.slice(0, 2).map(suite => ({ suite, status: 'passed' })) },
        nativeCatalog: { suites: catalog.extraSuites.map(suite => ({ suite, status: 'passed' })) },
        echoControls: { nativeGrpcPassed: true }, restrictedPrincipal: { status: 'ready' },
        resources: [{ owned: true }], allCreatedResourcesDeleted: true, existingResourcesUnchanged: true,
        error: 'INTENTIONAL_CATALOG_E2E_FAILURE' };
}
function withReceipts(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-campaign-receipts-'));
    try {
        for (const relative of catalog.SOURCE_FILES) {
            const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `fixture source: ${relative}\n`);
        }
        const directory = path.join(root, 'verification'); fs.mkdirSync(directory);
        const evidenceFile = path.join(directory, 'evidence.json'), rawFile = path.join(directory, 'gcp-cloud-probe.json'), liveFile = path.join(directory, 'gcp-cloud-catalog.json');
        fs.writeFileSync(evidenceFile, JSON.stringify(fixture()));
        const raw = { ...rawFixture(), catalogSourceHashes: catalog.sourceHashes(root) };
        const live = catalog.summarize(raw);
        fs.writeFileSync(rawFile, JSON.stringify(raw)); fs.writeFileSync(liveFile, JSON.stringify(live));
        return run({ root, rawFile, liveFile, raw, live });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
test('complete campaign accounts for every one of the original 44 gaps', () => {
    const result = summarize(fixture());
    assert.equal(new Set(campaignIds).size, 44);
    assert.equal(result.cases.length, 44);
    assert.equal(result.localGapsVerified, 28);
    assert.equal(result.verifiedDifferences, 6);
    assert.equal(result.adapterPoliciesVerified, 4);
    assert.equal(result.sdkExtensionsVerified, 2);
    assert.equal(result.cloudCases, 10);
    assert.equal(result.liveReceiptIncluded, false);
    assert.equal(result.releaseEligible, false);
});
test('campaign rejects missing local proof or unexecuted compatibility differences', () => {
    for (const id of [...local, ...Object.keys(differences)]) {
        const evidence = fixture(); evidence.cases.find(row => row.id === id).execution = 'not_run';
        assert.throws(() => summarize(evidence), /WGA_EVIDENCE_INVALID/);
    }
});
test('live execution does not rewrite local coverage or imply catalog compliance', () => {
    const live = catalog.summarize(rawFixture());
    const result = summarize(fixture(), live);
    assert.equal(result.liveReceiptIncluded, true);
    assert.equal(result.cases.filter(row => row.disposition === 'verified-live-with-catalog-conditions').length, 9);
    assert.ok(result.cases.filter(row => row.id.startsWith('CLOUD-')).every(row => row.originalRequirementSatisfied === false && row.live.catalogMatch === false));
    assert.equal(result.cases.find(row => row.id === 'CLOUD-008').disposition, 'verified-local-policy');
    live.cases.pop();
    assert.throws(() => summarize(fixture(), live), /live case missing/);
});
test('campaign keeps all six original compatibility differences partial after explicit decisions', () => {
    for (const id of Object.keys(differences)) {
        const evidence = fixture();
        const row = evidence.cases.find(row => row.id === id); row.coverage = 'covered'; row.satisfiesPlannedCase = true;
        assert.throws(() => summarize(evidence), /difference lacks current execution/);
    }
});
test('behavior decisions require original hashes and executed reports without rewriting original requirements', () => {
    assert.equal(validateDecisions(decisions), decisions);
    for (const mutate of [
        value => { value.decisions.pop(); },
        value => { value.decisions[1] = value.decisions[0]; },
        value => { value.decisions[0].originalRequirementSatisfied = true; },
        value => { value.decisions[0].catalogCaseSha256 = '0'.repeat(64); },
        value => { value.decisions[0].report = 'unexecuted.json'; },
        value => { value.decisions[0].rationale = ''; },
        value => { value.revision = 0; },
    ]) {
        const policy = structuredClone(decisions); mutate(policy);
        assert.throws(() => summarize(fixture(), undefined, policy), /behavior decision/);
    }
    for (const decision of decisions.decisions) {
        const evidence = fixture(); evidence.cases.find(row => row.id === decision.id).references = [{ report: 'unrelated.json' }];
        assert.throws(() => summarize(evidence), /policy lacks current execution/);
    }
    const resolved = summarize(fixture()).cases.filter(row => row.disposition === 'verified-adapter-policy');
    assert.ok(resolved.every(row => row.originalCoverage === 'partial' && row.originalRequirementSatisfied === false));
});
test('SDK cancellation extensions preserve unwrapped SDK boundaries and require their own execution', () => {
    const evidence = fixture();
    evidence.supplementalCases = ['sdk-query-cancellation', 'sdk-call-cancellation'].map(id => ({
        id, execution: 'passed', appliesToOriginalCatalog: false, references: [{ report: 'verification/sdk-cancellation.json' }],
    }));
    const result = summarize(evidence);
    assert.equal(result.sdkExtensionsVerified, 2);
    assert.ok(result.cases.filter(row => row.disposition === 'verified-sdk-extension').every(row =>
        row.originalRequirementSatisfied === false && row.extension.changesUnwrappedSdk === false));
    for (const mutate of [
        value => { value.supplementalCases = []; },
        value => { value.supplementalCases[0].execution = 'not_run'; },
        value => { value.supplementalCases[0].appliesToOriginalCatalog = true; },
        value => { value.supplementalCases[0].references = []; },
        value => { value.supplementalCases.push(value.supplementalCases[0]); },
    ]) {
        const invalid = structuredClone(evidence); mutate(invalid);
        assert.throws(() => summarize(invalid), /SDK extension/);
    }
});
test('campaign rejects inconsistent catalog matches environment reasons and execution layers', () => {
    for (const mutate of [
        live => { live.cases.find(row => row.id === 'CLOUD-003').catalogMatch = true; },
        live => { live.cases.find(row => row.id === 'CLOUD-003').reasons = []; },
        live => { live.dedicatedProject = true; },
        live => { live.allCreatedResourcesDeleted = false; },
        live => { live.cases.find(row => row.id === 'CLOUD-003').behavior = 'failed'; },
        live => { live.cases.find(row => row.id === 'DS-019').catalogMatch = false; },
        live => { live.cases.find(row => row.id === 'CLOUD-008').executionLayer = 'live'; },
        live => { live.cases.find(row => row.id === 'CLOUD-008').reasons = ['dedicated-project-unconfirmed']; },
        live => { live.certificationPassed = true; },
        live => { live.cases[1] = live.cases[0]; },
    ]) {
        const live = catalog.summarize(rawFixture()); mutate(live);
        assert.throws(() => summarize(fixture(), live), /WGA_EVIDENCE_INVALID/);
    }
});
test('campaign never labels local environment policies as verified live execution', () => {
    const live = catalog.summarize({ run: 'no-network' });
    const result = summarize(fixture(), live);
    assert.equal(result.cases.find(row => row.id === 'CLOUD-008').disposition, 'verified-local-policy');
    assert.equal(result.cases.filter(row => row.disposition === 'verified-live-with-catalog-conditions').length, 0);
    const policy = live.cases.find(row => row.id === 'CLOUD-008'); policy.behavior = 'failed'; policy.reasons.push('required-execution-incomplete');
    assert.equal(summarize(fixture(), live).cases.find(row => row.id === 'CLOUD-008').disposition, 'local-policy-incomplete');
});
test('campaign validates exact source manifest and hashes both summary and raw receipt bytes', () => {
    withReceipts(({ root, rawFile, liveFile }) => {
        const result = writeCampaign(root, { liveFile });
        assert.equal(result.liveReceiptSha256, hash(fs.readFileSync(liveFile)));
        assert.equal(result.liveRawReceiptSha256, hash(fs.readFileSync(rawFile)));
        assert.equal(result.releaseEligible, false);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'verification/remaining-campaign.json'))), result);
        assert.ok(result.cases.filter(row => row.id.startsWith('CLOUD-')).every(row => row.live.catalogMatch === false));
    });
});
test('campaign rejects each missing required source substituted extras and stale source bytes', () => {
    for (const relative of catalog.SOURCE_FILES) withReceipts(({ root, liveFile, live }) => {
        delete live.sourceHashes[relative]; fs.writeFileSync(liveFile, JSON.stringify(live));
        assert.throws(() => writeCampaign(root, { liveFile }), /exact required manifest/);
    });
    withReceipts(({ root, liveFile, live }) => {
        const [first] = catalog.SOURCE_FILES;
        live.sourceHashes['scripts/unrelated.cjs'] = live.sourceHashes[first]; delete live.sourceHashes[first];
        fs.writeFileSync(liveFile, JSON.stringify(live));
        assert.throws(() => writeCampaign(root, { liveFile }), /exact required manifest/);
    });
    withReceipts(({ root, liveFile }) => {
        fs.appendFileSync(path.join(root, catalog.SOURCE_FILES[0]), 'stale');
        assert.throws(() => writeCampaign(root, { liveFile }), /Stale live campaign source/);
    });
});
test('campaign rejects outcome edits and requires the matching completed raw cloud receipt', () => {
    withReceipts(({ root, liveFile, live }) => {
        const row = live.cases.find(row => row.id === 'CLOUD-003');
        row.behavior = 'failed'; row.reasons.push('required-execution-incomplete');
        fs.writeFileSync(liveFile, JSON.stringify(live));
        assert.throws(() => writeCampaign(root, { liveFile }), /summary differs from its raw receipt/);
    });
    for (const mutate of [raw => { raw.run = 'different-run'; }, raw => { raw.results[0].httpStatus = 500; }, raw => { raw.bundle = { sha256: 'a'.repeat(64) }; }]) {
        withReceipts(({ root, rawFile, liveFile, raw }) => {
            mutate(raw); fs.writeFileSync(rawFile, JSON.stringify(raw));
            assert.throws(() => writeCampaign(root, { liveFile }), /summary differs from its raw receipt/);
        });
    }
    for (const mutate of [raw => { delete raw.finishedAt; }, raw => { raw.catalogRequested = false; }, raw => { raw.finishedAt = '2025-12-31T00:00:00Z'; }]) {
        withReceipts(({ root, rawFile, liveFile, raw }) => {
            mutate(raw); fs.writeFileSync(rawFile, JSON.stringify(raw));
            assert.throws(() => writeCampaign(root, { liveFile }), /raw receipt is incomplete/);
        });
    }
    withReceipts(({ root, rawFile, liveFile }) => {
        fs.unlinkSync(rawFile);
        assert.throws(() => writeCampaign(root, { liveFile }), /ENOENT/);
    });
});
