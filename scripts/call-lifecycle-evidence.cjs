'use strict';
const { isDeepStrictEqual } = require('node:util');
function need(condition, message) { if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: call-lifecycle ${message}`); }
const same = (actual, expected, message) => need(isDeepStrictEqual(actual, expected), message);
const modes = ['cloudflare', 'grpc-web'], runtimes = ['node', 'workerd'];
const executionKeys = ['activePumps', 'pendingMessages', 'pendingMessageBytes', 'pendingWriteCallbacks',
  'parserAssemblies', 'parserAssemblyBytes', 'runtimeChunkBytes'];
const resourceKeys = ['activeCalls', 'queuedCalls', 'bufferedBytes'];
const sources = ['scripts/test-call-lifecycle.cjs', 'scripts/call-lifecycle-evidence.cjs',
  'fixtures/shared/call-lifecycle.mjs', 'fixtures/shared/lifecycle-deadlines.mjs',
  'fixtures/shared/lifecycle-terminals.mjs', 'fixtures/worker/call-lifecycle.mjs', 'fixtures/worker/package-lock.json',
  'fixtures/native/package.json', 'fixtures/native/package-lock.json'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value, maximum = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const catalogIds = ['WIRE-018', ...Array.from({ length: 18 }, (_, index) => `LIFE-${String(index + 1).padStart(3, '0')}`)];
const httpCodes = [[400, 13], [401, 16], [403, 7], [404, 12], [429, 14], [502, 14], [503, 14], [504, 14], [200, 2]];
const preparation = [
  ['half-close-before-auth', 'LIFE-002'], ['auth-before-message', 'LIFE-003'],
  ['empty-request', 'LIFE-004'], ['caller-buffer-mutation', 'LIFE-018'],
  ...httpCodes.map(([http]) => [`http-${http}`, 'WIRE-018']),
  ['public-unary-buffer', 'LIFE-018'], ['public-server-stream-buffer', 'LIFE-018'],
];
const deadlines = [
  ['explicit-infinity-overrides-default', 'LIFE-013', 0, null, []],
  ['omitted-deadline-with-default', 'LIFE-014', 4, '200m', [200]],
  ['omitted-deadline-without-default', 'LIFE-014', 0, null, []],
  ['past-numeric-deadline', 'LIFE-015', 4, null, []], ['past-date-deadline', 'LIFE-015', 4, null, []],
  ['invalid-date', 'LIFE-015', 3, null, []], ['nan-deadline', 'LIFE-015', 3, null, []],
  ['negative-infinity-deadline', 'LIFE-015', 3, null, []],
  ...[[1, '1m'], [99999999, '99999999m'], [100000000, '100000S'], [99999999000, '99999999S'],
    [99999999001, '1666667M'], [5999999940000, '99999999M'], [5999999940001, '1666667H'], [359999996400000, '99999999H']]
    .map(([duration, header]) => [`timeout-${header}-${duration}`, 'LIFE-016', 0, header, [Math.min(duration, 2147483647)]]),
  ['long-timer-rearms-without-overflow', 'LIFE-016', 4, '2147496S', [2147483647, 12345]],
];
const terminals = [
  ['cancel-before-listener', 'LIFE-001', [1], [0], 0],
  ['send-immediate-cancel', 'LIFE-005', [1], [0], 0],
  ['pending-fetch-reject-after-cancel', 'LIFE-006', [1], [1], 0],
  ['cancel-with-later-frame-in-chunk', 'LIFE-007', [1], [1], 1],
  ['reentrant-demand-and-cancel', 'LIFE-012', [1], [1], 1],
  ['eof-then-cancel-same-turn', 'LIFE-008', [1], [1], 1],
  ['cancel-then-eof-same-turn', 'LIFE-008', [1], [1], 1],
  ['committed-eof-then-cancel', 'LIFE-008', [0], [1], 1],
  ['close-twice-two-active-and-new-call', 'LIFE-009', [14, 14, 14], [1, 1, 0], 0],
  ['same-channel-credentials-and-readers-isolated', 'LIFE-010', [1, 0], [1, 1], 2],
  ['late-auth-rejection', 'LIFE-011', [1], [0], 0],
  ['late-fetch-rejection', 'LIFE-011', [1], [1], 0],
  ['late-read-rejection', 'LIFE-011', [1], [1], 1],
  ['late-controlled-reader-rejection', 'LIFE-011', [1], [1], 1],
  ['one-hundred-of-each-terminal-outcome', 'LIFE-017', [...Array(100).fill(0), ...Array(100).fill(13), ...Array(100).fill(1)], Array(300).fill(1), 200],
];
const variants = new Map([...preparation, ...deadlines, ...terminals].map(([variant, id]) => [variant, id]));
function execution(value, label, expected = {}) {
  need(value && typeof value === 'object', `${label} execution`);
  for (const key of executionKeys) need(value[key] === (expected[key] ?? 0), `${label} execution ${key}`);
}
function resources(value, label) {
  need(value && typeof value === 'object', `${label} resources`);
  for (const key of resourceKeys) need(value[key] === 0, `${label} resource ${key}`);
  for (const key of ['peakActiveCalls', 'peakQueuedCalls', 'peakBufferedBytes']) need(integer(value[key]), `${label} resource ${key}`);
}
function cleanup(row, fetches, label) {
  need(integer(fetches, 1), `${label} per-call fetch bound`);
  same(row.diagnostics, { terminal: true, fetchCount: fetches, requestBytes: 0, responseBytes: 0, timerActive: false }, `${label} terminal diagnostics`);
  execution(row.execution, label); resources(row.resources, label);
  need(row.activeCalls === 0, `${label} registry`);
}
function checkPreparation(row) {
  const label = row.variant;
  need(row.fetchCount === 1 && row.terminalCount === 1 && row.unhandledRejections === 0, `${label} counts`);
  cleanup(row, row.fetchCount, label);
  if (label.startsWith('public-')) {
    need(row.acceptedBytesPreserved === true && row.callbackCount === (label === 'public-unary-buffer' ? 1 : 0), `${label} public call`);
    return;
  }
  need(row.authCount === 1 && row.writeCompletions === 1 && row.readerUnlocked === true && row.replayCount === 0, `${label} preparation ownership`);
  const http = httpCodes.find(([value]) => label === `http-${value}`);
  if (http) {
    need(row.httpStatus === http[0] && row.code === http[1], `${label} HTTP status policy`);
    same(row.messages, [], `${label} no message`); same(row.requestPayload, [7], `${label} request`);
  } else {
    need(row.code === 0, `${label} success`); same(row.messages, ['ok'], `${label} message`);
    if (['half-close-before-auth', 'auth-before-message'].includes(label)) {
      need(row.fetchBeforeReady === 0, `${label} fetch gating`); same(row.requestPayload, [1, 2, 3], `${label} request`);
    } else {
      need(row.acceptedBytesPreserved === true, `${label} buffer ownership`);
      same(row.requestPayload, label === 'empty-request' ? [] : [10, 20, 30], `${label} request`);
    }
  }
}
function checkDeadline(row, spec) {
  const [label, , code, header, timers] = spec, preflight = row.id === 'LIFE-015';
  cleanup(row, preflight ? 0 : 1, label);
  need(row.fetches === (preflight ? 0 : 1) && row.authCalls === (preflight ? 0 : 1), `${label} auth/fetch`);
  need(row.writes === 1 && row.writeErrors === Number(preflight) && row.messagesAfterTerminal === 0 && row.timers === 0, `${label} callback/timer cleanup`);
  need(row.metadata === Number(code === 0) && row.messages === Number(code === 0), `${label} response count`);
  need(row.fetchAborts === Number(!preflight && code === 4), `${label} abort`);
  need(Array.isArray(row.statuses) && row.statuses.length === 1 && row.statuses[0].code === code && typeof row.statuses[0].details === 'string', `${label} terminal`);
  need(row.synchronousStatuses === 0, `${label} asynchronous delivery`);
  same(row.timeoutHeader, header, `${label} timeout header`); same(row.timerDelays, timers, `${label} timer timeline`);
  if (code === 3) {
    need(row.statuses[0].details === 'WGA_INVALID_DEADLINE' && row.catalogExpectedCode === 3 && row.actualCode === 3,
      `${label} invalid deadline policy`);
  }
  need(row.catalogMatch === true, `${label} catalog match`);
}
function checkTerminal(row, spec) {
  const [label, , codes, fetches, readerCount] = spec;
  need(row.unhandledRejections === 0 && row.activeCalls === 0, `${label} aggregate cleanup`); resources(row.resources, label);
  need(Array.isArray(row.calls) && row.calls.length === codes.length, `${label} actual calls`);
  need(row.fetches === fetches.reduce((sum, n) => sum + n, 0), `${label} fetch total`);
  row.calls.forEach((call, index) => {
    const suffix = `${label}/${index}`; cleanup(call, fetches[index], suffix); same(call.statuses, [codes[index]], `${suffix} status`);
    need(Array.isArray(call.events) && Array.isArray(call.messages) && Array.isArray(call.writes), `${suffix} event records`);
    const sendCount = label === 'cancel-before-listener' ? 0 : 1;
    need(call.events.filter(value => value === 'send').length === sendCount && call.writes.length === sendCount
      && call.events.filter(value => value === 'write').length === sendCount, `${suffix} write completion`);
    same(call.events.filter(value => value.startsWith('status:')), [`status:${codes[index]}`], `${suffix} single terminal event`);
    const final = call.events.findIndex(value => value.startsWith('status:'));
    need(call.events.lastIndexOf('message') < final && call.events.filter(value => value === 'message').length === call.messages.length, `${suffix} message order`);
    const messages = label.includes('frame-in-chunk') || label === 'reentrant-demand-and-cancel' ? ['first']
      : label === 'same-channel-credentials-and-readers-isolated' && index === 1 ? ['B-only']
      : row.id === 'LIFE-017' && index < 100 ? ['ok'] : [];
    same(call.messages, messages, `${suffix} messages`);
  });
  need(Array.isArray(row.requests) && row.requests.length === row.fetches, `${label} peer request receipts`);
  for (const receipt of row.requests) need(receipt.aborted === true && receipt.aborts === 1
    && receipt.request === '000000000772657175657374' && (receipt.credential === null || ['A', 'B'].includes(receipt.credential)), `${label} peer abort and bytes`);
  need(Array.isArray(row.readers) && row.readers.length === readerCount, `${label} reader receipts`);
  for (const reader of row.readers) need(reader.locked === false && integer(reader.cancels, 1), `${label} reader cleanup`);
  if (row.id === 'LIFE-001') need(row.authCalls === 0, `${label} no auth`);
  if (row.id === 'LIFE-005') {
    need(row.authCalls === 0, `${label} no auth`);
    execution(row.afterSend, label, { pendingWriteCallbacks: 1 }); execution(row.afterCancel, label, { pendingWriteCallbacks: 1 });
  }
  if (row.id === 'LIFE-006') execution(row.afterTerminal, label, { activePumps: 1 });
  if (row.id === 'LIFE-007' || row.id === 'LIFE-012') {
    for (const key of ['inMessage', 'afterCancel']) {
      need(integer(row[key]?.parserAssemblyBytes) && row[key].parserAssemblyBytes > 0 && integer(row[key]?.runtimeChunkBytes) && row[key].runtimeChunkBytes > 0, `${label} retained framing bytes`);
      execution(row[key], label, { activePumps: 1, parserAssemblies: 1, parserAssemblyBytes: row[key].parserAssemblyBytes, runtimeChunkBytes: row[key].runtimeChunkBytes });
    }
    need(row.readers[0].cancels === 1, `${label} reader cancelled`);
  }
  if (row.id === 'LIFE-008') need(row.eofArrivalIsNotTerminalCommit === true, `${label} EOF policy`);
  if (row.id === 'LIFE-010') {
    same(row.authCalls, { A: 1, B: 1 }, `${label} separate credentials`);
    same(row.requests.map(value => value.credential).sort(), ['A', 'B'], `${label} peer credentials`);
  }
  if (row.id === 'LIFE-011') {
    if (label === 'late-controlled-reader-rejection') {
      need(row.mechanism === 'fault-injecting-reader-delays-standard-reader-result' && row.standardReaderCancelBehavior === false, `${label} controlled mechanism`);
      execution(row.afterTerminal, label, { activePumps: 1, parserAssemblies: 1, parserAssemblyBytes: 5 });
      for (const key of ['readCalls', 'readRejects', 'cancellations', 'releases']) need(row[key] === 1, `${label} ${key}`);
      need(row.readers[0].reads === 1 && row.readers[0].rejects === 1 && row.readers[0].releases === 1, `${label} reader rejection receipt`);
    } else {
      const stage = label.slice(5, -10);
      need(row.stage === stage && row.authCalls === Number(stage === 'auth') && row.sourceRejects === 1, `${label} late rejection`);
      need(row.mechanism === (stage === 'read' ? 'standard-stream-late-source-pull-rejection' : `controlled-${stage}-promise`), `${label} mechanism`);
      if (stage === 'read') need(row.readContract === 'standard reader cancellation resolves pending read; later underlying pull rejects', `${label} standard read boundary`);
    }
  }
  if (row.id === 'LIFE-017') {
    same(row.counts, { success: 100, error: 100, cancel: 100 }, `${label} exact stress counts`);
    need(row.resources.peakActiveCalls === 100 && row.resources.peakBufferedBytes > 0, `${label} positive resource calibration`);
    need(Array.isArray(row.waveResources) && row.waveResources.length === 3, `${label} waves`);
    row.waveResources.forEach((wave, index) => {
      need(wave.kind === ['success', 'error', 'cancel'][index] && wave.calls === 100 && wave.initialTimers === 100
        && wave.initialWriteCallbacks === 100 && wave.activeCalls === 0, `${label} wave calibration`);
      resources(wave.usage, `${label} wave`);
    });
  }
}
function catalogCases(runs) {
  const all = runs.flatMap(run => run.rows.map(row => ({ runtime: run.runtime, row })));
  return catalogIds.map(id => {
    const selected = all.filter(value => value.row.id === id);
    return { id, status: selected.length && selected.every(value => value.row.status === 'passed') ? 'passed' : 'failed',
      catalogMatch: selected.length > 0 && selected.every(({ row }) => row.catalogMatch !== false &&
        (row.catalogExpectedCode === undefined || row.catalogExpectedCode === row.actualCode)),
      runtimes: runtimes.filter(runtime => selected.some(value => value.runtime === runtime)),
      modes: modes.filter(mode => selected.some(value => value.row.mode === mode)),
      scenarioCount: selected.length, callCount: selected.reduce((sum, value) => sum + (value.row.calls?.length ?? 1), 0) };
  });
}
function validateCallLifecycleReport(report, { allowSourceBuild = false } = {}) {
  need(report?.status === 'passed', 'status');
  need(report.sourceBuild === false || (allowSourceBuild && report.sourceBuild === true), 'installed execution');
  for (const key of ['liveCloud', 'incomingCloudflareTranslation', 'nativeHttp2']) need(report[key] === false, key);
  for (const key of ['controlledPeer', 'runtimeDisposed', 'cleanupVerifiedBeforeDispose']) need(report[key] === true, key);
  need(report.externalRequests === 0, 'external requests');
  need(report.compatibilityDate === '2026-09-21' && typeof report.workerd === 'string' && report.workerd.length > 0
    && typeof report.miniflare === 'string' && report.miniflare.length > 0, 'runtime identity');
  need(digest(report.bundleSha256), 'bundle hash');
  need(sources.every(file => digest(report.evidence?.[file])), 'source evidence');
  same(report.nativeDeadline, { grpc: '1.14.0', variant: 'invalid-date', threwSynchronously: true,
    errorName: 'RangeError', callReturned: false, callbacks: 0, authCalls: 0, nativeParity: false,
    adapterPolicy: 'asynchronous-invalid-argument' }, 'pinned native invalid-Date boundary');
  need(report.nativeInputs && typeof report.nativeInputs === 'object' && !Array.isArray(report.nativeInputs), 'native inputs');
  for (const [file, hash] of Object.entries(report.nativeInputs)) need(file.startsWith('fixtures/native/node_modules/@grpc/grpc-js/')
    && !file.split('/').includes('..') && digest(hash), 'native input provenance');
  for (const file of ['package.json', 'build/src/client.js', 'build/src/resolving-call.js', 'build/src/deadline.js']) {
    need(digest(report.nativeInputs[`fixtures/native/node_modules/@grpc/grpc-js/${file}`]), `native ${file}`);
  }
  need(report.installedInputs && typeof report.installedInputs === 'object' && !Array.isArray(report.installedInputs), 'installed inputs');
  for (const [file, hash] of Object.entries(report.installedInputs)) need(file.startsWith('fixtures/worker/node_modules/@grpc/grpc-js/') && !file.split('/').includes('..') && digest(hash), 'installed input provenance');
  if (!report.sourceBuild) for (const file of ['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'call.js', 'wire.js']) {
    need(digest(report.installedInputs[`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`]), `installed ${file}`);
  }
  need(Array.isArray(report.runs) && report.runs.length === 2, 'runtime count');
  same(report.runs.map(run => run.runtime).sort(), [...runtimes].sort(), 'distinct runtimes');
  for (const run of report.runs) {
    need(run.status === 'passed' && run.unhandledRejections === 0 && run.rejectionSensorCount === 1, `${run.runtime} calibrated rejection monitor`);
    need(Array.isArray(run.rows) && run.rows.length === 94, `${run.runtime} scenario count`);
    const seen = new Set();
    for (const row of run.rows) {
      need(modes.includes(row.mode) && variants.get(row.variant) === row.id && row.status === 'passed', `${run.runtime} scenario identity`);
      const key = `${row.mode}/${row.variant}`; need(!seen.has(key), `${run.runtime} duplicate scenario`); seen.add(key);
      if (preparation.some(([variant]) => row.variant === variant)) checkPreparation(row);
      else {
        const deadline = deadlines.find(([variant]) => row.variant === variant);
        if (deadline) checkDeadline(row, deadline); else checkTerminal(row, terminals.find(([variant]) => row.variant === variant));
      }
    }
    for (const mode of modes) for (const variant of variants.keys()) need(seen.has(`${mode}/${variant}`), `${run.runtime} missing scenario`);
  }
  need(report.caseCount === 188, 'aggregate scenario count');
  same(report.catalogCases, catalogCases(report.runs), 'catalog aggregation');
  need(report.catalogCases.length === 19 && report.catalogCases.every(row => row.status === 'passed'
    && row.catalogMatch === true), 'catalog requirements satisfied');
}
module.exports = { catalogCases, validateCallLifecycleReport };
