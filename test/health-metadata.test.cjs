'use strict';
const { test } = require('node:test');
const { assert, grpc, trailers, deferred, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { HealthClient } = require('../dist/health.js');
const { encodeFrame } = require('../dist/wire.js');

const config = (mode, limited) => ({ mode,
  ...(mode === 'grpc-web' ? { endpoints: { 'health.test': 'https://gateway.test' } } : {}),
  ...(limited ? { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 2 } } : {}),
});
const reply = (code = 0) => new Response(Buffer.concat([
  ...(code ? [] : [encodeFrame(Buffer.from([8, 1]))]), trailers(code),
]), { headers: { 'content-type': 'application/grpc-web+proto' } });
function idle(client, transport) {
  assert.equal(client.getChannel().activeCallCount(), 0);
  const usage = transport.resourceUsage();
  assert.equal(usage.activeCalls, 0);
  assert.equal(usage.queuedCalls, 0);
  assert.equal(usage.bufferedBytes, 0);
}
const interceptor = start => (options, nextCall) => new grpc.InterceptingCall(nextCall(options), { start });

for (const mode of ['cloudflare', 'grpc-web']) for (const limited of [false, true]) {
  for (const helper of ['direct', 'check', 'watch', 'monitor']) {
    test(`HEALTH opaque authentication context survives ${helper} ${mode} limit=${limited}`, { timeout: 3000 }, async () => {
      const seen = [], sent = [], owner = { identity: 'synthetic-request' };
      const metadata = new grpc.Metadata({ idempotentRequest: true });
      metadata.setOpaque('request-auth', owner);
      metadata.set('proof-bin', Buffer.from([1]));
      metadata.add('x-repeated', 'one'); metadata.add('x-repeated', 'two');
      const transport = createWorkersGrpcTransport({ ...config(mode, limited),
        fetcher: { async fetch(_url, init) {
          sent.push(init.headers.get('authorization'));
          assert.equal(init.headers.get('proof-bin'), 'AQ==');
          assert.equal(init.headers.get('x-repeated'), 'one, two');
          return reply(sent.at(-1) === 'Bearer synthetic-request' ? 0 : grpc.status.UNAUTHENTICATED);
        } },
      });
      const client = new grpc.Client('health.test', transport.channelCredentials, transport.grpcOptions({
        interceptors: [interceptor((value, listener, next) => {
          const context = value.getOpaque('request-auth'); seen.push(context);
          assert.deepEqual(value.getOptions(), { idempotentRequest: true });
          if (context) value.set('authorization', `Bearer ${context.identity}`);
          if (helper !== 'direct') {
            assert.notStrictEqual(value, metadata);
            value.setOpaque('interceptor-owned', true);
            value.getOptions().idempotentRequest = false;
          }
          next(value, listener);
        })],
      }));
      const health = new HealthClient(client); let monitor;
      try {
        let result;
        if (helper === 'direct') result = await new Promise((resolve, reject) => client.makeUnaryRequest(
          '/grpc.health.v1.Health/Check', () => Buffer.alloc(0), bytes => ({ status: bytes[1] }),
          '', metadata, { deadline: Date.now() + 2000 }, (error, value) => error ? reject(error) : resolve(value)));
        if (helper === 'check') result = await health.check('', { metadata });
        if (helper === 'watch') {
          const values = [];
          for await (const value of health.watch('', { metadata, deadline: Date.now() + 2000 })) values.push(value);
          result = values[0];
        }
        if (helper === 'monitor') {
          monitor = health.monitor('', { metadata, initialBackoffMs: 1000, maxBackoffMs: 1000, backoffJitter: 0 });
          const state = await monitor.waitForServing({ deadline: Date.now() + 1000 });
          result = { status: state.servingStatus };
          monitor.close();
        }
        assert.deepEqual(result, { status: 1 });
        assert.equal(seen.length, 1); assert.strictEqual(seen[0], owner);
        assert.deepEqual(sent, ['Bearer synthetic-request']);
        if (helper !== 'direct') {
          assert.equal(metadata.getOpaque('interceptor-owned'), undefined);
          assert.deepEqual(metadata.getOptions(), { idempotentRequest: true });
          assert.deepEqual(metadata.get('authorization'), []);
        }
        await immediate(); idle(client, transport);
      } finally { monitor?.close(); client.close(); await immediate(); }
    });
  }

  test(`HEALTH monitor snapshots caller metadata and isolates retry mutations ${mode} limit=${limited}`, { timeout: 3000 }, async () => {
    const owner = {}, laterOwner = {}, options = { idempotentRequest: true }, proof = Buffer.from([1]);
    const metadata = new grpc.Metadata(options);
    metadata.setOpaque('owner', owner); metadata.set('proof-bin', proof);
    metadata.add('x-repeated', 'one'); metadata.add('x-repeated', 'two');
    const seen = [], sent = [], ready = deferred(); let cancelled = 0;
    const transport = createWorkersGrpcTransport({ ...config(mode, limited), fetcher: { async fetch(_url, init) {
      sent.push([init.headers.get('proof-bin'), init.headers.get('x-repeated')]);
      if (sent.length === 1) return reply(grpc.status.UNAVAILABLE);
      ready.resolve();
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encodeFrame(Buffer.from([8, 1]))); },
        cancel() { cancelled++; } }), { headers: { 'content-type': 'application/grpc-web+proto' } });
    } } });
    const client = new grpc.Client('health.test', transport.channelCredentials, transport.grpcOptions({
      interceptors: [interceptor((value, listener, next) => {
        seen.push({ owner: value.getOpaque('owner'), options: { ...value.getOptions() },
          later: value.getOpaque('later'), priorAttempt: value.getOpaque('attempt'),
          proof: value.get('proof-bin')[0][0], repeated: [...value.get('x-repeated')] });
        value.setOpaque('attempt', seen.length); value.setOpaque('owner', {});
        value.getOptions().idempotentRequest = false;
        value.get('proof-bin')[0][0] = 3; value.add('x-repeated', 'interceptor');
        next(value, listener);
      })],
    }));
    const health = new HealthClient(client); let monitor;
    try {
      monitor = health.monitor('', { metadata, initialBackoffMs: 1, maxBackoffMs: 1, backoffJitter: 0 });
      metadata.setOpaque('owner', laterOwner); metadata.setOpaque('later', true);
      options.idempotentRequest = false; proof[0] = 2;
      metadata.set('x-repeated', 'caller-later');
      await monitor.waitForServing({ deadline: Date.now() + 2000 }); await ready.promise;
      assert.equal(seen.length, 2);
      for (const value of seen) {
        assert.strictEqual(value.owner, owner);
        assert.deepEqual(value.options, { idempotentRequest: true });
        assert.equal(value.later, undefined); assert.equal(value.priorAttempt, undefined);
        assert.equal(value.proof, 1); assert.deepEqual(value.repeated, ['one', 'two']);
      }
      assert.deepEqual(sent, [['Aw==', 'one, two, interceptor'], ['Aw==', 'one, two, interceptor']]);
      assert.strictEqual(metadata.getOpaque('owner'), laterOwner);
      assert.equal(metadata.getOpaque('attempt'), undefined);
      assert.equal(proof[0], 2); assert.deepEqual(metadata.get('x-repeated'), ['caller-later']);
      monitor.close(); await immediate();
      assert.equal(cancelled, 1); idle(client, transport);
    } finally { monitor?.close(); client.close(); await immediate(); }
  });
}

