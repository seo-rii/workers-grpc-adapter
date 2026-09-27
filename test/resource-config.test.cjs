'use strict';
const { test } = require('node:test');
const { Readable, Duplex } = require('node:stream');
const { assert, grpc, Echo, response, withFetch, unary, deferred, immediate, deserialize } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { validateConfig, resourcesFor, INSTANCE_CONFIG, GAX_CONFIG_OPTION, configFromGaxToken } = require('../dist/config-internal.js');

const zero = { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, peakActiveCalls: 0, peakQueuedCalls: 0, peakBufferedBytes: 0 };
function client(transport, gax = false) {
  const options = gax ? { [GAX_CONFIG_OPTION]: transport.gaxOptions({})[GAX_CONFIG_OPTION] } : transport.grpcOptions();
  return new Echo('echo.test', transport.channelCredentials, options);
}

test('RESOURCE CONFIG validates optional limits and deeply freezes the configuration snapshot', () => {
  const defaults = validateConfig(); assert.deepEqual(defaults.resourceLimits, {}); assert.ok(Object.isFrozen(defaults.resourceLimits));
  const input = { resourceLimits: { maxConcurrentCalls: 2, maxQueuedCalls: 4, maxBufferedBytes: 8192, readableHighWaterMark: 1 } };
  const config = validateConfig(input); input.resourceLimits.maxConcurrentCalls = 100; input.resourceLimits.readableHighWaterMark = 40;
  assert.deepEqual(config.resourceLimits, { maxConcurrentCalls: 2, maxQueuedCalls: 4, maxBufferedBytes: 8192, readableHighWaterMark: 1 });
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.resourceLimits));
  for (const resourceLimits of [null, [], { maxQueuedCalls: 1 }, { maxConcurrentCalls: 0 }, { maxBufferedBytes: 2147483648 }, { readableHighWaterMark: 0 }, { arbitrary: 1 }]) {
    assert.throws(() => validateConfig({ resourceLimits }), { code: 'WGA_INVALID_CONFIG' });
    assert.throws(() => createWorkersGrpcTransport({ resourceLimits }), { code: 'WGA_INVALID_CONFIG' });
  }
});

test('RESOURCE CONFIG one factory shares a budget across grpc and GAX snapshots; factories remain isolated', async () => {
  const input = { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 0, maxBufferedBytes: 20 } };
  const first = createWorkersGrpcTransport(input), second = createWorkersGrpcTransport(input);
  const direct = first.grpcOptions()[INSTANCE_CONFIG], gax = configFromGaxToken(first.gaxOptions({})[GAX_CONFIG_OPTION]);
  assert.strictEqual(direct, gax); assert.strictEqual(resourcesFor(direct), resourcesFor(gax));
  assert.notStrictEqual(resourcesFor(direct), resourcesFor(second.grpcOptions()[INSTANCE_CONFIG]));
  input.resourceLimits.maxConcurrentCalls = 100;
  const budget = resourcesFor(direct), release = await budget.acquire(), lease = budget.reserve(7);
  assert.deepEqual(first.resourceUsage(), { ...zero, activeCalls: 1, bufferedBytes: 7, peakActiveCalls: 1, peakBufferedBytes: 7 });
  assert.deepEqual(second.resourceUsage(), zero);
  const returned = first.resourceUsage(); returned.activeCalls = 999; returned.bufferedBytes = 999;
  assert.equal(first.resourceUsage().activeCalls, 1); assert.equal(first.resourceUsage().bufferedBytes, 7);
  await assert.rejects(budget.acquire(), { code: 8, diagnostic: 'WGA_CALL_QUEUE_FULL' });
  lease.release(); release(); assert.equal(first.resourceUsage().activeCalls, 0); assert.equal(first.resourceUsage().bufferedBytes, 0);
});

test('RESOURCE CONFIG actual grpc and GAX clients share admission while an independent factory proceeds', { timeout: 4000 }, async () => {
  const first = createWorkersGrpcTransport({ resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 } });
  const independent = createWorkersGrpcTransport({ resourceLimits: { maxConcurrentCalls: 1 } });
  const clients = [client(first), client(first, true), client(independent)], entered = deferred(), reply = deferred(); let fetches = 0;
  try {
    await withFetch(async (_url, init) => {
      fetches++;
      const message = deserialize(Buffer.from(init.body).subarray(5));
      if (message.text === 'held') { entered.resolve(); return reply.promise; }
      return response([{ text: message.text }]);
    }, async () => {
      const held = unary(clients[0], { text: 'held' }, { deadline: Date.now() + 3000 });
      await entered.promise;
      const queued = unary(clients[1], { text: 'queued' }, { deadline: Date.now() + 3000 });
      await immediate();
      assert.equal(first.resourceUsage().activeCalls, 1); assert.equal(first.resourceUsage().queuedCalls, 1);
      await assert.rejects(unary(clients[0], { text: 'overflow' }).promise, { code: grpc.status.RESOURCE_EXHAUSTED });
      assert.deepEqual(await unary(clients[2], { text: 'independent' }).promise, { text: 'independent' });
      assert.equal(fetches, 2); reply.resolve(response([{ text: 'held' }]));
      assert.deepEqual(await held.promise, { text: 'held' }); assert.deepEqual(await queued.promise, { text: 'queued' });
      assert.equal(fetches, 3); await immediate();
      for (const transport of [first, independent]) {
        const usage = transport.resourceUsage(); assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
        assert.equal(usage.peakActiveCalls, 1);
      }
    });
  } finally { clients.forEach(c => c.close()); }
});

test('RESOURCE CONFIG readable high water mark applies to server and bidi streams, preserving default writable queues', async () => {
  const referenceReadable = new Readable({ objectMode: true, read() {} });
  const referenceDuplex = new Duplex({ objectMode: true, read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const defaultReadable = referenceReadable.readableHighWaterMark, defaultWritable = referenceDuplex.writableHighWaterMark;
  referenceReadable.destroy(); referenceDuplex.destroy();
  for (const configured of [undefined, 1, 3]) {
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true,
      ...(configured === undefined ? {} : { resourceLimits: { readableHighWaterMark: configured } }) });
    const c = client(transport), gax = client(transport, true);
    try {
      await withFetch(async () => assert.fail('Immediate destruction must not fetch'), async () => {
        for (const owner of [c, gax]) {
          assert.equal(owner.getChannel().getReadQueueLimit(), configured);
          const readable = owner.stream({ text: 'x' }), bidi = owner.bidi();
          const terminals = [readable, bidi].map(stream => {
            stream.on('error', () => {});
            assert.equal(stream.readableHighWaterMark, configured ?? defaultReadable);
            return new Promise(resolve => stream.once('status', resolve));
          });
          assert.equal(bidi.writableHighWaterMark, defaultWritable);
          readable.destroy(); bidi.destroy();
          for (const terminal of await Promise.all(terminals)) assert.equal(terminal.code, 1);
        }
        await immediate(); assert.equal(transport.resourceUsage().activeCalls, 0); assert.equal(transport.resourceUsage().bufferedBytes, 0);
      });
    } finally { c.close(); gax.close(); }
  }
});
