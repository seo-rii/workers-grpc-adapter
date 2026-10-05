'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSoakSeconds, parseSoakBurst, runDeployedSoak, validateDeployedSoak, workerRequestFailure } = require('../scripts/gcp-soak.cjs');

// Advance a monotonic virtual clock to pending waits. Production still always
// runs 60..600 real seconds at one fixed slot per second; tests cannot configure
// a shorter production dispatch period or observation window.
function virtualClock() {
  let value = 50, order = 0;
  const pending = new Set();
  const clock = {
    now: () => value,
    pending,
    jump: milliseconds => { value += milliseconds; },
    wait: (ms, signal) => new Promise((resolve, reject) => {
      assert.ok(Number.isFinite(ms) && ms >= 0);
      if (signal?.aborted) { reject(new Error('abort')); return; }
      const item = { due: value + ms, order: order++, finish: null };
      const done = action => { pending.delete(item); signal?.removeEventListener('abort', abort); action(); };
      const abort = () => done(() => reject(new Error('abort')));
      item.finish = () => done(resolve);
      signal?.addEventListener('abort', abort, { once: true });
      pending.add(item);
    }),
    async drive(promise) {
      let finished = false, result, error;
      promise.then(value => { result = value; finished = true; }, value => { error = value; finished = true; });
      for (let turn = 0; turn < 10000 && !finished; turn++) {
        for (let microtask = 0; microtask < 64; microtask++) await Promise.resolve();
        if (finished) break;
        assert.ok(pending.size, 'virtual test deadlocked without a pending wait');
        const next = [...pending].sort((a, b) => a.due - b.due || a.order - b.order)[0];
        value = Math.max(value, next.due);
        for (const item of [...pending].filter(item => item.due <= value).sort((a, b) => a.order - b.order)) item.finish();
      }
      assert.ok(finished, 'virtual run exceeded bounded test schedule');
      if (error) throw error;
      return result;
    },
  };
  return clock;
}

function responseFor({ route, mode }) {
  if (route.startsWith('/gcp/')) return { route, httpStatus: 200,
    body: { suite: 'secret-manager-read', mode, status: 'passed', checks: ['getSecret'], elapsedMs: 10 } };
  const expected = [
    ['initial-unary', 0, 0, 1, 0, 1, 1], ['expected-error', 3, 3, 1, 0, 1, 0],
    ['cancel-stream', 1, null, 0, 1, 1, 1], ['recovered-unary', 0, 0, 1, 0, 1, 1],
  ];
  return { route, httpStatus: 200, body: { schemaVersion: 1, name: 'recovery', mode, passed: true, clientCount: 1,
    steps: expected.map(([id, statusCode, callbackCode, callbackCount, errorCount, statusCount, messageCount]) => ({
      id, passed: true, statusCode, callbackCode, callbackCount, errorCount, statusCount, messageCount,
      messagesMatch: true, detailsMatch: true, fetchCount: 1, elapsedMs: 2,
    })),
    cleanup: { beforeClose: true, channelOpen: true, channelActiveCalls: 0, activeCalls: 0, queuedCalls: 0,
      bufferedBytes: 0, activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
      parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0, requestBytes: 0,
      responseBytes: 0, timers: 0, nonterminalCalls: 0, capturedCalls: 4 }, elapsedMs: 10 } };
}

async function run({ seconds = 60, burst = false, delay = 10, mutate, request: customRequest, signal } = {}) {
  const clock = virtualClock(), requests = [];
  let active = 0, maximum = 0;
  const request = async plan => {
    requests.push({ id: plan.id, mode: plan.mode, route: plan.route, timeoutMs: plan.timeoutMs,
      dispatched: clock.now(), aborted: false });
    const row = requests.at(-1);
    plan.signal.addEventListener('abort', () => { row.aborted = true; }, { once: true });
    active++; maximum = Math.max(maximum, active);
    try {
      if (customRequest) return await customRequest(plan, clock, requests);
      await clock.wait(typeof delay === 'function' ? delay(plan, requests) : delay, plan.signal);
      const response = responseFor(plan);
      mutate?.(response, plan);
      return response;
    } finally { active--; }
  };
  const receipt = await clock.drive(runDeployedSoak({ seconds, burst, now: clock.now, wait: clock.wait, request, signal }));
  return { receipt, requests, maximum, active, clock };
}