for (const mode of ['cloudflare', 'grpc-web']) {
  test(`HEALTH queued check abort and monitor close release metadata snapshots ${mode}`, { timeout: 3000 }, async () => {
    const entered = deferred(), released = deferred(), started = [], sent = [];
    const transport = createWorkersGrpcTransport({ ...config(mode, true), fetcher: { async fetch(url) {
      sent.push(url); entered.resolve(); return released.promise;
    } } });
    const client = new grpc.Client('health.test', transport.channelCredentials, transport.grpcOptions({
      interceptors: [interceptor((value, listener, next) => { started.push(value.getOpaque('owner')); next(value, listener); })],
    }));
    const health = new HealthClient(client), owner = {}, metadata = new grpc.Metadata();
    metadata.setOpaque('owner', owner);
    let monitor, blocker;
    try {
      blocker = health.check('', { metadata }); await entered.promise;
      const controller = new AbortController();
      const cancelled = assert.rejects(health.check('', { metadata, signal: controller.signal }), { code: grpc.status.CANCELLED });
      monitor = health.monitor('', { metadata }); await immediate();
      assert.equal(transport.resourceUsage().queuedCalls, 2);
      const closed = assert.rejects(monitor.waitForServing({ deadline: Date.now() + 2000 }), { code: grpc.status.CANCELLED });
      controller.abort(); monitor.close(); await Promise.all([cancelled, closed]);
      assert.equal(transport.resourceUsage().queuedCalls, 0);
      released.resolve(reply()); await blocker; await immediate();
      assert.deepEqual(started, [owner]); assert.equal(sent.length, 1); idle(client, transport);
    } finally { released.resolve(reply()); monitor?.close(); client.close(); await blocker?.catch(() => {}); await immediate(); }
  });
}

test('HEALTH metadata snapshots preserve the public clone contract', () => {
  const metadata = new grpc.Metadata(), owner = {};
  metadata.setOpaque('owner', owner);
  assert.equal(metadata.clone().getOpaque('owner'), undefined);
  assert.strictEqual(metadata.getOpaque('owner'), owner);
});
