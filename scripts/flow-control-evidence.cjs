'use strict';
const { isDeepStrictEqual } = require('node:util');
function need(value, reason) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: flow-control ${reason}`); }
const same = (actual, expected, label) => need(isDeepStrictEqual(actual, expected), label);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const modes = ['cloudflare', 'grpc-web'], runtimes = ['node', 'workerd'];
const zero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
  parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const publicSpecs = [
  ['FLOW-001', 'slow', 128, 1024, 0], ['FLOW-002', 'pause', 96, 1024, 0],
  ['FLOW-003', 'total', 513, 65536, 0], ['FLOW-004', 'cancel', 4096, 1024, 1],
  ['FLOW-005', 'partial', 8, 1024, 14],
];
function payloadSum(count, size) {
  let result = 0;
  for (let index = 0; index < count; index++) {
    result += (index % 251) * (size - 4);
    for (let shift = 0; shift < 32; shift += 8) result += (index >>> shift) & 255;
  }
  return result;
}
function resourceBounds(value, label, terminal = true) {
  need(value && typeof value === 'object', `${label} resource snapshot`);
  for (const field of ['activeCalls', 'queuedCalls', 'bufferedBytes']) {
    need(integer(value[field], field === 'bufferedBytes' ? 1048576 : 1), `${label} resource ${field}`);
    if (terminal) need(value[field] === 0, `${label} final resource ${field}`);
  }
  need(value.peakActiveCalls === 1 && value.peakQueuedCalls === 0
    && integer(value.peakBufferedBytes, 1048576) && value.peakBufferedBytes > 0, `${label} positive bounded resource peaks`);
}
function executionBounds(value, size, label) {
  need(value && Object.keys(zero).every(field => integer(value[field])), `${label} execution snapshot`);
  need(value.activePumps <= 1 && value.pendingMessages <= 1 && value.pendingMessageBytes <= size
    && value.pendingWriteCallbacks <= 1 && value.parserAssemblies <= 1 && value.parserAssemblyBytes <= size + 5
    && value.runtimeChunkBytes <= 1048576, `${label} bounded execution owners`);
}
function publicRow(row, spec, native = false) {
  const [id, scenario, count, size, code] = spec, label = `${row.runtime}/${row.mode}/${scenario}`;
  const delivered = scenario === 'cancel' ? 1 : count;
  need(row.id === id && row.scenario === scenario && row.status === 'passed', `${label} scenario identity`);
  need(row.requestId === `${row.runtime}:${row.mode}:${scenario}`, `${label} request identity`);
  need(row.requestedCount === count && row.messageSize === size && row.deliveredCount === delivered
    && row.deliveredBytes === delivered * size && row.payloadByteSum === payloadSum(delivered, size), `${label} exact ordered payload receipt`);
  same(row.codes, [code], `${label} terminal code`); same(row.errorCodes, code ? [code] : [], `${label} error code`);
  need(row.terminalCount === 1 && row.endCount === Number(scenario !== 'cancel')
    && row.cancelCount === Number(scenario === 'cancel') && row.deliveredAtCancel === (scenario === 'cancel' ? 1 : null), `${label} terminal counts`);
  need(Array.isArray(row.events) && row.events.every(event => typeof event === 'string'), `${label} event trace`);
  same(row.events.filter(event => event.startsWith('data:')), Array.from({ length: delivered }, (_, index) => `data:${index}`), `${label} exact public message order`);
  same(row.events.filter(event => !event.startsWith('data:')), [...(code ? [`error:${code}`] : []), `status:${code}`,
    ...(scenario === 'cancel' ? [] : ['end'])], `${label} public terminal order`);
  const final = row.events.indexOf(`status:${code}`), afterTerminal = row.events.slice(final + 1).filter(event => event.startsWith('data:')).length;
  need(row.dataAfterTerminal === afterTerminal && integer(afterTerminal, row.readableHighWaterMark), `${label} terminal versus buffered public messages`);
  if (scenario === 'partial') need(row.events.indexOf('data:0') < row.events.indexOf('error:14') && row.events.at(-1) === 'end', `${label} partial data precedes error`);
  if (scenario === 'cancel') need(afterTerminal === 0, `${label} no cancelled data delivery`);
  need(integer(row.readableHighWaterMark) && row.readableHighWaterMark > 0
    && integer(row.maxReadableLength, row.readableHighWaterMark), `${label} public queue bound`);
  need(row.cleanupVerifiedBeforeClose === true && row.readableLengthAfterDiscard === 0
    && integer(row.readableLengthBeforeDiscard, row.readableHighWaterMark)
    && row.discardedMessages === row.readableLengthBeforeDiscard, `${label} separate public queue disposal`);
  if (scenario === 'total') need(row.deliveredBytes > 32 * 1024 * 1024, `${label} exceeds aggregate safety cap`);
  if (scenario === 'pause') {
    need(row.pauseDeliveredDuringWindow === 0 && integer(row.pauseWindowMs) && row.pauseWindowMs >= 20
      && row.pausedSample?.deliveredCount === 8
      && integer(row.pausedSample.readableLength, row.readableHighWaterMark), `${label} measured pause interval`);
  } else same([row.pauseDeliveredDuringWindow, row.pauseWindowMs, row.pausedSample], [null, null, null], `${label} no pause receipt relabelling`);
  if (scenario === 'cancel') {
    need(row.cancelSample?.deliveredCount === 1 && row.cancelSample.readableLength === row.readableHighWaterMark
      && row.readableLengthAfterCancel === row.readableHighWaterMark
      && row.readableLengthBeforeDiscard === row.readableLengthAfterCancel
      && row.maxReadableLength === row.readableHighWaterMark, `${label} actual backpressure and retained public queue`);
  } else {
    same([row.cancelSample, row.readableLengthAfterCancel], [null, null], `${label} no cancellation receipt relabelling`);
    need(row.readableLengthBeforeDiscard === 0, `${label} consumed public queue`);
  }
  if (native) {
    for (const field of ['maxExecution', 'finalExecution', 'finalDiagnostics', 'finalResources', 'activeCallsBeforeClose', 'bufferOwnership']) {
      need(row[field] === null, `${label} no fabricated native adapter counters`);
    }
    for (const snapshot of [row.pausedSample, row.cancelSample].filter(Boolean)) {
      same([snapshot.execution, snapshot.resources], [null, null], `${label} native snapshot boundary`);
    }
  } else {
    need(row.readableHighWaterMark === 1 && row.activeCallsBeforeClose === 0, `${label} configured queue and registry`);
    executionBounds(row.maxExecution, size, label);
    need(row.maxExecution.activePumps === 1 && row.maxExecution.parserAssemblies === 1
      && row.maxExecution.parserAssemblyBytes > 0 && row.maxExecution.runtimeChunkBytes > 0, `${label} positive measured owners`);
    if (scenario !== 'total') need(row.maxReadableLength === 1 && row.maxExecution.pendingMessages === 1
      && row.maxExecution.pendingMessageBytes === size, `${label} exercised backpressure`);
    same(row.finalExecution, zero, `${label} actual execution cleanup`);
    same(row.finalDiagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }, `${label} terminal diagnostics`);
    resourceBounds(row.finalResources, label);
    const ownership = row.bufferOwnership;
    need(ownership?.scope === 'adapter-visible-buffer-references' && ownership.additive === false,
      `${label} byte ownership is not a heap total`);
    same(Object.keys(ownership).sort(), ['additive', 'highWater', 'samples', 'scope'], `${label} byte ownership schema`);
    const byteKeys = ['requestBytes', 'pendingMessageBytes', 'parserAssemblyBytes', 'runtimeChunkBytes', 'readableBytes'];
    same(Object.keys(ownership.samples).sort(), ['backpressured', 'released', 'requestRetained'], `${label} ownership checkpoints`);
    for (const sample of [ownership.highWater, ...Object.values(ownership.samples)].filter(value => value !== null)) {
      need(sample && Object.keys(sample).length === byteKeys.length && byteKeys.every(key => integer(sample[key], 1048576)),
        `${label} measured byte categories`);
    }
    const requestBytes = Buffer.byteLength(JSON.stringify({ id: row.requestId, scenario, count, size, catalogId: id, requestId: row.requestId }));
    same(ownership.samples.requestRetained, { requestBytes, pendingMessageBytes: 0, parserAssemblyBytes: 0,
      runtimeChunkBytes: 0, readableBytes: 0 }, `${label} actual serialized request checkpoint`);
    same(ownership.highWater, { requestBytes, pendingMessageBytes: row.maxExecution.pendingMessageBytes,
      parserAssemblyBytes: row.maxExecution.parserAssemblyBytes, runtimeChunkBytes: row.maxExecution.runtimeChunkBytes,
      readableBytes: row.maxReadableLength * size }, `${label} high-water categories match sampled owners`);
    same(ownership.samples.released, Object.fromEntries(byteKeys.map(key => [key, 0])), `${label} all byte owners released`);
    if (scenario !== 'total') need(ownership.samples.backpressured !== null, `${label} real backpressure checkpoint`);
    if (ownership.samples.backpressured !== null) {
      const bytes = ownership.samples.backpressured;
      need(bytes.requestBytes === 0 && bytes.pendingMessageBytes === size && bytes.readableBytes === size
        && bytes.parserAssemblyBytes > 0 && bytes.runtimeChunkBytes > 0,
      `${label} request release and occupied pending, assembly, runtime chunk and queue`);
      need(byteKeys.every(key => bytes[key] <= ownership.highWater[key]), `${label} checkpoints stay within observed high water`);
    }
    for (const snapshot of [row.pausedSample, row.cancelSample].filter(Boolean)) {
      executionBounds(snapshot.execution, size, label); resourceBounds(snapshot.resources, label, false);
    }
    if (scenario === 'cancel') need(row.cancelSample.execution.pendingMessages === 1
      && row.cancelSample.execution.pendingMessageBytes === size && row.cancelSample.execution.parserAssemblies === 1
      && row.cancelSample.execution.parserAssemblyBytes > 0 && row.cancelSample.execution.runtimeChunkBytes > 0,
    `${label} positive cancelled pending and framing owners`);
  }
}
function wireCleanup(row) {
  const label = `${row.runtime}/${row.mode}/${row.scenario}`;
  need(row.fetchCount === 1 && row.readerUnlocked === true && row.cleanup?.activeCalls === 0, `${label} fetch and reader cleanup`);
  same(row.cleanup.execution, zero, `${label} actual execution cleanup`);
  same(row.cleanup.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false }, `${label} terminal diagnostics`);
  resourceBounds(row.cleanup.resources, label);
  need(row.cleanup.resources.peakBufferedBytes <= 65536, `${label} configured byte budget`);
}
function wireRow(row) {
  const label = `${row.runtime}/${row.mode}/${row.scenario}`;
  need(row.status === 'passed', `${label} status`); wireCleanup(row);
  if (row.id === 'FLOW-006') {
    const duplicate = row.scenario === 'unary-duplicate';
    need(duplicate || row.scenario === 'unary-one', `${label} unary scenario`);
    need(row.peer === 'controlled-binary-response' && row.readDemands === 1, `${label} one unary demand`);
    same(row.callbacks, [{ code: duplicate ? 12 : 0, value: duplicate ? null : 'one' }], `${label} unary callback`);
    same(row.statuses, [duplicate ? 12 : 0], `${label} unary status`);
    same(row.decoded, duplicate ? ['one', 'two'] : ['one'], `${label} unary decoded messages`);
    executionBounds(row.maxExecution, 16, label);
    need(row.maxExecution.activePumps === 1 && row.maxExecution.parserAssemblies === 1
      && row.maxExecution.parserAssemblyBytes > 0 && row.maxExecution.runtimeChunkBytes > 0, `${label} observed unary parser`);
  } else {
    need(row.id === 'FLOW-007' && row.scenario === 'coalesced-native-stream'
      && row.peer === 'native-grpc-js-with-bounded-fixture-rechunking', `${label} native stream and controlled chunk boundary`);
    need(row.requestId === `${row.runtime}:${row.mode}:chunk` && row.count === 128 && row.size === 256
      && row.received === 128 && row.writes === 1 && row.fixtureBufferLimit === 65536 && row.enqueues === 1, `${label} coalesced stream counts`);
    need(integer(row.chunkBytes, 65536) && row.chunkBytes > 128 * 261, `${label} separately measured runtime chunk`);
    same(row.statuses, [0], `${label} terminal status`);
    executionBounds(row.beforeDemand, 256, label); executionBounds(row.maxExecution, 256, label);
    need(row.beforeDemand.activePumps === 1 && row.beforeDemand.pendingMessages === 1 && row.beforeDemand.pendingMessageBytes === 256
      && row.beforeDemand.parserAssemblies === 1 && row.beforeDemand.parserAssemblyBytes === 261
      && row.beforeDemand.runtimeChunkBytes === row.chunkBytes, `${label} actual one-frame demand stall`);
    need(row.maxExecution.pendingMessages === 1 && row.maxExecution.pendingMessageBytes === 256
      && row.maxExecution.parserAssemblies === 1 && row.maxExecution.parserAssemblyBytes === 261
      && row.maxExecution.runtimeChunkBytes === row.chunkBytes, `${label} no parser message array accumulation`);
  }
}
function nativeWire(value) {
  need(value?.sessionsClosed === true && value.nativeParity === false, 'native unary cleanup and explicit divergence');
  need(Array.isArray(value.rows) && value.rows.length === 2, 'native unary case count');
  for (const scenario of ['unary-one', 'unary-duplicate']) {
    const selected = value.rows.filter(row => row.scenario === scenario), duplicate = scenario === 'unary-duplicate';
    need(selected.length === 1, 'native unary case identity'); const row = selected[0];
    need(row.id === 'FLOW-006' && row.readDemands === 1, 'native unary single demand');
    same(row.callbacks, [{ code: duplicate ? 4 : 0, value: duplicate ? null : 'one' }], 'native unary callback');
    same(row.statuses, [duplicate ? 4 : 0], 'native unary status'); same(row.decoded, ['one'], 'native unary decoded');
  }
  same(value.rawControl, { messages: 2, grpcStatus: 0, endStream: true, bytes: '00000000036f6e65000000000374776f' }, 'native duplicate raw HTTP2 control');
  same(value.arrivals, [{ count: 1, trailers: true, finished: true }, { count: 2, trailers: true, finished: true },
    { count: 2, trailers: true, finished: true }], 'native unary backend arrivals');
}
const peerCounters = ['activeSessions', 'activeBridges', 'activeBackendCalls', 'pendingDrainWaiters', 'pendingPulls'];
function peerState(value, closed, idle, label) {
  need(value?.serverClosed === closed, `${label} peer server lifetime`);
  for (const field of peerCounters) need(integer(value[field]) && (!idle || value[field] === 0), `${label} peer ${field}`);
}
function peers(report) {
  const cases = [...publicSpecs, ['FLOW-007', 'chunk', 128, 256, 0]];
  const contexts = [['native', 'native'], ...runtimes.flatMap(runtime => modes.map(mode => [runtime, mode]))];
  need(report.peer?.serverCalls?.length === 30 && report.peer.receipts?.length === 24, 'exact native backend and bridge counts');
  const explicit = new Set();
  need(report.peerCheckpoints?.length === 5, 'peer checkpoint count');
  for (const [runtime, mode] of contexts) {
    const label = runtime === 'native' ? 'native' : `${runtime}:${mode}`;
    const checkpoints = report.peerCheckpoints.filter(row => row.label === label);
    need(checkpoints.length === 1, `${label} unique checkpoint`); const checkpoint = checkpoints[0];
    peerState(checkpoint.before, false, false, label); peerState(checkpoint.after, false, true, label);
    need(Array.isArray(checkpoint.explicitCancelled) && checkpoint.explicitCancelled.length <= 1
      && checkpoint.explicitCancelled.every(id => runtime === 'workerd' && id === `${runtime}:${mode}:cancel`), `${label} explicit fixture cleanup boundary`);
    for (const id of checkpoint.explicitCancelled) explicit.add(id);
    for (const [id, scenario, count, size, code] of cases) {
      const key = `${runtime}:${mode}:${scenario}`, servers = report.peer.serverCalls.filter(row => row.id === key);
      need(servers.length === 1, `${key} exactly one backend call`); const server = servers[0];
      need(server.scenario === scenario && (scenario === 'chunk' || server.catalogId === id)
        && server.count === count && server.size === size && server.generatorSettled === true && server.failure === undefined,
      `${key} backend identity and producer cleanup`);
      need(integer(server.messagesProduced, count) && server.messagesProduced > 0 && server.bytesProduced === server.messagesProduced * size
        && integer(server.drainWaits, count) && integer(server.cancellationEvents, 1)
        && server.cancelled === (server.cancellationEvents === 1), `${key} backend message accounting`);
      const cancelledEarly = scenario === 'cancel' && server.cancelledBeforeFinish;
      if (cancelledEarly) need(server.messagesProduced < count && server.finished === false && server.status === null
        && server.cancelled === true && server.drainWaits > 0, `${key} backend cancellation`);
      else need(server.messagesProduced === count && server.finished === true && server.status === (scenario === 'partial' ? 14 : 0)
        && server.cancelledBeforeFinish === false, `${key} backend completion`);
      if (scenario === 'cancel' && runtime !== 'workerd') need(cancelledEarly, `${key} native and Node cancellation reaches backend`);
      if (['slow', 'pause', 'total', 'chunk'].includes(scenario)) need(server.drainWaits > 0, `${key} real native backpressure`);
      if (runtime === 'native') continue;
      const receipts = report.peer.receipts.filter(row => row.id === key); need(receipts.length === 1, `${key} exactly one Fetch bridge`);
      const receipt = receipts[0];
      need(receipt.scenario === scenario && (scenario === 'chunk' || receipt.catalogId === id)
        && receipt.host === (mode === 'cloudflare' ? 'flow.test' : 'gateway.flow.test')
        && receipt.path === '/flow.Test/Stream' && receipt.httpStatus === 200 && integer(receipt.requestBytes, 65536)
        && receipt.requestBytes > 5 && receipt.sessionClosed === true && receipt.failure === undefined, `${key} bridge routing and cleanup`);
      need(integer(receipt.pulls) && integer(receipt.chunks) && receipt.chunks > 0
        && integer(receipt.peakReadableBytes, 1048576) && receipt.peakReadableBytes > 0
        && integer(receipt.responseBytes, count * (size + 5)) && receipt.responseBytes > 0, `${key} measured bounded bridge`);
      for (const flag of ['cancelled', 'abortObserved', 'bodyCancelled', 'explicitCancellation', 'ended', 'bodyClosed']) need(typeof receipt[flag] === 'boolean', `${key} bridge ${flag}`);
      need(receipt.explicitCancellation === explicit.has(key), `${key} explicit cancellation receipt`);
      if (receipt.cancelled) {
        need(scenario === 'cancel' && (receipt.abortObserved || receipt.bodyCancelled || receipt.explicitCancellation)
          && receipt.status === null && receipt.statusSource === 'not-observed' && receipt.trailerBytes === 0
          && receipt.bodyClosed === false && receipt.pulls >= receipt.chunks && receipt.pulls <= receipt.chunks + 1, `${key} interrupted bridge`);
      } else {
        need(!receipt.abortObserved && !receipt.bodyCancelled && !receipt.explicitCancellation && receipt.status === (scenario === 'partial' ? code : 0)
          && receipt.statusSource === 'observed-native-http2-trailers' && receipt.ended && receipt.bodyClosed
          && receipt.responseBytes === count * (size + 5) && integer(receipt.trailerBytes, 65536) && receipt.trailerBytes > 5
          && receipt.pulls === receipt.chunks + 1, `${key} complete native stream and trailers`);
      }
      if (scenario === 'cancel' && runtime === 'node') need(receipt.cancelled && receipt.abortObserved && !receipt.explicitCancellation, `${key} direct Fetch abort propagation`);
      if (scenario === 'chunk') {
        const row = report.runs.find(run => run.runtime === runtime && run.mode === mode).rows.find(row => row.id === 'FLOW-007');
        need(row.chunkBytes === receipt.responseBytes + receipt.trailerBytes, `${key} exact coalesced native bytes`);
      }
    }
  }
  same(report.peer.receipts.map(row => row.sequence).sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 1), 'distinct bridge attempt receipts');
  peerState(report.peer.beforeClose, false, true, 'before fixture close'); peerState(report.peerAfterClose, true, true, 'after fixture close');
}
function catalogCases(runs, native) {
  const all = runs.flatMap(run => run.rows), baseline = [...(native?.rows ?? []), ...(native?.wire?.rows ?? []), ...(native?.chunk ? [native.chunk] : [])];
  return Array.from({ length: 7 }, (_, index) => {
    const id = `FLOW-${String(index + 1).padStart(3, '0')}`, selected = all.filter(row => row.id === id);
    return { id, status: selected.length && selected.every(row => row.status === 'passed') ? 'passed' : 'failed',
      catalogMatch: id !== 'FLOW-006', runtimes: runtimes.filter(runtime => selected.some(row => row.runtime === runtime)),
      modes: modes.filter(mode => selected.some(row => row.mode === mode)), scenarioCount: selected.length,
      nativeScenarioCount: baseline.filter(row => row.id === id).length };
  });
}
function validateFlowControlReport(report, { allowSourceBuild = false } = {}) {
  need(report?.status === 'passed' && report.development === false, 'complete nondevelopment execution');
  need(report.sourceBuild === false || (allowSourceBuild && report.sourceBuild === true), 'installed package execution');
  need(report.liveCloud === false && report.incomingCloudflareTranslation === false && report.nativeHttp2 === true
    && report.externalRequests === 0, 'loopback native execution scope');
  need(report.runtimeDisposed === true && report.cleanupVerifiedBeforeDispose === true, 'cleanup before runtime disposal');
  need(report.nativeBusinessCompared === true, 'explicit native public result comparison');
  need(report.compatibilityDate === '2026-09-21' && typeof report.workerd === 'string' && report.workerd.length > 0
    && typeof report.miniflare === 'string' && report.miniflare.length > 0 && hash(report.bundleSha256), 'runtime provenance');
  const sources = ['scripts/test-flow-control.cjs', 'scripts/flow-control-peer.cjs', 'scripts/flow-control-unary.cjs',
    'scripts/flow-control-evidence.cjs', 'fixtures/shared/flow-control.mjs', 'fixtures/shared/flow-wire.mjs',
    'fixtures/worker/flow-control.mjs', 'fixtures/worker/package-lock.json', 'fixtures/native/package-lock.json'];
  need(sources.every(file => hash(report.evidence?.[file])), 'complete source provenance');
  for (const [field, prefix] of [['installedInputs', 'fixtures/worker/node_modules/@grpc/grpc-js/'], ['nativeInputs', 'fixtures/native/node_modules/']]) {
    need(report[field] && typeof report[field] === 'object' && !Array.isArray(report[field]), `${field} provenance map`);
    for (const [file, digest] of Object.entries(report[field])) need(file.startsWith(prefix) && !file.split('/').includes('..') && hash(digest), `${field} valid input`);
  }
  if (!report.sourceBuild) for (const file of ['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'call.js', 'wire.js']) {
    need(hash(report.installedInputs[`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`]), `installed ${file}`);
  }
  for (const file of ['package.json', 'build/src/client.js', 'build/src/subchannel-call.js', 'build/src/server.js']) {
    need(hash(report.nativeInputs[`fixtures/native/node_modules/@grpc/grpc-js/${file}`]), `native ${file}`);
  }
  need(report.native?.version === '1.14.0' && report.native.runtime === 'native' && report.native.mode === 'native'
    && report.native.status === 'passed' && report.native.rows?.length === 5, 'pinned native public baseline');
  for (const spec of publicSpecs) {
    const selected = report.native.rows.filter(row => row.id === spec[0]); need(selected.length === 1, 'unique native public scenario');
    need(selected[0].runtime === 'native' && selected[0].mode === 'native', 'native public runtime'); publicRow(selected[0], spec, true);
  }
  nativeWire(report.native.wire);
  same(report.native.chunk, { id: 'FLOW-007', scenario: 'coalesced-native-stream', requestId: 'native:native:chunk',
    count: 128, bytes: 32768, codes: [0], errors: [], nativeChunkBoundaryClaimed: false }, 'native chunk oracle without allocation parity claim');
  need(report.runs?.length === 4 && report.caseCount === 32, 'exact adapter execution count');
  for (const runtime of runtimes) for (const mode of modes) {
    const selected = report.runs.filter(run => run.runtime === runtime && run.mode === mode);
    need(selected.length === 1 && selected[0].status === 'passed' && selected[0].rows?.length === 8, `${runtime}/${mode} execution matrix`);
    const rows = selected[0].rows;
    need(rows.every(row => row.runtime === runtime && row.mode === mode), `${runtime}/${mode} row provenance`);
    for (const spec of publicSpecs) {
      const cases = rows.filter(row => row.id === spec[0]); need(cases.length === 1, `${runtime}/${mode} public case identity`); publicRow(cases[0], spec);
      const baseline = report.native.rows.find(row => row.id === spec[0]);
      for (const field of ['deliveredCount', 'deliveredBytes', 'payloadByteSum', 'codes', 'errorCodes']) {
        same(cases[0][field], baseline[field], `${runtime}/${mode}/${spec[0]} native business result ${field}`);
      }
    }
    for (const scenario of ['unary-one', 'unary-duplicate', 'coalesced-native-stream']) {
      const cases = rows.filter(row => row.scenario === scenario); need(cases.length === 1, `${runtime}/${mode} wire case identity`); wireRow(cases[0]);
    }
  }
  peers(report);
  same(report.catalogCases, catalogCases(report.runs, report.native), 'catalog aggregation');
  need(report.catalogCases.every(row => row.status === 'passed' && row.scenarioCount === (row.id === 'FLOW-006' ? 8 : 4)
    && row.nativeScenarioCount === (row.id === 'FLOW-006' ? 2 : 1)), 'catalog counts and preserved unary gap');
}
module.exports = { catalogCases, validateFlowControlReport };