test('deployed repetition is opt-in and rejects duplicate, malformed and unbounded durations', () => {
  assert.equal(parseSoakSeconds([]), undefined);
  assert.equal(parseSoakSeconds(['--catalog']), undefined);
  for (const seconds of [60, 90, 600]) assert.equal(parseSoakSeconds(['--catalog', `--soak-seconds=${seconds}`]), seconds);
  for (const args of [
    ['--soak-seconds'], ['--soak-seconds', '60'], ['--soak-seconds='], ['--soak-seconds=59'], ['--soak-seconds=601'],
    ['--soak-seconds=0'], ['--soak-seconds=-60'], ['--soak-seconds=60.0'], ['--soak-seconds=6e1'], ['--soak-seconds=060'],
    ['--soak-seconds=+60'], ['--soak-seconds=60 '], ['--soak-seconds=Infinity'], ['--soak-seconds-extra=60'],
    ['--soak-seconds=60', '--soak-seconds=60'], ['--soak-seconds=600', '--soak-seconds=60'], [null],
  ]) assert.throws(() => parseSoakSeconds(args), /soak|Soak/);
  assert.throws(() => parseSoakSeconds(null), /arguments/);
  assert.equal(parseSoakBurst([]), false);
  assert.equal(parseSoakBurst(['--soak-seconds=600']), false);
  assert.equal(parseSoakBurst(['--soak-seconds=600', '--soak-burst=4']), true);
  for (const args of [
    ['--soak-burst=4'], ['--soak-seconds=600', '--soak-burst'],
    ['--soak-seconds=600', '--soak-burst=2'],
    ['--soak-seconds=600', '--soak-burst=4', '--soak-burst=4'],
  ]) assert.throws(() => parseSoakBurst(args), /soak/);
});

test('four-request bursts overlap in both modes and retain the complete fixed window', async () => {
  const { receipt, requests, maximum, active } = await run({ burst: true, delay: 1500 });
  assert.deepEqual(validateDeployedSoak(receipt), { ok: true, errors: [] });
  assert.equal(receipt.schemaVersion, 3);
  assert.equal(receipt.limits.maxInFlight, 4);
  assert.equal(receipt.limits.dispatchPattern, 'burst4');
  assert.equal(receipt.maxInFlightObserved, 4);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.equal(receipt.count, 60);
  assert.equal(receipt.window.observedMs, 60000);
  for (let wave = 0; wave < 15; wave++) {
    const batch = receipt.observations.slice(wave * 4, wave * 4 + 4);
    assert.deepEqual(batch.map(row => row.mode), ['grpc-web', 'cloudflare', 'grpc-web', 'cloudflare']);
    assert.ok(batch.every(row => row.plannedAtMs === wave * 4000));
    assert.ok(batch.every(row => row.startedOrder < Math.min(...batch.map(item => item.completedOrder))));
  }
  assert.ok(requests.every((row, index) => index < 4 || row.dispatched - requests[index - 4].dispatched >= 4000));
});

test('burst capacity exhaustion is reported as a failed run with no extra dispatches', async () => {
  const { receipt, requests, maximum, active } = await run({ burst: true, delay: 4500 });
  assert.equal(receipt.status, 'failed');
  assert.equal(validateDeployedSoak(receipt).ok, false);
  assert.equal(maximum, 4);
  assert.equal(active, 0);
  assert.ok(receipt.summary.missed > 0);
  assert.ok(receipt.observations.filter(row => row.status === 'missed').every(row => row.reason === 'capacity'));
  assert.equal(receipt.started, requests.length);
});

test('burst receipts reject a forged concurrency claim or a changed wave schedule', async () => {
  const { receipt } = await run({ burst: true, delay: 500 });
  assert.equal(validateDeployedSoak(receipt).ok, true);
  const changed = structuredClone(receipt);
  changed.maxInFlightObserved = 3;
  assert.ok(validateDeployedSoak(changed).errors.includes('concurrency'));
  changed.maxInFlightObserved = 4;
  changed.observations[4].plannedAtMs = 1000;
  assert.ok(validateDeployedSoak(changed).errors.includes('observation:soak-0005:identity'));
  changed.observations[4].plannedAtMs = 4000;
  changed.limits.maxInFlight = 8;
  assert.ok(validateDeployedSoak(changed).errors.includes('limits'));
});

