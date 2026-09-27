'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const fc = require('fast-check');
const { ResourceBudget, validateResourceLimits } = require('../dist/resources.js');
const { WorkersGrpcConfigurationError, status } = require('../dist/status.js');
const exhausted = diagnostic => ({ code: status.RESOURCE_EXHAUSTED, diagnostic });
const counts = budget => {
  const { activeCalls, queuedCalls, bufferedBytes } = budget.diagnostics();
  return { activeCalls, queuedCalls, bufferedBytes };
};

test('RESOURCE limits validate independently and snapshots cannot be mutated', () => {
  assert.deepEqual(validateResourceLimits(), {});
  const input = { maxConcurrentCalls: 2, maxQueuedCalls: 0, maxBufferedBytes: 2147483647, readableHighWaterMark: 1 };
  const snapshot = validateResourceLimits(input); input.maxConcurrentCalls = 99;
  assert.deepEqual(snapshot, { maxConcurrentCalls: 2, maxQueuedCalls: 0, maxBufferedBytes: 2147483647, readableHighWaterMark: 1 });
  assert.ok(Object.isFrozen(snapshot));
  for (const key of ['maxConcurrentCalls', 'maxQueuedCalls', 'maxBufferedBytes', 'readableHighWaterMark']) {
    for (const value of [null, '1', true, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, ...(key === 'maxQueuedCalls' ? [] : [0])]) {
      assert.throws(() => validateResourceLimits({ maxConcurrentCalls: 1, [key]: value }), error => error instanceof WorkersGrpcConfigurationError && error.code === 'WGA_INVALID_CONFIG');
    }
  }
  for (const value of [null, [], false, { surprise: 1 }, { maxQueuedCalls: 0 }, { maxBufferedBytes: 2147483648 }]) {
    assert.throws(() => validateResourceLimits(value), { code: 'WGA_INVALID_CONFIG' });
  }
});

test('RESOURCE omitted limits allow independent admission and byte ownership', async () => {
  const budget = new ResourceBudget(), releases = await Promise.all(Array.from({ length: 25 }, () => budget.acquire()));
  const lease = budget.reserve(10);
  assert.deepEqual(counts(budget), { activeCalls: 25, queuedCalls: 0, bufferedBytes: 10 });
  releases.forEach(release => { release(); release(); });
  assert.deepEqual(counts(budget), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 10 });
  lease.release(); lease.release();
  assert.deepEqual(budget.diagnostics(), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: 25, peakQueuedCalls: 0, peakBufferedBytes: 10 });
});

test('RESOURCE call admission is FIFO, bounded, and idempotent through release', async () => {
  const budget = new ResourceBudget({ maxConcurrentCalls: 1, maxQueuedCalls: 2 }), order = [];
  const first = await budget.acquire();
  const second = budget.acquire().then(release => { order.push(2); return release; });
  const third = budget.acquire().then(release => { order.push(3); return release; });
  await assert.rejects(budget.acquire(), exhausted('WGA_CALL_QUEUE_FULL'));
  assert.deepEqual(counts(budget), { activeCalls: 1, queuedCalls: 2, bufferedBytes: 0 });
  first(); first(); const secondRelease = await second;
  assert.deepEqual(order, [2]); assert.deepEqual(counts(budget), { activeCalls: 1, queuedCalls: 1, bufferedBytes: 0 });
  secondRelease(); const thirdRelease = await third;
  assert.deepEqual(order, [2, 3]); thirdRelease();
  assert.deepEqual(budget.diagnostics(), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: 1, peakQueuedCalls: 2, peakBufferedBytes: 0 });
  const failFast = new ResourceBudget({ maxConcurrentCalls: 1 }), release = await failFast.acquire();
  await assert.rejects(failFast.acquire(), exhausted('WGA_CALL_QUEUE_FULL')); release(); (await failFast.acquire())();
});

