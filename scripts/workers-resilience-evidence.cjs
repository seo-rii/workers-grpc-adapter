'use strict';
const { isDeepStrictEqual } = require('node:util');
const budgets = require('../fixtures/worker/resilience-budgets.json');
const modes = ['cloudflare', 'grpc-web'];
const labels = ['start', 'wave-0', 'wave-1', 'wave-2', 'wave-3', 'closed'];
const metrics = ['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'];
const executionZero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const codes = { success: 0, unavailable: 14, quota: 8, denied: 7, truncated: 13,
  'receive-limit': 8, 'send-limit': 8, empty: 12, slow: 0, cancel: 1, deadline: 4, close: 14, recovery: 0 };
const sources = ['scripts/test-workers-resilience.cjs', 'scripts/workers-resilience-evidence.cjs',
  'fixtures/worker/resilience.mjs', 'fixtures/worker/resilience-budgets.json',
  'fixtures/worker/package.json', 'fixtures/worker/package-lock.json'];
const checks = ['concurrent-mixed-faults', 'repeated-client-reuse', 'two-modes-in-one-isolate', 'http-503', 'grpc-quota-and-permission',
  'malformed-response', 'send-and-receive-limits', 'empty-unary', 'slow-stream-order-and-buffering', 'cancel-and-deadline', 'channel-close',
  'one-terminal-event', 'no-retained-transport-bytes-or-timers', 'zero-active-calls-after-each-wave', 'upstream-source-cancel-before-disposal', 'no-adapter-retry',
  'same-isolate-uncollected-heap-trend', 'coordinated-idle-checkpoints', 'actual-execution-owners-released', 'separate-isolate-retention-positive-control'];