test('sixty real-time slots require both modes, fixed SDK reads, complete recovery steps and full observation window', async () => {
  const { receipt, requests, maximum, active, clock } = await run();
  assert.deepEqual(validateDeployedSoak(receipt), { ok: true, errors: [] });
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.releaseEligible, false);
  assert.equal(receipt.count, 60); assert.equal(receipt.started, 60); assert.equal(receipt.completed, 60);
  assert.equal(maximum, 1); assert.equal(active, 0); assert.equal(clock.pending.size, 0);
  assert.equal(receipt.window.observedMs, 60000); assert.equal(receipt.window.drainMs, 0);
  assert.deepEqual(receipt.summary.latencyMs, { count: 60, min: 10, max: 10, mean: 10, p50: 10, p95: 10, p99: 10 });
  assert.ok(requests.every((row, index) => index === 0 || row.dispatched - requests[index - 1].dispatched >= 1000));
  for (const mode of ['grpc-web', 'cloudflare']) {
    assert.equal(receipt.summary.modes[mode].planned, 30);
    assert.equal(receipt.summary.modes[mode].recoveryPassed, 25);
    assert.equal(receipt.summary.modes[mode].sdkReadPassed, 5);
  }
  assert.deepEqual(requests.slice(10, 12).map(row => row.route), ['/gcp/grpc-web/secret-manager-read', '/gcp/cloudflare/secret-manager-read']);
  assert.ok(requests.every(row => row.timeoutMs === 30000 && !row.aborted));
  assert.ok(receipt.observations.every(row => row.failure === null));
});

test('hard request maximum is 600 with two in-flight HTTP requests and no injected production rate option', async () => {
  const { receipt, maximum } = await run({ seconds: 600, delay: 1500 });
  assert.deepEqual(validateDeployedSoak(receipt), { ok: true, errors: [] });
  assert.equal(receipt.count, 600); assert.equal(receipt.maxInFlightObserved, 2); assert.equal(maximum, 2);
  assert.equal(receipt.window.observedMs, 600000); assert.equal(receipt.window.drainMs, 500);
  for (const row of receipt.observations) assert.ok(row.timeoutMs <= 30000 && row.startedAtMs + row.timeoutMs <= 630000);
});

test('completion ties and generated mixed-latency schedules preserve admission and receipt invariants', async () => {
  let state = 0x3452f1a9;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let schedule = 0; schedule < 64; schedule++) {
    const delays = [0, 1, 999, 1000, 1001, 1999, 2000, 2001, 2999, 3000, 3001, 30000, 30001];
    const selected = schedule < delays.length ? Array(60).fill(delays[schedule])
      : Array.from({ length: 60 }, () => delays[next() % delays.length]);
    const { receipt, maximum, active, requests } = await run({ delay: (_plan, requests) => selected[requests.length - 1] });
    assert.ok(maximum <= 2 && receipt.maxInFlightObserved <= 2, `schedule ${schedule} exceeded concurrency`);
    assert.equal(active, 0);
    assert.equal(receipt.started, requests.length);
    assert.equal(receipt.completed, requests.length);
    assert.deepEqual(receipt.cleanup, { inFlight: 0, pendingTimeouts: 0 });
    assert.ok(requests.every((row, index) => index === 0 || row.dispatched - requests[index - 1].dispatched >= 1000));
    assert.equal(validateDeployedSoak(receipt).ok, receipt.status === 'passed', `schedule ${schedule}: ${validateDeployedSoak(receipt).errors.join(',')}`);
  }
});

test('fractional early timer wakeups cannot violate dispatch spacing or shorten the observation window', async () => {
  const clock = virtualClock();
  const receipt = await clock.drive(runDeployedSoak({ seconds: 60, now: clock.now,
    wait: (ms, signal) => clock.wait(signal ? ms : Math.max(0.25, ms - 0.25), signal),
    request: async plan => { await clock.wait(0.2, plan.signal); return responseFor(plan); },
  }));
  assert.deepEqual(validateDeployedSoak(receipt), { ok: true, errors: [] });
  assert.ok(receipt.window.observedMs >= 60000);
  assert.ok(receipt.observations.every((row, index, rows) => index === 0 || row.startedAtMs - rows[index - 1].startedAtMs >= 1000));
});

test('slow responses retain admission ownership and fail missed slots without catch-up or hidden work', async () => {
  const { receipt, requests, maximum, active } = await run({ delay: 3500 });
  assert.equal(receipt.status, 'failed'); assert.equal(validateDeployedSoak(receipt).ok, false);
  assert.equal(maximum, 2); assert.equal(active, 0);
  assert.ok(receipt.summary.missed > 0);
  assert.ok(receipt.observations.filter(row => row.status === 'missed').every(row => row.reason === 'capacity'));
  assert.equal(receipt.started + receipt.summary.missed, 60);
  assert.equal(requests.length, receipt.started);
  assert.ok(requests.every((row, index) => index === 0 || row.dispatched - requests[index - 1].dispatched >= 1000));
  assert.deepEqual(receipt.cleanup, { inFlight: 0, pendingTimeouts: 0 });
});

