'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSdkBenchmarkReport, summarize, evaluateSdkPerformance } = require('../scripts/sdk-benchmark-evidence.cjs');
const budgets = require('../fixtures/google/benchmark-budgets.json');
const staticLimits = budgets.profiles['google-static-v1'];
const names = ['datastore', 'firestore', 'secret-manager', 'combined'];
const hash = 'a'.repeat(64);
const digest = value => createHash('sha256').update(value).digest('hex');
const resources = () => ({ activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: 4, peakQueuedCalls: 0, peakBufferedBytes: 100 });
function fixture() {
  const report = { status: 'passed', sourceBuild: false, realGoogleSDK: true, runtimeExecuted: true,
    liveGoogle: false, liveCloud: false, incomingCloudflareTranslation: false, controlledPeer: true, unexpectedRequests: 0,
    timingSource: 'host-monotonic-wall-clock', heapSource: 'CDP.Runtime.getHeapUsage', isolateTotalMemoryMeasured: false,
    phaseTimingIncludesOrchestration: true, firstMessageProbeOverheadIncluded: true,
    firstMessageTimingSource: 'host-monotonic-since-phase-dispatch-observer-probe-arrival', observerTimingSource: 'workerd-performance.now',
    performanceCertification: { status: 'blocked', reason: 'release-performance-thresholds-unset', scope: 'local-controlled-workerd',
      thresholds: structuredClone(budgets.releaseThresholds), unsetThresholds: Object.keys(budgets.releaseThresholds),
      evaluatedComparisons: 0, violations: [] },
    versions: { node: 'v22.0.0', platform: 'linux', arch: 'x64', miniflare: 'fixture', workerd: 'fixture', wrangler: 'fixture', esbuild: 'fixture' },
    budgets: structuredClone(budgets), graphs: [], evidence: Object.fromEntries([
      'scripts/benchmark-sdk.cjs', 'scripts/sdk-benchmark-evidence.cjs', 'fixtures/google/benchmark-runtime.mjs',
      'fixtures/google/benchmark-bootstrap.mjs',
      'fixtures/google/benchmark-budgets.json', 'fixtures/google/package.json', 'fixtures/google/package-lock.json',
      'fixtures/modern/package.json', 'fixtures/modern/package-lock.json', 'fixtures/worker/package-lock.json',
      ...names.map(name => `fixtures/google/benchmark-${name}.mjs`),
    ].map(file => [file, hash])) };
  for (const [profile, { fixture: fixtureName }] of Object.entries(budgets.profiles)) for (const name of names) {
    const canonical = require(`../src/build/profiles/${profile}.json`);
    const profileSha256 = digest(JSON.stringify(canonical));
    const profileInputSha256 = digest(JSON.stringify({ packages: canonical.packages.map(pkg => [pkg.path, pkg.packageJsonSha256]),
      sources: [...canonical.files, ...canonical.schemas, ...canonical.codegenInputs].map(file => [file.path, file.sha256]) }));
    const transformer = { version: canonical.transformerVersion,
      sha256: digest(fs.readFileSync(path.join(__dirname, '../src/build/index.cjs'))), typescriptVersion: require('typescript').version };
    const profileCacheKey = digest(JSON.stringify({ profileSha256, transformer, inputSha256: profileInputSha256 }));
    const sdkNames = name === 'combined' ? names.slice(0, 3) : [name], streams = sdkNames.includes('firestore');
    const methods = sdkNames.map(sdk => sdk === 'datastore' ? '/google.datastore.v1.Datastore/Lookup'
      : sdk === 'firestore' ? '/google.firestore.v1.Firestore/BatchGetDocuments' : '/google.cloud.secretmanager.v1.SecretManagerService/GetSecret');
    const prefix = `fixtures/${fixtureName}/node_modules/`;
    const graph = { name, sdkNames, fixture: fixtureName, bundleBytes: 2000, gzipBytes: 1000, bundleSha256: hash,
      profile, profileRevision: canonical.revision, profileSha256, profileInputSha256, profileCacheKey, transformer,
      sourceCopies: Object.fromEntries([name, 'runtime', 'bootstrap'].map(part => [`fixtures/google/benchmark-${part}.mjs`, hash])),
      sdkVersions: Object.entries(require(`../fixtures/${fixtureName}/package.json`).dependencies)
        .filter(([name]) => name.startsWith('@google-cloud/')).map(([name, version]) => ({ name, version })),
      installedInputs: Object.fromEntries(['@grpc/grpc-js/dist/index.js', '@grpc/grpc-js/dist/build/index.cjs',
        `@grpc/grpc-js/dist/build/profiles/${profile}.json`, ...sdkNames.map(sdk => `@google-cloud/${sdk}/build/src/index.js`)]
        .map(file => [prefix + file, hash])), runs: [] };
    report.graphs.push(graph);
    for (let sample = 0; sample < budgets.coldSamples; sample++) {
      const run = { sample, status: 'passed', runtimeDisposed: true, cleanupVerifiedBeforeDispose: true,
        inspectorTarget: 'core:user:sdk-benchmark', startupAndReadyMs: 100, phases: [], peerReceipts: [], firstMessageReceipts: [],
        oauthRefreshes: [{ phase: 'refresh', sequence: 1 }, { phase: 'concurrent', sequence: 2 }], memoryCheckpoints: streams ? 1 : 0,
        close: { clientsClosed: true, resources: resources() }, heapSamples: [] };
      graph.runs.push(run);
      run.phaseOrder = ['ready', 'import', 'construct-unauthenticated', 'initialize-unauthenticated', 'unauthenticated',
        'close-unauthenticated', 'construct-authenticated', 'initialize-authenticated', 'authenticated',
        ...Array(budgets.warmSamples).fill('warm'), 'compressed', 'refresh', 'concurrent', 'close'];
      run.bootstrap = { status: 'passed', sdks: sdkNames, graphLoaded: false, imports: 0,
        index: 0, elapsedMs: 10, rpcCount: 0, oauthRefreshes: 0, controlProbeCount: 0 };
      run.setupPhases = ['import', 'construct-unauthenticated', 'initialize-unauthenticated', 'close-unauthenticated',
        'construct-authenticated', 'initialize-authenticated'].map(phase => ({ name: phase, index: run.phaseOrder.indexOf(phase),
        status: 'passed', sdks: sdkNames, elapsedMs: 2, rpcCount: 0, oauthRefreshes: 0, controlProbeCount: 0,
        ...(phase === 'import' ? { graphLoaded: true, imports: 1, clientCount: 0, initialized: false }
          : { contextId: phase.endsWith('-unauthenticated') ? 'unauthenticated' : 'authenticated',
            logicalCalls: 0, authMetadataCalls: 0, resources: resources(),
            ...(phase === 'close-unauthenticated' ? { clientsClosed: true } : { clientCount: sdkNames.length,
              initialized: phase.startsWith('initialize-'),
              ...(phase.startsWith('initialize-') ? { initialization: sdkNames.map(sdk => ({ sdk, generatedClients: 1, initialized: true,
                path: sdk === 'datastore' ? 'fixture-internal-prepareGaxRequest_-gapic.initialize'
                  : sdk === 'firestore' ? 'fixture-internal-initializeIfNeeded-clientPool-gapic.initialize' : 'public-initialize' })) } : {}),
            }),
          }),
      }));
      let callId = 0;
      for (const phase of ['unauthenticated', 'authenticated', ...Array(budgets.warmSamples).fill('warm'), 'compressed', 'refresh', 'concurrent']) {
        const concurrent = phase === 'concurrent', refreshed = ['refresh', 'concurrent'].includes(phase);
        const count = concurrent ? budgets.concurrency * (streams ? 1 : sdkNames.length) : sdkNames.length;
        const phaseIndex = run.phases.length === 0 ? 4 : 7 + run.phases.length;
        const observerEvents = Array.from({ length: count }, () => {
          const logicalCallId = `wga-${++callId}`;
          return ['call-start', 'call-admitted', 'attempt-start', 'auth-end', 'fetch-start', 'response-headers', 'first-message',
            'attempt-end', 'call-end'].map((type, index) => ({ type, logicalCallId, elapsedMs: index / 10,
            ...(index >= 2 && index < 8 ? { attempt: 1 } : {}),
            ...(index === 3 || index >= 7 ? { statusCode: 0 } : {}),
            ...(index === 7 ? { fetchStarted: true } : {}),
            ...(index === 8 ? { attemptCount: 1, fetchCount: 1, responseMessages: concurrent && streams ? budgets.messages : 1 } : {}),
          }));
        }).flat();
        for (const event of observerEvents.filter(event => event.type === 'first-message')) run.firstMessageReceipts.push({
          phase, phaseIndex, elapsedMs: 5, event: structuredClone(event),
        });
        run.phases.push({ name: phase, index: phaseIndex, contextId: phase === 'unauthenticated' ? 'unauthenticated' : 'authenticated',
          observerEvents, controlProbeCount: count, firstMessageProbes: count,
          status: 'passed', sdks: sdkNames, elapsedMs: 10, rpcCount: count, logicalCalls: count,
          authMetadataCalls: count, terminalCodes: Array(count).fill(0), messages: concurrent && streams ? count * budgets.messages : count,
          concurrency: concurrent ? budgets.concurrency : 1, slowConsumer: concurrent && streams,
          oauthRefreshes: refreshed ? 1 : 0, accessTokenRefreshed: refreshed, resources: resources(),
          ...(concurrent && streams ? { heldResources: { ...resources(), activeCalls: 4 } } : {}) });
        const selected = concurrent && streams ? ['/google.firestore.v1.Firestore/RunQuery'] : methods;
        for (let index = 0; index < (concurrent ? budgets.concurrency : 1); index++) {
          for (const method of selected) run.peerReceipts.push({ phase, phaseIndex, method, requestBytes: 10, responseBytes: 50,
            messages: method.endsWith('/RunQuery') ? budgets.messages : 1, compressed: ['compressed', 'concurrent'].includes(phase),
            authorization: phase === 'unauthenticated' ? 'absent' : refreshed ? 'refreshed' : 'cached', bodyLocked: false, ended: true, cancellations: 0 });
        }
      }
      run.heapSamples = ['ready', 'imported', 'unauthenticated', 'authenticated', 'warm', 'compressed', 'refresh',
        ...(streams ? ['concurrent-held'] : []), 'concurrent-complete', 'closed'].map(label =>
        ({ label, usedSize: 1000000, totalSize: 2000000, embedderHeapUsedSize: 100000, backingStorageSize: 1000 }));
    }
    const times = phase => graph.runs.flatMap(run => run.phases.filter(item => item.name === phase).map(item => item.elapsedMs));
    const setupTimes = phase => graph.runs.flatMap(run => run.setupPhases.filter(item => item.name === phase).map(item => item.elapsedMs));
    graph.timingsMs = { startupAndReady: summarize(graph.runs.map(run => run.startupAndReadyMs)),
      sdkImport: summarize(setupTimes('import')),
      unauthenticatedConstruction: summarize(setupTimes('construct-unauthenticated')),
      unauthenticatedInitialization: summarize(setupTimes('initialize-unauthenticated')),
      authenticatedConstruction: summarize(setupTimes('construct-authenticated')),
      authenticatedInitialization: summarize(setupTimes('initialize-authenticated')),
      firstUnauthenticatedRpc: summarize(times('unauthenticated')), firstAuthenticatedRpc: summarize(times('authenticated')),
      warmRpc: summarize(times('warm')), compressedRpc: summarize(times('compressed')), oauthRefreshRpc: summarize(times('refresh')),
      concurrent: summarize(times('concurrent')) };
    graph.firstMessageTimingsMs = Object.fromEntries(Object.entries({ firstUnauthenticatedRpc: 'unauthenticated',
      firstAuthenticatedRpc: 'authenticated', warmRpc: 'warm', compressedRpc: 'compressed', oauthRefreshRpc: 'refresh', concurrent: 'concurrent' })
      .map(([key, phase]) => [key, summarize(graph.runs.flatMap(run => run.firstMessageReceipts
        .filter(receipt => receipt.phase === phase).map(receipt => receipt.elapsedMs)))]));
    graph.sampledPeakHeap = { usedSize: 1000000, totalSize: 2000000, embedderHeapUsedSize: 100000, backingStorageSize: 1000 };
  }
  return report;
}