test('RESOURCE queued cancellation removes listeners and leaves survivors in FIFO order', async () => {
  const budget = new ResourceBudget({ maxConcurrentCalls: 1, maxQueuedCalls: 4 }), head = await budget.acquire();
  const middle = new AbortController(), survivor = new AbortController();
  const cancelled = budget.acquire(middle.signal), remaining = budget.acquire(survivor.signal);
  const rejected = assert.rejects(cancelled, { code: 1, diagnostic: 'WGA_CALL_QUEUE_CANCELLED' });
  middle.abort(); await rejected; assert.equal(getEventListeners(middle.signal, 'abort').length, 0);
  assert.equal(budget.diagnostics().queuedCalls, 1); head(); const release = await remaining;
  assert.equal(getEventListeners(survivor.signal, 'abort').length, 1);
  release(); assert.equal(getEventListeners(survivor.signal, 'abort').length, 0);
  assert.deepEqual(counts(budget), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
});

test('RESOURCE abort before, during, and after grant never leaks a slot or buffer lease', async () => {
  const budget = new ResourceBudget({ maxConcurrentCalls: 1, maxQueuedCalls: 1 }), lease = budget.reserve(9);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(budget.acquire(pre.signal), { code: 1 });
  assert.equal(budget.diagnostics().peakActiveCalls, 0); assert.equal(getEventListeners(pre.signal, 'abort').length, 0);
  const controller = new AbortController(), release = await budget.acquire(controller.signal);
  const queued = budget.acquire(); controller.abort(); release();
  const nextRelease = await queued; assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(counts(budget), { activeCalls: 1, queuedCalls: 0, bufferedBytes: 9 });
  nextRelease(); lease.release();
  const registration = new AbortController(), originalAdd = registration.signal.addEventListener.bind(registration.signal);
  registration.signal.addEventListener = (...args) => { registration.abort(); originalAdd(...args); };
  await assert.rejects(budget.acquire(registration.signal), { code: 1 });
  assert.equal(getEventListeners(registration.signal, 'abort').length, 0);
  assert.deepEqual(counts(budget), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
});

test('RESOURCE reentrant abort and release preserve FIFO and remove every listener', async () => {
  const budget = new ResourceBudget({ maxConcurrentCalls: 1, maxQueuedCalls: 2 });
  const firstSignal = new AbortController(), secondSignal = new AbortController(), thirdSignal = new AbortController();
  const first = await budget.acquire(firstSignal.signal), second = budget.acquire(secondSignal.signal), third = budget.acquire(thirdSignal.signal);
  const secondRejected = assert.rejects(second, { code: 1 });
  const remove = firstSignal.signal.removeEventListener.bind(firstSignal.signal);
  firstSignal.signal.removeEventListener = (...args) => { secondSignal.abort(); first(); remove(...args); };
  first(); await secondRejected; const release = await third; release();
  for (const controller of [firstSignal, secondSignal, thirdSignal]) assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(counts(budget), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
});

test('RESOURCE listener registration failure rolls back admission and starts the next waiter', async () => {
  const budget = new ResourceBudget({ maxConcurrentCalls: 1, maxQueuedCalls: 1 });
  const controller = new AbortController(), add = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { add(...args); throw new Error('registration failed'); };
  await assert.rejects(budget.acquire(controller.signal), { code: 1 });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const release = await budget.acquire(); release();
  assert.deepEqual(counts(budget), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
});

test('RESOURCE byte leases enforce aggregate limits atomically and recover capacity', () => {
  const budget = new ResourceBudget({ maxBufferedBytes: 10 }), first = budget.reserve(6), second = budget.reserve(4);
  assert.throws(() => budget.reserve(1), exhausted('WGA_BUFFER_BUDGET'));
  assert.throws(() => first.resize(7), exhausted('WGA_BUFFER_BUDGET'));
  assert.equal(budget.diagnostics().bufferedBytes, 10);
  first.resize(3); second.resize(7); assert.equal(budget.diagnostics().bufferedBytes, 10);
  first.release(); first.release(); second.resize(0);
  assert.equal(budget.diagnostics().bufferedBytes, 0); assert.equal(budget.diagnostics().peakBufferedBytes, 10);
  second.resize(10); second.release(); assert.equal(budget.diagnostics().bufferedBytes, 0);
  assert.throws(() => second.resize(1), { code: 13, diagnostic: 'WGA_BUFFER_RELEASED' });
  for (const bytes of [-1, NaN, Infinity, 0.5, '1']) assert.throws(() => budget.reserve(bytes), TypeError);
  const unlimited = new ResourceBudget(), huge = unlimited.reserve(Number.MAX_SAFE_INTEGER);
  assert.throws(() => unlimited.reserve(1), exhausted('WGA_BUFFER_BUDGET')); huge.release();
});

test('RESOURCE generated admission/abort/release schedules preserve counts and FIFO', { timeout: 15000 }, async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ action: fc.constantFrom('acquire', 'abort', 'release'), index: fc.nat(50) }), { minLength: 1, maxLength: 80 }), async schedule => {
    const budget = new ResourceBudget({ maxConcurrentCalls: 2, maxQueuedCalls: 3 }), calls = [], admitted = [];
    for (const operation of schedule) {
      if (operation.action === 'acquire') {
        const controller = new AbortController(), entry = { controller, release: undefined, released: false, state: 'pending', id: calls.length }; calls.push(entry);
        entry.promise = budget.acquire(controller.signal).then(release => { entry.release = () => { entry.released = true; release(); }; entry.state = 'active'; admitted.push(entry.id); }, error => {
          assert.ok(error.code === 1 || error.code === 8); entry.state = 'rejected';
        });
      } else if (calls.length) {
        const entry = calls[operation.index % calls.length];
        if (operation.action === 'abort') entry.controller.abort(); else entry.release?.();
      }
      await Promise.resolve();
      const state = budget.diagnostics();
      assert.ok(state.activeCalls >= 0 && state.activeCalls <= 2); assert.ok(state.queuedCalls >= 0 && state.queuedCalls <= 3);
      assert.equal(state.activeCalls, calls.filter(call => call.state === 'active' && !call.released && !call.controller.signal.aborted).length);
      assert.equal(state.queuedCalls, calls.filter(call => call.state === 'pending' && !call.controller.signal.aborted).length);
      assert.equal(state.bufferedBytes, 0);
      assert.deepEqual(admitted, [...admitted].sort((a, b) => a - b));
    }
    for (const call of calls) call.controller.abort();
    await Promise.all(calls.map(call => call.promise));
    for (const call of calls) { call.release?.(); assert.equal(getEventListeners(call.controller.signal, 'abort').length, 0); }
    assert.deepEqual(counts(budget), { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 });
  }), { seed: 20260927, numRuns: 300, endOnFailure: false, markInterruptAsFailure: true });
});