test('late event-loop scheduling misses expired slots and never dispatches a burst', async () => {
  const { receipt, requests } = await run({ request: async (plan, clock, requests) => {
    if (requests.length === 1) clock.jump(4500);
    return responseFor(plan);
  } });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.observations[1].reason, 'slot-expired');
  assert.equal(receipt.observations[2].reason, 'slot-expired');
  assert.equal(receipt.observations[3].reason, 'slot-expired');
  assert.ok(requests.every((row, index) => index === 0 || row.dispatched - requests[index - 1].dispatched >= 1000));
  assert.ok(receipt.observations.filter(row => row.startedAtMs !== null).every(row => row.startedAtMs < 60000));
});

test('request deadline aborts at 30 seconds and cannot turn a late success into a pass', async () => {
  const { receipt, requests, maximum, active } = await run({ delay: 31000 });
  assert.equal(receipt.status, 'failed'); assert.equal(validateDeployedSoak(receipt).ok, false);
  assert.equal(maximum, 2); assert.equal(active, 0);
  assert.ok(requests.every(row => row.aborted));
  assert.ok(receipt.observations.filter(row => row.completedAtMs !== null).every(row =>
    row.reason === 'request-timeout' && row.timedOut === true && row.durationMs === 30000));
  assert.ok(receipt.window.observedMs + receipt.window.drainMs <= 90000);
  assert.deepEqual(receipt.cleanup, { inFlight: 0, pendingTimeouts: 0 });
});

test('a callback that ignores cancellation never releases capacity and has a bounded failed drain', async () => {
  const { receipt, requests, maximum, clock } = await run({ request: async (plan, clock) => {
    await clock.wait(200000); return responseFor(plan);
  } });
  assert.equal(receipt.started, 2); assert.equal(receipt.completed, 0);
  assert.equal(receipt.summary.pending, 2); assert.equal(receipt.summary.missed, 58);
  assert.equal(receipt.status, 'failed'); assert.equal(validateDeployedSoak(receipt).ok, false);
  assert.equal(maximum, 2); assert.ok(requests.every(row => row.aborted));
  assert.equal(receipt.window.observedMs, 60000); assert.equal(receipt.window.drainMs, 30000);
  assert.deepEqual(receipt.cleanup, { inFlight: 2, pendingTimeouts: 0 });
  const frozen = JSON.stringify(receipt);
  clock.jump(300000);
  for (const item of [...clock.pending]) item.finish();
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
  assert.equal(JSON.stringify(receipt), frozen, 'late completions cannot rewrite returned evidence');
});

test('pre-interruption performs no work and cannot pass a forged zero-work summary', async () => {
  const controller = new AbortController(); controller.abort();
  const { receipt, requests, clock } = await run({ signal: controller.signal });
  assert.equal(receipt.status, 'interrupted'); assert.equal(receipt.started, 0); assert.equal(receipt.completed, 0);
  assert.equal(receipt.window.completed, false); assert.equal(receipt.window.observedMs, 0);
  assert.equal(receipt.summary.interrupted, 60); assert.equal(requests.length, 0); assert.equal(clock.pending.size, 0);
  receipt.status = 'passed';
  assert.equal(validateDeployedSoak(receipt).ok, false);
});

test('interrupt synchronously aborts owned HTTP before caller abort returns and stops dispatch', async () => {
  const controller = new AbortController();
  let synchronouslyAborted = false;
  const { receipt, requests, active, clock } = await run({ signal: controller.signal,
    request: async (plan, clock) => {
      if (plan.id === 'soak-0001') {
        await clock.wait(250); controller.abort(); synchronouslyAborted = plan.signal.aborted;
      }
      await clock.wait(1750, plan.signal);
      return responseFor(plan);
    } });
  assert.equal(synchronouslyAborted, true);
  assert.equal(requests.length, 1); assert.equal(requests[0].aborted, true); assert.equal(active, 0);
  assert.equal(receipt.status, 'interrupted'); assert.equal(receipt.window.observedMs, 250);
  assert.equal(receipt.window.drainMs, 0); assert.equal(receipt.completed, 1);
  assert.equal(receipt.summary.failed, 1); assert.equal(receipt.summary.interrupted, 59);
  assert.equal(receipt.observations[0].reason, 'interrupted');
  assert.equal(validateDeployedSoak(receipt).ok, false); assert.equal(clock.pending.size, 0);
});

