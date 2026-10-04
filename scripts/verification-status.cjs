'use strict';
// One completion view for the entire remaining campaign; never rewrites the
// original catalog or equates a reproduced difference with compatibility.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const catalog = require('./gcp-catalog.cjs');
const differences = {
    'API-011': ['verified-difference', 'Duplicate unary messages: native deadlines with code 4; adapter rejects with code 12.'],
    'WIRE-013': ['historical-expectation', 'The original blanket compression rejection predates implemented gzip/deflate support.'],
    'WIRE-016': ['verified-difference', 'The implemented missing-status diagnostic differs from the original catalog name.'],
    'LIFE-015': ['verified-difference', 'Invalid Date: adapter asynchronously returns INTERNAL; native synchronously throws RangeError.'],
    'FLOW-006': ['verified-difference', 'Counted read-demand controls reproduce the duplicate-unary native/adapter difference.'],
    'DS-021': ['upstream-sdk-boundary', 'Both pinned native and adapter Datastore streams continue paging after destroy().'],
    'TX-008': ['upstream-sdk-boundary', 'Pinned public Commit promises expose no cancellation handle; deadlines do not undo writes.'],
};
const local = [
    ...[1, 3, 6, 7, 8, 9, 11, 12, 13, 14, 15].map(n => `AUTH-${String(n).padStart(3, '0')}`),
    ...[2, 5, 6, 7, 8, 9, 11].map(n => `BOOT-${String(n).padStart(3, '0')}`),
    ...[1, 2, 3, 4, 6, 7].map(n => `SEC-${String(n).padStart(3, '0')}`),
    'RETRY-001', 'RETRY-004', 'WIRE-023',
];
const cloud = catalog.ids;
const campaignIds = [...local, ...Object.keys(differences), ...cloud].sort();
function validateLiveSummary(live) {
    const need = (condition, message) => { if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: live campaign ${message}`); };
    need(live?.schemaVersion === 1 && typeof live.run === 'string' && live.run.length > 0 && live.releaseEligible === false, 'receipt identity');
    need(typeof live.dedicatedProject === 'boolean' && typeof live.allCreatedResourcesDeleted === 'boolean', 'environment/cleanup flags');
    need(Array.isArray(live.cases) && isDeepStrictEqual(live.cases.map(row => row.id).sort(), [...cloud].sort()), 'live case missing/duplicated');
    for (const row of live.cases) {
        need(['passed', 'failed', 'blocked', 'not-run'].includes(row.behavior), `${row.id} execution status`);
        need(Array.isArray(row.reasons) && row.reasons.every(reason => typeof reason === 'string' && reason.length > 0)
            && new Set(row.reasons).size === row.reasons.length && Array.isArray(row.evidence) && row.evidence.length > 0, `${row.id} evidence/reasons`);
        need(row.reasons.includes('dedicated-project-unconfirmed') === (row.id.startsWith('CLOUD-') && !live.dedicatedProject), `${row.id} dedicated project consistency`);
        need(row.reasons.includes('cleanup-or-inventory-unverified') === !live.allCreatedResourcesDeleted, `${row.id} cleanup consistency`);
        need(row.reasons.includes('required-execution-incomplete') === (row.behavior !== 'passed'), `${row.id} incomplete execution consistency`);
        const localPolicy = row.id === 'CLOUD-008';
        need(row.executionLayer === (localPolicy ? 'local-policy' : 'live')
            && row.reasons.includes('environment-gate-exercised-locally') === localPolicy, `${row.id} execution layer`);
        need(typeof row.catalogMatch === 'boolean' && row.catalogMatch === (!localPolicy && row.behavior === 'passed' && row.reasons.length === 0), `${row.id} catalog match consistency`);
    }
    need(live.certificationPassed === live.cases.every(row => row.catalogMatch), 'certification consistency');
    return live;
}
function summarize(evidence, live) {
    const need = (condition, message) => { if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: campaign ${message}`); };
    need(evidence?.cases?.length === 189 && evidence.summary?.planned === 189 && evidence.releaseEligible === false, 'complete local catalog required');
    need(new Set(campaignIds).size === 44, '44 unique original cases required');
    if (live) validateLiveSummary(live);
    const rows = campaignIds.map(id => {
        const matches = evidence.cases.filter(row => row.id === id);
        need(matches.length === 1, `missing/duplicate ${id}`);
        const row = matches[0];
        const result = { id, originalCoverage: row.coverage, localExecution: row.execution,
            originalRequirementSatisfied: row.satisfiesPlannedCase, evidence: row.references?.map(ref => ref.report || ref.source) || [] };
        if (local.includes(id)) {
            need(row.coverage === 'covered' && row.execution === 'passed' && row.satisfiesPlannedCase === true, `local gap incomplete: ${id}`);
            return { ...result, disposition: 'verified-local' };
        }
        if (differences[id]) {
            need(row.coverage === 'partial' && row.execution === 'passed' && row.references?.length > 0 && row.satisfiesPlannedCase === false,
                `difference lacks current execution: ${id}`);
            return { ...result, disposition: differences[id][0], explanation: differences[id][1] };
        }
        const liveRows = live?.cases?.filter(item => item.id === id) || [];
        need(!live || liveRows.length === 1, `live case missing/duplicated: ${id}`);
        return { ...result, disposition: liveRows[0]?.executionLayer === 'local-policy'
            ? liveRows[0].behavior === 'passed' ? 'verified-local-policy' : 'local-policy-incomplete'
            : liveRows[0]?.behavior === 'passed' ? 'verified-live-with-catalog-conditions'
            : liveRows[0]?.behavior === 'failed' ? 'live-failed' : 'cloud-environment-required',
            ...(liveRows[0] ? { live: liveRows[0] } : { reasons: ['This local run cannot execute the deployed cloud layer.'] }) };
    });
    return { schemaVersion: 1, status: 'campaign-classified', releaseEligible: false,
        originalCatalog: evidence.summary, campaignCount: rows.length, localGapsVerified: local.length,
        verifiedDifferences: Object.keys(differences).length, cloudCases: cloud.length,
        liveReceiptIncluded: !!live, liveRun: live?.run || null, cases: rows };
}
function writeCampaign(root, { liveFile } = {}) {
    const evidenceFile = path.join(root, 'verification/evidence.json');
    const evidence = JSON.parse(fs.readFileSync(evidenceFile));
    let live, liveBytes, rawBytes;
    if (liveFile) {
        liveBytes = fs.readFileSync(liveFile);
        live = validateLiveSummary(JSON.parse(liveBytes));
        if (!isDeepStrictEqual(Object.keys(live.sourceHashes || {}).sort(), [...catalog.SOURCE_FILES].sort())) throw new Error('Live campaign source provenance must contain the exact required manifest');
        for (const [file, expected] of Object.entries(live.sourceHashes || {})) {
            if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..') ||
                crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') !== expected) {
                throw new Error(`Stale live campaign source: ${file}`);
            }
        }
        rawBytes = fs.readFileSync(path.join(path.dirname(path.resolve(liveFile)), 'gcp-cloud-probe.json'));
        const raw = JSON.parse(rawBytes);
        if (raw.catalogRequested !== true || !Number.isFinite(Date.parse(raw.finishedAt))
            || !Number.isFinite(Date.parse(raw.startedAt)) || Date.parse(raw.finishedAt) < Date.parse(raw.startedAt)) {
            throw new Error('Live campaign raw receipt is incomplete');
        }
        if (!isDeepStrictEqual(live, catalog.summarize(raw))) throw new Error('Live campaign summary differs from its raw receipt');
    }
    const report = summarize(evidence, live);
    report.localEvidenceSha256 = crypto.createHash('sha256').update(fs.readFileSync(evidenceFile)).digest('hex');
    if (liveFile) {
        report.liveReceiptSha256 = crypto.createHash('sha256').update(liveBytes).digest('hex');
        report.liveRawReceiptSha256 = crypto.createHash('sha256').update(rawBytes).digest('hex');
    }
    fs.writeFileSync(path.join(root, 'verification/remaining-campaign.json'), JSON.stringify(report, null, 2) + '\n');
    return report;
}
if (require.main === module) {
    try {
        const root = path.resolve(__dirname, '..');
        require('./test-evidence.cjs').checkEvidence(root);
        const liveFile = process.argv.find(arg => arg.startsWith('--cloud='))?.slice(8);
        const report = writeCampaign(root, { liveFile });
        console.log(JSON.stringify({ status: report.status, campaignCount: report.campaignCount,
            localGapsVerified: report.localGapsVerified, verifiedDifferences: report.verifiedDifferences,
            cloudCases: report.cloudCases, liveReceiptIncluded: report.liveReceiptIncluded }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { summarize, writeCampaign, validateLiveSummary, campaignIds, differences, local, cloud };
