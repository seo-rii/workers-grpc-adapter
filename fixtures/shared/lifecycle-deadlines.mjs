import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

const path = '/catalog.lifecycle.Echo/Unary';
const maxTimer = 2147483647;
const epoch = 1000000000000;

// Only this suite owns the clock while it runs. drain must use a captured real
// scheduler so that stream jobs can settle without advancing adapter deadlines.
function installClock() {
  const original = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const pending = new Map(), delays = [];
  let now = epoch, nextId = 0;
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    assert.ok(Number.isFinite(delay) && delay >= 0 && delay <= maxTimer, 'timer delay stays in the signed 32-bit range');
    const id = ++nextId;
    pending.set(id, { at: now + delay, callback: () => callback(...args) });
    delays.push(delay);
    return id;
  };
  globalThis.clearTimeout = id => { pending.delete(id); };
  return {
    delays,
    count: () => pending.size,
    advance(milliseconds) {
      const target = now + milliseconds;
      assert.ok(Number.isSafeInteger(target) && target >= now);
      let callbacks = 0;
      while (true) {
        let earliest;
        for (const [id, timer] of pending) {
          if (timer.at <= target && (!earliest || timer.at < earliest.timer.at)) earliest = { id, timer };
        }
        if (!earliest) break;
        assert.ok(++callbacks <= 100, 'bounded controlled clock advancement');
        now = earliest.timer.at;
        pending.delete(earliest.id);
        earliest.timer.callback();
      }
      now = target;
    },
    restore() {
      Date.now = original.now;
      globalThis.setTimeout = original.setTimeout;
      globalThis.clearTimeout = original.clearTimeout;
    },
  };
}

function terminalReceipt(call, channel, transport, clock, counts) {
  const diagnostics = call.diagnostics();
  assert.deepEqual(diagnostics, { terminal: true, fetchCount: counts.fetches, requestBytes: 0, responseBytes: 0, timerActive: false });
  const execution = call.executionDiagnostics();
  assert.deepEqual(execution, { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
    pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 });
  const resources = transport.resourceUsage();
  assert.equal(channel.activeCallCount(), 0, 'call registry recovers before channel.close');
  for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(resources[key], 0, `resource ${key} recovers before channel.close`);
  assert.equal(clock.count(), 0, 'deadline timer removed before channel.close');
  assert.equal(counts.statuses.length, 1, 'one terminal delivery');
  assert.equal(counts.writes, 1, 'one write completion');
  assert.equal(counts.messagesAfterTerminal, 0);
  return { ...counts, activeCalls: channel.activeCallCount(), timers: clock.count(), diagnostics, execution, resources };
}