test('EVIDENCE SDK workerd benchmark requires measured graphs, OAuth refresh, slow streams and heap samples', () => {
  validateSdkBenchmarkReport(fixture());
  for (const mutate of [
    report => { report.sourceBuild = true; }, report => { report.runtimeExecuted = false; },
    report => { report.realGoogleSDK = false; }, report => { report.liveCloud = true; },
    report => { report.liveGoogle = true; }, report => { report.incomingCloudflareTranslation = true; },
    report => { report.controlledPeer = false; }, report => { report.unexpectedRequests = 1; },
    report => { report.heapSource = 'Node.process.memoryUsage'; }, report => { report.isolateTotalMemoryMeasured = true; },
    report => { report.timingSource = 'worker-Date.now'; }, report => { report.budgets.profiles['google-static-v1'].maxWarmRpcMs *= 2; },
    report => { report.graphs.pop(); }, report => { report.graphs[0].sdkNames.push('firestore'); },
    report => { report.graphs[0].installedInputs = {}; }, report => { delete report.evidence['fixtures/google/benchmark-runtime.mjs']; },
    report => { report.versions.workerd = ''; }, report => { report.graphs[0].bundleSha256 = ''; },
    report => { report.graphs[0].sdkVersions[0].version = '0.0.0'; },
    report => { report.graphs[0].bundleBytes = staticLimits.bundleCeilings.datastore.bytes + 1; },
    report => { report.graphs[0].gzipBytes = staticLimits.bundleCeilings.datastore.gzipBytes + 1; },
    report => { report.graphs[4].fixture = 'google'; },
    report => { report.graphs[4].profile = 'google-static-v1'; },
    report => { report.graphs[4].installedInputs['fixtures/google/node_modules/@grpc/grpc-js/dist/index.js'] = hash; },
    report => { delete report.graphs[4].installedInputs['fixtures/modern/node_modules/@grpc/grpc-js/dist/build/index.cjs']; },
    report => { delete report.graphs[4].installedInputs['fixtures/modern/node_modules/@google-cloud/datastore/build/src/index.js']; },
    report => { report.graphs[4].sourceCopies['fixtures/google/benchmark-runtime.mjs'] = 'b'.repeat(64); },
    report => { report.graphs[4].profileCacheKey = ''; },
    report => { report.graphs[4].profileInputSha256 = ''; },
    report => { report.graphs[4].profileRevision++; },
    report => { report.graphs[4].profileSha256 = hash; },
    report => { report.graphs[4].profileInputSha256 = hash; },
    report => { report.graphs[4].profileCacheKey = hash; },
    report => { report.graphs[4].transformer.version++; },
    report => { report.graphs[4].transformer.sha256 = hash; },
    report => { report.graphs[4].transformer.typescriptVersion = '0.0.0'; },
    report => { delete report.graphs[4].transformer; },
    report => { // A self-consistent fake transformer/cache identity is still not canonical.
      const graph = report.graphs[4]; graph.transformer.sha256 = hash;
      graph.profileCacheKey = digest(JSON.stringify({ profileSha256: graph.profileSha256,
        transformer: graph.transformer, inputSha256: graph.profileInputSha256 }));
    },
    report => { report.graphs[4].sdkVersions = report.graphs[0].sdkVersions; },
    report => { report.graphs = report.graphs.slice(0, 4); },
    report => { report.graphs[0].runs.pop(); }, report => { report.graphs[0].runs[0].runtimeDisposed = false; },
    report => { report.graphs[0].runs[0].cleanupVerifiedBeforeDispose = false; },
    report => { report.graphs[0].runs[0].inspectorTarget = 'core:entry'; },
    report => { report.graphs[0].runs[0].startupAndReadyMs = NaN; },
    report => { report.graphs[0].runs[0].phases[0].elapsedMs = 0; },
    report => { report.graphs[0].runs[0].phases[0].rpcCount++; },
    report => { report.graphs[0].runs[0].phases[0].terminalCodes[0] = 14; },
    report => { report.graphs[0].runs[0].phases[0].authMetadataCalls = 0; },
    report => { report.graphs[0].runs[0].phases.at(-1).oauthRefreshes = 0; },
    report => { report.graphs[1].runs[0].phases.at(-1).slowConsumer = false; },
    report => { report.graphs[1].runs[0].phases.at(-1).messages--; },
    report => { report.graphs[1].runs[0].phases.at(-1).heldResources.activeCalls = 0; },
    report => { report.graphs[0].runs[0].phases[0].resources.bufferedBytes = 1; },
    report => { report.graphs[0].runs[0].peerReceipts.pop(); },
    report => { report.graphs[0].runs[0].peerReceipts[0].method = '/synthetic.Rpc/Call'; },
    report => { report.graphs[0].runs[0].peerReceipts[0].authorization = 'cached'; },
    report => { report.graphs[0].runs[0].peerReceipts.at(-1).compressed = false; },
    report => { report.graphs[0].runs[0].peerReceipts[0].bodyLocked = true; },
    report => { report.graphs[0].runs[0].peerReceipts[0].ended = false; },
    report => { report.graphs[0].runs[0].oauthRefreshes.pop(); },
    report => { report.graphs[1].runs[0].memoryCheckpoints = 0; },
    report => { report.graphs[0].runs[0].heapSamples.pop(); },
    report => { report.graphs[0].runs[0].heapSamples[0].usedSize = Infinity; },
    report => { report.graphs[0].runs[0].heapSamples[0].backingStorageSize = staticLimits.maxSampledBackingStorageBytes + 1; },
    report => { report.graphs[0].runs[0].close.clientsClosed = false; },
    report => { report.graphs[0].timingsMs.warmRpc.p95 = 9; },
    report => { report.graphs[0].sampledPeakHeap.usedSize = 9; },
  ]) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateSdkBenchmarkReport(report), /WGA_EVIDENCE_INVALID/);
  }
});