test('interrupted callbacks retain ownership until they acknowledge abort or the bounded drain expires', async () => {
  const controller = new AbortController();
  const { receipt, requests } = await run({ signal: controller.signal, request: async (plan, clock) => {
    await clock.wait(250); controller.abort();
    await clock.wait(200000);
    return responseFor(plan);
  } });
  assert.equal(requests.length, 1); assert.equal(requests[0].aborted, true);
  assert.equal(receipt.status, 'interrupted'); assert.equal(receipt.window.observedMs, 250);
  assert.equal(receipt.window.drainMs, 30000); assert.equal(receipt.completed, 0);
  assert.deepEqual(receipt.cleanup, { inFlight: 1, pendingTimeouts: 0 });
  assert.equal(validateDeployedSoak(receipt).ok, false);
});

test('request throw and rejected bodies cannot leak arbitrary error, metadata or payload fields', async () => {
  const marker = 'token-and-secret-payload-must-not-appear';
  for (const request of [
    () => { throw new Error(marker); },
    plan => ({ ...responseFor(plan), payload: marker }),
    plan => { const value = responseFor(plan); value.body.payload = marker; return value; },
    plan => ({ route: plan.route, httpStatus: 500, body: { message: marker, details: marker, token: marker } }),
    plan => { const value = responseFor(plan); value.body.mode = marker; return value; },
  ]) {
    const { receipt } = await run({ request });
    assert.equal(receipt.status, 'failed'); assert.equal(validateDeployedSoak(receipt).ok, false);
    assert.equal(JSON.stringify(receipt).includes(marker), false);
    assert.ok(receipt.observations.every(row => row.result === null));
    assert.deepEqual(receipt.cleanup, { inFlight: 0, pendingTimeouts: 0 });
  }
});

test('worker failure wrappers retain only fixed HTTP phases and allowlisted error atoms', async () => {
  const marker = 'private-token-URL-host-header-payload-must-not-appear';
  const cases = [
    { phase: 'fetch', error: Object.assign(new TypeError(marker), { cause: { code: 'ECONNRESET', host: marker } }),
      expected: { phase: 'fetch', name: 'TypeError', code: 'ECONNRESET' }, httpStatus: null },
    { phase: 'fetch', error: new DOMException(marker, 'AbortError'),
      expected: { phase: 'fetch', name: 'AbortError', code: 'UNKNOWN' }, httpStatus: null },
    { phase: 'response-body', error: Object.assign(new Error(marker), { code: 'UND_ERR_BODY_TIMEOUT' }),
      expected: { phase: 'response-body', name: 'Error', code: 'UND_ERR_BODY_TIMEOUT' }, httpStatus: 503 },
    { phase: 'response-body', error: Object.assign(new Error(marker), { code: 'WGA_WORKER_HTTP_BODY_TOO_LARGE' }),
      expected: { phase: 'response-body', name: 'Error', code: 'WGA_WORKER_HTTP_BODY_TOO_LARGE' }, httpStatus: 200 },
    { phase: 'fetch', error: Object.assign(new Error(marker), { code: 'WGA_WORKER_HTTP_STATUS_INVALID' }),
      expected: { phase: 'fetch', name: 'Error', code: 'WGA_WORKER_HTTP_STATUS_INVALID' }, httpStatus: null },
    { phase: 'response-body', error: Object.assign(new TypeError(marker), { cause: { code: 'UND_ERR_SOCKET', socket: marker } }),
      expected: { phase: 'response-body', name: 'TypeError', code: 'UND_ERR_SOCKET' }, httpStatus: 200 },
    { phase: 'fetch', error: Object.assign(new Error(marker), { code: marker, cause: { code: 'ENOTFOUND' } }),
      expected: { phase: 'fetch', name: 'Error', code: 'ENOTFOUND' }, httpStatus: null },
    { phase: 'fetch', error: Object.assign(new Error(marker), { code: 'ECONNRESET', cause: { code: 'ENOTFOUND' } }),
      expected: { phase: 'fetch', name: 'Error', code: 'ECONNRESET' }, httpStatus: null },
    { phase: 'fetch', error: { name: marker, code: marker, message: marker, cause: { code: marker, message: marker } },
      expected: { phase: 'fetch', name: 'UnknownError', code: 'UNKNOWN' }, httpStatus: null },
    { phase: 'fetch', error: { get name() { throw new Error(marker); }, get code() { throw new Error(marker); },
        get cause() { throw new Error(marker); } },
      expected: { phase: 'fetch', name: 'UnknownError', code: 'UNKNOWN' }, httpStatus: null },
    { phase: 'fetch', error: Object.assign(new Error(marker), { cause: { cause: { code: 'ECONNRESET' } } }),
      expected: { phase: 'fetch', name: 'Error', code: 'UNKNOWN' }, httpStatus: null },
    { phase: 'fetch', error: { name: new String('Error'), code: new String('ECONNRESET') },
      expected: { phase: 'fetch', name: 'UnknownError', code: 'UNKNOWN' }, httpStatus: null },
    { phase: 'fetch', error: new DOMException(marker, 'TimeoutError'),
      expected: { phase: 'fetch', name: 'TimeoutError', code: 'UNKNOWN' }, httpStatus: null },
    { phase: 'fetch', error: marker,
      expected: { phase: 'fetch', name: 'UnknownError', code: 'UNKNOWN' }, httpStatus: null },
  ];
  const { receipt, requests } = await run({ request: plan => {
    const selected = cases[(Number(plan.id.slice(5)) - 1) % cases.length];
    const wrapped = workerRequestFailure(selected.phase, selected.error, selected.httpStatus);
    assert.ok(wrapped instanceof Error); assert.equal(wrapped.message, 'WGA_WORKER_REQUEST_FAILED');
    assert.equal(wrapped.cause, undefined); assert.equal(Object.isFrozen(wrapped), true);
    assert.equal(JSON.stringify(wrapped).includes(marker), false);
    assert.equal(wrapped.stack.includes(marker), false);
    throw wrapped;
  } });
  assert.equal(receipt.status, 'failed'); assert.equal(requests.length, 60);
  assert.equal(receipt.started, 60); assert.equal(receipt.completed, 60);
  for (const row of receipt.observations) {
    const selected = cases[row.slot % cases.length];
    assert.deepEqual(row.failure, selected.expected);
    assert.equal(row.httpStatus, selected.httpStatus);
    assert.equal(row.reason, 'request-failed'); assert.equal(row.timedOut, false); assert.equal(row.result, null);
  }
  assert.equal(JSON.stringify(receipt).includes(marker), false);
  const verified = validateDeployedSoak(receipt);
  assert.equal(verified.ok, false);
  assert.ok(verified.errors.every(error => !error.endsWith(':diagnostics')), 'authentic failure diagnostics remain structurally valid');
});

