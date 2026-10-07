'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { catalogCases, validateFlowControlReport } = require('../scripts/flow-control-evidence.cjs');

// Independently constructed receipts for validator mutation tests. These are
// deliberately not runtime execution evidence and do not import fixture code.
const empty = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
  parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const specs = [
  ['FLOW-001', 'slow', 128, 1024, 0], ['FLOW-002', 'pause', 96, 1024, 0],
  ['FLOW-003', 'total', 513, 65536, 0], ['FLOW-004', 'cancel', 4096, 1024, 1],
  ['FLOW-005', 'partial', 8, 1024, 14],
];
const byteSum = (count, size) => Array.from({ length: count }, (_, index) => {
  const header = Buffer.alloc(4); header.writeUInt32BE(index);
  return [...header].reduce((sum, byte) => sum + byte, 0) + (size - 4) * (index % 251);
}).reduce((sum, value) => sum + value, 0);
const usage = () => ({ activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: 1, peakQueuedCalls: 0, peakBufferedBytes: 4096 });
const diagnostics = () => ({ terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
const state = (closed = false) => ({ activeSessions: 0, activeBridges: 0, activeBackendCalls: 0,
  pendingDrainWaiters: 0, pendingPulls: 0, serverClosed: closed });
function publicRows(runtime, mode) {
  return specs.map(([id, scenario, count, size, code]) => {
    const native = runtime === 'native', cancelled = scenario === 'cancel', delivered = cancelled ? 1 : count;
    const hwm = native ? 16 : 1, pressured = scenario !== 'total';
    const execution = { ...empty, activePumps: 1, pendingMessages: Number(pressured), pendingMessageBytes: pressured ? size : 0,
      parserAssemblies: 1, parserAssemblyBytes: size + 5, runtimeChunkBytes: size + 5 };
    const snapshot = deliveredCount => ({ deliveredCount, readableLength: hwm, execution: native ? null : { ...execution },
      resources: native ? null : { ...usage(), activeCalls: 1, bufferedBytes: 3072 } });
    const late = scenario === 'slow' ? hwm : scenario === 'partial' ? (native ? 4 : 1) : 0;
    const data = Array.from({ length: delivered }, (_, index) => `data:${index}`);
    const requestId = `${runtime}:${mode}:${scenario}`;
    const requestBytes = Buffer.byteLength(JSON.stringify({ id: requestId, scenario, count, size, catalogId: id, requestId }));
    const zeroBytes = { requestBytes: 0, pendingMessageBytes: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0, readableBytes: 0 };
    const highWater = { requestBytes, pendingMessageBytes: pressured ? size : 0,
      parserAssemblyBytes: size + 5, runtimeChunkBytes: size + 5, readableBytes: pressured ? size : 0 };
    return { id, scenario, requestId: `${runtime}:${mode}:${scenario}`, runtime, mode, status: 'passed',
      requestedCount: count, messageSize: size, deliveredCount: delivered, deliveredBytes: delivered * size,
      payloadByteSum: byteSum(delivered, size), codes: [code], terminalCount: 1, errorCodes: code ? [code] : [],
      endCount: Number(!cancelled), cancelCount: Number(cancelled), deliveredAtCancel: cancelled ? 1 : null,
      events: [...data.slice(0, delivered - late), ...(code ? [`error:${code}`] : []), `status:${code}`,
        ...data.slice(delivered - late), ...(cancelled ? [] : ['end'])], dataAfterTerminal: late,
      readableHighWaterMark: hwm, maxReadableLength: pressured ? hwm : 0,
      pauseDeliveredDuringWindow: scenario === 'pause' ? 0 : null, pauseWindowMs: scenario === 'pause' ? 20 : null,
      pausedSample: scenario === 'pause' ? snapshot(8) : null, cancelSample: cancelled ? snapshot(1) : null,
      readableLengthAfterCancel: cancelled ? hwm : null, readableLengthBeforeDiscard: cancelled ? hwm : 0,
      discardedMessages: cancelled ? hwm : 0, readableLengthAfterDiscard: 0,
      maxExecution: native ? null : execution, finalExecution: native ? null : { ...empty },
      finalDiagnostics: native ? null : diagnostics(), finalResources: native ? null : usage(),
      bufferOwnership: native ? null : { scope: 'adapter-visible-buffer-references', additive: false, highWater,
        samples: { requestRetained: { ...zeroBytes, requestBytes }, backpressured: pressured ? { ...highWater, requestBytes: 0 } : null,
          released: { ...zeroBytes } } },
      activeCallsBeforeClose: native ? null : 0, cleanupVerifiedBeforeClose: true, elapsedMs: 30 };
  });
}
function wireRows(runtime, mode) {
  const cleanup = () => ({ execution: { ...empty }, diagnostics: diagnostics(), resources: usage(), activeCalls: 0 });
  const rows = [false, true].map(duplicate => ({ id: 'FLOW-006', scenario: duplicate ? 'unary-duplicate' : 'unary-one',
    runtime, mode, status: 'passed', peer: 'controlled-binary-response', fetchCount: 1, readDemands: 1,
    callbacks: [{ code: duplicate ? 12 : 0, value: duplicate ? null : 'one' }], statuses: [duplicate ? 12 : 0],
    decoded: duplicate ? ['one', 'two'] : ['one'], maxExecution: { ...empty, activePumps: 1, parserAssemblies: 1,
      parserAssemblyBytes: 8, runtimeChunkBytes: duplicate ? 37 : 29 }, readerUnlocked: true, cleanup: cleanup() }));
  const owners = { ...empty, activePumps: 1, pendingMessages: 1, pendingMessageBytes: 256,
    parserAssemblies: 1, parserAssemblyBytes: 261, runtimeChunkBytes: 33447 };
  rows.push({ id: 'FLOW-007', scenario: 'coalesced-native-stream', runtime, mode, status: 'passed',
    peer: 'native-grpc-js-with-bounded-fixture-rechunking', requestId: `${runtime}:${mode}:chunk`, count: 128,
    size: 256, received: 128, fetchCount: 1, writes: 1, statuses: [0], fixtureBufferLimit: 65536,
    chunkBytes: 33447, enqueues: 1, beforeDemand: { ...owners }, maxExecution: { ...owners }, readerUnlocked: true, cleanup: cleanup() });
  return rows;
}
function fixture() {
  const contexts = [['native', 'native'], ['node', 'cloudflare'], ['node', 'grpc-web'], ['workerd', 'cloudflare'], ['workerd', 'grpc-web']];
  const runs = contexts.slice(1).map(([runtime, mode]) => ({ runtime, mode, status: 'passed', rows: [...publicRows(runtime, mode), ...wireRows(runtime, mode)] }));
  const native = { runtime: 'native', mode: 'native', status: 'passed', rows: publicRows('native', 'native'), version: '1.14.5',
    chunk: { id: 'FLOW-007', scenario: 'coalesced-native-stream', requestId: 'native:native:chunk', count: 128,
      bytes: 32768, codes: [0], errors: [], nativeChunkBoundaryClaimed: false },
    wire: { rows: [false, true].map(duplicate => ({ id: 'FLOW-006', scenario: duplicate ? 'unary-duplicate' : 'unary-one',
      readDemands: 1, callbacks: [{ code: duplicate ? 4 : 0, value: duplicate ? null : 'one' }], statuses: [duplicate ? 4 : 0], decoded: ['one'] })),
    rawControl: { messages: 2, grpcStatus: 0, endStream: true, bytes: '00000000036f6e65000000000374776f' },
    arrivals: [1, 2, 2].map(count => ({ count, trailers: true, finished: true })), sessionsClosed: true, nativeParity: false } };
  const serverCalls = [], receipts = [];
  for (const [runtime, mode] of contexts) for (const [catalogId, scenario, count, size] of [...specs, ['FLOW-007', 'chunk', 128, 256]]) {
    const id = `${runtime}:${mode}:${scenario}`, cancelled = scenario === 'cancel' && runtime !== 'workerd';
    const produced = cancelled ? 32 : count;
    serverCalls.push({ id, catalogId, scenario, count, size, messagesProduced: produced, bytesProduced: produced * size,
      drainWaits: scenario === 'partial' ? 0 : 1, cancelled: true, cancellationEvents: 1, cancelledBeforeFinish: cancelled,
      finished: !cancelled, generatorSettled: true, status: cancelled ? null : scenario === 'partial' ? 14 : 0 });
    if (runtime === 'native') continue;
    receipts.push({ sequence: receipts.length + 1, id, catalogId, scenario, host: mode === 'cloudflare' ? 'flow.test' : 'gateway.flow.test',
      path: '/flow.Test/Stream', requestBytes: 140, pulls: cancelled ? 3 : 11, chunks: cancelled ? 3 : 10,
      responseBytes: cancelled ? 3087 : count * (size + 5), trailerBytes: cancelled ? 0 : scenario === 'partial' ? 77 : 39,
      peakReadableBytes: 16384, cancelled, abortObserved: cancelled, bodyCancelled: false, explicitCancellation: false,
      status: cancelled ? null : scenario === 'partial' ? 14 : 0, statusSource: cancelled ? 'not-observed' : 'observed-native-http2-trailers',
      ended: !cancelled, bodyClosed: !cancelled, sessionClosed: true, httpStatus: 200 });
  }
  return { status: 'passed', sourceBuild: false, development: false, liveCloud: false, incomingCloudflareTranslation: false,
    nativeHttp2: true, externalRequests: 0, runtimeDisposed: true, cleanupVerifiedBeforeDispose: true, nativeBusinessCompared: true,
    compatibilityDate: '2026-09-21', workerd: 'synthetic', miniflare: 'synthetic', bundleSha256: 'a'.repeat(64),
    evidence: Object.fromEntries(['scripts/test-flow-control.cjs', 'scripts/flow-control-peer.cjs', 'scripts/flow-control-unary.cjs',
      'scripts/flow-control-evidence.cjs', 'fixtures/shared/flow-control.mjs', 'fixtures/shared/flow-wire.mjs',
      'fixtures/worker/flow-control.mjs', 'fixtures/worker/package-lock.json', 'fixtures/native/package-lock.json'].map(file => [file, 'b'.repeat(64)])),
    installedInputs: Object.fromEntries(['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'call.js', 'wire.js']
      .map(file => [`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`, 'c'.repeat(64)])),
    nativeInputs: Object.fromEntries(['package.json', 'build/src/client.js', 'build/src/subchannel-call.js', 'build/src/server.js']
      .map(file => [`fixtures/native/node_modules/@grpc/grpc-js/${file}`, 'd'.repeat(64)])),
    runs, native, caseCount: 32, catalogCases: catalogCases(runs, native), peer: { serverCalls, receipts, beforeClose: state() },
    peerAfterClose: state(true), peerCheckpoints: contexts.map(([runtime, mode]) => ({ label: runtime === 'native' ? 'native' : `${runtime}:${mode}`,
      before: state(), explicitCancelled: [], after: state() })) };
}
const row = (r, scenario, run = 0) => r.runs[run].rows.find(value => value.scenario === scenario);

test('EVIDENCE stream ownership separates request, pending, assembly, chunk and public queue bytes', () => {
  validateFlowControlReport(fixture());
  for (const mutate of [
    r => { row(r, 'slow').bufferOwnership = null; },
    r => { row(r, 'slow').bufferOwnership.additive = true; },
    r => { row(r, 'slow').bufferOwnership.scope = 'isolate-total-heap'; },
    r => { row(r, 'slow').bufferOwnership.totalHeapBytes = 4096; },
    r => { row(r, 'slow').bufferOwnership.samples.requestRetained.requestBytes = 0; },
    r => { row(r, 'pause').bufferOwnership.samples.backpressured = null; },
    r => { row(r, 'slow').bufferOwnership.samples.backpressured.requestBytes = 1; },
    r => { row(r, 'slow').bufferOwnership.highWater.readableBytes++; },
    r => { r.native.rows[0].bufferOwnership = row(r, 'slow').bufferOwnership; },
    ...['requestBytes', 'pendingMessageBytes', 'parserAssemblyBytes', 'runtimeChunkBytes', 'readableBytes'].flatMap(key => [
      r => { row(r, 'slow').bufferOwnership.highWater[key]++; },
      r => { row(r, 'slow').bufferOwnership.samples.released[key] = 1; },
      r => { delete row(r, 'slow').bufferOwnership.samples.requestRetained[key]; },
    ]),
    ...['pendingMessageBytes', 'parserAssemblyBytes', 'runtimeChunkBytes', 'readableBytes'].map(key =>
      r => { row(r, 'slow').bufferOwnership.samples.backpressured[key] = 0; }),
  ]) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateFlowControlReport(report), /WGA_EVIDENCE_INVALID/);
  }
});
function reject(mutate) { const report = fixture(); mutate(report); assert.throws(() => validateFlowControlReport(report), /WGA_EVIDENCE_INVALID/); }

test('EVIDENCE flow control accepts native and adapter receipts while preserving distinct ownership boundaries', () => {
  const report = fixture(); validateFlowControlReport(report);
  assert.deepEqual(report.catalogCases.filter(value => !value.catalogMatch).map(value => value.id), ['FLOW-006']);
  assert.equal(report.catalogCases.find(value => value.id === 'FLOW-006').scenarioCount, 8);
  assert.equal(report.catalogCases.find(value => value.id === 'FLOW-003').nativeScenarioCount, 1);
  const original = structuredClone(report); catalogCases(report.runs, report.native); assert.deepEqual(report, original);
  // A service binding can consume the upstream body after local cancellation.
  assert.equal(report.peer.serverCalls.find(value => value.id === 'workerd:cloudflare:cancel').finished, true);
  assert.equal(row(report, 'cancel', 2).codes[0], 1);
});

test('EVIDENCE flow control rejects missing execution matrices or native and installed provenance', () => {
  for (const mutate of [
    r => { r.status = 'development-passed'; }, r => { r.development = true; }, r => { r.sourceBuild = true; },
    r => { r.liveCloud = true; }, r => { r.incomingCloudflareTranslation = true; }, r => { r.nativeHttp2 = false; },
    r => { r.externalRequests = 1; }, r => { r.runtimeDisposed = false; }, r => { r.cleanupVerifiedBeforeDispose = false; },
    r => { r.nativeBusinessCompared = false; }, r => { r.compatibilityDate = '2020-01-01'; }, r => { r.workerd = ''; },
    r => { r.bundleSha256 = 'bad'; }, r => { r.evidence['fixtures/shared/flow-control.mjs'] = ''; },
    r => { delete r.evidence['scripts/flow-control-unary.cjs']; }, r => { r.nativeInputs = {}; },
    r => { delete r.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/dist/wire.js']; },
    r => { r.installedInputs['fixtures/worker/node_modules/@grpc/grpc-js/../untrusted.js'] = 'a'.repeat(64); },
    r => { r.nativeInputs['fixtures/native/node_modules/../../untrusted.js'] = 'a'.repeat(64); },
    r => { r.runs.pop(); }, r => { r.runs[3] = structuredClone(r.runs[2]); }, r => { r.runs[0].rows.pop(); },
    r => { r.runs[0].rows[0] = structuredClone(r.runs[0].rows[1]); }, r => { r.runs[1].rows[0].runtime = 'native'; },
    r => { r.native.version = '1.15.0'; }, r => { r.native.rows.pop(); }, r => { r.native.rows[0].mode = 'cloudflare'; },
    r => { r.caseCount = 31; }, r => { r.catalogCases[0].scenarioCount++; },
    r => { r.catalogCases.find(value => value.id === 'FLOW-006').catalogMatch = true; },
  ]) reject(mutate);
});

test('EVIDENCE flow control validates exact payloads and buffered public events without claiming status always follows data', () => {
  for (const mutate of [
    r => { row(r, 'slow').deliveredCount--; }, r => { row(r, 'slow').deliveredBytes++; }, r => { row(r, 'slow').payloadByteSum++; },
    r => { row(r, 'total').requestedCount = 512; }, r => { row(r, 'total').messageSize = 1024; },
    r => { row(r, 'pause').events.splice(2, 1); }, r => { row(r, 'pause').events[1] = 'data:0'; },
    r => { row(r, 'partial').codes = [0]; }, r => { row(r, 'partial').errorCodes = []; },
    r => { row(r, 'partial').events = ['error:14', 'status:14', ...Array.from({ length: 8 }, (_, i) => `data:${i}`), 'end']; row(r, 'partial').dataAfterTerminal = 8; },
    r => { row(r, 'partial').events.splice(7, 0, 'error:14'); }, r => { row(r, 'partial').dataAfterTerminal = 0; },
    r => { row(r, 'cancel').events.push('data:1'); }, r => { row(r, 'cancel').terminalCount = 2; },
    r => { row(r, 'pause').pauseDeliveredDuringWindow = 1; }, r => { row(r, 'pause').pauseWindowMs = 19; },
    r => { row(r, 'pause').pausedSample.deliveredCount = 9; }, r => { row(r, 'slow').maxReadableLength = 2; },
    r => { r.native.rows[0].maxExecution = { ...empty }; }, r => { r.native.rows[4].payloadByteSum++; },
  ]) reject(mutate);
  const report = fixture(), partial = row(report, 'partial');
  partial.events = [...Array.from({ length: 8 }, (_, i) => `data:${i}`), 'error:14', 'status:14', 'end']; partial.dataAfterTerminal = 0;
  validateFlowControlReport(report);
});

test('EVIDENCE flow control requires positive pressure and genuine owner cleanup before stream discard', () => {
  for (const field of Object.keys(empty)) reject(r => { row(r, 'slow').finalExecution[field] = 1; });
  for (const field of ['activeCalls', 'queuedCalls', 'bufferedBytes']) reject(r => { row(r, 'slow').finalResources[field] = 1; });
  for (const mutate of [
    r => { row(r, 'cancel').cancelSample.readableLength = 0; }, r => { row(r, 'cancel').cancelSample.execution.pendingMessages = 0; },
    r => { row(r, 'cancel').cancelSample.execution.pendingMessageBytes = 0; }, r => { row(r, 'cancel').cancelSample.execution.parserAssemblies = 0; },
    r => { row(r, 'cancel').cancelSample.execution.runtimeChunkBytes = 0; }, r => { row(r, 'cancel').readableLengthAfterCancel = 0; },
    r => { row(r, 'cancel').discardedMessages = 0; }, r => { row(r, 'cancel').readableLengthAfterDiscard = 1; },
    r => { row(r, 'slow').maxExecution.pendingMessages = 2; }, r => { row(r, 'slow').maxExecution.pendingMessageBytes = 2048; },
    r => { row(r, 'slow').maxExecution.parserAssemblies = 2; }, r => { row(r, 'slow').maxExecution.runtimeChunkBytes = Infinity; },
    r => { row(r, 'pause').maxExecution.pendingMessages = 0; }, r => { row(r, 'slow').finalDiagnostics.timerActive = true; },
    r => { row(r, 'slow').finalDiagnostics.fetchCount = 2; }, r => { row(r, 'slow').activeCallsBeforeClose = 1; },
    r => { row(r, 'total').finalResources.peakBufferedBytes = 34 * 1024 * 1024; },
    r => { row(r, 'slow').finalResources.peakActiveCalls = 0; }, r => { row(r, 'slow').cleanupVerifiedBeforeClose = false; },
  ]) reject(mutate);
});

test('EVIDENCE flow control rejects unary parity relabelling and unmeasured coalesced frame ownership', () => {
  for (const mutate of [
    r => { row(r, 'unary-one').readDemands = 2; }, r => { row(r, 'unary-one').callbacks = []; },
    r => { row(r, 'unary-duplicate').statuses = [4]; }, r => { row(r, 'unary-duplicate').decoded = ['one']; },
    r => { row(r, 'unary-duplicate').cleanup.execution.activePumps = 1; },
    r => { r.native.wire.nativeParity = true; }, r => { r.native.wire.rows[1].statuses = [12]; },
    r => { r.native.wire.rawControl.messages = 1; }, r => { r.native.wire.rawControl.endStream = false; },
    r => { r.native.wire.arrivals[2].trailers = false; }, r => { r.native.wire.sessionsClosed = false; },
    r => { r.native.chunk.nativeChunkBoundaryClaimed = true; }, r => { r.native.chunk.bytes = 1; },
    r => { row(r, 'coalesced-native-stream').enqueues = 2; }, r => { row(r, 'coalesced-native-stream').chunkBytes--; },
    r => { row(r, 'coalesced-native-stream').fixtureBufferLimit = 34000000; },
    r => { row(r, 'coalesced-native-stream').beforeDemand.pendingMessages = 0; },
    r => { row(r, 'coalesced-native-stream').beforeDemand.runtimeChunkBytes = 261; },
    r => { row(r, 'coalesced-native-stream').maxExecution.parserAssemblies = 2; },
    r => { row(r, 'coalesced-native-stream').readerUnlocked = false; },
  ]) reject(mutate);
});

test('EVIDENCE flow control reconciles actual native server calls, bounded bridge bytes and cleanup checkpoints', () => {
  for (const field of ['activeSessions', 'activeBridges', 'activeBackendCalls', 'pendingDrainWaiters', 'pendingPulls']) {
    reject(r => { r.peerCheckpoints[4].after[field] = 1; }); reject(r => { r.peer.beforeClose[field] = 1; });
  }
  for (const mutate of [
    r => { r.peer.serverCalls.pop(); }, r => { r.peer.receipts.pop(); }, r => { r.peer.serverCalls[1].id = r.peer.serverCalls[0].id; },
    r => { r.peer.serverCalls[0].messagesProduced--; }, r => { r.peer.serverCalls[0].bytesProduced++; },
    r => { r.peer.serverCalls[0].drainWaits = 0; }, r => { r.peer.serverCalls[0].generatorSettled = false; },
    r => { r.peer.serverCalls[0].cancelledBeforeFinish = true; }, r => { r.peer.serverCalls[3].finished = true; },
    r => { r.peer.receipts[0].host = 'external.test'; }, r => { r.peer.receipts[0].responseBytes++; },
    r => { r.peer.receipts[0].pulls = 100; }, r => { r.peer.receipts[0].peakReadableBytes = 33 * 1024 * 1024; },
    r => { r.peer.receipts[0].statusSource = 'synthetic-status'; }, r => { r.peer.receipts[0].sessionClosed = false; },
    r => { r.peer.receipts[0].sequence = 2; }, r => { r.peer.receipts[3].abortObserved = false; },
    r => { r.peer.receipts[0].failure = 'failure'; }, r => { r.peerCheckpoints.pop(); },
    r => { r.peerCheckpoints[3].explicitCancelled = ['node:cloudflare:cancel']; },
    r => { r.peerCheckpoints[3].explicitCancelled = ['workerd:cloudflare:cancel']; },
    r => { r.peerAfterClose.serverClosed = false; },
  ]) reject(mutate);
});

test('EVIDENCE flow control source-build opt-in preserves all native and cross-runtime checks', () => {
  const report = fixture(); report.sourceBuild = true; report.installedInputs = {};
  assert.throws(() => validateFlowControlReport(report), /WGA_EVIDENCE_INVALID/);
  validateFlowControlReport(report, { allowSourceBuild: true });
  row(report, 'cancel', 3).finalExecution.pendingMessages = 1;
  assert.throws(() => validateFlowControlReport(report, { allowSourceBuild: true }), /WGA_EVIDENCE_INVALID/);
});
