'use strict';
const { isDeepStrictEqual } = require('node:util');
function need(value, message) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: ${message}`); }
function validateWorkerdServerStreamingReport(report) {
    need(report?.status === 'passed' && report.sourceBuild === false && report.liveCloud === false
        && report.incomingCloudflareTranslation === false && report.nativeHttp2 === false
        && report.serviceBindings === true && report.controlledPeer === true && report.externalRequests === 0,
    'Fetch server streaming execution scope is invalid');
    need(report.cleanupVerifiedBeforeDispose === true && report.runtimeDisposed === true,
        'Fetch server streaming cleanup did not precede runtime disposal');
    need(report.installedInputs && Object.keys(report.installedInputs).length > 0
        && Object.entries(report.installedInputs).every(([file, hash]) => file.startsWith('fixtures/worker/node_modules/@grpc/grpc-js/')
            && /^[a-f0-9]{64}$/.test(hash)), 'Fetch server streaming did not execute installed package');
    const required = ['scripts/test-workerd-server-streaming.cjs', 'fixtures/worker/server-request-streaming.mjs',
        'fixtures/worker/server-request-streaming-backend.mjs', 'fixtures/worker/package-lock.json', 'src/server.ts'];
    need(required.every(file => /^[a-f0-9]{64}$/.test(report.evidence?.[file] || '')), 'Fetch server streaming source hashes are incomplete');
    const scenarios = [
        ['controlled-fetch', ['sum', 'empty', 'bidi', 'early-error', 'early-success', 'cancel', 'deadline', 'slow-consumer', 'gzip', 'receive-limit']],
        ['service-binding', ['client-eof', 'bidi-demand', 'cancel', 'deadline']],
    ];
    need(report.runs?.length === 2 && report.caseCount === 14 && report.rpcCount === 14 && report.fetchCount === 14,
        'Fetch server streaming aggregate execution counts drifted');
    for (const [transport, kinds] of scenarios) {
        const runs = report.runs.filter(value => value.transport === transport);
        need(runs.length === 1, 'Fetch server streaming transport coverage is incomplete');
        const run = runs[0];
        need(run.status === 'passed' && run.caseCount === kinds.length && run.rpcCount === kinds.length && run.fetchCount === kinds.length
            && run.cleanupVerifiedBeforeDispose === true && isDeepStrictEqual(run.cases?.map(value => value.kind), kinds),
        'Fetch server streaming scenarios are incomplete');
        for (const row of run.cases) {
            const expected = row.kind === 'early-error' ? 7 : row.kind === 'cancel' ? 1 : row.kind === 'deadline' ? 4 : row.kind === 'receive-limit' ? 8 : 0;
            const messages = row.kind === 'empty' || row.kind.startsWith('early-') || row.kind === 'receive-limit' ? 0
                : row.kind === 'cancel' || row.kind === 'deadline' ? 1 : row.kind === 'slow-consumer' ? 12 : 2;
            need(row.status === 'passed' && row.grpcStatus === expected && row.serverMessages === messages
                && row.uploadUnlocked === true && row.activeCalls === 0 && row.bufferedBytes === 0,
            'Fetch server streaming terminal status, demand or cleanup differs');
            need(row.responseBeforeHalfClose === ['bidi', 'bidi-demand', 'early-error', 'early-success'].includes(row.kind),
                'Fetch server streaming response did not prove directional independence');
            if (transport === 'controlled-fetch') need(row.fetches === 1
                && row.cancellationObserved === (['cancel', 'deadline'].includes(row.kind) ? true : null),
            'Fetch server streaming cancellation or attempt count differs');
            else need(row.serverClosed === true && row.inputReleased === true && row.serverCancelled === (expected !== 0) && row.eof === (expected === 0)
                && row.cleanupRetainedWithWaitUntil === true && row.immediateRemoteCancellationRequired === false,
            'Service-binding server streaming lifecycle boundary was not verified');
        }
    }
}
module.exports = { validateWorkerdServerStreamingReport };