function need(value, message) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: workers resilience ${message}`); }
const equal = (actual, expected, message) => need(isDeepStrictEqual(actual, expected), message);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instance = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function summarizeHeap(samples) {
  need(Array.isArray(samples) && samples.length >= 2, 'heap sample count');
  return { samples: samples.length, metrics: Object.fromEntries(metrics.map(key => {
    const values = samples.map(sample => sample[key]); need(values.every(finite), 'heap sample values');
    const center = (values.length - 1) / 2, mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const divisor = values.reduce((sum, _, index) => sum + (index - center) ** 2, 0);
    const slope = values.reduce((sum, value, index) => sum + (index - center) * (value - mean), 0) / divisor;
    return [key, { baseline: values[0], final: values.at(-1), min: Math.min(...values), max: Math.max(...values),
      maxDelta: Math.max(...values) - values[0], finalDelta: values.at(-1) - values[0], slopeBytesPerCheckpoint: slope }];
  })) };
}
function evaluateEnvelope(samples, warmSamples) {
  const all = summarizeHeap(samples).metrics, warm = summarizeHeap(warmSamples).metrics;
  return [
    ['heap-absolute', all.usedSize.max > budgets.maxSampledHeapUsedBytes],
    ['backing-absolute', all.backingStorageSize.max > budgets.maxSampledBackingStorageBytes],
    ['heap-growth', all.usedSize.maxDelta > budgets.maxHeapGrowthBytes],
    ['backing-growth', all.backingStorageSize.maxDelta > budgets.maxBackingGrowthBytes],
    ['warm-heap-growth', warm.usedSize.maxDelta > budgets.maxWarmHeapGrowthBytes],
    ['warm-backing-growth', warm.backingStorageSize.maxDelta > budgets.maxWarmBackingGrowthBytes],
    ['warm-heap-slope', warm.usedSize.slopeBytesPerCheckpoint > budgets.maxWarmHeapSlopeBytesPerCheckpoint],
    ['warm-backing-slope', warm.backingStorageSize.slopeBytesPerCheckpoint > budgets.maxWarmBackingSlopeBytesPerCheckpoint],
  ].filter(([, exceeded]) => exceeded).map(([name]) => name);
}
function usage(sample) {
  need(sample && metrics.every(key => finite(sample[key])) && sample.usedSize > 0 && sample.totalSize >= sample.usedSize,
    'actual CDP heap usage');
}
function resources(value) {
  need(value && ['activeCalls', 'queuedCalls', 'bufferedBytes'].every(key => value[key] === 0)
    && ['peakActiveCalls', 'peakQueuedCalls', 'peakBufferedBytes'].every(key => integer(value[key])), 'idle resource ownership');
}
function checkpoint(value, invocation, label, mode) {
  need(value?.invocation === invocation && value.label === label && value.mode === mode, 'checkpoint identity');
  const wave = label.startsWith('wave-'), calls = wave ? 13 : 0;
  need(value.completedCalls === (wave ? (Number(label.at(-1)) + 1) * 13 : label === 'closed' ? 52 : 0)
    && value.observedCalls === calls && value.terminalCalls === calls, 'checkpoint actual call ownership');
  need(value.requestBytes === 0 && value.responseBytes === 0 && value.activeTimers === 0
    && value.clientsClosed === (label === 'closed'), 'checkpoint released calls/close');
  equal(value.ownership, executionZero, 'checkpoint actual execution owners'); resources(value.resources);
  equal(value.channelActiveCalls, Array(wave ? 2 : 1).fill(0), 'checkpoint actual channels');
}
function validateWorkersResilienceReport(report) {
  need(report?.status === 'passed' && report.runtimeExecuted === true && report.sourceBuild === false
    && report.runtimeDisposed === true, 'installed workerd execution/lifetime');
  need(report.cloudflareTranslation === false && report.liveGoogle === false && report.productionLoad === false, 'local scope');
  need(report.compatibilityDate === '2026-09-21' && hash(report.bundleSha256), 'build provenance');
  need(report.versions && ['node', 'platform', 'arch', 'miniflare', 'workerd', 'esbuild'].every(key =>
    typeof report.versions[key] === 'string' && report.versions[key]), 'runtime versions');
  need(report.versions.miniflare === report.miniflare && report.versions.workerd === report.workerd, 'runtime identity');
  equal(report.budgets, budgets, 'canonical smoke envelopes'); equal(report.checks, checks, 'required checks');
  need(sources.every(file => hash(report.evidence?.[file])), 'source provenance');
  const prefix = 'fixtures/worker/node_modules/';
  need(report.installedInputs && Object.keys(report.installedInputs).every(file => file.startsWith(prefix)
    && !file.split(/[\\/]/).includes('..') && hash(report.installedInputs[file])), 'installed input provenance');
  for (const file of ['dist/index.js', 'dist/adapter.js', 'package.json']) need(hash(report.installedInputs[`${prefix}@grpc/grpc-js/${file}`]), 'installed adapter identity');
  equal(report.boundaryFailures, [], 'peer failures');
  need(report.pendingResponseSourcesBeforeDispose === 0 && report.controlRequests === 24 && report.totalCalls === 208
    && report.rpcFetches === 192, 'aggregate call/data/control accounting');
  need(Array.isArray(report.requests) && report.requests.length === 192, 'peer receipts');
  need(Array.isArray(report.invocations) && report.invocations.length === 2, 'same-isolate cold/warm invocation count');
  const memory = report.memory;
  need(memory?.source === 'CDP.Runtime.getHeapUsage' && memory.inspectorTarget === 'core:user:resilience'
    && memory.scope === 'same-isolate-whole-worker' && memory.garbageCollectionForced === false && memory.uncollectedHeap === true
    && memory.isolateTotalMemoryMeasured === false && memory.leakFreedomEstablished === false, 'heap measurement semantics');
  need(instance(memory.workerInstanceId), 'observed Worker instance identity');
  equal(memory.warmup, { invocation: 'cold', completedWaves: 4, baseline: 'warm:start' }, 'explicit warmup baseline');
  need(Array.isArray(memory.checkpoints) && memory.checkpoints.length === 12, 'heap checkpoint coverage');
  for (const [invocationIndex, invocation] of ['cold', 'warm'].entries()) {
    const result = report.invocations[invocationIndex];
    need(result?.invocation === invocation && result.status === 'passed' && result.pendingResponseSources === 0, 'invocation outcome');
    need(result.workerInstanceId === memory.workerInstanceId && result.invocationCount === invocationIndex + 1, 'same-isolate invocation continuity');
    equal(result.cases.map(row => row.mode), modes, 'two-mode same-isolate matrix');
    for (const [labelIndex, label] of labels.entries()) {
      const sample = memory.checkpoints[invocationIndex * 6 + labelIndex];
      need(sample?.invocation === invocation && sample.label === label && sample.sequence === invocationIndex * 6 + labelIndex
        && sample.pendingResponseSources === 0, 'coordinated heap checkpoint order'); usage(sample);
      equal(sample.modes.map(row => row.mode), modes, 'both modes idle before sample');
      for (const [modeIndex, mode] of modes.entries()) {
        need(sample.modes[modeIndex].workerInstanceId === memory.workerInstanceId, 'same-isolate checkpoint continuity');
        checkpoint(sample.modes[modeIndex], invocation, label, mode);
        equal(result.cases[modeIndex].checkpoints?.[labelIndex], sample.modes[modeIndex], 'Worker/host checkpoint receipt join');
      }
    }
    for (const row of result.cases) {
      need(row.status === 'passed' && row.calls === 52 && row.results?.length === 4 && row.checkpoints?.length === 6, 'mode wave coverage');
      for (const [round, wave] of row.results.entries()) {
        need(wave.round === round && wave.activeCalls === 0, 'wave recovery');
        equal(wave.batch?.map(value => value.kind), Object.keys(codes).filter(kind => kind !== 'recovery'), 'exact fault matrix');
        need(wave.recovered?.kind === 'recovery', 'same-client recovery call');
        for (const call of [...wave.batch, wave.recovered]) {
          need(call.calls === 1 && call.code === codes[call.kind], 'actual terminal code/call count');
          equal(call.statuses, [call.kind === 'empty' ? 0 : codes[call.kind]], 'exactly one terminal status');
          equal(call.diagnostics, { terminal: true, fetchCount: call.kind === 'send-limit' ? 0 : 1,
            requestBytes: 0, responseBytes: 0, timerActive: false }, 'per-call transport cleanup');
          equal(call.execution, executionZero, 'per-call actual asynchronous owners');
          if (['slow', 'cancel', 'deadline', 'close'].includes(call.kind)) {
            need(call.received === (call.kind === 'slow' ? 128 : 1) && call.errors === (call.kind === 'slow' ? 0 : 1)
              && integer(call.ends) && call.ends <= 1 && (call.kind !== 'slow' || call.ends === 1), 'stream messages and terminal events');
            need(integer(call.peakReadableMessages) && integer(call.readableHighWaterMark) && call.readableHighWaterMark > 0
              && call.peakReadableMessages <= call.readableHighWaterMark && integer(call.peakTransportBytes) && call.peakTransportBytes <= 1024,
            'slow-consumer bounded queue');
            if (call.kind === 'slow') need(call.peakReadableMessages > 0 || call.peakTransportBytes > 0, 'slow consumer exercised');
          } else need(call.callbacks === 1, 'one unary callback');
        }
        const receipts = report.requests.filter(value => value.invocation === invocation && value.mode === row.mode && value.round === round);
        equal(receipts.map(value => value.kind).sort(), Object.keys(codes).filter(kind => kind !== 'send-limit').sort(), 'actual one-Fetch fault matrix');
        for (const receipt of receipts) {
          const held = ['cancel', 'deadline', 'close'].includes(receipt.kind);
          need(receipt.sourceCancelled === held && receipt.sourceClosed === !held, 'source cleanup before disposal');
        }
      }
    }
  }
  const warm = memory.checkpoints.filter(sample => sample.invocation === 'warm');
  equal(memory.fullSummary, summarizeHeap(memory.checkpoints), 'baseline-relative heap summary');
  equal(memory.warmSummary, summarizeHeap(warm), 'warm heap slope/summary');
  equal(memory.envelopeViolations, evaluateEnvelope(memory.checkpoints, warm), 'derived workload envelope');
  equal(memory.envelopeViolations, [], 'workload memory smoke envelope exceeded');
  const control = report.positiveControl;
  need(control?.status === 'passed' && control.purpose === 'measurement-and-budget-sensitivity' && control.separateIsolate === true
    && control.sameWorkload === false && control.source === 'CDP.Runtime.getHeapUsage' && control.garbageCollectionForced === false
    && control.inspectorTarget === 'core:user:resilience-retention' && control.runtimeDisposed === true
    && control.referencesReleasedBeforeDispose === true && control.outboundRequests === 0, 'separate-isolate positive control');
  need(instance(control.workerInstanceId) && control.workerInstanceId !== memory.workerInstanceId, 'distinct positive-control Worker instance');
  need(Array.isArray(control.samples) && control.samples.length === budgets.positiveControl.waves + 1, 'positive control samples');
  for (const [index, sample] of control.samples.entries()) {
    usage(sample); need(sample.label === (index ? `retained-${index}` : 'ready') && sample.status === 'passed'
      && sample.workerInstanceId === control.workerInstanceId && sample.buffers === index
      && sample.retainedBytes === index * budgets.positiveControl.bytesPerWave, 'actual retained control buffers');
    equal(sample.sentinels, Array.from({ length: index }, (_, count) => [count + 1, count + 1]), 'touched retained buffers');
  }
  equal(control.summary, summarizeHeap(control.samples), 'positive control measured growth summary');
  equal(control.violations, evaluateEnvelope(control.samples, control.samples), 'positive control envelope detection');
  need(control.violations.includes('backing-growth') && control.summary.metrics.backingStorageSize.finalDelta >=
    budgets.positiveControl.waves * budgets.positiveControl.bytesPerWave * budgets.positiveControl.minObservedGrowthRatio,
  'retention sensitivity not established');
  usage(control.released); need(control.released.status === 'passed' && control.released.buffers === 0
    && control.released.workerInstanceId === control.workerInstanceId && control.released.retainedBytes === 0,
  'positive control released application references');
  equal(control.released.sentinels, [], 'positive control reference release');
  return report;
}
module.exports = { validateWorkersResilienceReport, summarizeHeap, evaluateEnvelope, sources, checks };
