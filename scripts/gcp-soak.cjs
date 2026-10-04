'use strict';
// A deliberately bounded deployed repetition probe. The orchestrator owns
// authentication, fixed Worker URLs, deployment identity and resource cleanup.
const { performance } = require('node:perf_hooks');

const MODES = Object.freeze(['grpc-web', 'cloudflare']);
const SOURCE = 'deployed-worker-http';
const LIMITS = Object.freeze({ maxInFlight: 2, minDispatchSpacingMs: 1000,
  maxRequests: 600, requestTimeoutMs: 30000, drainTimeoutMs: 30000 });
const STEP_IDS = ['initial-unary', 'expected-error', 'cancel-stream', 'recovered-unary'];
const STEP_KEYS = ['id', 'passed', 'statusCode', 'callbackCode', 'callbackCount',
  'errorCount', 'statusCount', 'messageCount', 'messagesMatch', 'detailsMatch', 'fetchCount', 'elapsedMs'];
const CLEANUP_ZERO = ['channelActiveCalls', 'activeCalls', 'queuedCalls', 'bufferedBytes',
  'activePumps', 'pendingMessages', 'pendingMessageBytes', 'pendingWriteCallbacks',
  'parserAssemblies', 'parserAssemblyBytes', 'runtimeChunkBytes', 'requestBytes',
  'responseBytes', 'timers', 'nonterminalCalls'];
const STEP_EXPECTED = [
  [0, 0, 1, 0, 1, 1], [3, 3, 1, 0, 1, 0], [1, null, 0, 1, 1, 1], [0, 0, 1, 0, 1, 1],
];
const STEP_COUNTS = ['statusCode', 'callbackCode', 'callbackCount', 'errorCount', 'statusCount', 'messageCount'];
const ROW_KEYS = ['id', 'slot', 'mode', 'source', 'kind', 'route', 'plannedAtMs',
  'startedAtMs', 'completedAtMs', 'startedOrder', 'completedOrder', 'durationMs', 'timeoutMs', 'status', 'reason',
  'timedOut', 'httpStatus', 'result'];
const STATUSES = ['passed', 'failed', 'missed', 'interrupted', 'pending'];
const REASONS = [null, 'http-status', 'response-schema', 'request-failed',
  'request-timeout', 'capacity', 'slot-expired', 'interrupted', 'drain-timeout'];

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const validSeconds = seconds => Number.isInteger(seconds) && seconds >= 60 && seconds <= 600;

function parseSoakSeconds(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new TypeError('Invalid soak arguments');
  const selected = argv.filter(value => value.startsWith('--soak-seconds'));
  if (!selected.length) return undefined;
  if (selected.length !== 1 || !/^--soak-seconds=(?:[1-9][0-9]*)$/.test(selected[0])) {
    throw new TypeError('Use one --soak-seconds=<integer 60..600>');
  }
  const seconds = Number(selected[0].slice('--soak-seconds='.length));
  if (!validSeconds(seconds)) throw new RangeError('Soak duration must be 60..600 seconds');
  return seconds;
}

function plannedRow(slot) {
  const mode = MODES[slot % MODES.length];
  const kind = (Math.floor(slot / MODES.length) + 1) % 6 === 0 ? 'sdk-read' : 'recovery';
  return { id: `soak-${String(slot + 1).padStart(4, '0')}`, slot, mode, source: SOURCE, kind,
    route: kind === 'recovery' ? `/echo/${mode}/recovery` : `/gcp/${mode}/secret-manager-read`,
    plannedAtMs: slot * LIMITS.minDispatchSpacingMs };
}