test('unknown callback throws cannot forge branded HTTP diagnostics', async () => {
  const forged = Object.assign(new Error('private callback error'), {
    name: 'WorkerRequestError', code: 'WGA_WORKER_REQUEST_FAILED', httpStatus: 503,
    failure: { phase: 'response-body', name: 'TypeError', code: 'UND_ERR_SOCKET' },
    cause: { code: 'ECONNRESET' },
  });
  const { receipt } = await run({ request: () => { throw forged; } });
  assert.equal(receipt.status, 'failed');
  assert.ok(receipt.observations.every(row => row.httpStatus === null));
  for (const row of receipt.observations) assert.deepEqual(row.failure,
    { phase: 'request', name: 'UnknownError', code: 'UNKNOWN_REQUEST_FAILURE' });
  assert.equal(JSON.stringify(receipt).includes('private callback error'), false);
  for (const [phase, status] of [['request', null], ['fetch', 200], ['response-body', null],
    ['response-body', 99], ['response-body', 600], ['response-body', '200'], ['response-body', NaN]]) {
    assert.throws(() => workerRequestFailure(phase, forged, status), /classification/);
  }
});

test('timeout and interruption retain safe failure diagnostics without changing termination behavior', async () => {
  const timeout = await run({ request: async (plan, clock) => {
    try { await clock.wait(31000, plan.signal); }
    catch { throw workerRequestFailure('fetch', Object.assign(new Error('private timeout'), { name: 'AbortError', code: 'ABORT_ERR' })); }
    return responseFor(plan);
  } });
  assert.equal(timeout.receipt.status, 'failed');
  assert.ok(timeout.requests.every(row => row.aborted));
  for (const row of timeout.receipt.observations.filter(row => row.completedAtMs !== null)) {
    assert.equal(row.reason, 'request-timeout'); assert.equal(row.timedOut, true);
    assert.deepEqual(row.failure, { phase: 'fetch', name: 'AbortError', code: 'ABORT_ERR' });
  }
  const controller = new AbortController();
  const interrupted = await run({ signal: controller.signal, request: async (plan, clock) => {
    await clock.wait(250); controller.abort();
    try { await clock.wait(1000, plan.signal); }
    catch { throw workerRequestFailure('response-body', new DOMException('private canceled body', 'AbortError'), 200); }
    return responseFor(plan);
  } });
  assert.equal(interrupted.receipt.status, 'interrupted'); assert.equal(interrupted.requests.length, 1);
  const row = interrupted.receipt.observations[0];
  assert.equal(row.reason, 'interrupted'); assert.equal(row.httpStatus, 200); assert.equal(row.timedOut, false);
  assert.deepEqual(row.failure, { phase: 'response-body', name: 'AbortError', code: 'UNKNOWN' });
  assert.equal(validateDeployedSoak(interrupted.receipt).ok, false);
  assert.ok(validateDeployedSoak(interrupted.receipt).errors.every(error => !error.endsWith(':diagnostics')));
});

