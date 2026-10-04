'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkersResilienceReport, summarizeHeap, evaluateEnvelope, sources, checks } = require('../scripts/workers-resilience-evidence.cjs');
const budgets = require('../fixtures/worker/resilience-budgets.json');
const hash = 'a'.repeat(64), modes = ['cloudflare', 'grpc-web'];
const workerInstanceId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', controlInstanceId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const execution = () => ({ activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
  parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 });
const resources = () => ({ activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: 12, peakQueuedCalls: 0, peakBufferedBytes: 16384 });
const heap = backingStorageSize => ({ usedSize: 4000000, totalSize: 8000000, embedderHeapUsedSize: 0, backingStorageSize });
// Synthetic validator input only; this fixture never substitutes for workerd
// execution or the independently sampled positive control in accepted evidence.
function fixture() {
  const report = { status: 'passed', runtimeExecuted: true, sourceBuild: false, runtimeDisposed: true,
    cloudflareTranslation: false, liveGoogle: false, productionLoad: false, compatibilityDate: '2026-09-21', bundleSha256: hash,
    miniflare: 'fixture', workerd: 'fixture', versions: { node: 'v22.0.0', platform: 'linux', arch: 'x64', miniflare: 'fixture', workerd: 'fixture', esbuild: 'fixture' },
    budgets: structuredClone(budgets), checks: [...checks], evidence: Object.fromEntries(sources.map(file => [file, hash])),
    installedInputs: Object.fromEntries(['dist/index.js', 'dist/adapter.js', 'package.json'].map(file => [`fixtures/worker/node_modules/@grpc/grpc-js/${file}`, hash])),
    boundaryFailures: [], pendingResponseSourcesBeforeDispose: 0, controlRequests: 24, totalCalls: 208, rpcFetches: 192,
    requests: [], invocations: [], memory: { source: 'CDP.Runtime.getHeapUsage', inspectorTarget: 'core:user:resilience',
      scope: 'same-isolate-whole-worker', workerInstanceId, garbageCollectionForced: false, uncollectedHeap: true,
      isolateTotalMemoryMeasured: false, leakFreedomEstablished: false,
      warmup: { invocation: 'cold', completedWaves: 4, baseline: 'warm:start' }, checkpoints: [] } };
  const codes = { success: 0, unavailable: 14, quota: 8, denied: 7, truncated: 13,
    'receive-limit': 8, 'send-limit': 8, empty: 12, slow: 0, cancel: 1, deadline: 4, close: 14, recovery: 0 };
  for (const invocation of ['cold', 'warm']) {
    const result = { invocation, workerInstanceId, invocationCount: invocation === 'cold' ? 1 : 2,
      status: 'passed', pendingResponseSources: 0, cases: [] }; report.invocations.push(result);
    for (const mode of modes) {
      const row = { mode, status: 'passed', calls: 52, results: [], checkpoints: [] }; result.cases.push(row);
      for (let round = 0; round < 4; round++) {
        const calls = Object.entries(codes).map(([kind, code]) => {
          const stream = ['slow', 'cancel', 'deadline', 'close'].includes(kind), held = stream && kind !== 'slow';
          if (kind !== 'send-limit') report.requests.push({ invocation, mode, round, kind, sourceClosed: !held, sourceCancelled: held });
          return { kind, code, calls: 1, statuses: [kind === 'empty' ? 0 : code],
            diagnostics: { terminal: true, fetchCount: kind === 'send-limit' ? 0 : 1, requestBytes: 0, responseBytes: 0, timerActive: false },
            execution: execution(), ...(stream ? { received: kind === 'slow' ? 128 : 1, errors: held ? 1 : 0, ends: 1,
              peakReadableMessages: 1, readableHighWaterMark: 16, peakTransportBytes: 1024 } : { callbacks: 1 }) };
        });
        row.results.push({ round, batch: calls.slice(0, -1), recovered: calls.at(-1), activeCalls: 0 });
      }
    }
    for (const label of ['start', 'wave-0', 'wave-1', 'wave-2', 'wave-3', 'closed']) {
      const wave = label.startsWith('wave-');
      const sample = { invocation, label, sequence: report.memory.checkpoints.length, pendingResponseSources: 0,
        ...heap(1000000 + report.memory.checkpoints.length * 1000), modes: [] };
      for (const [index, mode] of modes.entries()) {
        const observed = { invocation, label, mode, workerInstanceId, completedCalls: wave ? (Number(label.at(-1)) + 1) * 13 : label === 'closed' ? 52 : 0,
          observedCalls: wave ? 13 : 0, terminalCalls: wave ? 13 : 0, requestBytes: 0, responseBytes: 0, activeTimers: 0,
          clientsClosed: label === 'closed', ownership: execution(), resources: resources(), channelActiveCalls: Array(wave ? 2 : 1).fill(0) };
        sample.modes.push(observed); result.cases[index].checkpoints.push(structuredClone(observed));
      }
      report.memory.checkpoints.push(sample);
    }
  }
  const warm = report.memory.checkpoints.filter(sample => sample.invocation === 'warm');
  report.memory.fullSummary = summarizeHeap(report.memory.checkpoints); report.memory.warmSummary = summarizeHeap(warm);
  report.memory.envelopeViolations = evaluateEnvelope(report.memory.checkpoints, warm);
  const samples = Array.from({ length: 5 }, (_, index) => ({ label: index ? `retained-${index}` : 'ready', status: 'passed',
    workerInstanceId: controlInstanceId, buffers: index, retainedBytes: index * 4194304, sentinels: Array.from({ length: index }, (_, count) => [count + 1, count + 1]),
    ...heap(1000000 + index * 4194304) }));
  report.positiveControl = { status: 'passed', purpose: 'measurement-and-budget-sensitivity', separateIsolate: true, sameWorkload: false,
    source: 'CDP.Runtime.getHeapUsage', garbageCollectionForced: false, inspectorTarget: 'core:user:resilience-retention',
    workerInstanceId: controlInstanceId, runtimeDisposed: true, referencesReleasedBeforeDispose: true, outboundRequests: 0, samples,
    summary: summarizeHeap(samples), violations: evaluateEnvelope(samples, samples),
    released: { status: 'passed', workerInstanceId: controlInstanceId, buffers: 0, retainedBytes: 0, sentinels: [], ...heap(17777216) } };
  return report;
}
function rejectMutations(mutations) {
  for (const [index, mutate] of mutations.entries()) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateWorkersResilienceReport(report), /WGA_EVIDENCE_INVALID/, `mutation ${index}`);
  }
}
test('EVIDENCE resilience preserves exact workload, source identity, owner cleanup and peer accounting', () => {
  validateWorkersResilienceReport(fixture());
  rejectMutations([
    report => { report.sourceBuild = true; }, report => { report.runtimeExecuted = false; }, report => { report.runtimeDisposed = false; },
    report => { report.productionLoad = true; }, report => { report.cloudflareTranslation = true; }, report => { report.liveGoogle = true; },
    report => { delete report.evidence['fixtures/worker/resilience-budgets.json']; }, report => { report.installedInputs = {}; },
    report => { report.installedInputs['fixtures/google/node_modules/@grpc/grpc-js/dist/index.js'] = hash; },
    report => { report.versions.workerd = 'other'; }, report => { report.checks.pop(); }, report => { report.boundaryFailures.push('unobserved request'); },
    report => { report.rpcFetches--; }, report => { report.totalCalls--; }, report => { report.controlRequests--; },
    report => { report.pendingResponseSourcesBeforeDispose = 1; }, report => { report.requests.pop(); },
    report => { report.requests[0].kind = 'send-limit'; }, report => { report.requests.find(row => row.kind === 'cancel').sourceCancelled = false; },
    report => { report.invocations.reverse(); }, report => { report.invocations[0].cases.pop(); },
    report => { report.invocations[0].cases[0].results[0].activeCalls = 1; },
    report => { report.invocations[0].cases[0].results[0].batch[0].code = 14; },
    report => { report.invocations[0].cases[0].results[0].batch[0].statuses.push(0); },
    report => { report.invocations[0].cases[0].results[0].batch[0].callbacks = 2; },
    report => { report.invocations[0].cases[0].results[0].batch[0].diagnostics.timerActive = true; },
    report => { report.invocations[0].cases[0].results[0].batch[0].execution.activePumps = 1; },
    report => { report.invocations[0].cases[0].results[0].batch.find(call => call.kind === 'slow').received--; },
    report => { report.invocations[0].cases[0].results[0].batch.find(call => call.kind === 'slow').peakTransportBytes = 1025; },
    report => { report.invocations[0].cases[0].results[0].batch.find(call => call.kind === 'cancel').errors = 2; },
    report => { report.invocations[0].cases[0].results[0].recovered.kind = 'success'; },
  ]);
});
test('EVIDENCE resilience requires coordinated real Worker samples and recomputes trends and envelopes', () => {
  rejectMutations([
    report => { report.memory.source = 'Node.process.memoryUsage'; }, report => { report.memory.inspectorTarget = 'core:entry'; },
    report => { report.invocations[1].workerInstanceId = controlInstanceId; }, report => { report.invocations[1].invocationCount = 1; },
    report => { report.memory.checkpoints[1].modes[0].workerInstanceId = controlInstanceId; },
    report => { report.memory.scope = 'per-call'; }, report => { report.memory.garbageCollectionForced = true; },
    report => { report.memory.uncollectedHeap = false; }, report => { report.memory.isolateTotalMemoryMeasured = true; },
    report => { report.memory.leakFreedomEstablished = true; }, report => { report.memory.warmup.completedWaves--; },
    report => { report.memory.checkpoints.pop(); }, report => { report.memory.checkpoints[0].modes.pop(); },
    report => { report.memory.checkpoints[1].pendingResponseSources = 1; },
    report => { report.memory.checkpoints[1].modes[0].ownership.parserAssemblyBytes = 1; },
    report => { report.memory.checkpoints[1].modes[0].resources.bufferedBytes = 1; },
    report => { report.memory.checkpoints[1].modes[0].observedCalls = 0; },
    report => { report.memory.checkpoints[0].usedSize = NaN; }, report => { report.memory.checkpoints[0].totalSize = 1; },
    report => { report.memory.fullSummary.metrics.usedSize.max++; },
    report => { report.memory.warmSummary.metrics.backingStorageSize.slopeBytesPerCheckpoint++; },
    report => { report.budgets.maxBackingGrowthBytes *= 2; },
    report => {
      report.memory.checkpoints.at(-1).backingStorageSize += budgets.maxBackingGrowthBytes;
      report.memory.fullSummary = summarizeHeap(report.memory.checkpoints);
      const warm = report.memory.checkpoints.filter(sample => sample.invocation === 'warm');
      report.memory.warmSummary = summarizeHeap(warm);
      report.memory.envelopeViolations = evaluateEnvelope(report.memory.checkpoints, warm);
    },
  ]);
});
test('EVIDENCE resilience requires measured retention sensitivity and separate-isolate cleanup', () => {
  rejectMutations([
    report => { report.positiveControl.separateIsolate = false; }, report => { report.positiveControl.sameWorkload = true; },
    report => { report.positiveControl.inspectorTarget = report.memory.inspectorTarget; },
    report => { report.positiveControl.workerInstanceId = workerInstanceId; },
    report => { report.positiveControl.outboundRequests++; }, report => { report.positiveControl.runtimeDisposed = false; },
    report => { report.positiveControl.referencesReleasedBeforeDispose = false; },
    report => { report.positiveControl.samples[1].retainedBytes = 0; },
    report => { report.positiveControl.samples[1].sentinels[0][1] = 0; },
    report => { report.positiveControl.summary.metrics.backingStorageSize.finalDelta++; },
    report => { report.positiveControl.violations = []; }, report => { report.positiveControl.released.buffers = 4; },
    report => {
      for (const sample of report.positiveControl.samples) sample.backingStorageSize = 1000000;
      report.positiveControl.summary = summarizeHeap(report.positiveControl.samples);
      report.positiveControl.violations = evaluateEnvelope(report.positiveControl.samples, report.positiveControl.samples);
    },
  ]);
});
test('resilience heap summaries retain GC decreases and use all actual checkpoints for OLS slope', () => {
  const samples = [1000, 1400, 900].map(value => heap(value));
  assert.deepEqual(summarizeHeap(samples).metrics.backingStorageSize, {
    baseline: 1000, final: 900, min: 900, max: 1400, maxDelta: 400, finalDelta: -100, slopeBytesPerCheckpoint: -50,
  });
  assert.deepEqual(evaluateEnvelope(samples, samples), []);
});
