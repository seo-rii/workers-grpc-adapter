'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkerdObserverReport } = require('../scripts/test-evidence.cjs');

function fixture() {
    const results = [], cleanup = [], peerReceipts = [];
    let sequence = 0;
    for (const mode of ['cloudflare', 'grpc-web']) {
        for (const [kind, codes, attempts, fetches] of [
            ['retry', [0], [2], [2]], ['queue-terminal', [0, 1, 4], [1, 0, 0], [1, 0, 0]],
            ['auth-cancel', [1], [1], [0]], ['stream-destroy', [1], [1], [1]],
            ['observer-throw', [0], [1], [1]], ['observer-reject', [0], [1], [1]], ['recovery', [0], [1], [1]],
        ]) {
            const calls = codes.map((code, index) => {
                const logicalCallId = `wga-${++sequence}`, events = [];
                const emit = value => events.push({ ...value, logicalCallId, elapsedMs: events.length });
                const traffic = { sentBytes: 0, receivedBytes: 0, responseMessages: 0, responseMessageBytes: 0 };
                emit({ type: 'call-start' });
                if (attempts[index]) emit({ type: 'call-admitted', queueMs: 0 });
                for (let attempt = 1; attempt <= attempts[index]; attempt++) {
                    const fetchStarted = attempt <= fetches[index], statusCode = kind === 'retry' && attempt === 1 ? 14 : code;
                    const message = fetchStarted && statusCode !== 14;
                    const bytes = { sentBytes: fetchStarted ? 6 : 0, receivedBytes: fetchStarted ? (message ? 6 : 0) + (kind === 'stream-destroy' ? 0 : 10) : 0,
                        responseMessages: message ? 1 : 0, responseMessageBytes: message ? 1 : 0 };
                    emit({ type: 'attempt-start', attempt });
                    emit({ type: 'auth-end', attempt, durationMs: 1, statusCode: fetchStarted ? 0 : code });
                    if (fetchStarted) {
                        emit({ type: 'fetch-start', attempt }); emit({ type: 'response-headers', attempt });
                        if (message) emit({ type: 'first-message', attempt });
                        peerReceipts.push({ mode, sentBytes: bytes.sentBytes, code: statusCode, streaming: kind === 'stream-destroy' });
                        cleanup.push({ bodyLocked: false, ended: kind !== 'stream-destroy', cancellations: kind === 'stream-destroy' ? 1 : 0,
                            deliveredBytes: bytes.receivedBytes });
                    }
                    emit({ type: 'attempt-end', attempt, durationMs: 4, authDurationMs: 1, fetchStarted, statusCode, ...bytes });
                    for (const key of Object.keys(traffic)) traffic[key] += bytes[key];
                    if (attempt < attempts[index]) emit({ type: 'retry-scheduled', attempt, delayMs: 0, statusCode });
                }
                emit({ type: 'call-end', statusCode: code, attemptCount: attempts[index], fetchCount: fetches[index], queueMs: 0, ...traffic });
                return { logicalCallId, events, terminalCode: code, attemptCount: attempts[index], fetchCount: fetches[index], statuses: 1 };
            });
            results.push({ mode, kind, calls, privacyVerified: true, frozenEvents: true,
                ...(kind === 'retry' ? { authCalls: 2, retryCount: 1 } : {}),
                ...(kind === 'queue-terminal' ? { queuedFetches: 0 } : {}),
                ...(kind === 'auth-cancel' ? { lateEvents: 0 } : {}),
                ...(kind === 'stream-destroy' ? { messages: 1, bytesVerified: true } : {}),
                ...(kind.startsWith('observer-') ? { rpcUnaffected: true } : {}),
            });
        }
    }
    const calls = results.flatMap(value => value.calls);
    const run = { status: 'passed', results, caseCount: 14, rpcCount: 18, attemptCount: 16, fetchCount: 14,
        eventCount: calls.reduce((sum, call) => sum + call.events.length, 0), cleanup, peerReceipts, resourcesIdle: true, activeClientCalls: 0 };
    return { status: 'passed', sourceBuild: false, liveCloud: false, incomingCloudflareTranslation: false, nativeHttp2: false,
        serviceBindings: false, controlledPeer: true, runtimeDisposed: true, cleanupVerifiedBeforeDispose: true, externalRequests: 0,
        installedInputs: { 'fixtures/worker/node_modules/@grpc/grpc-js/dist/index.js': 'a'.repeat(64) },
        evidence: Object.fromEntries(['scripts/test-workerd-observer.cjs', 'fixtures/worker/observer.mjs',
            'fixtures/worker/package-lock.json'].map(file => [file, 'a'.repeat(64)])),
        runs: [run], caseCount: 14, rpcCount: 18, attemptCount: 16, fetchCount: 14, eventCount: run.eventCount };
}