test('SDK benchmark summaries preserve host measurements and use nearest-rank percentiles', () => {
  assert.deepEqual(summarize([9, 1, 5, 2]), { samples: 4, min: 1, p50: 2, p95: 9, max: 9 });
});

test('EVIDENCE SDK import, construction and initialization require independent host brackets and fresh contexts', () => {
  for (const mutate of [
    report => { report.phaseTimingIncludesOrchestration = false; },
    report => { delete report.evidence['fixtures/google/benchmark-bootstrap.mjs']; },
    report => { delete report.graphs[0].sourceCopies['fixtures/google/benchmark-bootstrap.mjs']; },
    report => { report.graphs[0].runs[0].bootstrap.graphLoaded = true; },
    report => { report.graphs[0].runs[0].bootstrap.imports = 1; },
    report => { report.graphs[0].runs[0].bootstrap.rpcCount = 1; },
    report => { report.graphs[0].runs[0].setupPhases.shift(); },
    report => { report.graphs[0].runs[0].setupPhases[0].clientCount = 1; },
    report => { report.graphs[0].runs[0].setupPhases[1].initialized = true; },
    report => { report.graphs[0].runs[0].setupPhases[2].elapsedMs = 0; },
    report => { report.graphs[0].runs[0].setupPhases[2].rpcCount = 1; },
    report => { report.graphs[0].runs[0].setupPhases[2].oauthRefreshes = 1; },
    report => { report.graphs[0].runs[0].setupPhases[2].authMetadataCalls = 1; },
    report => { report.graphs[0].runs[0].setupPhases[2].initialization[0].path = 'public-initialize'; },
    report => { report.graphs[1].runs[0].setupPhases[2].initialization[0].path = 'initializeIfNeeded-only'; },
    report => { report.graphs[1].runs[0].setupPhases[2].initialization[0].generatedClients = 0; },
    report => { report.graphs[0].runs[0].setupPhases[3].clientsClosed = false; },
    report => { report.graphs[0].runs[0].setupPhases[4].contextId = 'unauthenticated'; },
    report => { report.graphs[0].runs[0].phases[1].contextId = 'unauthenticated'; },
    report => { report.graphs[0].runs[0].phaseOrder.splice(2, 2, 'initialize-unauthenticated', 'construct-unauthenticated'); },
    report => { report.graphs[0].timingsMs.sdkImport.p50++; },
    report => { report.graphs[0].timingsMs.authenticatedInitialization.samples = 0; },
  ]) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateSdkBenchmarkReport(report), /WGA_EVIDENCE_INVALID/);
  }
});

