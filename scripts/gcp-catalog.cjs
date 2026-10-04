'use strict';
// Live results are deliberately separate from the network-disabled CI report.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const extraSuites = ['datastore-typed', 'datastore-aggregation', 'datastore-rollback',
    'datastore-errors', 'secret-manager-catalog', 'permission-denied'];
const caseSuites = {
    'DS-019': ['datastore-errors'],
    'CLOUD-002': ['datastore-crud'],
    'CLOUD-003': ['datastore-typed'],
    'CLOUD-004': ['datastore-aggregation'],
    'CLOUD-005': ['datastore-transaction', 'datastore-rollback'],
    'CLOUD-006': ['permission-denied'],
    'CLOUD-007': ['secret-manager-catalog'],
};
const ids = ['DS-019', ...Array.from({ length: 9 }, (_, i) => `CLOUD-${String(i + 1).padStart(3, '0')}`)];
const SOURCE_FILES = Object.freeze(['scripts/gcp-cloud-probe.cjs', 'scripts/gcp-native-probe.cjs', 'scripts/gcp-catalog.cjs',
    'fixtures/google/gcp-probe.mjs', 'fixtures/google/gcp-echo-probe.mjs', 'fixtures/google/shared/cloud-catalog.mjs',
    'fixtures/google/shared/datastore.mjs', 'fixtures/google/shared/secret-manager.mjs',
    'fixtures/cloud-run-probe/images.json', 'fixtures/google/package-lock.json', 'fixtures/native/package-lock.json',
    'fixtures/worker/package-lock.json']);
function environmentGate({ credentials, conversion, permissions, dedicatedProject }) {
    const reasons = [];
    if (!credentials) reasons.push('credentials-unavailable');
    if (!conversion) reasons.push('conversion-unavailable');
    if (!permissions) reasons.push('permission-unavailable');
    if (!dedicatedProject) reasons.push('dedicated-project-unconfirmed');
    return { status: reasons.length ? 'blocked' : 'passed', certificationPassed: !reasons.length, reasons };
}
function summarize(report) {
    const modes = ['grpc-web', 'cloudflare'];
    const results = report.results || [];
    const cleanup = report.allCreatedResourcesDeleted === true && report.existingResourcesUnchanged === true;
    const rows = ids.map(id => {
        const reasons = [];
        let behavior = 'not-run', evidence = [];
        if (caseSuites[id]) {
            evidence = modes.flatMap(mode => caseSuites[id].map(suite => {
                const route = `/gcp/${mode}/${suite}`;
                const matches = results.filter(row => row.route === route);
                const receipt = matches.length === 1 ? matches[0] : undefined;
                const identityMatched = receipt?.body?.suite === suite && receipt?.body?.mode === mode;
                return { route, httpStatus: Number.isInteger(receipt?.httpStatus) ? receipt.httpStatus : null, identityMatched,
                    status: !receipt ? 'not-run' : receipt.body?.status === 'blocked' ? 'blocked'
                        : receipt.httpStatus === 200 && identityMatched && receipt.body?.status === 'passed' ? 'passed' : 'failed' };
            }));
            const native = report.nativeCatalog?.suites || [];
            evidence.push(...caseSuites[id].map(suite => {
                const base = suite === 'datastore-crud' || suite === 'datastore-transaction'
                    ? report.nativeGoogle?.suites || [] : native;
                const matches = base.filter(row => row.suite === suite);
                return { route: `native/${suite}`, status: matches.length === 1 ? matches[0].status : 'not-run' };
            }));
            behavior = evidence.every(row => row.status === 'passed') ? 'passed'
                : evidence.some(row => row.status === 'failed') ? 'failed' : 'blocked';
            if (id === 'CLOUD-006' && report.restrictedPrincipal?.status !== 'ready') reasons.push('restricted-principal-token-unavailable');
        } else if (id === 'CLOUD-001') {
            evidence = modes.flatMap(mode => ['unary', 'stream', 'error', 'cancel'].map(name => {
                const route = `/echo/${mode}/${name}`, matches = results.filter(row => row.route === route);
                const receipt = matches.length === 1 ? matches[0] : undefined;
                const identityMatched = receipt?.body?.name === name && receipt?.body?.mode === mode;
                return { route, httpStatus: Number.isInteger(receipt?.httpStatus) ? receipt.httpStatus : null, identityMatched,
                    status: !receipt ? 'not-run' : receipt.httpStatus === 200 && identityMatched && receipt.body?.passed === true ? 'passed' : 'failed' };
            }));
            behavior = report.echoControls?.nativeGrpcPassed === true && evidence.every(row => row.status === 'passed') ? 'passed' : 'blocked';
        } else if (id === 'CLOUD-008') {
            evidence = ['credentials', 'conversion', 'permissions', 'dedicatedProject'].map(key => {
                const result = environmentGate({ credentials: true, conversion: true, permissions: true, dedicatedProject: true, [key]: false });
                return { condition: key, status: result.status, certificationPassed: result.certificationPassed };
            });
            behavior = 'passed';
            reasons.push('environment-gate-exercised-locally');
        } else if (id === 'CLOUD-009') {
            behavior = report.error === 'INTENTIONAL_CATALOG_E2E_FAILURE' && cleanup && report.resources?.some(row => row.owned) ? 'passed' : 'blocked';
            evidence = [{ primaryErrorRetained: report.error === 'INTENTIONAL_CATALOG_E2E_FAILURE', cleanupVerified: cleanup,
                ownedResources: report.resources?.filter(row => row.owned).length || 0 }];
        }
        if (id.startsWith('CLOUD-') && report.dedicatedProject !== true) reasons.push('dedicated-project-unconfirmed');
        if (!cleanup) reasons.push('cleanup-or-inventory-unverified');
        if (behavior !== 'passed') reasons.push('required-execution-incomplete');
        return { id, behavior, executionLayer: id === 'CLOUD-008' ? 'local-policy' : 'live',
            catalogMatch: behavior === 'passed' && reasons.length === 0, reasons, evidence };
    });
    return { schemaVersion: 1, scope: 'live cloud campaign; does not promote local CI evidence',
        run: report.run || null, sourceHashes: report.catalogSourceHashes || {}, bundle: report.bundle || null,
        dedicatedProject: report.dedicatedProject === true, project: report.project || null,
        startedAt: report.startedAt, completedAt: report.finishedAt,
        allCreatedResourcesDeleted: cleanup, releaseEligible: false,
        certificationPassed: rows.every(row => row.catalogMatch), cases: rows,
        limits: ['Public grpcbin cannot expose backend generator cleanup after caller cancellation.',
            'A temporary namespace in an existing project does not meet the original dedicated-project invariant.',
            'Negative environment gate controls execute locally; they are not a deployed restricted-account test.'] };
}
function sourceHashes(root) {
    return Object.fromEntries(SOURCE_FILES.map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}
module.exports = { extraSuites, ids, SOURCE_FILES, environmentGate, summarize, sourceHashes };
