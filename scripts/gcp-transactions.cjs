'use strict';

const suites = Object.freeze(['datastore-conflict', 'firestore-conflict',
    'datastore-commit-response-lost', 'firestore-commit-response-lost']);
function parseTransactionArgs(argv) {
    const fail = () => { throw new Error('INVALID_TRANSACTION_OPTION'); };
    if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) fail();
    const options = argv.filter(value => value.startsWith('--verify-transaction'));
    if (!options.length) return false;
    if (options.length !== 1 || options[0] !== '--verify-transactions') fail();
    return true;
}

function summarizeTransactions(report) {
    const modes = ['native', 'grpc-web', 'cloudflare'];
    const expectedChecks = (suite, mode) => suite.endsWith('-conflict') ? [
        'two-explicit-read-write-transactions', 'same-record-shared-snapshot',
        'first-commit-accepted', 'second-commit-real-aborted-10', 'no-sdk-or-application-retry',
        'winner-value-preserved', 'same-client-fresh-transaction-recovery', 'verified-delete-cleanup',
    ] : [
        'explicit-transaction-commit', 'commit-success-observed-before-discard',
        `response-discard-at-${mode === 'native' ? 'native-sdk-result' : 'adapter-fetch'}`,
        'caller-unavailable-14', 'one-commit-attempt-no-retry', 'independent-read-reconciles-applied-value',
        'same-client-recovery', 'verified-delete-cleanup',
    ];
    const results = modes.flatMap(mode => suites.map(suite => {
        const rows = mode === 'native' ? (report.nativeTransactions?.suites || []).filter(row => row.suite === suite)
            : (report.results || []).filter(row => row.route === `/gcp/${mode}/${suite}`);
        const receipt = rows.length === 1 ? rows[0] : undefined;
        const body = mode === 'native' ? receipt : receipt?.body;
        const expected = expectedChecks(suite, mode);
        const valid = body?.status === 'passed' && Array.isArray(body.checks) &&
            body.checks.length === expected.length && expected.every((check, i) => body.checks[i] === check) &&
            (mode === 'native' || (receipt.httpStatus === 200 && body.suite === suite && body.mode === mode));
        return { mode, suite, status: valid ? 'passed' : 'failed',
            ...(valid ? { checks: expected } : { reason: 'missing-or-invalid-receipt' }) };
    }));
    const optimistic = ['datastore', 'firestore'].every(service => report.databaseConcurrency?.[service] === 'OPTIMISTIC');
    return { schemaVersion: 1, kind: 'live-transactions',
        status: optimistic && report.nativeTransactions?.status === 'passed' && results.every(row => row.status === 'passed')
            ? 'passed' : 'failed',
        concurrencyModeVerified: optimistic, results,
        limits: ['Response loss is injected after observing successful Commit, not an uncontrolled network outage.',
            'Native injection discards the completed SDK result; Worker injection discards the Fetch response.',
            'This verifies optimistic conflicts in owned temporary databases, not all production concurrency modes.',
            'A failed Commit response does not imply rollback; callers must reconcile or use an idempotency policy.'] };
}

module.exports = { suites, parseTransactionArgs, summarizeTransactions };