test('EVIDENCE SDK first-message probes join actual observer IDs and preserve distinct timing sources', () => {
  for (const mutate of [
    report => { report.firstMessageTimingSource = 'worker-Date.now'; },
    report => { report.observerTimingSource = 'host-monotonic-wall-clock'; },
    report => { report.firstMessageProbeOverheadIncluded = false; },
    report => { report.graphs[0].runs[0].firstMessageReceipts.pop(); },
    report => { report.graphs[0].runs[0].firstMessageReceipts.push(report.graphs[0].runs[0].firstMessageReceipts[0]); },
    report => { report.graphs[0].runs[0].firstMessageReceipts[0].event.logicalCallId = 'synthetic'; },
    report => { report.graphs[0].runs[0].firstMessageReceipts[0].event.elapsedMs++; },
    report => { report.graphs[0].runs[0].firstMessageReceipts[0].elapsedMs = 11; },
    report => { report.graphs[0].runs[0].firstMessageReceipts[0].elapsedMs = -1; },
    report => { report.graphs[0].runs[0].firstMessageReceipts[0].phaseIndex++; },
    report => { report.graphs[0].runs[0].firstMessageReceipts[0].phase = 'warm'; },
    report => { report.graphs[0].runs[0].phases[0].observerEvents.splice(6, 1); },
    report => { report.graphs[0].runs[0].phases[0].observerEvents[6].type = 'call-end'; },
    report => { report.graphs[0].runs[0].phases[0].observerEvents[6].attempt = 2; },
    report => { report.graphs[0].runs[0].phases[0].observerEvents[6].elapsedMs = -1; },
    report => { report.graphs[0].runs[0].phases[0].observerEvents.at(-1).fetchCount = 2; },
    report => { report.graphs[0].runs[0].phases[0].observerEvents.at(-1).statusCode = 4; },
    report => { report.graphs[0].runs[0].phases[0].controlProbeCount = 0; },
    report => { report.graphs[0].runs[0].phases[0].firstMessageProbes = 0; },
    report => { report.graphs[0].runs[0].peerReceipts[0].phaseIndex++; },
    report => { report.graphs[0].firstMessageTimingsMs.warmRpc = report.graphs[0].timingsMs.warmRpc; },
  ]) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateSdkBenchmarkReport(report), /WGA_EVIDENCE_INVALID/);
  }
});

