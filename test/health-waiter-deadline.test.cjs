'use strict';
const { test } = require('node:test');
const { getEventListeners } = require('node:events');
const { assert, grpc, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { HealthClient } = require('../dist/health.js');
const { encodeFrame } = require('../dist/wire.js');

function clock(t) {
  // The wall clock can pass a deadline before the event loop runs its timer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  return value => { now = value; };
}
const outcome = promise => promise.then(state => ({ phase: state.phase }), error => ({ code: error.code, details: error.details }));
const expired = { code: grpc.status.DEADLINE_EXCEEDED, details: 'WGA_HEALTH_DEADLINE_EXCEEDED' };

for (const mode of ['cloudflare', 'grpc-web']) for (const limited of [false, true]) {
  for (const delivery of [1099, 1100, 1101]) {
    test(`HEALTH waiter rechecks ${delivery < 1100 ? 'before' : delivery === 1100 ? 'at' : 'after'} deadline on SERVING ${mode} limit=${limited}`, { timeout: 3000 }, async t => {
      const advance = clock(t);
      let controller, cancelled = 0, arrivals = 0, completions = 0;
      const body = new ReadableStream({ start(value) {
        controller = value; value.enqueue(encodeFrame(Buffer.from([8, 2])));
      }, cancel() { cancelled++; } });
      const transport = createWorkersGrpcTransport({ mode,
        ...(mode === 'grpc-web' ? { endpoints: { 'health.test': 'https://gateway.test' } } : {}),
        ...(limited ? { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 } } : {}),
        fetcher: { async fetch() {
          arrivals++; return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
        } },
      });
      const client = new grpc.Client('health.test', transport.channelCredentials, transport.grpcOptions());
      const monitor = new HealthClient(client).monitor();
      const shortSignal = new AbortController(), longSignal = new AbortController(), abortSignal = new AbortController();
      try {
        await immediate(); assert.equal(monitor.getState().phase, 'not-serving');
        const short = outcome(monitor.waitForServing({ deadline: 1100, signal: shortSignal.signal })).then(value => { completions++; return value; });
        const long = outcome(monitor.waitForServing({ deadline: new Date(2000), signal: longSignal.signal })).then(value => { completions++; return value; });
        const aborted = outcome(monitor.waitForServing({ deadline: 3000, signal: abortSignal.signal }));
        assert.equal(getEventListeners(shortSignal.signal, 'abort').length, 1);
        abortSignal.abort();
        assert.deepEqual(await aborted, { code: grpc.status.CANCELLED, details: 'WGA_HEALTH_ABORTED' });
        advance(delivery);
        controller.enqueue(encodeFrame(Buffer.from([8, 1])));
        const [shortResult, longResult] = await Promise.all([short, long]);
        assert.deepEqual(shortResult, delivery < 1100 ? { phase: 'serving' } : expired);
        assert.deepEqual(longResult, { phase: 'serving' });
        assert.equal(completions, 2);
        for (const signal of [shortSignal.signal, longSignal.signal, abortSignal.signal]) {
          assert.equal(getEventListeners(signal, 'abort').length, 0);
        }
        assert.equal(monitor.getState().phase, 'serving');
        assert.equal(arrivals, 1); assert.equal(cancelled, 0);
        // Cached SERVING must also reject a new waiter with no remaining budget.
        advance(1100);
        assert.deepEqual(await outcome(monitor.waitForServing({ deadline: new Date(1100) })), expired);
        assert.deepEqual(await outcome(monitor.waitForServing({ deadline: 2000 })), { phase: 'serving' });
        // Delayed timers and aborts cannot alter already settled outcomes.
        shortSignal.abort(); longSignal.abort(); t.mock.timers.tick(10000); await immediate();
        assert.equal(completions, 2); assert.equal(monitor.getState().phase, 'serving');
        monitor.close(); await immediate();
        assert.equal(cancelled, 1); assert.equal(body.locked, false);
        assert.equal(client.getChannel().activeCallCount(), 0);
        const usage = transport.resourceUsage();
        assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
      } finally { monitor.close(); client.close(); await immediate(); }
    });
  }
}

for (const terminal of ['abort', 'close', 'unimplemented']) {
  test(`HEALTH overdue waiter preserves observed ${terminal} instead of replacing its error`, { timeout: 3000 }, async t => {
    const advance = clock(t);
    let controller, cancelled = 0;
    const body = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled++; } });
    const transport = createWorkersGrpcTransport({ mode: 'cloudflare', fetcher: { async fetch() {
      return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
    } } });
    const client = new grpc.Client('health.test', transport.channelCredentials, transport.grpcOptions());
    const monitor = new HealthClient(client).monitor(), aborter = new AbortController();
    try {
      await immediate();
      const result = outcome(monitor.waitForServing({ deadline: 1100, signal: aborter.signal }));
      advance(1100);
      if (terminal === 'abort') aborter.abort();
      if (terminal === 'close') monitor.close();
      if (terminal === 'unimplemented') {
        controller.enqueue(encodeFrame(Buffer.from('grpc-status: 12\r\ngrpc-message: unsupported\r\n'), true));
        controller.close();
      }
      assert.deepEqual(await result, terminal === 'unimplemented'
        ? { code: grpc.status.UNIMPLEMENTED, details: 'WGA_HEALTH_WATCH_UNIMPLEMENTED' }
        : { code: grpc.status.CANCELLED, details: terminal === 'abort' ? 'WGA_HEALTH_ABORTED' : 'WGA_HEALTH_WATCH_CLOSED' });
      assert.equal(getEventListeners(aborter.signal, 'abort').length, 0);
      t.mock.timers.tick(10000); monitor.close(); await immediate();
      assert.equal(cancelled, terminal === 'unimplemented' ? 0 : 1);
      assert.equal(client.getChannel().activeCallCount(), 0);
    } finally { monitor.close(); client.close(); await immediate(); }
  });
}
