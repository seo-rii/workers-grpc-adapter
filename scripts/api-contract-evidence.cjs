'use strict';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function need(value, reason) { if (!value) throw new Error(`WGA_EVIDENCE_INVALID: api-contracts ${reason}`); }
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sources = ['scripts/test-api-contracts.cjs', 'scripts/api-contract-node.cjs', 'scripts/api-contract-throw.cjs', 'scripts/api-contract-native.cjs', 'scripts/api-contract-evidence.cjs', 'fixtures/shared/catalog-api.mjs', 'fixtures/shared/catalog-api.proto', 'fixtures/worker/catalog-api.mjs', 'fixtures/worker/package-lock.json', 'fixtures/native/package-lock.json'];
function clean(state) {
  need(state?.terminal === true && state.timerActive === false && state.requestBytes === 0 && state.responseBytes === 0, 'terminal buffer/timer cleanup');
  need(state.fetchCount === 0 || state.fetchCount === 1, 'at most one fetch');
}
function caseRow(row, native) {
  const number = Number(row.id?.slice(4)); need(Number.isInteger(number) && number >= 1 && number <= 16, 'case id');
  need(row.status === 'passed' && row.resourcesIdle === true && row.activeCalls === 0 && row.authCalls === 0, 'case status/resources/auth');
  const rpc = number >= 14 && number <= 15 ? 0 : number === 1 ? 2 : [4, 6].includes(number) ? 3 : 1;
  const fetch = [8, 12, 13, 14, 15].includes(number) ? 0 : rpc;
  need(row.rpcCount === rpc && row.fetchCount === fetch && row.calls?.length === rpc && row.receipts?.length === fetch, 'RPC/fetch accounting');
  need(row.cleanup?.length === (number === 6 ? 2 : fetch), 'body accounting');
  for (const body of row.cleanup) need(body.locked === false && (body.ended === true && body.cancelled === 0 || body.ended === false && body.cancelled === 1), 'body cleanup');
  row.calls.forEach((call, index) => {
    const code = number === 6 && index === 1 ? 4 : number === 8 || number === 9 ? 13 : number >= 10 && number <= 13 ? 12 : 0;
    need(call.callbacks?.length === (number === 13 ? 0 : 1) && call.statuses?.length === (number === 16 ? 0 : 1), 'callback/status counts');
    for (const callback of call.callbacks) need(callback.code === code && callback.asynchronous === true, 'callback code/order');
    for (const status of call.statuses) need(status.code === (number === 10 ? 0 : code) && status.asynchronous === true, 'status code/order');
    clean(call.diagnostics);
    need(call.diagnostics.fetchCount === ([8, 12, 13].includes(number) ? 0 : 1), 'call fetch accounting');
    need(Array.isArray(call.trace) && call.trace.filter(event => event[0] === 'callback').length === call.callbacks.length && call.trace.filter(event => event[0] === 'status').length === call.statuses.length, 'event trace counts');
  });
  if (number === 1) need(row.aliasWithoutOptions === true && row.factoryCompared === true && row.receipts[0].wire === row.receipts[1].wire && same(row.calls[0].trace, row.calls[1].trace), 'default alias/factory comparison');
  if (number === 2) need(row.subclassWithoutHook === true, 'subclass');
  if (number === 3) need(row.serviceIdentity === true && row.methodAliasIdentity === true && row.serviceName === 'catalog.api.nested.Echo', 'generic metadata');
  if (number === 4) {
    need(row.fullDescriptorGraphPreserved === true && row.enumIdentity === true && row.messageIdentity === true && row.serviceIdentity === true && row.nestedPackage === 'catalog.api.nested' && row.enumName === 'READY' && row.fieldName === 'text', 'real descriptor graph');
    need(same(row.payloads, ['', '안녕 ☃', 'x'.repeat(96)]), 'static codec varied payloads');
    row.calls.forEach((call, index) => need(call.callbacks[0].value?.text === row.payloads[index] && row.receipts[index].request?.text === row.payloads[index], 'static codec roundtrip'));
  }
  if (number === 5) need(row.rewriteVerified === true && row.receipts[0].request?.text === 'request|rewritten' && row.receipts[0].metadata?.rewrite === 'changed', 'request/metadata rewrite');
  if (number === 6) need(row.finiteDeadlineReplaced === true && row.headerWindowMs > 40000 && row.headerWindowMs <= 45000 && row.finalWindowMs === 45000 && row.originalWindowMs === 105000 && same(row.deadlineOutcomes, [0, 4, 0]) && row.shorteningMs >= 400 && row.shorteningMs < 4000 && row.extensionOutlivedOriginalMs === 150, 'shorter/longer final deadline');
  if (number >= 7 && number <= 10) {
    const baseline = native.results.find(value => value.id === row.id); need(row.nativeCompared === true && baseline && same(row.calls[0].trace, baseline.trace), 'native trace comparison');
    if (number === 7) need(same(row.order, baseline.order) && row.receipts[0].wire === baseline.wires[0] && row.receipts[0].request?.text === 'request|transformer|one|two' && row.receipts[0].metadata?.transformer === 'yes' && row.receipts[0].metadata?.order === 'one, two', 'native transformer/interceptor ordering and wire');
  }
  if (number === 11) need(row.nativeCompared !== true && row.nativeDivergence?.adapterCode === 12 && row.nativeDivergence?.nativeCode === 4 && row.calls[0].callbacks[0].details === 'Too many responses received', 'explicit native cardinality divergence');
  if (number === 12 || number === 13) need(row.defaultRequestStreamingDisabled === true && row.callbacksAsynchronous === true && row.statusesAsynchronous === true, 'disabled streaming async surfaces');
  if (number === 14) need(row.code === 12 && row.asynchronous === true && row.state === 'IDLE' && row.healthFetches === 0, 'truthful readiness');
  if (number === 15) need(row.importSucceeded === true && row.useError === 'WGA_SERVER_UNSUPPORTED', 'server import/use distinction');
  if (number === 16) need(row.applicationThrow === true && row.observerTerminalCode === 0 && row.observerTerminalCount === 1 && row.callbackStatus === 0 && row.statusEvents === 0, 'application throw not reinterpreted');
}
function validateApiContractsReport(report) {
  need(report?.status === 'passed' && report.sourceBuild === false, 'installed execution');
  need(report.liveCloud === false && report.incomingCloudflareTranslation === false && report.controlledPeer === true && report.externalRequests === 0, 'scope');
  need(report.runtimeDisposed === true && report.cleanupVerifiedBeforeDispose === true, 'runtime cleanup');
  need(report.compatibilityDate === '2026-09-21' && typeof report.workerd === 'string' && typeof report.miniflare === 'string' && typeof report.node === 'string', 'runtime identity');
  need(hash(report.bundleSha256) && sources.every(file => hash(report.evidence?.[file])), 'source hashes');
  for (const file of ['index.js', 'index.mjs', 'adapter.js', 'adapter.mjs', 'config.js', 'config.mjs']) need(hash(report.installedInputs?.[`fixtures/worker/node_modules/@grpc/grpc-js/dist/${file}`]), 'installed public graph');
  for (const name of ['@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs']) need(hash(report.nativeInputs?.[`fixtures/native/node_modules/${name}/package.json`]), 'native dependency identity');
  need(report.protoLoader?.version === '0.8.1' && hash(report.protoLoader.descriptorSha256) && hash(report.protoLoader.staticModuleSha256), 'real proto-loader compilation');
  need(report.protoLoader.descriptorPath === 'verification/api-contracts/package-definition.json' && report.protoLoader.staticModulePath === 'verification/api-contracts/static-codecs.mjs' && report.generatedArtifacts?.[report.protoLoader.descriptorPath] === report.protoLoader.descriptorSha256 && report.generatedArtifacts?.[report.protoLoader.staticModulePath] === report.protoLoader.staticModuleSha256, 'generated proto artifacts');
  const native = report.native;
  need(native?.version === '1.14.5' && native.transport === 'independent-loopback-http2' && native.sessionsClosed === true && native.results?.length === 6, 'native oracle');
  need(native.rawControl?.messages === 2 && native.rawControl.grpcStatus === 0 && native.rawControl.endStream === true && native.rawControl.responseHex === '00000000070a05666972737400000000080a067365636f6e64', 'raw HTTP2 duplicate response control');
  for (const id of ['control-one-message', 'API-007', 'API-008', 'API-009', 'API-010', 'API-011']) {
    const rows = native.results.filter(value => value.id === id); need(rows.length === 1, 'native case matrix'); const value = rows[0];
    const code = id === 'API-008' || id === 'API-009' ? 13 : id === 'API-010' ? 12 : id === 'API-011' ? 4 : 0;
    need(value.callbacks?.length === 1 && value.callbacks[0].code === code && value.statuses?.length === 1 && value.statuses[0].code === (id === 'API-010' ? 0 : code), 'native callback/status');
    need(value.serverArrivals === (id === 'API-008' ? 0 : 1), 'native arrival counts');
    if (id === 'API-011') need(same(value.receivedMessages, ['first']) && value.emissions.filter(event => event.kind === 'data').length === 2 && value.emissions.some(event => event.kind === 'trailers' && event.status === 0) && value.emissions.some(event => event.kind === 'end-stream'), 'native duplicate response boundary');
  }
  need(report.runs?.length === 10 && report.results?.length === 124 && report.exceptions?.length === 4, 'execution matrix');
  for (const runtime of ['node', 'workerd']) for (const mode of ['cloudflare', 'grpc-web']) {
    for (const invocation of ['cold', 'warm']) {
      const runs = report.runs.filter(run => run.runtime === runtime && run.mode === mode && run.invocation === invocation);
      need(runs.length === 1 && runs[0].status === 'passed' && runs[0].resourcesIdle === true && runs[0].results?.length === 15 && runs[0].rpcCount === 18 && runs[0].fetchCount === 15, 'cold/warm execution');
      for (let number = 1; number <= 15; number++) {
        const id = `API-${String(number).padStart(3, '0')}`;
        const rows = report.results.filter(row => row.runtime === runtime && row.mode === mode && row.invocation === invocation && row.id === id);
        need(rows.length === 1, 'exact case matrix'); const row = rows[0]; caseRow(row, native);
        const { runtime: _runtime, invocation: _invocation, ...original } = row;
        need(same(original, runs[0].results.find(value => value.id === id)), 'flattened row provenance');
      }
    }
    const rows = report.results.filter(row => row.runtime === runtime && row.mode === mode && row.invocation === 'throw' && row.id === 'API-016'); need(rows.length === 1, 'callback throw case'); caseRow(rows[0], native);
    const signals = report.exceptions.filter(value => value.runtime === runtime && value.mode === mode); need(signals.length === 1, 'exception signal'); const signal = signals[0];
    if (runtime === 'node') {
      need(signal.fatalExitCode === 1 && signal.origin === 'uncaughtException' && signal.error === `CATALOG_API016_APPLICATION_THROW_${mode}`, 'fatal Node exception preserved');
      clean(signal.diagnostics); need(signal.activeCalls === 0 && ['activeCalls', 'queuedCalls', 'bufferedBytes'].every(key => signal.usage?.[key] === 0), 'fatal child cleanup');
      need(signal.observer?.length === 1 && signal.observer[0].statusCode === 0 && same(signal.trace, rows[0].calls[0].trace), 'fatal child transport result');
    } else {
      need(signal.exceptions?.length === 1 && signal.exceptions[0].method === 'Runtime.exceptionThrown' && signal.exceptions[0].text.startsWith(`Uncaught Error: CATALOG_API016_APPLICATION_THROW_${mode}\n`), 'uncaught workerd exception observed');
      const runs = report.runs.filter(run => run.runtime === runtime && run.mode === mode && run.invocation === 'throw');
      need(runs.length === 1 && runs[0].results?.length === 1 && same(runs[0].results[0], (({ runtime, invocation, ...row }) => row)(rows[0])), 'workerd throw receipt');
    }
  }
  need(report.caseCount === 124 && report.rpcCount === 148 && report.fetchCount === 124, 'totals');
}
module.exports = { validateApiContractsReport };