test('EVIDENCE local SDK smoke success cannot certify release performance with unset thresholds', () => {
  for (const mutate of [
    report => { delete report.performanceCertification; },
    report => { report.performanceCertification.status = 'passed'; },
    report => { report.performanceCertification.reason = 'local-smoke-passed'; },
    report => { report.performanceCertification.thresholds.firstMessageP95Ms = 1000; },
    report => { report.budgets.releaseThresholds.firstMessageP95Ms = 1000; },
    report => { report.budgets.releaseThresholds = {}; report.performanceCertification.thresholds = {}; },
  ]) {
    const report = fixture(); mutate(report);
    assert.throws(() => validateSdkBenchmarkReport(report), /WGA_EVIDENCE_INVALID/);
  }
});

test('SDK performance policy evaluates explicit p50/p95 ceilings and blocks any unset threshold', () => {
  // Synthetic summaries exercise policy semantics, not workerd performance.
  const graphs = fixture().graphs;
  const complete = Object.fromEntries(Object.keys(budgets.releaseThresholds).map(key => [key, 1000]));
  const passed = evaluateSdkPerformance(graphs, complete);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.reason, 'configured-thresholds-satisfied');
  assert.equal(passed.scope, 'local-controlled-workerd');
  assert.equal(passed.evaluatedComparisons, 224);
  assert.deepEqual(passed.unsetThresholds, []); assert.deepEqual(passed.violations, []);
  assert.equal(evaluateSdkPerformance(graphs, { ...complete, firstMessageP50Ms: 5, firstMessageP95Ms: 5 }).status, 'passed',
    'equality at both exact thresholds is accepted');
  const exceeded = evaluateSdkPerformance(graphs, { ...complete, firstMessageP50Ms: 4, firstMessageP95Ms: 4 });
  assert.equal(exceeded.status, 'failed'); assert.equal(exceeded.reason, 'configured-threshold-exceeded');
  assert.equal(exceeded.violations.length, 96);
  assert.deepEqual(exceeded.violations[0], { profile: 'google-static-v1', graph: 'datastore',
    measurement: 'firstMessageTimingsMs.firstUnauthenticatedRpc.p50', valueMs: 5, threshold: 'firstMessageP50Ms', maximumMs: 4 });
  graphs[0].firstMessageTimingsMs.firstUnauthenticatedRpc.p95 = 6;
  const regression = evaluateSdkPerformance(graphs, { ...complete, firstMessageP50Ms: 5, firstMessageP95Ms: 5 });
  assert.equal(regression.violations.length, 1);
  assert.equal(regression.violations[0].measurement, 'firstMessageTimingsMs.firstUnauthenticatedRpc.p95');
  const partial = evaluateSdkPerformance(graphs, { ...complete, firstMessageP50Ms: null });
  assert.equal(partial.status, 'blocked'); assert.equal(partial.reason, 'release-performance-thresholds-unset');
  assert.deepEqual(partial.unsetThresholds, ['firstMessageP50Ms']);
  assert.equal(partial.evaluatedComparisons, 176);
  const blockedEvenWhenAnotherLimitFails = evaluateSdkPerformance(graphs, { ...complete, sdkImportP50Ms: null,
    firstMessageP50Ms: 4, firstMessageP95Ms: 4 });
  assert.equal(blockedEvenWhenAnotherLimitFails.status, 'blocked');
  assert.ok(blockedEvenWhenAnotherLimitFails.violations.length > 0);
});