function validBody(body, row) {
  if (row.kind === 'sdk-read') {
    return exactKeys(body, ['suite', 'mode', 'status', 'checks', 'elapsedMs'])
      && body.suite === 'secret-manager-read' && body.mode === row.mode && body.status === 'passed'
      && same(body.checks, ['getSecret']) && finite(body.elapsedMs) && body.elapsedMs <= LIMITS.requestTimeoutMs;
  }
  if (!exactKeys(body, ['schemaVersion', 'name', 'mode', 'passed', 'clientCount', 'steps', 'cleanup', 'elapsedMs'])
    || body.schemaVersion !== 1 || body.name !== 'recovery' || body.mode !== row.mode
    || body.passed !== true || body.clientCount !== 1 || !finite(body.elapsedMs)
    || body.elapsedMs > LIMITS.requestTimeoutMs || !Array.isArray(body.steps) || body.steps.length !== STEP_IDS.length) return false;
  if (!body.steps.every((step, index) => exactKeys(step, STEP_KEYS) && step.id === STEP_IDS[index]
    && step.passed === true && step.messagesMatch === true && step.detailsMatch === true
    && step.fetchCount === 1 && finite(step.elapsedMs) && step.elapsedMs <= body.elapsedMs
    && STEP_COUNTS.every((key, field) => step[key] === STEP_EXPECTED[index][field]))) return false;
  if (body.steps.reduce((sum, step) => sum + step.elapsedMs, 0) > body.elapsedMs) return false;
  return exactKeys(body.cleanup, ['beforeClose', 'channelOpen', ...CLEANUP_ZERO, 'capturedCalls'])
    && body.cleanup.beforeClose === true && body.cleanup.channelOpen === true
    && body.cleanup.capturedCalls === 4 && CLEANUP_ZERO.every(key => body.cleanup[key] === 0);
}

function safeBody(body, row) {
  // Never copy arbitrary response fields, metadata, payloads or error strings.
  if (!validBody(body, row)) return null;
  if (row.kind === 'sdk-read') return { suite: 'secret-manager-read', mode: row.mode,
    status: 'passed', checks: ['getSecret'], elapsedMs: body.elapsedMs };
  return { schemaVersion: 1, name: 'recovery', mode: row.mode, passed: true, clientCount: 1,
    steps: body.steps.map(step => Object.fromEntries(STEP_KEYS.map(key => [key, step[key]]))),
    cleanup: { beforeClose: true, channelOpen: true, ...Object.fromEntries(CLEANUP_ZERO.map(key => [key, 0])), capturedCalls: 4 },
    elapsedMs: body.elapsedMs };
}

