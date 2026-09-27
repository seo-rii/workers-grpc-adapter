'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkerdLifecycleReport } = require('../scripts/test-evidence.cjs');
function fixture() {
    const resources = ['cloudflare', 'grpc-web'].flatMap(mode =>
        ['resource-admission', 'resource-send-budget', 'resource-receive-budget', 'resource-slow-compressed'].map(kind => ({
            mode, kind, recovered: true, limits: { maxBufferedBytes: 4096 },
            usage: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakBufferedBytes: 128,
                peakActiveCalls: kind === 'resource-slow-compressed' ? 2 : 1, peakQueuedCalls: 1 },
            ...(kind === 'resource-admission' ? { overloadCode: 8, queuedFetches: 0, sharedClients: 3, queuedTerminalCodes: [1, 4] } : {}),
            ...(kind === 'resource-slow-compressed' ? { peakReadableLength: 1, messages: 8, compressed: true, peerDuringAuth: true } : {}),
            ...(['resource-send-budget', 'resource-receive-budget'].includes(kind) ? { code: 8, compressed: true } : {}),
        })));
    return {
        status: 'passed', sourceBuild: false, liveCloud: false, serviceBindings: true,
        productionServerHandler: true, independentUploadPeer: true, incomingCloudflareTranslation: false, nativeHttp2: false,
        runtimeDisposed: true, cleanupVerifiedBeforeDispose: true, externalRequests: 0,
        caseCount: 39, coreCaseCount: 31, resourceCaseCount: 8, rpcCount: 70, fetchCount: 54, responseReaderCount: 54,
        cancelledResponseReaderCount: 6, backendAbortCount: 4,
        installedInputs: { 'fixtures/worker/node_modules/@grpc/grpc-js/dist/index.js': 'fixture-hash' },
        evidence: Object.fromEntries(['scripts/test-workerd-lifecycle.cjs', 'fixtures/worker/lifecycle-client.mjs',
            'fixtures/worker/lifecycle-server.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, 'fixture-hash'])),
        runs: [{ status: 'passed', caseCount: 39, coreCaseCount: 31, resourceCaseCount: 8,
            results: [...Array.from({ length: 31 }, () => ({ kind: 'core' })), ...resources],
            rpcCount: 70, fetchCount: 54, activeClientCalls: 0,
            callReceipts: Array.from({ length: 70 }, (_, index) => ({ statuses: 1, callbacks: 1, fetchCount: index < 54 ? 1 : 0,
                diagnostics: { terminal: true, fetchCount: index < 54 ? 1 : 0, requestBytes: 0, responseBytes: 0, timerActive: false } })),
            backend: { active: 0, receipts: Array.from({ length: 54 }, (_, index) => ({
                finalized: true, active: false, aborted: index < 4,
                ...(index > 51 ? { uploadEOF: true, readerReleased: true, input: [0, 1, 2] } : {}),
            })) },
            cleanup: Array.from({ length: 54 }, (_, index) => ({ released: true, bodyLocked: false,
                sourceLocked: false, ended: index >= 6, cancellations: index < 6 ? 1 : 0 })),
        }],
    };
}
test('EVIDENCE workerd lifecycle requires installed execution and cleanup before runtime disposal', () => {
    validateWorkerdLifecycleReport(fixture());
    for (const mutate of [
        report => { report.sourceBuild = true; },
        report => { report.status = 'failed'; },
        report => { report.serviceBindings = false; },
        report => { report.liveCloud = true; },
        report => { report.externalRequests = 1; },
        report => { report.incomingCloudflareTranslation = true; },
        report => { report.cleanupVerifiedBeforeDispose = false; },
        report => { report.runtimeDisposed = false; },
        report => { report.installedInputs = {}; },
        report => { delete report.evidence['fixtures/worker/lifecycle-server.mjs']; },
        report => { report.runs = []; },
        report => { report.runs[0].activeClientCalls = 1; },
        report => { report.runs[0].backend.active = 1; },
        report => { report.runs[0].backend.receipts[0].finalized = false; },
        report => { report.runs[0].backend.receipts[0].aborted = false; },
        report => { report.runs[0].backend.receipts.at(-1).readerReleased = false; },
        report => { report.runs[0].backend.receipts.at(-1).uploadEOF = false; },
        report => { report.runs[0].cleanup[0].bodyLocked = true; },
        report => { report.runs[0].cleanup[0].sourceLocked = true; },
        report => { report.runs[0].cleanup[0].cancellations = 0; },
        report => { report.runs[0].cleanup[0].cancellations = 2; },
        report => { report.runs[0].cleanup.pop(); },
        report => { report.rpcCount = 0; },
        report => { report.runs[0].callReceipts[0].statuses = 2; },
        report => { report.runs[0].callReceipts[0].diagnostics.timerActive = true; },
        report => { report.runs[0].callReceipts[0].diagnostics.requestBytes = 1; },
        report => { report.runs[0].results[31].usage.bufferedBytes = 1; },
        report => { report.runs[0].results[31].queuedFetches = 1; },
        report => { report.runs[0].results[31].queuedTerminalCodes = [1, 1]; },
        report => { report.runs[0].results[31].sharedClients = 1; },
        report => { report.runs[0].results[31].recovered = false; },
        report => { report.runs[0].results[32].usage.peakBufferedBytes = 4097; },
        report => { report.runs[0].results[33].compressed = false; },
        report => { report.runs[0].results[34].peakReadableLength = 2; },
        report => { report.runs[0].results[34].peerDuringAuth = false; },
        report => { report.runs[0].results[34].kind = 'resource-invented'; },
    ]) {
        const report = fixture(); mutate(report);
        assert.throws(() => validateWorkerdLifecycleReport(report), /WGA_EVIDENCE_INVALID/);
    }
});