/** Portable controlled deadline schedules. No wall-clock wait determines a deadline. */
export async function runDeadlineSchedules({ grpc, createWorkersGrpcTransport, drain, frame, trailers }, mode) {
  const rows = [];
  const cases = [
    { id: 'LIFE-013', variant: 'explicit-infinity-overrides-default', deadline: Infinity, defaultTimeoutMs: 200, timeout: null, elapsed: 201 },
    { id: 'LIFE-014', variant: 'omitted-deadline-with-default', defaultTimeoutMs: 200, timeout: '200m', duration: 200, expires: true },
    { id: 'LIFE-014', variant: 'omitted-deadline-without-default', timeout: null, elapsed: 1000 },
    { id: 'LIFE-015', variant: 'past-numeric-deadline', deadline: epoch - 1, code: grpc.status.DEADLINE_EXCEEDED },
    { id: 'LIFE-015', variant: 'past-date-deadline', deadline: new Date(epoch - 1), code: grpc.status.DEADLINE_EXCEEDED },
    // Preserve the current policy honestly: the catalog requires INVALID_ARGUMENT,
    // but both direct and managed adapter calls currently report INTERNAL here.
    { id: 'LIFE-015', variant: 'invalid-date-policy-gap', deadline: new Date(NaN), code: grpc.status.INTERNAL, catalogCode: grpc.status.INVALID_ARGUMENT },
    ...[
      [1, '1m'],
      [99999999, '99999999m'],
      [100000000, '100000S'],
      [99999999000, '99999999S'],
      [99999999001, '1666667M'],
      [5999999940000, '99999999M'],
      [5999999940001, '1666667H'],
      [359999996400000, '99999999H'],
    ].map(([duration, timeout]) => ({ id: 'LIFE-016', variant: `timeout-${timeout}-${duration}`, duration, timeout, deadline: epoch + duration })),
    { id: 'LIFE-016', variant: 'long-timer-rearms-without-overflow', duration: maxTimer + 12345, deadline: epoch + maxTimer + 12345,
      timeout: '2147496S', expires: true, longTimer: true },
  ];
  for (const scenario of cases) {
    const clock = installClock();
    const counts = { authCalls: 0, fetches: 0, metadata: 0, messages: 0, messagesAfterTerminal: 0, writes: 0, writeErrors: 0, statuses: [], fetchAborts: 0 };
    let channel, call, release, timeout;
    const fetcher = { fetch(_url, init) {
      counts.fetches++;
      assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
      timeout = init.headers.get('grpc-timeout');
      return new Promise((resolve, reject) => {
        const abort = () => { counts.fetchAborts++; reject(new Error('controlled deadline abort')); };
        init.signal.addEventListener('abort', abort, { once: true });
        release = () => {
          init.signal.removeEventListener('abort', abort);
          resolve(new Response(Buffer.concat([frame(Buffer.from([8, 1])), trailers(0)]),
            { headers: { 'content-type': 'application/grpc-web+proto' } }));
        };
      });
    } };
    try {
      const transport = createWorkersGrpcTransport({ mode, fetcher,
        ...(mode === 'grpc-web' ? { endpoints: { 'lifecycle.test': 'https://gateway.lifecycle.test' } } : {}),
        ...(scenario.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: scenario.defaultTimeoutMs }) });
      channel = new grpc.Channel('lifecycle.test', transport.channelCredentials, transport.grpcOptions());
      const credentials = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
        counts.authCalls++; callback(null, new grpc.Metadata());
      });
      call = channel.createCallForMethod(path, false, false, { credentials,
        ...(Object.hasOwn(scenario, 'deadline') ? { deadline: scenario.deadline } : {}) });
      call.start(new grpc.Metadata(), {
        onReceiveMetadata() { counts.metadata++; },
        onReceiveMessage() {
          counts.messages++;
          if (counts.statuses.length) counts.messagesAfterTerminal++;
          call.startRead();
        },
        onReceiveStatus(value) { counts.statuses.push({ code: value.code, details: value.details }); },
      });
      call.startRead();
      call.sendMessageWithContext({ callback(error) { counts.writes++; if (error) counts.writeErrors++; } }, Buffer.from([8, 1]));
      call.halfClose();
      await drain();
      if (scenario.code !== undefined) {
        assert.equal(counts.authCalls, 0);
        assert.equal(counts.fetches, 0);
        assert.equal(counts.writeErrors, 1);
        assert.equal(clock.delays.length, 0);
      } else {
        assert.equal(counts.authCalls, 1);
        assert.equal(counts.fetches, 1);
        assert.equal(counts.writeErrors, 0);
        assert.equal(timeout, scenario.timeout);
        assert.equal(counts.statuses.length, 0);
        const duration = scenario.duration;
        assert.deepEqual(clock.delays, duration === undefined ? [] : [Math.min(duration, maxTimer)]);
        if (scenario.elapsed) {
          clock.advance(scenario.elapsed);
          await drain();
          assert.equal(counts.statuses.length, 0, 'no implicit/default timer for an infinite deadline');
          assert.equal(clock.count(), 0);
        }
        if (scenario.expires) {
          if (scenario.longTimer) {
            clock.advance(maxTimer);
            await drain();
            assert.equal(counts.statuses.length, 0, 'first maximum timer chunk cannot end a longer RPC');
            assert.deepEqual(clock.delays, [maxTimer, 12345]);
            assert.equal(clock.count(), 1);
            clock.advance(12344);
          } else clock.advance(duration - 1);
          await drain();
          assert.equal(counts.statuses.length, 0, 'RPC stays alive one millisecond before its deadline');
          clock.advance(1);
        } else release();
        await drain();
      }
      const expectedCode = scenario.code ?? (scenario.expires ? grpc.status.DEADLINE_EXCEEDED : grpc.status.OK);
      assert.deepEqual(counts.statuses.map(value => value.code), [expectedCode]);
      assert.equal(counts.messages, expectedCode === grpc.status.OK ? 1 : 0);
      assert.equal(counts.metadata, expectedCode === grpc.status.OK ? 1 : 0);
      assert.equal(counts.fetchAborts, scenario.expires ? 1 : 0);
      const receipt = terminalReceipt(call, channel, transport, clock, counts);
      rows.push({ id: scenario.id, variant: scenario.variant, mode, status: 'passed',
        catalogMatch: scenario.catalogCode === undefined || scenario.catalogCode === expectedCode,
        ...(scenario.catalogCode === undefined ? {} : { catalogExpectedCode: scenario.catalogCode, actualCode: expectedCode }),
        timeoutHeader: timeout ?? null, timerDelays: [...clock.delays], ...receipt });
    } finally {
      try {
        channel?.close();
        await drain();
      } finally { clock.restore(); }
    }
  }
  return rows;
}