test('generated private errors cannot introduce new diagnostic values or sensitive receipt fields', async () => {
  let state = 0x2718ab61;
  const next = () => { state = (Math.imul(state, 1103515245) + 12345) >>> 0; return state; };
  const cases = Array.from({ length: 60 }, (_, index) => {
    const privateText = `private-${index}-${next().toString(16)}-https://sensitive.invalid/token`;
    const name = index % 3 === 0 ? 'TypeError' : privateText;
    const directCode = index % 4 === 0 ? 'EPIPE' : privateText;
    const causeCode = index % 5 === 0 ? 'UND_ERR_SOCKET' : privateText;
    return { privateText, error: { name, code: directCode, message: privateText, stack: privateText,
      url: privateText, headers: { authorization: privateText }, body: privateText,
      cause: { name: privateText, code: causeCode, message: privateText, host: privateText, cause: { code: 'ECONNRESET' } } },
      expected: { phase: index % 2 ? 'response-body' : 'fetch', name: name === 'TypeError' ? name : 'UnknownError',
        code: directCode === 'EPIPE' ? directCode : causeCode === 'UND_ERR_SOCKET' ? causeCode : 'UNKNOWN' } };
  });
  const { receipt } = await run({ request: plan => {
    const item = cases[Number(plan.id.slice(5)) - 1];
    throw workerRequestFailure(item.expected.phase, item.error, item.expected.phase === 'fetch' ? null : 502);
  } });
  const encoded = JSON.stringify(receipt);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.started, 60); assert.equal(receipt.completed, 60);
  for (const [index, row] of receipt.observations.entries()) {
    assert.deepEqual(row.failure, cases[index].expected);
    assert.equal(encoded.includes(cases[index].privateText), false);
  }
  assert.ok(validateDeployedSoak(receipt).errors.every(error => !error.endsWith(':diagnostics')));
});

