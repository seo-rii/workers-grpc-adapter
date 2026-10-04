'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the real orchestration block without credential discovery or cloud
// creation. Receipt semantics have independent strict-validator/property tests.
const source = fs.readFileSync(path.join(__dirname, '../scripts/gcp-cloud-probe.cjs'), 'utf8');
const start = source.indexOf('  if (report.authRenewalRequested) {\n');
const end = source.indexOf('  if (report.soakRequested) {\n', start);
assert.ok(start >= 0 && end > start);
const block = source.slice(start, end);
function harness({ native, worker, interrupted = false } = {}) {
  const report = { authRenewalRequested: true }, calls = [];
  const context = { report, interrupted, AbortController, AbortSignal,
    credentialController: undefined, env: {}, save() {}, phase(value) { calls.push({ phase: value }); },
    controls: { async runNativeCredentialRenewal(env, { signal }) {
      calls.push({ mode: 'native', signal });
      return native ? native(signal) : { mode: 'native', verified: true };
    } },
    async workerRequest(route, authorized, mode, timeoutMs, signal) {
      calls.push({ route, authorized, mode, timeoutMs, signal });
      return worker ? worker(mode, signal) : { httpStatus: 200, body: { mode, verified: true } };
    },
    validateCredentialRenewal(value, { mode }) {
      const valid = value?.verified === true && value.mode === mode;
      return { valid, errors: valid ? [] : ['INVALID_RECEIPT'] };
    },
  };
  const run = vm.runInNewContext(`(async () => {${block}})`, context);
  return { run, context, report, calls };
}

test('renewal runner starts all three controls and validates each matching mode', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = harness({ native: async () => { await waiting; return { mode: 'native', verified: true }; },
    worker: async mode => { await waiting; return { httpStatus: 200, body: { mode, verified: true } }; } });
  const completion = h.run();
  assert.equal(h.calls.filter(call => call.mode).length, 3);
  release(); await completion;
  assert.equal(h.report.authRenewal.status, 'passed');
  assert.deepEqual(Array.from(h.report.authRenewal.results, row => row.mode), ['native', 'grpc-web', 'cloudflare']);
  for (const call of h.calls.filter(call => call.route)) {
    assert.equal(call.authorized, true);
    assert.equal(call.timeoutMs, 150000);
    assert.equal(call.route, `/gcp/${call.mode}/auth-renewal`);
    assert.ok(call.signal instanceof AbortSignal);
  }
  assert.equal(h.context.credentialController, undefined);
});

test('renewal runner retains completed peers and discards rejected native error details', async () => {
  const marker = 'private-native-error-do-not-persist';
  const h = harness({ native: async () => { throw new Error(marker); } });
  await assert.rejects(h.run(), /AUTH_RENEWAL_FAILED/);
  assert.equal(h.report.authRenewal.status, 'failed');
  assert.equal(h.report.authRenewal.results.filter(row => row.status === 'passed').length, 2);
  assert.equal(h.report.authRenewal.results[0].code, 'AUTH_RENEWAL_REQUEST_FAILED');
  assert.ok(!JSON.stringify(h.report).includes(marker));
  assert.equal(h.context.credentialController, undefined);
});

test('HTTP failure and invalid renewal receipts never copy remote bodies', async () => {
  const marker = 'private-remote-body-do-not-persist';
  const h = harness({ worker: async mode => ({ httpStatus: mode === 'grpc-web' ? 503 : 200,
    body: { token: marker, mode, verified: false } }) });
  await assert.rejects(h.run(), /AUTH_RENEWAL_FAILED/);
  const results = h.report.authRenewal.results;
  assert.equal(results[0].status, 'passed');
  assert.equal(results[1].code, 'AUTH_RENEWAL_HTTP_FAILED');
  assert.equal(results[1].httpStatus, 503);
  assert.equal(results[2].code, 'AUTH_RENEWAL_INVALID_RECEIPT');
  assert.ok(!JSON.stringify(h.report).includes(marker));
});

test('interruption aborts the shared campaign signal and retains cleanup control', async () => {
  const h = harness({ native: signal => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const completion = h.run();
  h.context.interrupted = true;
  h.context.credentialController.abort();
  await assert.rejects(completion, /INTERRUPTED/);
  assert.equal(h.report.authRenewal.status, 'failed');
  assert.ok(h.calls.filter(call => call.mode).every(call => call.signal.aborted));
  assert.equal(h.context.credentialController, undefined);
  const beforeStart = harness({ interrupted: true });
  await assert.rejects(beforeStart.run(), /INTERRUPTED/);
  assert.equal(beforeStart.calls.length, 0);
});
