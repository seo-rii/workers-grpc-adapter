'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateApiContractsReport } = require('../scripts/api-contract-evidence.cjs');
const template = require('./fixtures/api-contract-report.json');
// A compact frozen reference shape validates the evidence parser; it is not execution evidence.
function fixture() {
  const { base, regular, thrown, nodeException } = structuredClone(template);
  const report = { ...base, runs: [], results: [], exceptions: [] };
  for (const runtime of ['node', 'workerd']) for (const mode of ['cloudflare', 'grpc-web']) {
    for (const invocation of ['cold', 'warm']) {
      const results = structuredClone(regular).map(row => ({ ...row, mode }));
      report.runs.push({ runtime, mode, invocation, status: 'passed', resourcesIdle: true, rpcCount: 18, fetchCount: 15, results });
      report.results.push(...results.map(row => ({ runtime, invocation, ...row })));
    }
    const result = { ...structuredClone(thrown), mode }; report.results.push({ runtime, invocation: 'throw', ...result });
    if (runtime === 'workerd') {
      report.runs.push({ runtime, mode, invocation: 'throw', status: 'passed', resourcesIdle: true, rpcCount: 1, fetchCount: 1, results: [result] });
      report.exceptions.push({ runtime, mode, exceptions: [{ method: 'Runtime.exceptionThrown', text: `Uncaught Error: CATALOG_API016_APPLICATION_THROW_${mode}\n` }] });
    } else report.exceptions.push({ ...structuredClone(nodeException), mode, error: `CATALOG_API016_APPLICATION_THROW_${mode}` });
  }
  return report;
}
test('EVIDENCE API contracts requires exact runtime matrix, native traces and real uncaught signals', () => {
  validateApiContractsReport(fixture());
  for (const mutate of [
    r => { r.status = 'failed'; }, r => { r.sourceBuild = true; }, r => { r.liveCloud = true; },
    r => { r.incomingCloudflareTranslation = true; }, r => { r.externalRequests = 1; },
    r => { r.cleanupVerifiedBeforeDispose = false; }, r => { r.runtimeDisposed = false; },
    r => { r.evidence = {}; }, r => { r.installedInputs = {}; }, r => { r.nativeInputs = {}; },
    r => { r.generatedArtifacts = {}; }, r => { r.protoLoader.staticModuleSha256 = 'b'.repeat(64); },
    r => { delete r.protoLoader.staticCodecCalibration; },
    r => { r.protoLoader.staticCodecCalibration.nativeSerializationMatched = false; },
    r => { r.protoLoader.staticCodecCalibration.emptyWireMatched = false; },
    r => { r.protoLoader.staticCodecCalibration.malformedObjectRejected = false; },
    r => { r.protoLoader.staticCodecCalibration.malformedWireRejected = false; },
    r => { r.protoLoader.staticCodecCalibration.payloads.pop(); },
    r => { r.runs.pop(); }, r => { r.runs[0].mode = 'other'; }, r => { r.results.pop(); },
    r => { r.native.results.pop(); }, r => { r.native.version = 'different'; }, r => { r.native.sessionsClosed = false; },
    r => { r.native.rawControl.messages = 1; }, r => { r.native.rawControl.grpcStatus = 13; },
    r => { r.native.results.find(row => row.id === 'API-011').receivedMessages.push('second'); },
    r => { r.results.find(row => row.id === 'API-007').nativeCompared = false; },
    r => { r.results.find(row => row.id === 'API-008').calls[0].callbacks[0].code = 14; },
    r => { r.results.find(row => row.id === 'API-010').calls[0].statuses[0].code = 12; },
    r => { r.results.find(row => row.id === 'API-011').nativeCompared = true; },
    r => { r.results.find(row => row.id === 'API-004').fullDescriptorGraphPreserved = false; },
    r => { r.results.find(row => row.id === 'API-006').deadlineOutcomes = [0, 0, 0]; },
    r => { r.results.find(row => row.id === 'API-012').authCalls = 1; },
    r => { r.results.find(row => row.id === 'API-012').fetchCount = 1; },
    r => { r.results.find(row => row.id === 'API-012').calls[0].callbacks[0].asynchronous = false; },
    r => { r.results.find(row => row.id === 'API-013').statusesAsynchronous = false; },
    r => { r.results[0].calls[0].diagnostics.timerActive = true; },
    r => { r.results[0].calls[0].diagnostics.requestBytes = 10; }, r => { r.results[0].cleanup[0].locked = true; },
    r => { r.results[0].activeCalls = 1; }, r => { r.results[0].calls[0].callbacks.push({ code: 0, asynchronous: true }); },
    r => { r.exceptions.find(row => row.runtime === 'workerd').exceptions = []; },
    r => { r.exceptions.find(row => row.runtime === 'workerd').exceptions[0].method = 'console.log'; },
    r => { r.exceptions.find(row => row.runtime === 'node').fatalExitCode = 0; },
    r => { r.exceptions.find(row => row.runtime === 'node').origin = 'handled'; },
    r => { r.exceptions.find(row => row.runtime === 'node').observer[0].statusCode = 14; },
    r => { r.results.find(row => row.id === 'API-016').observerTerminalCode = 14; },
    r => { r.caseCount--; }, r => { r.rpcCount--; }, r => { r.fetchCount++; },
  ]) {
    const value = fixture(); mutate(value); assert.throws(() => validateApiContractsReport(value), /WGA_EVIDENCE_INVALID/);
  }
});
