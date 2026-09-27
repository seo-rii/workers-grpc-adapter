'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validateWorkerdServerStreamingReport } = require('../scripts/server-streaming-evidence.cjs');
function fixture() {
    const hash = 'a'.repeat(64);
    const runs = [['controlled-fetch', ['sum', 'empty', 'bidi', 'early-error', 'early-success', 'cancel', 'deadline', 'slow-consumer', 'gzip', 'receive-limit']],
        ['service-binding', ['client-eof', 'bidi-demand', 'cancel', 'deadline']]].map(([transport, kinds]) => ({
        transport, status: 'passed', caseCount: kinds.length, rpcCount: kinds.length, fetchCount: kinds.length, cleanupVerifiedBeforeDispose: true,
        cases: kinds.map(kind => {
            const grpcStatus = kind === 'early-error' ? 7 : kind === 'cancel' ? 1 : kind === 'deadline' ? 4 : kind === 'receive-limit' ? 8 : 0;
            return { kind, status: 'passed', grpcStatus, serverMessages: kind === 'empty' || kind.startsWith('early-') || kind === 'receive-limit' ? 0
                : kind === 'cancel' || kind === 'deadline' ? 1 : kind === 'slow-consumer' ? 12 : 2,
            uploadUnlocked: true, activeCalls: 0, bufferedBytes: 0, responseBeforeHalfClose: ['bidi', 'bidi-demand', 'early-error', 'early-success'].includes(kind),
            ...(transport === 'controlled-fetch' ? { fetches: 1, cancellationObserved: ['cancel', 'deadline'].includes(kind) ? true : null }
                : { serverClosed: true, inputReleased: true, serverCancelled: grpcStatus !== 0, eof: grpcStatus === 0,
                    cleanupRetainedWithWaitUntil: true, immediateRemoteCancellationRequired: false }) };
        }),
    }));
    return { status: 'passed', sourceBuild: false, liveCloud: false, incomingCloudflareTranslation: false, nativeHttp2: false,
        serviceBindings: true, controlledPeer: true, externalRequests: 0, cleanupVerifiedBeforeDispose: true, runtimeDisposed: true,
        installedInputs: { 'fixtures/worker/node_modules/@grpc/grpc-js/dist/server.js': hash },
        evidence: Object.fromEntries(['scripts/test-workerd-server-streaming.cjs', 'fixtures/worker/server-request-streaming.mjs',
            'fixtures/worker/server-request-streaming-backend.mjs', 'fixtures/worker/package-lock.json', 'src/server.ts'].map(file => [file, hash])),
        caseCount: 14, rpcCount: 14, fetchCount: 14, runs };
}
test('EVIDENCE server request streaming requires complete installed scenarios and both-direction cleanup', () => {
    validateWorkerdServerStreamingReport(fixture());
    for (const mutate of [
        r => { r.status = 'failed'; }, r => { r.sourceBuild = true; }, r => { r.liveCloud = true; },
        r => { r.incomingCloudflareTranslation = true; }, r => { r.nativeHttp2 = true; }, r => { r.serviceBindings = false; },
        r => { r.controlledPeer = false; }, r => { r.externalRequests = 1; }, r => { r.cleanupVerifiedBeforeDispose = false; },
        r => { r.runtimeDisposed = false; }, r => { r.installedInputs = {}; }, r => { r.evidence = {}; },
        r => { r.runs.pop(); }, r => { r.runs[0].transport = 'service-binding'; }, r => { r.rpcCount--; },
        r => { r.runs[0].cases.pop(); }, r => { r.runs[0].cases[0].grpcStatus = 13; },
        r => { r.runs[0].cases[0].serverMessages++; }, r => { r.runs[0].cases[0].uploadUnlocked = false; },
        r => { r.runs[0].cases[0].activeCalls = 1; }, r => { r.runs[0].cases[0].bufferedBytes = 1; },
        r => { r.runs[0].cases[2].responseBeforeHalfClose = false; }, r => { r.runs[0].cases[5].cancellationObserved = false; },
        r => { r.runs[1].cases[0].eof = false; }, r => { r.runs[1].cases[2].serverCancelled = false; },
        r => { r.runs[1].cases[2].serverClosed = false; }, r => { r.runs[1].cases[2].inputReleased = false; }, r => { r.runs[1].cases[2].cleanupRetainedWithWaitUntil = false; },
        r => { r.runs[1].cases[2].immediateRemoteCancellationRequired = true; },
    ]) { const report = fixture(); mutate(report); assert.throws(() => validateWorkerdServerStreamingReport(report), /WGA_EVIDENCE_INVALID/); }
});
