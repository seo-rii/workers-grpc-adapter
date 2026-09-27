'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSdkBenchmarkReport, summarize } = require('../scripts/sdk-benchmark-evidence.cjs');
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
    versions: { node: 'v22.0.0', platform: 'linux', arch: 'x64', miniflare: 'fixture', workerd: 'fixture', wrangler: 'fixture', esbuild: 'fixture' },
    budgets: structuredClone(budgets), graphs: [], evidence: Object.fromEntries([
      'scripts/benchmark-sdk.cjs', 'scripts/sdk-benchmark-evidence.cjs', 'fixtures/google/benchmark-runtime.mjs',
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
      sourceCopies: Object.fromEntries([name, 'runtime'].map(part => [`fixtures/google/benchmark-${part}.mjs`, hash])),
      sdkVersions: Object.entries(require(`../fixtures/${fixtureName}/package.json`).dependencies)
        .filter(([name]) => name.startsWith('@google-cloud/')).map(([name, version]) => ({ name, version })),
      installedInputs: Object.fromEntries(['@grpc/grpc-js/dist/index.js', '@grpc/grpc-js/dist/build/index.cjs',
        `@grpc/grpc-js/dist/build/profiles/${profile}.json`, ...sdkNames.map(sdk => `@google-cloud/${sdk}/build/src/index.js`)]
        .map(file => [prefix + file, hash])), runs: [] };
    report.graphs.push(graph);
    for (let sample = 0; sample < budgets.coldSamples; sample++) {
      const run = { sample, status: 'passed', runtimeDisposed: true, cleanupVerifiedBeforeDispose: true,
        inspectorTarget: 'core:user:sdk-benchmark', startupAndReadyMs: 100, phases: [], peerReceipts: [],
        oauthRefreshes: [{ phase: 'refresh', sequence: 1 }, { phase: 'concurrent', sequence: 2 }], memoryCheckpoints: streams ? 1 : 0,
        close: { clientsClosed: true, resources: resources() }, heapSamples: [] };
      graph.runs.push(run);
      for (const phase of ['unauthenticated', 'authenticated', ...Array(budgets.warmSamples).fill('warm'), 'compressed', 'refresh', 'concurrent']) {
        const concurrent = phase === 'concurrent', refreshed = ['refresh', 'concurrent'].includes(phase);
        const count = concurrent ? budgets.concurrency * (streams ? 1 : sdkNames.length) : sdkNames.length;
        run.phases.push({ name: phase, status: 'passed', sdks: sdkNames, elapsedMs: 10, rpcCount: count, logicalCalls: count,
          authMetadataCalls: count, terminalCodes: Array(count).fill(0), messages: concurrent && streams ? count * budgets.messages : count,
          concurrency: concurrent ? budgets.concurrency : 1, slowConsumer: concurrent && streams,
          oauthRefreshes: refreshed ? 1 : 0, accessTokenRefreshed: refreshed, resources: resources(),
          ...(concurrent && streams ? { heldResources: { ...resources(), activeCalls: 4 } } : {}) });
        const selected = concurrent && streams ? ['/google.firestore.v1.Firestore/RunQuery'] : methods;
        for (let index = 0; index < (concurrent ? budgets.concurrency : 1); index++) {
          for (const method of selected) run.peerReceipts.push({ phase, method, requestBytes: 10, responseBytes: 50,
            messages: method.endsWith('/RunQuery') ? budgets.messages : 1, compressed: ['compressed', 'concurrent'].includes(phase),
            authorization: phase === 'unauthenticated' ? 'absent' : refreshed ? 'refreshed' : 'cached', bodyLocked: false, ended: true, cancellations: 0 });
        }
      }
      run.heapSamples = ['ready', 'unauthenticated', 'authenticated', 'warm', 'compressed', 'refresh',
        ...(streams ? ['concurrent-held'] : []), 'concurrent-complete', 'closed'].map(label =>
        ({ label, usedSize: 1000000, totalSize: 2000000, embedderHeapUsedSize: 100000, backingStorageSize: 1000 }));
    }
    const times = phase => graph.runs.flatMap(run => run.phases.filter(item => item.name === phase).map(item => item.elapsedMs));
    graph.timingsMs = { startupAndReady: summarize(graph.runs.map(run => run.startupAndReadyMs)),
      firstUnauthenticatedRpc: summarize(times('unauthenticated')), firstAuthenticatedRpc: summarize(times('authenticated')),
      warmRpc: summarize(times('warm')), compressedRpc: summarize(times('compressed')), oauthRefreshRpc: summarize(times('refresh')),
      concurrent: summarize(times('concurrent')) };
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