test('strict diagnostics reject inconsistent, arbitrary and tampered failure claims', async () => {
  const { receipt } = await run({ request: () => {
    throw workerRequestFailure('response-body', Object.assign(new TypeError('private'), { cause: { code: 'UND_ERR_SOCKET' } }), 503);
  } });
  const mutations = [
    row => { row.failure = null; }, row => { row.failure = {}; },
    row => { row.failure.phase = 'dns'; }, row => { row.failure.phase = 'fetch'; },
    row => { row.failure.name = 'private-error-name'; }, row => { row.failure.code = 'private-code'; },
    row => { row.failure.message = 'private'; }, row => { row.failure.code = 'UNKNOWN_REQUEST_FAILURE'; },
    row => { row.httpStatus = null; }, row => { row.httpStatus = '503'; }, row => { row.httpStatus = 700; },
    row => { row.reason = 'http-status'; }, row => { row.reason = 'response-schema'; },
    row => { row.status = 'passed'; }, row => { row.result = { arbitrary: true }; },
    row => { row.failure = { phase: 'request', name: 'Error', code: 'UNKNOWN_REQUEST_FAILURE' }; row.httpStatus = null; },
    row => { row.failure = { phase: 'request', name: 'UnknownError', code: 'ECONNRESET' }; row.httpStatus = null; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const forged = structuredClone(receipt); mutate(forged.observations[0]);
    const checked = validateDeployedSoak(forged);
    assert.equal(checked.ok, false);
    assert.ok(checked.errors.includes('observation:soak-0001:diagnostics'), `diagnostic mutation ${index} was accepted`);
  }
  const legacy = structuredClone(receipt); legacy.schemaVersion = 1;
  for (const row of legacy.observations) delete row.failure;
  assert.equal(validateDeployedSoak(legacy).ok, false, 'old receipts are not silently upgraded');
});

test('strict deployed receipts reject forged identity, timestamps, summary, steps and cleanup', async () => {
  const { receipt } = await run({ delay: 1500 });
  assert.equal(validateDeployedSoak(receipt).ok, true);
  const mutations = [
    row => { row.schemaVersion = 1; }, row => { row.source = 'local-workerd'; }, row => { row.releaseEligible = true; },
    row => { row.count++; }, row => { row.started--; }, row => { row.completed--; },
    row => { row.maxInFlightObserved = 1; }, row => { row.limits.maxInFlight = 3; },
    row => { row.window.observedMs = 59000; }, row => { row.window.completed = false; },
    row => { row.window.interrupted = true; }, row => { row.window.drainMs = 31001; },
    row => { row.observations.pop(); }, row => { row.observations[1] = structuredClone(row.observations[0]); },
    row => { row.observations[0] = null; }, row => { row.observations[0].id = 'invented'; },
    row => { row.observations[0].source = 'native-grpc'; }, row => { row.observations[0].route = '/arbitrary'; },
    row => { row.observations[0].mode = 'cloudflare'; }, row => { row.observations[0].slot = 100; },
    row => { row.observations[0].plannedAtMs = 1; }, row => { row.observations[0].startedAtMs = 1000; },
    row => { row.observations[0].startedOrder = 10; }, row => { row.observations[0].completedOrder = 0; },
    row => { row.observations[0].durationMs++; }, row => { row.observations[0].timeoutMs = 30001; },
    row => { row.observations[0].timedOut = true; }, row => { row.observations[0].httpStatus = '200'; },
    row => { row.observations[0].failure = { phase: 'fetch', name: 'Error', code: 'ECONNRESET' }; },
    row => { row.observations[0].result.mode = 'cloudflare'; }, row => { row.observations[0].result.clientCount = 4; },
    row => { row.observations[0].result.steps.reverse(); }, row => { row.observations[0].result.steps.pop(); },
    row => { row.observations[0].result.steps[2].callbackCount = 1; },
    row => { row.observations[0].result.steps[2].statusCode = 0; },
    row => { row.observations[0].result.steps[2].messageCount = 2; },
    row => { row.observations[0].result.steps[0].messagesMatch = false; },
    row => { row.observations[0].result.steps[1].detailsMatch = false; },
    row => { row.observations[0].result.steps[0].elapsedMs = -1; },
    row => { for (const step of row.observations[0].result.steps) step.elapsedMs = 5; },
    row => { row.observations[0].result.cleanup.activeCalls = 1; },
    row => { row.observations[0].result.cleanup.channelOpen = false; },
    row => { row.observations[0].result.cleanup.beforeClose = false; },
    row => { row.observations[0].result.cleanup.capturedCalls = 3; },
    row => { row.observations[10].result.checks = []; }, row => { row.observations[10].result.suite = 'secret-manager-catalog'; },
    row => { row.summary.passed--; }, row => { row.summary.modes['cloudflare'].sdkReadPassed = 0; },
    row => { row.summary.latencyMs.p99 = 10; }, row => { row.cleanup.inFlight = 1; },
    row => { row.cleanup.pendingTimeouts = 1; }, row => { row.payload = 'extra'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const forged = structuredClone(receipt); mutate(forged);
    assert.equal(validateDeployedSoak(forged).ok, false, `mutation ${index} was accepted`);
  }
  for (const malformed of [undefined, null, [], {}, { status: 'passed' }]) assert.equal(validateDeployedSoak(malformed).ok, false);
});

test('invalid monotonic clock and production duration inputs reject before creating HTTP work', async () => {
  let requests = 0;
  for (const seconds of [undefined, 0, 59, 601, 60.1, '60', NaN]) {
    await assert.rejects(runDeployedSoak({ seconds, request: () => { requests++; } }), /duration/);
  }
  await assert.rejects(runDeployedSoak({ seconds: 60, request: () => { requests++; }, now: () => NaN }), /clock/);
  let calls = 0;
  await assert.rejects(runDeployedSoak({ seconds: 60, request: () => { requests++; }, now: () => ++calls === 1 ? 10 : 9 }), /MONOTONIC/);
  await assert.rejects(runDeployedSoak({ seconds: 60, request: () => { requests++; }, signal: {} }), /signal/);
  assert.equal(requests, 0);
});
