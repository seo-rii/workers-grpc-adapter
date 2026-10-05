'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { workerRequestFailure } = require('./gcp-soak.cjs');

// Extract only the real polling/request functions; never import deployment setup.
const source = fs.readFileSync(path.join(__dirname, 'gcp-cloud-probe.cjs'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing runner section: ${start}`);
  return source.slice(first, last);
}
const readinessSource = section('async function waitWorkerReady(', '\nasync function main()');
const requestSource = section('async function workerRequest(', '\nasync function waitWorkerReady(');

function harness({ mode = 'cloudflare', targetKey = mode, replies = [], interrupted = false,
  interruptAfterPause = false } = {}) {
  let now = 0;
  const calls = [];
  const receipts = [];
  const pauses = [];
  const report = {};
  const context = {
    report, interrupted,
    Date: { now: () => now },
    save() { receipts.push(JSON.parse(JSON.stringify(report.workerReadiness[targetKey]))); },
    async pause(ms) {
      assert.equal(ms, 2000);
      pauses.push(ms);
      now += ms;
      if (interruptAfterPause) context.interrupted = true;
    },
    async workerRequest(...args) {
      assert.deepEqual(args, [`/gcp/${mode}/ready`, true, targetKey, 5000]);
      calls.push(args);
      const reply = replies[calls.length - 1] ?? { httpStatus: 404, body: { code: 'NON_JSON_RESPONSE' } };
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  assert.equal(vm.runInContext('typeof require', isolated), 'undefined');
  assert.equal(vm.runInContext('typeof process', isolated), 'undefined');
  assert.equal(vm.runInContext('typeof fetch', isolated), 'undefined');
  const ready = vm.runInContext('(' + readinessSource + ')', isolated);
  return { run: () => targetKey === mode ? ready(mode) : ready(mode, targetKey), calls, receipts, pauses, report,
    elapsed: () => now, receipt: () => report.workerReadiness[targetKey] };
}

async function invalidThenReady() {
  const invalid = [
    { httpStatus: 404, body: { status: 'ready', mode: 'cloudflare' } },
    { httpStatus: 200, body: { code: 'NON_JSON_RESPONSE' } },
    { httpStatus: 200, body: { status: 'ready', mode: 'grpc-web' } },
    { httpStatus: 200, body: { status: 'passed', mode: 'cloudflare' } },
    { httpStatus: 200, body: { status: 'ready' } },
    { httpStatus: 200, body: null },
    { httpStatus: 200, body: 'ready' },
    { httpStatus: 503, body: { status: 'ready', mode: 'cloudflare' } },
  ];
  const fixture = harness({ replies: [...invalid, { httpStatus: 200, body: { status: 'ready', mode: 'cloudflare' } }] });
  await fixture.run();
  assert.equal(fixture.calls.length, invalid.length + 1);
  assert.equal(fixture.pauses.length, invalid.length);
  assert.ok(fixture.receipts.slice(0, -1).every(receipt => receipt.passed === false),
    'Propagation errors and mismatching JSON must never be accepted as readiness');
  assert.equal(fixture.receipt().passed, true);
  assert.equal(fixture.receipt().attempts, invalid.length + 1);
}

async function fetchFailureThenReady() {
  const fixture = harness({ replies: [
    new TypeError('synthetic private failure detail'),
    { httpStatus: 200, body: { status: 'ready', mode: 'cloudflare' } },
  ] });
  await fixture.run();
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.receipts[0].passed, false);
  assert.equal(fixture.receipts[0].error, 'TypeError');
  assert.equal(JSON.stringify(fixture.receipts).includes('private failure detail'), false);
  assert.equal(Object.hasOwn(fixture.receipt(), 'error'), false);
  assert.equal(fixture.receipt().passed, true);
}

async function unavailableTimesOut() {
  const fixture = harness();
  await assert.rejects(fixture.run(), /^Error: WORKER_READINESS_TIMEOUT_cloudflare$/);
  assert.equal(fixture.elapsed(), 120000, 'Missing responses exhaust the two-minute readiness window');
  assert.equal(fixture.calls.length, 60, 'Retries are bounded without using real timers');
  assert.equal(fixture.receipt().attempts, 60);
  assert.equal(fixture.receipt().passed, false);
  assert.equal(fixture.receipt().httpStatus, 404);
  assert.ok(fixture.receipts.every(receipt => receipt.passed === false));
}

async function interruption() {
  const before = harness({ interrupted: true });
  await assert.rejects(before.run(), /^Error: INTERRUPTED$/);
  assert.equal(before.calls.length, 0);
  assert.equal(before.receipt().passed, false);
  assert.equal(before.elapsed(), 0);

  const during = harness({ interruptAfterPause: true });
  await assert.rejects(during.run(), /^Error: INTERRUPTED$/);
  assert.equal(during.calls.length, 1, 'No request starts after interruption between attempts');
  assert.equal(during.receipt().passed, false);
  assert.equal(during.elapsed(), 2000);
}

async function explicitTarget() {
  const fixture = harness({ targetKey: 'cloudflare-flag', replies: [
    { httpStatus: 200, body: { status: 'ready', mode: 'cloudflare-flag' } },
    { httpStatus: 200, body: { status: 'ready', mode: 'cloudflare' } },
  ] });
  await fixture.run();
  assert.equal(fixture.calls.length, 2, 'A deployment key is not the transport mode');
  assert.equal(fixture.receipt().passed, true);
  assert.deepEqual(Object.keys(fixture.report.workerReadiness), ['cloudflare-flag']);
}

async function gatewayTarget() {
  const fixture = harness({ mode: 'grpc-web', replies: [
    { httpStatus: 200, body: { status: 'ready', mode: 'grpc-web' } },
  ] });
  await fixture.run();
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.elapsed(), 0);
  assert.equal(fixture.receipt().passed, true);
}

async function authenticatedRequestBoundary() {
  const calls = [];
  const timeoutSignal = {};
  const callerSignal = {}, combinedSignal = {};
  let expectedSignal = timeoutSignal;
  const context = {
    report: { workerUrls: { 'cloudflare-flag': 'https://readiness.invalid' } },
    workerKey: 'synthetic-test-key',
    workerRequestFailure,
    AbortSignal: {
      timeout(ms) { assert.equal(ms, 5000); return timeoutSignal; },
      any(signals) {
        assert.equal(signals.length, 2);
        assert.equal(signals[0], callerSignal);
        assert.equal(signals[1], timeoutSignal);
        return combinedSignal;
      },
    },
    async fetch(url, options) {
      calls.push({ url, options });
      assert.equal(url, 'https://readiness.invalid/gcp/cloudflare/ready');
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal, expectedSignal);
      assert.deepEqual(JSON.parse(JSON.stringify(options.headers)), { authorization: 'Bearer synthetic-test-key' });
      assert.equal(options.body, undefined, 'Readiness cannot carry an SDK workload');
      return { status: 200, text: async () => JSON.stringify({ status: 'ready', mode: 'cloudflare' }) };
    },
  };
  const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  assert.equal(vm.runInContext('typeof require', isolated), 'undefined');
  assert.equal(vm.runInContext('typeof process', isolated), 'undefined');
  const request = vm.runInContext('(' + requestSource + ')', isolated);
  const result = await request('/gcp/cloudflare/ready', true, 'cloudflare-flag', 5000);
  assert.equal(calls.length, 1);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.status, 'ready');
  expectedSignal = combinedSignal;
  await request('/gcp/cloudflare/ready', true, 'cloudflare-flag', 5000, callerSignal);
  assert.equal(calls.length, 2, 'Caller cancellation is composed with the request timeout');
}

async function freshRequestBoundary() {
  const timeoutSignal = {}, callerSignal = {}, combinedSignal = {};
  let expectedSignal = timeoutSignal, authorized = true, calls = 0;
  const context = {
    report: { workerUrls: { 'cloudflare-flag': 'https://readiness.invalid' }, workerHttp: { transport: 'fresh' } },
    workerKey: 'synthetic-test-key', workerRequestFailure,
    AbortSignal: {
      timeout(ms) { assert.equal(ms, 5000); return timeoutSignal; },
      any(signals) {
        assert.equal(signals.length, 2); assert.equal(signals[0], callerSignal); assert.equal(signals[1], timeoutSignal);
        return combinedSignal;
      },
    },
    async fetch() { assert.fail('The fresh control must not silently fall back to Fetch'); },
    async fetchWorkerHttp(url, options) {
      calls++;
      assert.equal(url, 'https://readiness.invalid/gcp/cloudflare/ready');
      assert.equal(options.signal, expectedSignal);
      assert.deepEqual(JSON.parse(JSON.stringify(options.headers)), authorized
        ? { authorization: 'Bearer synthetic-test-key' } : {});
      assert.equal(options.body, undefined);
      assert.equal(options.method, undefined, 'The HTTPS helper owns its fixed POST method');
      assert.equal(options.redirect, undefined, 'The HTTPS helper never follows redirects');
      return { status: authorized ? 200 : 418,
        text: async () => authorized ? JSON.stringify({ status: 'ready', mode: 'cloudflare' })
          : 'synthetic private non-JSON response' };
    },
  };
  const request = vm.runInContext('(' + requestSource + ')',
    vm.createContext(context, { codeGeneration: { strings: false, wasm: false } }));
  const authenticated = await request('/gcp/cloudflare/ready', true, 'cloudflare-flag', 5000);
  assert.equal(authenticated.httpStatus, 200); assert.equal(authenticated.body.status, 'ready');
  expectedSignal = combinedSignal; authorized = false;
  const denied = await request('/gcp/cloudflare/ready', false, 'cloudflare-flag', 5000, callerSignal);
  assert.equal(denied.httpStatus, 418);
  assert.deepEqual(JSON.parse(JSON.stringify(denied.body)), { code: 'NON_JSON_RESPONSE' });
  assert.equal(JSON.stringify(denied).includes('synthetic private'), false);
  assert.equal(calls, 2, 'Authorization and caller cancellation are preserved by the fresh control');
}

async function requestFailureStages() {
  for (const transport of [undefined, 'fetch', 'fresh']) for (const phase of ['fetch', 'response-body']) {
    let requestCalls = 0, bodyReads = 0;
    const failures = [];
    const original = transport === 'fresh'
      ? Object.assign(new Error('synthetic private URL and token must not be retained'), { code: 'ECONNRESET' })
      : new TypeError('synthetic private URL and token must not be retained', {
        cause: Object.assign(new Error('synthetic private socket details'), {
          code: phase === 'fetch' ? 'EAI_AGAIN' : 'UND_ERR_SOCKET',
        }),
      });
    const perform = async () => {
      requestCalls++;
      if (phase === 'fetch') throw original;
      return { status: 503, async text() { bodyReads++; throw original; } };
    };
    const context = {
      report: { workerUrls: { cloudflare: 'https://readiness.invalid' },
        ...(transport ? { workerHttp: { transport } } : {}) },
      workerKey: 'synthetic-test-key',
      AbortSignal: { timeout: () => ({}) },
      workerRequestFailure(...args) { failures.push(args); return workerRequestFailure(...args); },
      async fetch() { assert.notEqual(transport, 'fresh'); return perform(); },
      async fetchWorkerHttp() { assert.equal(transport, 'fresh'); return perform(); },
    };
    const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
    const request = vm.runInContext('(' + requestSource + ')', isolated);
    await assert.rejects(request('/gcp/cloudflare/ready', true, 'cloudflare', 5000), error => {
      assert.equal(error.message, 'WGA_WORKER_REQUEST_FAILED');
      assert.equal(error.cause, undefined, 'The original cause is not retained');
      assert.equal(error.stack.includes('synthetic private'), false);
      assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes('synthetic private'), false);
      return true;
    });
    assert.equal(requestCalls, 1, 'A failed probe request is never silently retried or switched to another transport');
    assert.equal(bodyReads, phase === 'fetch' ? 0 : 1);
    assert.equal(failures.length, 1); assert.equal(failures[0][0], phase);
    assert.equal(failures[0][1], original, 'The helper receives the actual failure at the boundary');
    assert.equal(failures[0][2], phase === 'fetch' ? undefined : 503,
      'An HTTP status is retained only after response headers arrived');
  }
}

async function main() {
  await invalidThenReady();
  await fetchFailureThenReady();
  await unavailableTimesOut();
  await interruption();
  await explicitTarget();
  await gatewayTarget();
  await authenticatedRequestBoundary();
  await freshRequestBoundary();
  await requestFailureStages();
  console.log(JSON.stringify({ status: 'passed', cases: 14, networkRequests: 0, credentialReads: 0,
    scope: 'authenticated Worker readiness, propagation retries, mode matching, timeout, interruption, Fetch and fresh HTTPS request boundaries and failure stages' }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