test('RESOURCE generated byte lease transitions match an independent ownership model', () => {
  fc.assert(fc.property(fc.array(fc.record({ operation: fc.constantFrom('reserve', 'resize', 'release'), id: fc.nat(20), bytes: fc.nat(30) }), { maxLength: 100 }), operations => {
    const budget = new ResourceBudget({ maxBufferedBytes: 40 }), leases = []; let total = 0, peak = 0;
    for (const operation of operations) {
      if (operation.operation === 'reserve') {
        if (total + operation.bytes > 40) assert.throws(() => budget.reserve(operation.bytes), exhausted('WGA_BUFFER_BUDGET'));
        else { leases.push({ lease: budget.reserve(operation.bytes), bytes: operation.bytes, released: false }); total += operation.bytes; }
      } else if (leases.length) {
        const entry = leases[operation.id % leases.length];
        if (operation.operation === 'release') {
          entry.lease.release(); if (!entry.released) { total -= entry.bytes; entry.released = true; }
        } else if (entry.released) assert.throws(() => entry.lease.resize(operation.bytes), { diagnostic: 'WGA_BUFFER_RELEASED' });
        else if (total - entry.bytes + operation.bytes > 40) assert.throws(() => entry.lease.resize(operation.bytes), exhausted('WGA_BUFFER_BUDGET'));
        else { entry.lease.resize(operation.bytes); total = total - entry.bytes + operation.bytes; entry.bytes = operation.bytes; }
      }
      peak = Math.max(peak, total); assert.equal(budget.diagnostics().bufferedBytes, total); assert.equal(budget.diagnostics().peakBufferedBytes, peak);
    }
    for (const { lease } of leases) lease.release(); assert.equal(budget.diagnostics().bufferedBytes, 0);
  }), { seed: 1470698469, numRuns: 1000, markInterruptAsFailure: true });
});

test('RESOURCE scopes release only their own outstanding leases and reject late allocation', () => {
  const budget = new ResourceBudget({ maxBufferedBytes: 12 }), one = budget.scope(), two = budget.scope();
  const first = one.reserve(4), second = one.reserve(3), other = two.reserve(5);
  first.release(); second.resize(6); assert.equal(budget.diagnostics().bufferedBytes, 11);
  one.close(); one.close(); first.release(); second.release();
  assert.equal(budget.diagnostics().bufferedBytes, 5);
  assert.throws(() => one.reserve(0), { code: 1, diagnostic: 'WGA_BUFFER_SCOPE_CLOSED' });
  assert.throws(() => second.resize(2), { code: 1, diagnostic: 'WGA_BUFFER_SCOPE_CLOSED' });
  other.resize(8); assert.equal(budget.diagnostics().bufferedBytes, 8); two.close();
  assert.equal(budget.diagnostics().bufferedBytes, 0);
  assert.throws(() => two.reserve(1), { code: 1, diagnostic: 'WGA_BUFFER_SCOPE_CLOSED' });
});

test('RESOURCE child scopes close independently and parent close cleans every descendant', () => {
  const budget = new ResourceBudget({ maxBufferedBytes: 20 }), parent = budget.scope();
  const first = parent.scope(), second = parent.scope(), nested = second.scope();
  parent.reserve(1); const early = first.reserve(2); second.reserve(3); const deep = nested.reserve(4);
  assert.equal(budget.diagnostics().bufferedBytes, 10);
  first.close(); early.release(); assert.equal(budget.diagnostics().bufferedBytes, 8);
  parent.close(); parent.close(); first.close(); second.close(); nested.close(); deep.release();
  assert.equal(budget.diagnostics().bufferedBytes, 0);
  for (const scope of [parent, first, second, nested]) {
    assert.throws(() => scope.scope(), { code: 1, diagnostic: 'WGA_BUFFER_SCOPE_CLOSED' });
    assert.throws(() => scope.reserve(0), { code: 1, diagnostic: 'WGA_BUFFER_SCOPE_CLOSED' });
  }
});
