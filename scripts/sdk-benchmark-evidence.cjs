'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const budgets = require('../fixtures/google/benchmark-budgets.json');
const profiles = { 'google-static-v1': 'google', 'google-modern-v1': 'modern' };
const graphNames = ['datastore', 'firestore', 'secret-manager', 'combined'];
const digest = value => createHash('sha256').update(value).digest('hex');
function need(value, message) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: sdk benchmark ${message}`); }
function finite(value, minimum = 0) { return typeof value === 'number' && Number.isFinite(value) && value >= minimum; }
function hashes(value, prefix) {
  return value && Object.keys(value).length > 0 && Object.entries(value).every(([file, hash]) =>
    file.startsWith(prefix) && !file.split(/[\\/]/).includes('..') && /^[a-f0-9]{64}$/.test(hash));
}
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.length, min: sorted[0], p50: sorted[Math.ceil(sorted.length * .5) - 1],
    p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1) };
}
function equal(actual, expected, message) {
  try { assert.deepEqual(actual, expected); } catch { need(false, message); }
}
function idle(resources) {
  return resources && resources.activeCalls === 0 && resources.queuedCalls === 0 && resources.bufferedBytes === 0
    && ['peakActiveCalls', 'peakQueuedCalls', 'peakBufferedBytes'].every(key => Number.isSafeInteger(resources[key]) && resources[key] >= 0);
}
// This evaluates an explicit local benchmark policy. It cannot certify deployed
// latency, choose acceptable thresholds, or replace the other release gates.
function evaluateSdkPerformance(graphs, thresholds) {
  const groups = {
    sdkImport: ['sdkImport'], clientConstruction: ['unauthenticatedConstruction', 'authenticatedConstruction'],
    sdkInitialization: ['unauthenticatedInitialization', 'authenticatedInitialization'],
    firstRpc: ['firstUnauthenticatedRpc', 'firstAuthenticatedRpc'],
    firstMessage: ['firstUnauthenticatedRpc', 'firstAuthenticatedRpc', 'warmRpc', 'compressedRpc', 'oauthRefreshRpc', 'concurrent'],
    warmRpc: ['warmRpc'],
  };
  const keys = Object.keys(groups).flatMap(group => [`${group}P50Ms`, `${group}P95Ms`]);
  need(thresholds && typeof thresholds === 'object' && !Array.isArray(thresholds), 'performance thresholds must be an object');
  equal(Object.keys(thresholds).sort(), [...keys].sort(), 'performance threshold keys must be explicit');
  need(keys.every(key => thresholds[key] === null || finite(thresholds[key], Number.MIN_VALUE)), 'invalid performance threshold');
  for (const group of Object.keys(groups)) {
    const p50 = thresholds[`${group}P50Ms`], p95 = thresholds[`${group}P95Ms`];
    need(p50 === null || p95 === null || p50 <= p95, 'performance p50 threshold exceeds p95 threshold');
  }
  need(Array.isArray(graphs) && graphs.length === 8, 'performance policy requires all SDK graphs');
  equal(graphs.map(graph => `${graph.profile}/${graph.name}`), Object.keys(profiles).flatMap(profile =>
    graphNames.map(name => `${profile}/${name}`)), 'performance graph identity');
  const unsetThresholds = keys.filter(key => thresholds[key] === null), violations = [];
  let evaluatedComparisons = 0;
  for (const graph of graphs) for (const [group, measurements] of Object.entries(groups)) {
    const summaries = group === 'firstMessage' ? graph.firstMessageTimingsMs : graph.timingsMs;
    for (const measurement of measurements) {
      const summary = summaries?.[measurement];
      need(summary && Number.isSafeInteger(summary.samples) && summary.samples > 0
        && finite(summary.p50, Number.MIN_VALUE) && finite(summary.p95, summary.p50), 'performance policy measurement missing');
      for (const percentile of ['p50', 'p95']) {
        const key = `${group}${percentile.toUpperCase()}Ms`, ceiling = thresholds[key];
        if (ceiling === null) continue;
        evaluatedComparisons++;
        if (summary[percentile] > ceiling) violations.push({ profile: graph.profile, graph: graph.name,
          measurement: `${group === 'firstMessage' ? 'firstMessageTimingsMs' : 'timingsMs'}.${measurement}.${percentile}`,
          valueMs: summary[percentile], threshold: key, maximumMs: ceiling });
      }
    }
  }
  return { status: unsetThresholds.length ? 'blocked' : violations.length ? 'failed' : 'passed',
    reason: unsetThresholds.length ? 'release-performance-thresholds-unset' : violations.length ? 'configured-threshold-exceeded' : 'configured-thresholds-satisfied',
    scope: 'local-controlled-workerd', thresholds: { ...thresholds }, unsetThresholds, evaluatedComparisons, violations };
}
function validateSdkBenchmarkReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false && report.realGoogleSDK === true && report.runtimeExecuted === true,
    'requires installed SDK workerd execution');
  need(report.liveGoogle === false && report.liveCloud === false && report.incomingCloudflareTranslation === false
    && report.controlledPeer === true && report.unexpectedRequests === 0, 'scope or unexpected network');
  need(report.timingSource === 'host-monotonic-wall-clock' && report.heapSource === 'CDP.Runtime.getHeapUsage'
    && report.isolateTotalMemoryMeasured === false, 'measurement scope');
  need(report.phaseTimingIncludesOrchestration === true && report.firstMessageProbeOverheadIncluded === true
    && report.firstMessageTimingSource === 'host-monotonic-since-phase-dispatch-observer-probe-arrival'
    && report.observerTimingSource === 'workerd-performance.now', 'separate phase/observer/probe timing sources');
  equal(report.budgets, budgets, 'budgets changed or missing');
  const required = ['scripts/benchmark-sdk.cjs', 'scripts/sdk-benchmark-evidence.cjs', 'fixtures/google/benchmark-runtime.mjs',
    'fixtures/google/benchmark-bootstrap.mjs',
    'fixtures/google/benchmark-budgets.json', 'fixtures/google/package.json', 'fixtures/google/package-lock.json',
    'fixtures/modern/package.json', 'fixtures/modern/package-lock.json', 'fixtures/worker/package-lock.json',
    ...graphNames.map(name => `fixtures/google/benchmark-${name}.mjs`)];
  need(hashes(report.evidence, '') && required.every(file => Object.hasOwn(report.evidence, file)), 'source and lock evidence');
  need(report.versions && ['node', 'miniflare', 'workerd', 'wrangler', 'esbuild', 'platform', 'arch'].every(key =>
    typeof report.versions[key] === 'string' && report.versions[key]), 'runtime versions');
  need(Array.isArray(report.graphs) && report.graphs.length === 8, 'four entry graphs per supported profile required');
  equal(report.graphs.map(value => `${value.profile}/${value.name}`), Object.keys(profiles).flatMap(profile =>
    graphNames.map(name => `${profile}/${name}`)), 'profile/graph identity');
  for (const graph of report.graphs) {
    const fixture = profiles[graph.profile], limits = budgets.profiles[graph.profile];
    need(graph.fixture === fixture && limits.fixture === fixture, 'profile fixture mismatch');
    const sdkDependencies = Object.entries(require(`../fixtures/${fixture}/package.json`).dependencies)
      .filter(([name]) => name.startsWith('@google-cloud/'));
    const sdkNames = graph.name === 'combined' ? graphNames.slice(0, 3) : [graph.name];
    equal(graph.sdkNames, sdkNames, 'SDK membership');
    need(Array.isArray(graph.sdkVersions), 'SDK versions missing');
    equal(graph.sdkVersions.map(({ name, version }) => [name, version]).sort(), [...sdkDependencies].sort(), 'SDK versions differ from pinned fixture');
    const canonical = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/build/profiles', `${graph.profile}.json`), 'utf8'));
    const profileSha256 = digest(JSON.stringify(canonical));
    const inputSha256 = digest(JSON.stringify({ packages: canonical.packages.map(pkg => [pkg.path, pkg.packageJsonSha256]),
      sources: [...canonical.files, ...canonical.schemas, ...canonical.codegenInputs].map(file => [file.path, file.sha256]) }));
    const transformer = { version: canonical.transformerVersion,
      sha256: digest(fs.readFileSync(path.join(__dirname, '..', 'src/build/index.cjs'))), typescriptVersion: require('typescript').version };
    need(graph.profileRevision === canonical.revision && graph.profileSha256 === profileSha256, 'canonical profile identity mismatch');
    need(graph.profileInputSha256 === inputSha256, 'canonical profile input hash mismatch');
    equal(graph.transformer, transformer, 'canonical transformer identity mismatch');
    need(graph.profileCacheKey === digest(JSON.stringify({ profileSha256, transformer, inputSha256 })), 'canonical profile cache key mismatch');
    const prefix = `fixtures/${fixture}/node_modules/`, adapter = prefix + '@grpc/grpc-js/';
    need(hashes(graph.installedInputs, prefix) && Object.hasOwn(graph.installedInputs, adapter + 'dist/index.js')
      && Object.hasOwn(graph.installedInputs, adapter + 'dist/build/index.cjs')
      && Object.hasOwn(graph.installedInputs, adapter + `dist/build/profiles/${graph.profile}.json`), 'installed adapter/transformer/profile hashes');
    for (const sdk of sdkNames) need(Object.keys(graph.installedInputs).some(file =>
      file.startsWith(prefix + '@google-cloud/' + sdk + '/') && !file.endsWith('/package.json')), 'missing raw SDK bundle input');
    equal(graph.sourceCopies, Object.fromEntries([graph.name, 'runtime', 'bootstrap'].map(name => {
      const file = `fixtures/google/benchmark-${name}.mjs`; return [file, report.evidence[file]];
    })), 'fixture entry/runtime copies differ from canonical benchmark source');
    const ceiling = limits.bundleCeilings[graph.name];
    need(/^[a-f0-9]{64}$/.test(graph.bundleSha256) && finite(graph.bundleBytes, 1) && graph.bundleBytes <= ceiling.bytes
      && finite(graph.gzipBytes, 1) && graph.gzipBytes <= ceiling.gzipBytes && graph.gzipBytes < graph.bundleBytes, 'bundle budget');
    need(Array.isArray(graph.runs) && graph.runs.length === budgets.coldSamples, 'fresh isolate sample count');
    for (const [index, run] of graph.runs.entries()) {
      need(run.status === 'passed' && run.sample === index && run.runtimeDisposed === true && run.cleanupVerifiedBeforeDispose === true,
        'runtime lifetime');
      need(run.inspectorTarget === 'core:user:sdk-benchmark' && finite(run.startupAndReadyMs, .000001)
        && run.startupAndReadyMs <= limits.maxStartupMs, 'startup or wrong inspector target');
      const phases = ['unauthenticated', 'authenticated', ...Array(budgets.warmSamples).fill('warm'), 'compressed', 'refresh', 'concurrent'];
      equal(run.phases.map(value => value.name), phases, 'phase coverage/order');
      const order = ['ready', 'import', 'construct-unauthenticated', 'initialize-unauthenticated', 'unauthenticated',
        'close-unauthenticated', 'construct-authenticated', 'initialize-authenticated', 'authenticated',
        ...Array(budgets.warmSamples).fill('warm'), 'compressed', 'refresh', 'concurrent', 'close'];
      equal(run.phaseOrder, order, 'bootstrap/import/construction/initialization/RPC order');
      need(run.bootstrap?.status === 'passed' && run.bootstrap.graphLoaded === false && run.bootstrap.imports === 0
        && run.bootstrap.index === 0 && finite(run.bootstrap.elapsedMs, .000001)
        && run.bootstrap.rpcCount === 0 && run.bootstrap.oauthRefreshes === 0 && run.bootstrap.controlProbeCount === 0,
      'bootstrap must not import SDK graph or send requests');
      equal(run.bootstrap.sdks, sdkNames, 'bootstrap SDK identity');
      const setup = ['import', 'construct-unauthenticated', 'initialize-unauthenticated', 'close-unauthenticated',
        'construct-authenticated', 'initialize-authenticated'];
      equal(run.setupPhases?.map(item => item.name), setup, 'separate setup measurements');
      for (const item of run.setupPhases) {
        need(item.status === 'passed' && item.index === order.indexOf(item.name)
          && finite(item.elapsedMs, .000001) && item.elapsedMs <= limits.maxScenarioMs
          && item.rpcCount === 0 && item.oauthRefreshes === 0 && item.controlProbeCount === 0, 'setup phase timing/network isolation');
        equal(item.sdks, sdkNames, 'setup SDK membership');
        if (item.name === 'import') {
          need(item.graphLoaded === true && item.imports === 1 && item.clientCount === 0 && item.initialized === false,
            'deferred graph evaluation without client construction');
          continue;
        }
        need(item.contextId === (item.name.endsWith('-unauthenticated') ? 'unauthenticated' : 'authenticated')
          && item.logicalCalls === 0 && item.authMetadataCalls === 0 && idle(item.resources), 'fresh setup context or unexpected RPC/auth');
        if (item.name === 'close-unauthenticated') need(item.clientsClosed === true, 'anonymous context closed before authenticated construction');
        else {
          need(item.clientCount === sdkNames.length && item.initialized === item.name.startsWith('initialize-'), 'client construction vs initialization');
          if (item.initialized) equal(item.initialization, sdkNames.map(sdk => ({ sdk, generatedClients: 1, initialized: true,
            path: sdk === 'datastore' ? 'fixture-internal-prepareGaxRequest_-gapic.initialize'
              : sdk === 'firestore' ? 'fixture-internal-initializeIfNeeded-clientPool-gapic.initialize' : 'public-initialize' })),
          'actual pinned GAPIC initialization path');
        }
      }
      const streams = sdkNames.includes('firestore');
      const observedIds = new Set();
      need(Array.isArray(run.firstMessageReceipts), 'host first-message receipts missing');
      for (const [phaseOffset, phase] of run.phases.entries()) {
        const concurrent = phase.name === 'concurrent';
        const count = concurrent ? budgets.concurrency * (streams ? 1 : sdkNames.length) : sdkNames.length;
        const maxMs = phase.name === 'warm' ? limits.maxWarmRpcMs
          : ['authenticated', 'unauthenticated'].includes(phase.name) ? limits.maxFirstRpcMs : limits.maxScenarioMs;
        need(phase.status === 'passed' && finite(phase.elapsedMs, .000001) && phase.elapsedMs <= maxMs, 'phase timing/budget');
        need(phase.index === (phaseOffset === 0 ? 4 : 7 + phaseOffset)
          && phase.contextId === (phase.name === 'unauthenticated' ? 'unauthenticated' : 'authenticated'), 'RPC phase index/fresh context');
        need(phase.rpcCount === count && phase.logicalCalls === count && phase.authMetadataCalls >= count, 'actual RPC counts');
        equal(phase.terminalCodes, Array(count).fill(0), 'terminal status');
        equal(phase.sdks, sdkNames, 'phase SDK identity');
        need(phase.messages === (concurrent && streams ? count * budgets.messages : count), 'decoded SDK messages');
        need(phase.concurrency === (concurrent ? budgets.concurrency : 1) && phase.slowConsumer === (concurrent && streams), 'concurrency/slow consumer');
        need(phase.oauthRefreshes === (['refresh', 'concurrent'].includes(phase.name) ? 1 : 0)
          && phase.accessTokenRefreshed === ['refresh', 'concurrent'].includes(phase.name), 'real OAuth2 refresh/cache');
        need(idle(phase.resources), 'post-phase resource recovery');
        if (concurrent && streams) need(phase.heldResources?.activeCalls === budgets.concurrency,
          'held streams not active');
        need(Array.isArray(phase.observerEvents) && phase.controlProbeCount === count && phase.firstMessageProbes === count,
          'first-message observer/probe counts');
        const ids = [...new Set(phase.observerEvents.map(event => event.logicalCallId))];
        need(ids.length === count, 'logical call IDs per phase');
        for (const id of ids) {
          need(typeof id === 'string' && /^wga-[1-9][0-9]*$/.test(id) && !observedIds.has(id), 'unique actual logical call ID');
          observedIds.add(id);
          const events = phase.observerEvents.filter(event => event.logicalCallId === id);
          equal(events.map(event => event.type), ['call-start', 'call-admitted', 'attempt-start', 'auth-end', 'fetch-start',
            'response-headers', 'first-message', 'attempt-end', 'call-end'], 'one ordered attempt and first-message per actual call');
          need(events.every((event, index) => finite(event.elapsedMs) && (!index || event.elapsedMs >= events[index - 1].elapsedMs)),
            'raw observer monotonic samples');
          need(events.slice(2, -1).every(event => event.attempt === 1), 'one attempt without retry');
          const first = events[6], end = events.at(-1), attemptEnd = events.at(-2);
          need(events[3].statusCode === 0 && attemptEnd.statusCode === 0 && attemptEnd.fetchStarted === true
            && end.statusCode === 0 && end.attemptCount === 1 && end.fetchCount === 1
            && end.responseMessages === (concurrent && streams ? budgets.messages : 1), 'observed completion/result counts');
          const probes = run.firstMessageReceipts.filter(receipt => receipt.event?.logicalCallId === id);
          need(probes.length === 1 && probes[0].phase === phase.name && probes[0].phaseIndex === phase.index
            && finite(probes[0].elapsedMs, .000001) && probes[0].elapsedMs <= phase.elapsedMs, 'independent host first-message receipt');
          equal(probes[0].event, first, 'host probe must carry the actual raw first-message event');
        }
        need(run.peerReceipts.filter(receipt => receipt.phaseIndex === phase.index && receipt.phase === phase.name).length === count,
          'peer per-dispatch RPC count');
      }
      const expectedCount = run.phases.reduce((sum, phase) => sum + phase.rpcCount, 0);
      need(run.peerReceipts.length === expectedCount, 'peer receipt count');
      need(run.firstMessageReceipts.length === expectedCount, 'unexpected first-message control probes');
      const expectedMethods = sdkNames.map(sdk => sdk === 'datastore' ? '/google.datastore.v1.Datastore/Lookup'
        : sdk === 'firestore' ? '/google.firestore.v1.Firestore/BatchGetDocuments' : '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret');
      for (const phase of ['unauthenticated', 'authenticated', 'warm', 'compressed', 'refresh', 'concurrent']) {
        const receipts = run.peerReceipts.filter(value => value.phase === phase);
        const methods = phase === 'concurrent' && streams ? ['/google.firestore.v1.Firestore/RunQuery'] : expectedMethods;
        equal([...new Set(receipts.map(value => value.method))].sort(), [...methods].sort(), 'actual SDK method coverage');
        const multiplier = phase === 'warm' ? budgets.warmSamples : phase === 'concurrent' ? budgets.concurrency : 1;
        need(receipts.length === methods.length * multiplier, 'per-phase peer count');
        for (const receipt of receipts) {
          need(receipt.authorization === (phase === 'unauthenticated' ? 'absent' : ['refresh', 'concurrent'].includes(phase) ? 'refreshed' : 'cached'),
            'verified authorization');
          need(receipt.compressed === ['compressed', 'concurrent'].includes(phase) && receipt.messages ===
            (receipt.method.endsWith('/RunQuery') ? budgets.messages : 1), 'compression/message receipt');
          need(Number.isSafeInteger(receipt.requestBytes) && receipt.requestBytes > 5 && Number.isSafeInteger(receipt.responseBytes)
            && receipt.responseBytes > 5 && receipt.bodyLocked === false && (receipt.ended || receipt.cancellations === 1), 'peer body cleanup');
        }
      }
      equal(run.oauthRefreshes, [{ phase: 'refresh', sequence: 1 }, { phase: 'concurrent', sequence: 2 }], 'OAuth2 exchange receipts');
      need(run.memoryCheckpoints === (streams ? 1 : 0), 'held heap checkpoint');
      equal(run.heapSamples.map(value => value.label), ['ready', 'imported', 'unauthenticated', 'authenticated', 'warm', 'compressed', 'refresh',
        ...(streams ? ['concurrent-held'] : []), 'concurrent-complete', 'closed'], 'heap sample phases');
      for (const sample of run.heapSamples) {
        need(['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'].every(key => finite(sample[key])), 'heap sample fields');
        need(sample.usedSize > 0 && sample.totalSize >= sample.usedSize && sample.usedSize <= limits.maxSampledHeapUsedBytes
          && sample.backingStorageSize <= limits.maxSampledBackingStorageBytes, 'sampled heap regression budget');
      }
      need(run.close?.clientsClosed === true && idle(run.close.resources), 'SDK close/resource recovery');
    }
    const times = name => graph.runs.flatMap(run => run.phases.filter(phase => phase.name === name).map(phase => phase.elapsedMs));
    const setupTimes = name => graph.runs.flatMap(run => run.setupPhases.filter(phase => phase.name === name).map(phase => phase.elapsedMs));
    equal(graph.timingsMs, { startupAndReady: summarize(graph.runs.map(run => run.startupAndReadyMs)),
      sdkImport: summarize(setupTimes('import')),
      unauthenticatedConstruction: summarize(setupTimes('construct-unauthenticated')),
      unauthenticatedInitialization: summarize(setupTimes('initialize-unauthenticated')),
      authenticatedConstruction: summarize(setupTimes('construct-authenticated')),
      authenticatedInitialization: summarize(setupTimes('initialize-authenticated')),
      firstUnauthenticatedRpc: summarize(times('unauthenticated')), firstAuthenticatedRpc: summarize(times('authenticated')),
      warmRpc: summarize(times('warm')), compressedRpc: summarize(times('compressed')), oauthRefreshRpc: summarize(times('refresh')),
      concurrent: summarize(times('concurrent')) }, 'summary does not match measured samples');
    equal(graph.firstMessageTimingsMs, Object.fromEntries(Object.entries({ firstUnauthenticatedRpc: 'unauthenticated',
      firstAuthenticatedRpc: 'authenticated', warmRpc: 'warm', compressedRpc: 'compressed', oauthRefreshRpc: 'refresh', concurrent: 'concurrent' })
      .map(([key, phase]) => [key, summarize(graph.runs.flatMap(run => run.firstMessageReceipts
        .filter(receipt => receipt.phase === phase).map(receipt => receipt.elapsedMs)))])), 'first-message summaries must use raw host probes');
    equal(graph.sampledPeakHeap, Object.fromEntries(['usedSize', 'totalSize', 'embedderHeapUsedSize', 'backingStorageSize'].map(key =>
      [key, Math.max(...graph.runs.flatMap(run => run.heapSamples.map(sample => sample[key])))])), 'heap peaks not derived from samples');
  }
  equal(report.performanceCertification, evaluateSdkPerformance(report.graphs, budgets.releaseThresholds),
    'performance certification must match explicit policy and measured summaries');
  need(report.performanceCertification.status !== 'failed', 'configured performance threshold exceeded');
}
module.exports = { validateSdkBenchmarkReport, summarize, evaluateSdkPerformance };