test('EVIDENCE workerd observer requires installed execution, complete event traces, privacy and cleanup', () => {
    validateWorkerdObserverReport(fixture());
    for (const mutate of [
        report => { report.status = 'failed'; }, report => { report.sourceBuild = true; },
        report => { report.liveCloud = true; }, report => { report.incomingCloudflareTranslation = true; },
        report => { report.nativeHttp2 = true; }, report => { report.controlledPeer = false; },
        report => { report.serviceBindings = true; }, report => { report.externalRequests = 1; },
        report => { report.runtimeDisposed = false; }, report => { report.cleanupVerifiedBeforeDispose = false; },
        report => { report.installedInputs = {}; }, report => { delete report.evidence['fixtures/worker/observer.mjs']; },
        report => { report.runs = []; }, report => { report.runs[0].resourcesIdle = false; },
        report => { report.runs[0].activeClientCalls = 1; }, report => { report.runs[0].results.pop(); },
        report => { report.rpcCount = 17; }, report => { report.eventCount--; },
        report => { report.runs[0].results[0].privacyVerified = false; },
        report => { report.runs[0].results[0].frozenEvents = false; },
        report => { report.runs[0].results[0].calls[0].statuses = 2; },
        report => { report.runs[0].results[0].calls[0].events[0].metadata = {}; },
        report => { report.runs[0].results[0].calls[0].events[0].elapsedMs = -1; },
        report => { report.runs[0].results[0].calls[0].events.at(-1).receivedBytes++; },
        report => { report.runs[0].results[0].calls[0].events.at(-1).statusCode = 14; },
        report => { report.runs[0].results[0].calls[0].events.find(item => item.type === 'attempt-start').attempt = 99; },
        report => { report.runs[0].results[0].calls[0].events.find(item => item.type === 'attempt-end').fetchStarted = false; },
        report => { report.runs[0].results[0].calls[0].events.find(item => item.type === 'attempt-end').durationMs = 0; },
        report => { report.runs[0].results[0].calls[0].events.push(report.runs[0].results[0].calls[0].events.at(-1)); },
        report => { report.runs[0].results[0].authCalls = 1; },
        report => { report.runs[0].results[1].queuedFetches = 1; },
        report => { report.runs[0].results[2].lateEvents = 1; },
        report => { report.runs[0].results[3].bytesVerified = false; },
        report => { report.runs[0].results[4].rpcUnaffected = false; },
        report => { report.runs[0].results[5].rpcUnaffected = false; },
        report => { report.runs[0].cleanup[0].bodyLocked = true; },
        report => { report.runs[0].cleanup[0].deliveredBytes++; },
        report => { report.runs[0].cleanup.find(item => !item.ended).cancellations = 0; },
        report => { report.runs[0].peerReceipts[0].sentBytes++; },
        report => { report.runs[0].results[6].calls[0].logicalCallId = report.runs[0].results[0].calls[0].logicalCallId; },
    ]) {
        const report = fixture(); mutate(report);
        assert.throws(() => validateWorkerdObserverReport(report), /WGA_EVIDENCE_INVALID/);
    }
});