test('SDK performance policy rejects malformed thresholds and incomplete measurements', () => {
  for (const mutate of [
    value => { delete value.thresholds.firstMessageP50Ms; },
    value => { value.thresholds.extra = 1000; },
    value => { value.thresholds.firstMessageP50Ms = undefined; },
    value => { value.thresholds.firstMessageP50Ms = NaN; },
    value => { value.thresholds.firstMessageP50Ms = Infinity; },
    value => { value.thresholds.firstMessageP50Ms = -1; },
    value => { value.thresholds.firstMessageP50Ms = 0; },
    value => { value.thresholds.firstMessageP50Ms = '1000'; },
    value => { value.thresholds.firstMessageP50Ms = true; },
    value => { value.thresholds.firstMessageP50Ms = 1001; },
    value => { value.thresholds = []; },
    value => { value.graphs.pop(); },
    value => { value.graphs[0].profile = 'google-modern-v1'; },
    value => { delete value.graphs[0].timingsMs.sdkImport; },
    value => { value.graphs[0].timingsMs.sdkImport.samples = 0; },
    value => { value.graphs[0].firstMessageTimingsMs.firstUnauthenticatedRpc.p95 = NaN; },
    value => { value.graphs[0].firstMessageTimingsMs.firstUnauthenticatedRpc.p95 = 1; },
  ]) {
    const value = { graphs: fixture().graphs, thresholds: Object.fromEntries(Object.keys(budgets.releaseThresholds).map(key => [key, 1000])) };
    mutate(value);
    assert.throws(() => evaluateSdkPerformance(value.graphs, value.thresholds), /WGA_EVIDENCE_INVALID/);
  }
});
