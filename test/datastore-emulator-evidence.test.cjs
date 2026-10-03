'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDatastoreEmulatorReport: validate, contracts, sources, helpers, runtimes, addedChecks } = require('../scripts/datastore-emulator-evidence.cjs');

// Synthetic mutation-test baseline derived from the explicit method contracts;
// this is not execution evidence. The harness executes the real official
// emulators and independently joins actual Fetch and Envoy access receipts.
function fixture() {
  const hash = 'a'.repeat(64), report = {
    status: 'passed', realGoogleSDK: true, officialEmulators: true,
    liveGoogleApiExecuted: false, deployedCloudflareExecuted: false, releaseEligible: false,
    sameSharedFiles: true, businessEquivalent: true, wireEquivalent: true,
    evidence: Object.fromEntries(sources.map(file => [file, hash])),
    sourceHashes: Object.fromEntries(['native', 'replacement', 'workerd'].map(runtime => [runtime, Object.fromEntries(helpers.map(file => [file, hash]))])),
    installedInputs: {}, nativeInputs: {}, results: [], requests: [], wire: [],
    datastoreAccounting: { status: 'passed', scope: 'anonymous-grpc-web-official-emulator', mode: 'grpc-web',
      adapterRetryEnabled: false, resourcesCheckedBeforeClose: true, physicalEnvoyReceiptsJoined: true,
      authMode: 'disabled-insecure-loopback', authFetches: 0, authNetworkRequests: 0, authMetadataRequests: 0,
      controlRequests: 0, controlScope: 'no-suite-control-requests; emulator and Envoy readiness are harness setup',
      logicalCalls: 0, dataFetches: 0 },
  };
  for (const [name, directory, entry] of [['installedInputs', 'google', 'dist/index.js'], ['nativeInputs', 'native', 'build/src/index.js']]) {
    for (const file of ['@grpc/grpc-js/package.json', `@grpc/grpc-js/${entry}`, '@google-cloud/datastore/package.json',
      '@google-cloud/datastore/build/src/index.js', '@google-cloud/datastore/build/src/request.js',
      '@google-cloud/datastore/build/src/v1/datastore_client.js', '@google-cloud/datastore/build/protos/protos.json',
      'google-gax/package.json', 'google-auth-library/package.json']) report[name][`fixtures/${directory}/node_modules/${file}`] = hash;
  }
  let sequence = 0;
  for (const runtime of runtimes) for (const [suite, operations] of Object.entries(contracts)) {
    const native = runtime === 'native', count = operations.length, registeredClients = suite === 'datastore-emulator-ids' ? 2 : 1;
    const row = { runtime, sdk: '@google-cloud/datastore', suite, status: 'passed', checks: [`${suite}-synthetic`, ...(addedChecks[suite] || [])],
      dataFetches: native ? 0 : count, grpcWebRequests: native ? 0 : count, authFetches: 0,
      authNetworkRequests: 0, authMetadataRequests: 0, controlRequests: 0, authMode: 'disabled-insecure-loopback',
      registeredClients, clientsClosed: registeredClients, accounting: native ? null : {
        beforeClose: true, calls: [], channelCount: registeredClients, activeChannels: 0,
        resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 },
      } };
    report.results.push(row);
    const scope = runtime.startsWith('workerd') ? { runtime: 'workerd', invocation: runtime.slice(8) } : { runtime, invocation: null };
    for (const operation of operations) {
      const [name, status] = operation.split('#'), method = `/google.datastore.v1.Datastore/${name}`, statusCode = Number(status || 0);
      const logicalCallId = native ? null : `wga-${++sequence}`;
      report.wire.push({ ...scope, suite: native ? null : suite, logicalCallId, method, grpcStatus: statusCode,
        httpStatus: 200, upstream: 'datastore', flags: '-' });
      if (native) continue;
      report.requests.push({ ...scope, suite, logicalCallId, method, httpStatus: 200, requestContentType: 'application/grpc-web+proto',
        responseContentType: 'application/grpc-web+proto', requestBytes: 10 });
      row.accounting.calls.push({ logicalCallId, method, statusCode, startCount: 1, terminalCount: 1, attemptCount: 1,
        fetchCount: 1, fetchEventCount: 1, authCount: 1, responseMessages: statusCode ? 0 : 1,
        diagnostics: { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false },
        execution: { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
          parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 },
      });
      report.datastoreAccounting.logicalCalls++; report.datastoreAccounting.dataFetches++;
    }
  }
  return report;
}
const row = report => report.results.find(item => item.runtime === 'workerd-second' && item.suite === 'datastore-emulator-types');
const request = report => report.requests.find(item => item.logicalCallId === row(report).accounting.calls[0].logicalCallId);
const arrival = report => report.wire.find(item => item.logicalCallId === row(report).accounting.calls[0].logicalCallId);
function rejectAll(mutations) {
  for (const [reason, mutate] of mutations) {
    const report = fixture(); mutate(report);
    assert.throws(() => validate(report), /WGA_EVIDENCE_INVALID/, reason);
  }
}
test('EVIDENCE emulator accounting accepts its explicitly synthetic mutation baseline', () => {
  assert.doesNotThrow(() => validate(fixture()));
});
test('EVIDENCE emulator accounting rejects missing scope, runtime and installed provenance', () => rejectAll([
  ['source', report => { delete report.evidence[sources[0]]; }],
  ['helper', report => { delete report.sourceHashes.workerd['sdk-call-accounting.mjs']; }],
  ['business source', report => { report.sourceHashes.native['emulator-datastore.mjs'] = 'b'.repeat(64); }],
  ['installed SDK', report => { delete report.installedInputs['fixtures/google/node_modules/@google-cloud/datastore/build/src/index.js']; }],
  ['runtime omitted', report => { report.results.pop(); }],
  ['duplicate scenario', report => { report.results[39] = structuredClone(report.results[38]); }],
  ['live claim', report => { report.liveGoogleApiExecuted = true; }],
  ['business check even with matching native', report => { for (const value of report.results) value.checks = ['fake']; }],
  ['scope', report => { report.datastoreAccounting.mode = 'cloudflare'; }],
  ['retry', report => { report.datastoreAccounting.adapterRetryEnabled = true; }],
  ['authentication', report => { row(report).authNetworkRequests = 1; }],
  ['auth metadata', report => { row(report).authMetadataRequests = 1; }],
  ['control requests', report => { row(report).controlRequests = 1; }],
]));
test('EVIDENCE emulator accounting rejects mismatched actual Fetch and Envoy call identities', () => rejectAll([
  ['physical Fetch ID', report => { request(report).logicalCallId = 'wrong'; }],
  ['Envoy ID', report => { arrival(report).logicalCallId = 'wrong'; }],
  ['peer suite', report => { arrival(report).suite = 'datastore-crud'; }],
  ['peer method', report => { arrival(report).method = '/google.datastore.v1.Datastore/Lookup'; }],
  ['peer status', report => { arrival(report).grpcStatus = 14; }],
  ['wrong emulator', report => { arrival(report).upstream = 'firestore'; }],
  ['extra Fetch', report => { report.requests.push(structuredClone(request(report))); }],
  ['extra peer call', report => { report.wire.push(structuredClone(arrival(report))); }],
  ['no native baseline', report => { report.wire = report.wire.filter(item => item.runtime !== 'native'); }],
  ['duplicate call ID', report => { row(report).accounting.calls[1].logicalCallId = row(report).accounting.calls[0].logicalCallId; }],
  ['aggregate', report => { report.datastoreAccounting.dataFetches++; }],
]));
test('EVIDENCE emulator accounting rejects masked extra attempts and premature cleanup', () => rejectAll([
  ['second physical Fetch', report => { row(report).accounting.calls[0].fetchCount = 2; }],
  ['observer missed Fetch', report => { row(report).accounting.calls[0].fetchEventCount = 0; }],
  ['terminal not delivered', report => { row(report).accounting.calls[0].terminalCount = 0; }],
  ['timer', report => { row(report).accounting.calls[0].diagnostics.timerActive = true; }],
  ['pump', report => { row(report).accounting.calls[0].execution.activePumps = 1; }],
  ['parser', report => { row(report).accounting.calls[0].execution.parserAssemblyBytes = 3; }],
  ['pending write', report => { row(report).accounting.calls[0].execution.pendingWriteCallbacks = 1; }],
  ['active calls', report => { row(report).accounting.resources.activeCalls = 1; }],
  ['active channels', report => { row(report).accounting.activeChannels = 1; }],
  ['snapshot after close', report => { row(report).accounting.beforeClose = false; }],
  ['SDK not closed', report => { row(report).clientsClosed = 0; }],
  ['missing cleanup RPC', report => { row(report).accounting.calls.pop(); }],
]));