function latency(rows) {
  const samples = rows.filter(row => finite(row.durationMs)).map(row => row.durationMs).sort((a, b) => a - b);
  if (!samples.length) return { count: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  const percentile = percent => samples[Math.ceil(samples.length * percent) - 1];
  return { count: samples.length, min: samples[0], max: samples.at(-1),
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

function summarize(rows) {
  const counts = values => ({ planned: values.length, started: values.filter(row => row.startedAtMs !== null).length,
    completed: values.filter(row => row.completedAtMs !== null).length,
    ...Object.fromEntries(STATUSES.map(status => [status, values.filter(row => row.status === status).length])) });
  return { ...counts(rows), latencyMs: latency(rows), modes: Object.fromEntries(MODES.map(mode => {
    const values = rows.filter(row => row.mode === mode);
    return [mode, { ...counts(values), recoveryPassed: values.filter(row => row.kind === 'recovery' && row.status === 'passed').length,
      sdkReadPassed: values.filter(row => row.kind === 'sdk-read' && row.status === 'passed').length }];
  })) };
}

function waitMilliseconds(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('SOAK_WAIT_ABORTED')); return; }
    const finish = action => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); action(); };
    const onAbort = () => finish(() => reject(new Error('SOAK_WAIT_ABORTED')));
    const timer = setTimeout(() => finish(resolve), Math.ceil(ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function runDeployedSoak({ seconds, request, now = () => performance.now(), wait = waitMilliseconds, signal } = {}) {
  if (!validSeconds(seconds)) throw new RangeError('Soak duration must be 60..600 seconds');
  if (typeof request !== 'function' || typeof now !== 'function' || typeof wait !== 'function') throw new TypeError('Invalid soak dependencies');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid soak signal');
  const started = now();
  if (!finite(started)) throw new TypeError('Invalid monotonic clock');
  let previous = started;
  const elapsed = () => {
    const value = now();
    if (!finite(value) || value < previous) throw new Error('SOAK_CLOCK_NOT_MONOTONIC');
    previous = value;
    return value - started;
  };
  const durationMs = seconds * 1000;
  const rows = Array.from({ length: seconds }, (_, slot) => ({ ...plannedRow(slot),
    startedAtMs: null, completedAtMs: null, startedOrder: null, completedOrder: null, durationMs: null, timeoutMs: null,
    status: 'interrupted', reason: 'interrupted', timedOut: false, httpStatus: null, result: null }));
  const active = new Set();
  let lastDispatch = -Infinity, maxInFlightObserved = 0, pendingTimeouts = 0, eventOrder = 0;
  let interrupted = Boolean(signal?.aborted);
  const onAbort = () => {
    interrupted = true;
    for (const entry of active) { entry.interrupted = true; entry.controller.abort(); }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  function dispatch(row, dispatchTime) {
    const controller = new AbortController(), timerController = new AbortController();
    row.startedAtMs = dispatchTime;
    row.startedOrder = eventOrder++;
    row.timeoutMs = Math.min(LIMITS.requestTimeoutMs, durationMs + LIMITS.drainTimeoutMs - dispatchTime);
    row.status = 'pending'; row.reason = 'drain-timeout';
    const entry = { controller, timerController, task: null, interrupted: false };
    active.add(entry);
    maxInFlightObserved = Math.max(maxInFlightObserved, active.size);
    pendingTimeouts++;
    // A timed-out callback still owns its slot until the underlying request
    // settles. Ignoring AbortSignal can never create extra HTTP concurrency.
    const timeout = wait(row.timeoutMs, timerController.signal).then(() => {
      row.timedOut = true; controller.abort();
    }, () => {}).finally(() => { pendingTimeouts--; });
    entry.task = Promise.resolve().then(() => request({ id: row.id, mode: row.mode,
      route: row.route, timeoutMs: row.timeoutMs, signal: controller.signal })).then(response => {
      if (exactKeys(response, ['route', 'httpStatus', 'body'])) {
        if (Number.isInteger(response.httpStatus) && response.httpStatus >= 100 && response.httpStatus <= 599) row.httpStatus = response.httpStatus;
        if (response.route === row.route && response.httpStatus === 200) row.result = safeBody(response.body, row);
      }
      row.status = !row.timedOut && row.httpStatus === 200 && row.result !== null ? 'passed' : 'failed';
      row.reason = row.timedOut ? 'request-timeout' : row.status === 'passed' ? null
        : row.httpStatus !== 200 ? 'http-status' : 'response-schema';
    }, () => { row.status = 'failed'; row.reason = row.timedOut ? 'request-timeout' : 'request-failed'; }).finally(async () => {
      timerController.abort();
      await timeout;
      if (entry.interrupted) { row.status = 'failed'; row.reason = 'interrupted'; }
      row.completedAtMs = elapsed();
      row.completedOrder = eventOrder++;
      row.durationMs = row.completedAtMs - row.startedAtMs;
      active.delete(entry);
    });
    // Consume internal dependency failures; production now/wait cannot throw.
    // Their incomplete row remains a failed receipt, not an unhandled rejection.
    entry.task.catch(() => {});
  }

  try {
    for (const row of rows) {
      if (interrupted) break;
      const target = Math.max(row.plannedAtMs, lastDispatch + LIMITS.minDispatchSpacingMs);
      const wakeAt = Math.min(target, row.plannedAtMs + 1000);
      while (!interrupted) {
        const remaining = wakeAt - elapsed();
        if (remaining <= 0) break;
        try { await wait(Math.ceil(remaining), signal); }
        catch (error) { if (!interrupted) throw error; }
      }
      if (interrupted) break;
      const dispatchTime = elapsed();
      if (dispatchTime >= row.plannedAtMs + 1000 || dispatchTime >= durationMs) {
        row.status = 'missed'; row.reason = 'slot-expired'; continue;
      }
      if (active.size >= LIMITS.maxInFlight) { row.status = 'missed'; row.reason = 'capacity'; continue; }
      lastDispatch = dispatchTime;
      dispatch(row, dispatchTime);
    }
    while (!interrupted) {
      const remaining = durationMs - elapsed();
      if (remaining <= 0) break;
      try { await wait(Math.ceil(remaining), signal); }
      catch (error) { if (!interrupted) throw error; }
    }
    const observedMs = elapsed();
    const drainDeadline = Math.min(durationMs, observedMs) + LIMITS.drainTimeoutMs;
    if (active.size && elapsed() < drainDeadline) {
      const drainController = new AbortController();
      try {
        await Promise.race([Promise.allSettled([...active].map(entry => entry.task)),
          wait(drainDeadline - elapsed(), drainController.signal).catch(() => {})]);
      } finally { drainController.abort(); }
    }
    for (const entry of active) { entry.controller.abort(); entry.timerController.abort(); }
    // Let cancellation-aware fetches settle without adding another timer or an
    // unbounded wait. Noncooperative requests are explicitly retained below.
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    const finishedAtMs = elapsed();
    const summary = summarize(rows);
    const receipt = { schemaVersion: 1, source: SOURCE, releaseEligible: false,
      status: interrupted ? 'interrupted' : summary.passed === seconds && active.size === 0 && pendingTimeouts === 0 ? 'passed' : 'failed',
      durationSeconds: seconds, window: { durationMs, observedMs, completed: !interrupted && observedMs >= durationMs,
        drainMs: Math.max(0, finishedAtMs - observedMs), interrupted }, limits: { ...LIMITS },
      count: rows.length, started: summary.started, completed: summary.completed,
      maxInFlightObserved, observations: rows, summary,
      cleanup: { inFlight: active.size, pendingTimeouts } };
    // A dependency that ignores cancellation must not mutate a returned receipt
    // after its bounded drain has ended.
    return JSON.parse(JSON.stringify(receipt));
  } finally {
    signal?.removeEventListener('abort', onAbort);
    for (const entry of active) { entry.controller.abort(); entry.timerController.abort(); }
  }
}

function validateDeployedSoak(receipt) {
  const errors = [];
  const check = (condition, name) => { if (!condition) errors.push(name); };
  if (!exactKeys(receipt, ['schemaVersion', 'source', 'releaseEligible', 'status', 'durationSeconds',
    'window', 'limits', 'count', 'started', 'completed', 'maxInFlightObserved', 'observations', 'summary', 'cleanup'])) {
    return { ok: false, errors: ['receipt-schema'] };
  }
  check(receipt.schemaVersion === 1 && receipt.source === SOURCE && receipt.releaseEligible === false, 'receipt-identity');
  check(validSeconds(receipt.durationSeconds), 'duration');
  check(exactKeys(receipt.limits, Object.keys(LIMITS)) && Object.keys(LIMITS).every(key => receipt.limits[key] === LIMITS[key]), 'limits');
  const window = receipt.window;
  const validWindow = exactKeys(window, ['durationMs', 'observedMs', 'completed', 'drainMs', 'interrupted'])
    && window.durationMs === receipt.durationSeconds * 1000 && finite(window.observedMs) && finite(window.drainMs)
    && typeof window.completed === 'boolean' && typeof window.interrupted === 'boolean';
  check(validWindow, 'window-schema');
  if (validWindow) {
    check(window.completed === true && window.interrupted === false && window.observedMs >= window.durationMs, 'observation-window-incomplete');
    check(window.observedMs + window.drainMs <= window.durationMs + LIMITS.drainTimeoutMs + 1000, 'bounded-drain');
  }
  check(receipt.status === 'passed', 'receipt-not-passed');
  if (!Array.isArray(receipt.observations) || receipt.observations.length !== receipt.durationSeconds
    || receipt.observations.length > LIMITS.maxRequests || receipt.observations.length < 60) {
    check(false, 'planned-slot-count'); return { ok: false, errors };
  }
  const rows = receipt.observations;
  let lastDispatch = -Infinity;
  const events = [];
  for (let slot = 0; slot < rows.length; slot++) {
    const row = rows[slot], plan = plannedRow(slot), prefix = `observation:${plan.id}:`;
    if (!exactKeys(row, ROW_KEYS)) { check(false, prefix + 'schema'); continue; }
    check(Object.keys(plan).every(key => row[key] === plan[key]), prefix + 'identity');
    check(STATUSES.includes(row.status) && REASONS.includes(row.reason) && typeof row.timedOut === 'boolean', prefix + 'state');
    check(row.status === 'passed' && row.reason === null && row.timedOut === false, prefix + 'not-passed');
    const timesValid = finite(row.startedAtMs) && finite(row.completedAtMs) && finite(row.durationMs)
      && row.completedAtMs >= row.startedAtMs && row.durationMs === row.completedAtMs - row.startedAtMs;
    check(timesValid, prefix + 'timestamps');
    const orderValid = Number.isInteger(row.startedOrder) && row.startedOrder >= 0
      && Number.isInteger(row.completedOrder) && row.completedOrder > row.startedOrder;
    check(orderValid, prefix + 'event-order');
    if (timesValid) {
      check(row.startedAtMs >= plan.plannedAtMs && row.startedAtMs < plan.plannedAtMs + 1000, prefix + 'dispatch-slot');
      check(row.startedAtMs - lastDispatch >= LIMITS.minDispatchSpacingMs, prefix + 'dispatch-spacing');
      check(finite(row.timeoutMs) && row.timeoutMs > 0 && row.timeoutMs <= LIMITS.requestTimeoutMs
        && row.completedAtMs - row.startedAtMs <= row.timeoutMs
        && row.startedAtMs + row.timeoutMs <= receipt.durationSeconds * 1000 + LIMITS.drainTimeoutMs, prefix + 'timeout');
      if (validWindow) check(row.completedAtMs <= window.observedMs + window.drainMs, prefix + 'completion-after-receipt');
      lastDispatch = row.startedAtMs;
      if (orderValid) events.push({ order: row.startedOrder, at: row.startedAtMs, delta: 1 },
        { order: row.completedOrder, at: row.completedAtMs, delta: -1 });
    }
    check(row.httpStatus === 200 && validBody(row.result, row), prefix + 'response');
  }
  if (rows.some(row => !exactKeys(row, ROW_KEYS))) return { ok: false, errors };
  // Sequence numbers disambiguate a dispatch and completion occurring at the
  // same monotonic timestamp; callback cleanup still owns its admission slot.
  events.sort((left, right) => left.order - right.order);
  let current = 0, maximum = 0, lastEventAt = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    check(event.order === index && event.at >= lastEventAt, 'event-timeline');
    current += event.delta; maximum = Math.max(maximum, current); lastEventAt = event.at;
    check(current >= 0 && current <= LIMITS.maxInFlight, 'concurrency-window');
  }
  check(events.length === rows.length * 2 && current === 0 && receipt.maxInFlightObserved === maximum, 'concurrency');
  const summary = summarize(rows);
  check(same(receipt.summary, summary), 'summary');
  check(receipt.count === rows.length && receipt.started === summary.started && receipt.completed === summary.completed
    && receipt.started === receipt.durationSeconds && receipt.completed === receipt.durationSeconds, 'counts');
  check(MODES.every(mode => summary.modes[mode].recoveryPassed > 0 && summary.modes[mode].sdkReadPassed > 0), 'mode-outcomes');
  check(exactKeys(receipt.cleanup, ['inFlight', 'pendingTimeouts'])
    && receipt.cleanup.inFlight === 0 && receipt.cleanup.pendingTimeouts === 0, 'cleanup');
  return { ok: errors.length === 0, errors };
}

module.exports = { parseSoakSeconds, runDeployedSoak, validateDeployedSoak };
