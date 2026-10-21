'use strict';
const test = require('node:test');
const { assert, grpc, Echo, response, immediate, deserialize, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { decodeFrames } = require('../dist/wire.js');

function transport(fetch, limited) {
  return createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' },
    experimentalRequestStreaming: true, fetcher: { fetch }, ...(limited ? { resourceLimits: { maxConcurrentCalls: 1 } } : {}) });
}
function assertReleased(factory, client, call) {
  const usage = factory.resourceUsage();
  assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
  assert.equal(client.getChannel().activeCallCount(), 0);
  assert.equal(transportCall(call).diagnostics().terminal, true);
  assert.ok(Object.values(transportCall(call).executionDiagnostics()).every(count => count === 0));
}

for (const kind of ['clientStream', 'bidi']) for (const limited of [false, true]) {
  for (const delayed of [false, true]) for (const entry of ['direct', 'microtask', 'immediate']) {
    test(`WRITE FLAGS rejects WriteThrough once: ${kind}, admission=${limited}, delayed=${delayed}, entry=${entry}`, { timeout: 5000 }, async () => {
      let fetches = 0, callbacks = 0, writeCallbacks = 0;
      const errors = [], statuses = [];
      const factory = transport(async (_url, init) => {
        fetches++;
        return new Promise((_resolve, reject) => {
          if (init.signal.aborted) reject(new Error('aborted'));
          else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }, limited);
      const interceptors = delayed ? [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        start(metadata, listener, next) { setImmediate(() => next(metadata, listener)); },
        sendMessage(message, next) { setImmediate(() => next(message)); },
      })] : [];
      const client = new Echo('echo.test', factory.channelCredentials, factory.grpcOptions({ interceptors }));
      try {
        const run = () => {
          const callback = error => { callbacks++; assert.equal(error.code, grpc.status.UNIMPLEMENTED); };
          const call = kind === 'clientStream' ? client.clientStream(callback) : client.bidi();
          call.on('error', error => errors.push(error));
          const done = new Promise(resolve => call.on('status', value => { statuses.push(value); resolve(); }));
          call.write({ text: 'rejected' }, 4, error => {
            writeCallbacks++; assert.equal(error.message, 'WGA_WRITE_FLAGS');
          });
          return done.then(async () => {
            await immediate(); await immediate();
            assert.equal(statuses.length, 1);
            assert.equal(statuses[0].code, grpc.status.UNIMPLEMENTED);
            assert.equal(statuses[0].details, 'WGA_WRITE_FLAGS');
            assert.equal(writeCallbacks, 1); assert.equal(callbacks, kind === 'clientStream' ? 1 : 0);
            assert.ok(errors.every(error => error.code === grpc.status.UNIMPLEMENTED || error.message === 'WGA_WRITE_FLAGS'));
            if (!delayed) assert.equal(fetches, 0);
            assertReleased(factory, client, call);
          });
        };
        if (entry === 'direct') await run();
        else await new Promise((resolve, reject) => (entry === 'microtask' ? queueMicrotask : setImmediate)(() => run().then(resolve, reject)));
      } finally { client.close(); }
    });
  }
}

for (const kind of ['clientStream', 'bidi']) for (const flags of [0, 1, 2, 3]) {
  test(`WRITE FLAGS supported ${flags} preserve gzip/NoCompress on ${kind}`, { timeout: 5000 }, async () => {
    let fetches = 0, writes = 0, callbacks = 0;
    const seen = [], statuses = [];
    const factory = transport(async (_url, init) => {
      fetches++;
      assert.equal(init.headers.get('grpc-encoding'), 'gzip');
      const chunks = [];
      for await (const chunk of init.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes[0], flags & 2 ? 0 : 1);
      const input = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
      const messages = [];
      for await (const frame of decodeFrames(input, 4096, undefined, { encoding: 'gzip' })) messages.push(deserialize(frame.payload));
      assert.deepEqual(messages, [{ text: 'accepted' }]);
      return response([{ text: 'response' }]);
    }, true);
    const client = new Echo('echo.test', factory.channelCredentials, factory.grpcOptions({ 'grpc.default_compression_algorithm': grpc.compressionAlgorithms.gzip }));
    try {
      const callback = (error, value) => { assert.ifError(error); callbacks++; seen.push(value); };
      const call = kind === 'clientStream' ? client.clientStream(callback) : client.bidi();
      call.on('error', assert.ifError);
      if (kind === 'bidi') call.on('data', value => seen.push(value));
      const done = new Promise(resolve => call.on('status', value => { statuses.push(value); resolve(); }));
      call.write({ text: 'accepted' }, flags, error => { assert.ifError(error); writes++; }); call.end();
      await done; await immediate();
      assert.equal(statuses.length, 1); assert.equal(statuses[0].code, grpc.status.OK);
      assert.equal(writes, 1); assert.equal(callbacks, kind === 'clientStream' ? 1 : 0); assert.equal(fetches, 1);
      assert.deepEqual(seen, [{ text: 'response' }]); assertReleased(factory, client, call);
    } finally { client.close(); }
  });
}
