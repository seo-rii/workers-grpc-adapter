'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { catalogCases, validateCallLifecycleReport } = require('../scripts/call-lifecycle-evidence.cjs');

// Synthetic receipts for validator mutation tests, not runtime execution evidence.
const zero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
  parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const usage = { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: 100, peakQueuedCalls: 0, peakBufferedBytes: 1000 };
function idle(fetchCount) {
  return { activeCalls: 0, execution: { ...zero }, resources: { ...usage },
    diagnostics: { terminal: true, fetchCount, requestBytes: 0, responseBytes: 0, timerActive: false } };
}
function preparation(mode) {
  const rows = [['LIFE-002', 'half-close-before-auth', [1, 2, 3]], ['LIFE-003', 'auth-before-message', [1, 2, 3]],
    ['LIFE-004', 'empty-request', []], ['LIFE-018', 'caller-buffer-mutation', [10, 20, 30]]]
    .map(([id, variant, payload]) => ({ id, variant, mode, status: 'passed', authCount: 1, fetchCount: 1,
      terminalCount: 1, writeCompletions: 1, code: 0, messages: ['ok'], requestPayload: payload,
      fetchBeforeReady: 0, acceptedBytesPreserved: true, replayCount: 0, readerUnlocked: true, unhandledRejections: 0, ...idle(1) }));
  for (const [http, code] of [[400, 13], [401, 16], [403, 7], [404, 12], [429, 14], [502, 14], [503, 14], [504, 14], [200, 2]]) {
    rows.push({ id: 'WIRE-018', variant: `http-${http}`, mode, status: 'passed', authCount: 1, fetchCount: 1, terminalCount: 1,
      writeCompletions: 1, code, messages: [], requestPayload: [7], httpStatus: http, replayCount: 0, readerUnlocked: true,
      unhandledRejections: 0, ...idle(1) });
  }
  for (const stream of [false, true]) rows.push({ id: 'LIFE-018', variant: stream ? 'public-server-stream-buffer' : 'public-unary-buffer',
    mode, status: 'passed', acceptedBytesPreserved: true, fetchCount: 1, terminalCount: 1, callbackCount: stream ? 0 : 1,
    unhandledRejections: 0, ...idle(1) });
  return rows;
}
function deadlineRows(mode) {
  const specs = [
    ['LIFE-013', 'explicit-infinity-overrides-default', 0, null, []],
    ['LIFE-014', 'omitted-deadline-with-default', 4, '200m', [200]],
    ['LIFE-014', 'omitted-deadline-without-default', 0, null, []],
    ['LIFE-015', 'past-numeric-deadline', 4, null, []], ['LIFE-015', 'past-date-deadline', 4, null, []],
    ['LIFE-015', 'invalid-date-policy-gap', 13, null, []],
    ...[[1, '1m'], [99999999, '99999999m'], [100000000, '100000S'], [99999999000, '99999999S'],
      [99999999001, '1666667M'], [5999999940000, '99999999M'], [5999999940001, '1666667H'], [359999996400000, '99999999H']]
      .map(([duration, header]) => ['LIFE-016', `timeout-${header}-${duration}`, 0, header, [Math.min(duration, 2147483647)]]),
    ['LIFE-016', 'long-timer-rearms-without-overflow', 4, '2147496S', [2147483647, 12345]],
  ];
  return specs.map(([id, variant, code, timeoutHeader, timerDelays]) => {
    const fetches = Number(id !== 'LIFE-015');
    return { id, variant, mode, status: 'passed', authCalls: fetches, fetches, metadata: Number(code === 0), messages: Number(code === 0),
      messagesAfterTerminal: 0, writes: 1, writeErrors: 1 - fetches, statuses: [{ code, details: '' }], fetchAborts: Number(fetches && code === 4),
      timers: 0, timeoutHeader, timerDelays, catalogMatch: variant !== 'invalid-date-policy-gap',
      ...(variant === 'invalid-date-policy-gap' ? { catalogExpectedCode: 3, actualCode: 13 } : {}), ...idle(fetches) };
  });
}
function terminalRows(mode) {
  const specs = [
    ['LIFE-001', 'cancel-before-listener', [1], [0], 0], ['LIFE-005', 'send-immediate-cancel', [1], [0], 0],
    ['LIFE-006', 'pending-fetch-reject-after-cancel', [1], [1], 0], ['LIFE-007', 'cancel-with-later-frame-in-chunk', [1], [1], 1],
    ['LIFE-012', 'reentrant-demand-and-cancel', [1], [1], 1], ['LIFE-008', 'eof-then-cancel-same-turn', [1], [1], 1],
    ['LIFE-008', 'cancel-then-eof-same-turn', [1], [1], 1], ['LIFE-008', 'committed-eof-then-cancel', [0], [1], 1],
    ['LIFE-009', 'close-twice-two-active-and-new-call', [14, 14, 14], [1, 1, 0], 0],
    ['LIFE-010', 'same-channel-credentials-and-readers-isolated', [1, 0], [1, 1], 2],
    ['LIFE-011', 'late-auth-rejection', [1], [0], 0], ['LIFE-011', 'late-fetch-rejection', [1], [1], 0],
    ['LIFE-011', 'late-read-rejection', [1], [1], 1], ['LIFE-011', 'late-controlled-reader-rejection', [1], [1], 1],
    ['LIFE-017', 'one-hundred-of-each-terminal-outcome', [...Array(100).fill(0), ...Array(100).fill(13), ...Array(100).fill(1)], Array(300).fill(1), 200],
  ];
  return specs.map(([id, variant, codes, fetchCounts, readerCount]) => {
    const fetches = fetchCounts.reduce((sum, value) => sum + value, 0);
    const calls = codes.map((code, index) => {
      const messages = ['LIFE-007', 'LIFE-012'].includes(id) ? ['first'] : id === 'LIFE-010' && index === 1 ? ['B-only']
        : id === 'LIFE-017' && index < 100 ? ['ok'] : [];
      const writes = id === 'LIFE-001' ? [] : [null];
      return { ...idle(fetchCounts[index]), statuses: [code], messages, writes,
        events: ['start', ...writes.flatMap(() => ['send', 'write']), ...messages.map(() => 'message'), `status:${code}`] };
    });
    const row = { id, variant, mode, status: 'passed', calls, fetches, resources: { ...usage }, activeCalls: 0, unhandledRejections: 0,
      requests: Array.from({ length: fetches }, (_, index) => ({ aborted: true, aborts: 1, request: '000000000772657175657374',
        credential: id === 'LIFE-010' ? ['A', 'B'][index] : null })),
      readers: Array.from({ length: readerCount }, () => ({ locked: false, cancels: 1 })) };
    if (id === 'LIFE-001') row.authCalls = 0;
    if (id === 'LIFE-005') Object.assign(row, { authCalls: 0, afterSend: { ...zero, pendingWriteCallbacks: 1 }, afterCancel: { ...zero, pendingWriteCallbacks: 1 } });
    if (id === 'LIFE-006') row.afterTerminal = { ...zero, activePumps: 1 };
    if (['LIFE-007', 'LIFE-012'].includes(id)) Object.assign(row, {
      inMessage: { ...zero, activePumps: 1, parserAssemblies: 1, parserAssemblyBytes: 10, runtimeChunkBytes: 30 },
      afterCancel: { ...zero, activePumps: 1, parserAssemblies: 1, parserAssemblyBytes: 10, runtimeChunkBytes: 30 } });
    if (id === 'LIFE-008') row.eofArrivalIsNotTerminalCommit = true;
    if (id === 'LIFE-010') row.authCalls = { A: 1, B: 1 };
    if (id === 'LIFE-011') {
      if (variant === 'late-controlled-reader-rejection') Object.assign(row, {
        mechanism: 'fault-injecting-reader-delays-standard-reader-result', standardReaderCancelBehavior: false,
        afterTerminal: { ...zero, activePumps: 1, parserAssemblies: 1, parserAssemblyBytes: 5 },
        readCalls: 1, readRejects: 1, cancellations: 1, releases: 1,
        readers: [{ locked: false, cancels: 1, reads: 1, rejects: 1, releases: 1 }] });
      else {
        const stage = variant.slice(5, -10);
        Object.assign(row, { stage, authCalls: Number(stage === 'auth'), sourceRejects: 1,
          mechanism: stage === 'read' ? 'standard-stream-late-source-pull-rejection' : `controlled-${stage}-promise`,
          ...(stage === 'read' ? { readContract: 'standard reader cancellation resolves pending read; later underlying pull rejects' } : {}) });
      }
    }
    if (id === 'LIFE-017') Object.assign(row, { counts: { success: 100, error: 100, cancel: 100 },
      waveResources: ['success', 'error', 'cancel'].map(kind => ({ kind, calls: 100, initialTimers: 100,
        initialWriteCallbacks: 100, activeCalls: 0, usage: { ...usage } })) });
    return row;
  });
}
function fixture() {
  const runs = ['node', 'workerd'].map(runtime => ({ runtime, status: 'passed', unhandledRejections: 0, rejectionSensorCount: 1,
    rows: ['cloudflare', 'grpc-web'].flatMap(mode => [...preparation(mode), ...deadlineRows(mode), ...terminalRows(mode)]) }));
  return { status: 'passed', sourceBuild: false, liveCloud: false, incomingCloudflareTranslation: false, nativeHttp2: false,
    controlledPeer: true, runtimeDisposed: true, cleanupVerifiedBeforeDispose: true, externalRequests: 0,
    compatibilityDate: '2026-09-21', miniflare: 'synthetic', workerd: 'synthetic', bundleSha256: 'a'.repeat(64),
    evidence: Object.fromEntries(['scripts/test-call-lifecycle.cjs', 'scripts/call-lifecycle-evidence.cjs',
      'fixtures/shared/call-lifecycle.mjs', 'fixtures/shared/lifecycle-deadlines.mjs', 'fixtures/shared/lifecycle-terminals.mjs',
      'fixtures/worker/call-lifecycle.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, 'b'.repeat(64)])),
    installedInputs: Object.fromEntries(['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'call.js', 'wire.js']
      .map(file => [`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`, 'c'.repeat(64)])),
    runs, caseCount: 180, catalogCases: catalogCases(runs) };
}
const row = (report, variant, runtime = 0, mode = 'cloudflare') => report.runs[runtime].rows.find(value => value.variant === variant && value.mode === mode);
const reject = mutate => { const report = fixture(); mutate(report); assert.throws(() => validateCallLifecycleReport(report), /WGA_EVIDENCE_INVALID/); };

test('EVIDENCE call lifecycle accepts the complete matrix and preserves the invalid-date catalog gap', () => {
  const report = fixture(); validateCallLifecycleReport(report);
  assert.equal(report.catalogCases.length, 19);
  assert.deepEqual(report.catalogCases.filter(value => !value.catalogMatch).map(value => value.id), ['LIFE-015']);
  assert.equal(report.catalogCases.find(value => value.id === 'LIFE-017').callCount, 1200);
  assert.equal(report.catalogCases.find(value => value.id === 'WIRE-018').scenarioCount, 36);
  const copy = structuredClone(report.runs); catalogCases(report.runs); assert.deepEqual(report.runs, copy);
});

test('EVIDENCE call lifecycle rejects missing duplicate relabelled or stale provenance receipts', () => {
  for (const mutate of [
    r => { r.status = 'failed'; }, r => { r.sourceBuild = true; }, r => { r.liveCloud = true; },
    r => { r.incomingCloudflareTranslation = true; }, r => { r.nativeHttp2 = true; }, r => { r.controlledPeer = false; },
    r => { r.runtimeDisposed = false; }, r => { r.cleanupVerifiedBeforeDispose = false; }, r => { r.externalRequests = 1; },
    r => { r.compatibilityDate = '2020-01-01'; }, r => { r.bundleSha256 = 'invalid'; }, r => { r.miniflare = ''; },
    r => { delete r.evidence['fixtures/shared/lifecycle-deadlines.mjs']; }, r => { r.installedInputs = {}; },
    r => { delete r.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/dist/call.js']; },
    r => { r.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/../other.js'] = 'a'.repeat(64); },
    r => { r.runs.pop(); }, r => { r.runs[1].runtime = 'node'; }, r => { r.runs[1].rejectionSensorCount = 0; },
    r => { r.runs[0].rejectionSensorCount = 2; }, r => { r.runs[1].unhandledRejections = 1; }, r => { r.runs[0].rows.pop(); },
    r => { r.runs[0].rows[1] = structuredClone(r.runs[0].rows[0]); }, r => { r.runs[0].rows[0].mode = 'native'; },
    r => { r.runs[0].rows[0].id = 'LIFE-001'; }, r => { r.runs[0].rows[0].status = 'failed'; }, r => { r.caseCount--; },
    r => { r.catalogCases[0].scenarioCount--; }, r => { r.catalogCases.find(value => value.id === 'LIFE-015').catalogMatch = true; },
  ]) reject(mutate);
});

test('EVIDENCE call lifecycle requires measured per-call ownership and positive retained-owner controls', () => {
  for (const field of Object.keys(zero)) reject(r => { row(r, 'half-close-before-auth').execution[field] = 1; });
  for (const field of ['activeCalls', 'queuedCalls', 'bufferedBytes']) reject(r => { row(r, 'http-400').resources[field] = 1; });
  for (const mutate of [
    r => { row(r, 'half-close-before-auth').fetchCount = NaN; }, r => { row(r, 'half-close-before-auth').writeCompletions = 2; },
    r => { row(r, 'empty-request').requestPayload = [0]; }, r => { row(r, 'caller-buffer-mutation').requestPayload = [255, 255, 255]; },
    r => { row(r, 'http-504').code = 4; }, r => { row(r, 'http-200').messages = ['bad']; },
    r => { row(r, 'public-server-stream-buffer').callbackCount = 1; },
    r => { row(r, 'pending-fetch-reject-after-cancel').afterTerminal.activePumps = 0; },
    r => { row(r, 'send-immediate-cancel').afterCancel.pendingWriteCallbacks = 0; },
    r => { row(r, 'cancel-with-later-frame-in-chunk').inMessage.parserAssemblyBytes = 0; },
    r => { row(r, 'reentrant-demand-and-cancel').afterCancel.runtimeChunkBytes = Infinity; },
    r => { row(r, 'late-controlled-reader-rejection').afterTerminal.parserAssemblies = 0; },
    r => { row(r, 'late-controlled-reader-rejection').readRejects = 0; },
    r => { row(r, 'late-read-rejection').mechanism = 'controlled-reader-reject'; },
    r => { row(r, 'late-auth-rejection').sourceRejects = 0; },
    r => { row(r, 'same-channel-credentials-and-readers-isolated').requests[1].credential = 'A'; },
    r => { row(r, 'pending-fetch-reject-after-cancel').calls[0].diagnostics.fetchCount = 2; },
    r => { row(r, 'cancel-with-later-frame-in-chunk').calls[0].messages.push('later'); },
    r => { row(r, 'cancel-with-later-frame-in-chunk').readers[0].locked = true; },
  ]) reject(mutate);
});

test('EVIDENCE call lifecycle validates timer units and the exact calibrated 100-call stress waves', () => {
  for (const mutate of [
    r => { row(r, 'explicit-infinity-overrides-default').timeoutHeader = '200m'; },
    r => { row(r, 'omitted-deadline-with-default').timerDelays = []; },
    r => { row(r, 'omitted-deadline-without-default').timerDelays = [200]; },
    r => { row(r, 'timeout-100000S-100000000').timeoutHeader = '100000000m'; },
    r => { row(r, 'long-timer-rearms-without-overflow').timerDelays = [2147495992]; },
    r => { row(r, 'invalid-date-policy-gap').catalogMatch = true; },
    r => { row(r, 'invalid-date-policy-gap').actualCode = 3; },
    r => { row(r, 'past-date-deadline').fetches = 1; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').counts.cancel = 99; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').calls.pop(); },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').calls[200].statuses = [13]; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').calls[250].execution.activePumps = 1; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').calls[250].resources.bufferedBytes = 1; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').calls[250].diagnostics.timerActive = true; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').calls[250].writes = []; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').calls[250].events.push('message'); },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').waveResources[1].initialTimers = 0; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').waveResources[1].initialWriteCallbacks = 99; },
    r => { row(r, 'one-hundred-of-each-terminal-outcome').resources.peakActiveCalls = 0; },
  ]) reject(mutate);
});

test('EVIDENCE call lifecycle source-build exception does not bypass runtime or schedule validation', () => {
  const report = fixture(); report.sourceBuild = true; report.installedInputs = {};
  assert.throws(() => validateCallLifecycleReport(report), /WGA_EVIDENCE_INVALID/);
  validateCallLifecycleReport(report, { allowSourceBuild: true });
  row(report, 'http-401', 1, 'grpc-web').code = 14;
  assert.throws(() => validateCallLifecycleReport(report, { allowSourceBuild: true }), /WGA_EVIDENCE_INVALID/);
});
