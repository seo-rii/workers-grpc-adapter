'use strict';
const { test } = require('node:test');
const { assert, grpc, trailers, deferred, immediate } = require('./helpers.cjs');
const { HealthClient } = require('../dist/health.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');

const reply = (code = 0) => new Response(Buffer.concat([
  ...(code === 0 ? [encodeFrame(Buffer.from([8, 1]))] : []), trailers(code),
]), { headers: { 'content-type': 'application/grpc-web+proto' } });

for (const mode of ['cloudflare', 'grpc-web']) {
  for (const hook of ['transformer', 'interceptor']) {
    for (const closeAttempt of [1, 2]) {
      test(`HEALTH close during ${hook} startup owns attempt ${closeAttempt} in ${mode}`, { timeout: 3000 }, async () => {
        let monitor, attempts = 0, watchFetches = 0, checkFetches = 0, cancelledBodies = 0;
        const closed = deferred(), statuses = [];
        const transport = createWorkersGrpcTransport({
          mode, ...(mode === 'grpc-web' ? { endpoints: { 'health.test': 'https://gateway.test' } } : {}),
          resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 0 },
          fetcher: { async fetch(url) {
            if (String(url).endsWith('/Check')) { checkFetches++; return reply(); }
            assert.ok(String(url).endsWith('/Watch'));
            watchFetches++;
            if (attempts < closeAttempt) return reply(grpc.status.UNAVAILABLE);
            // A missed cancellation must keep its real reader and admission
            // slot alive, rather than accidentally pass through response EOF.
            return new Response(new ReadableStream({ cancel() { cancelledBodies++; } }),
              { headers: { 'content-type': 'application/grpc-web+proto' } });
          } },
        });
        function closeFromHook(method) {
          if (!method.endsWith('/Watch')) return;
          attempts++;
          if (attempts === closeAttempt) {
            monitor.close(); monitor.close();
            closed.resolve();
          }
        }
        const client = new grpc.Client('health.test', transport.channelCredentials, transport.grpcOptions({
          callInvocationTransformer(properties) {
            if (properties.methodDefinition.path.endsWith('/Watch')) {
              properties.call.once('status', result => statuses.push(result.code));
              // HealthWatch must install its own error listener before cancelling.
            }
            if (hook === 'transformer') closeFromHook(properties.methodDefinition.path);
            return properties;
          },
          ...(hook === 'interceptor' ? { interceptors: [(options, next) => {
            closeFromHook(options.method_definition.path);
            return next(options);
          }] } : {}),
        }));
        const health = new HealthClient(client);
        monitor = health.monitor('', { initialBackoffMs: 1, maxBackoffMs: 1, backoffJitter: 0 });
        const waiter = assert.rejects(monitor.waitForServing({ deadline: Date.now() + 2000 }),
          { code: grpc.status.CANCELLED, details: 'WGA_HEALTH_WATCH_CLOSED' });
        try {
          await closed.promise;
          await waiter;
          await immediate();
          monitor.close();
          await immediate();
          assert.equal(monitor.getState().phase, 'closed');
          assert.equal(monitor.getState().attempt, closeAttempt);
          assert.deepEqual(statuses, [...Array(closeAttempt - 1).fill(grpc.status.UNAVAILABLE), grpc.status.CANCELLED]);
          assert.equal(watchFetches, closeAttempt - 1, 'The closed startup attempt cannot start Fetch');
          assert.equal(cancelledBodies, 0);
          const usage = transport.resourceUsage();
          assert.equal(usage.activeCalls, 0);
          assert.equal(usage.queuedCalls, 0);
          assert.equal(usage.bufferedBytes, 0);
          assert.equal(client.getChannel().activeCallCount(), 0);
          assert.deepEqual(await health.check(), { status: 1 }, 'The same client retains its admission capacity');
          assert.equal(checkFetches, 1);
          await new Promise(resolve => setTimeout(resolve, 10));
          assert.equal(attempts, closeAttempt, 'A closed monitor must not schedule another attempt');
          assert.equal(transport.resourceUsage().activeCalls, 0);
          assert.equal(transport.resourceUsage().bufferedBytes, 0);
        } finally {
          monitor.close(); client.close();
          await waiter;
        }
      });
    }
  }
}
