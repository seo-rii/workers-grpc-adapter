'use strict';
const { test } = require('node:test');
const { assert, grpc, methods, serialize, deserialize, response, trailers, withFetch, deferred, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { validateConfig } = require('../dist/config-internal.js');
const { decodeFrames, encodeFrame } = require('../dist/wire.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
function client(options = {}, config = {}, service = methods) {
  const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'stream.test': 'https://gateway.test' },
    experimentalRequestStreaming: true, ...config });
  const C = grpc.makeGenericClientConstructor(service, 'demo.Echo');
  return new C('stream.test', transport.channelCredentials, transport.grpcOptions(options));
}
async function messages(body) {
  const result = []; for await (const frame of decodeFrames(body, 1024)) { assert.equal(frame.trailer, false); result.push(deserialize(frame.payload)); }
  return result;
}
function finished(call) { return new Promise(resolve => call.on('status', resolve)); }
function clean(call, c) {
  assert.equal(c.getChannel().activeCallCount(), 0);
  assert.deepEqual(transportCall(call).diagnostics(), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
}

test('REQUEST STREAMING is opt-in gateway-only and rejects Cloudflare or non-boolean settings', () => {
  assert.equal(validateConfig().experimentalRequestStreaming, false);
  for (const config of [{ experimentalRequestStreaming: true }, { mode: 'cloudflare', experimentalRequestStreaming: false },
    { mode: 'grpc-web', endpoints: { 'stream.test': 'https://gateway.test' }, experimentalRequestStreaming: 'yes' }]) {
    assert.throws(() => validateConfig(config), { code: 'WGA_INVALID_CONFIG' });
  }
  assert.equal(validateConfig({ mode: 'grpc-web', endpoints: { 'stream.test': 'https://gateway.test' }, experimentalRequestStreaming: true }).experimentalRequestStreaming, true);
});

test('REQUEST STREAMING client writable sends multiple frames with ordered write callbacks and half-close', async () => {
  const c = client(); let fetches = 0; const acknowledgements = [];
  try {
    await withFetch(async (_url, init) => {
      fetches++; assert.equal(init.duplex, 'half'); assert.equal(init.cf.grpcWeb, 'passthrough');
      assert.deepEqual(await messages(init.body), [{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
      return response([{ text: 'three messages' }]);
    }, async () => {
      let call;
      const result = new Promise((resolve, reject) => {
        call = c.clientStream({ deadline: Date.now() + 1000 }, (error, value) => error ? reject(error) : resolve(value));
      });
      call.on('error', () => {}); const terminal = finished(call);
      for (const [index, text] of ['one', 'two', 'three'].entries()) call.write({ text }, error => { assert.ifError(error); acknowledgements.push(index); });
      call.end(); assert.deepEqual(await result, { text: 'three messages' }); assert.equal((await terminal).code, 0);
      assert.deepEqual(acknowledgements, [0, 1, 2]); assert.equal(fetches, 1); clean(call, c);
    });
  } finally { c.close(); }
});

test('REQUEST STREAMING full duplex receives response one before writing request two', async () => {
  const c = client(); let receivedRequests = 0, responseBeforeSecondWrite = false;
  try {
    await withFetch(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      void (async () => {
        for await (const frame of decodeFrames(init.body, 1024)) {
          receivedRequests++; controller.enqueue(encodeFrame(frame.payload));
        }
        controller.enqueue(trailers()); controller.close();
      })().catch(error => controller.error(error));
    } }), { headers: { 'content-type': 'application/grpc-web+proto' } }), async () => {
      const call = c.bidi({ deadline: Date.now() + 1000 }), seen = [];
      call.on('error', () => {}); const terminal = finished(call);
      call.on('data', value => {
        seen.push(value.text);
        if (seen.length === 1) { responseBeforeSecondWrite = receivedRequests === 1; call.write({ text: 'second' }); call.end(); }
      });
      call.write({ text: 'first' }); assert.equal((await terminal).code, 0);
      assert.deepEqual(seen, ['first', 'second']); assert.ok(responseBeforeSecondWrite); clean(call, c);
    });
  } finally { c.close(); }
});

test('REQUEST STREAMING empty half-close is a valid zero-message request body', async () => {
  const c = client();
  try {
    await withFetch(async (_url, init) => { assert.deepEqual(await messages(init.body), []); return response([{ text: 'empty' }]); }, async () => {
      let call; const result = new Promise((resolve, reject) => { call = c.clientStream((error, value) => error ? reject(error) : resolve(value)); });
      const terminal = finished(call); call.end(); assert.equal((await result).text, 'empty'); await terminal; clean(call, c);
    });
  } finally { c.close(); }
});

test('REQUEST STREAMING terminal server error releases a write pending Fetch pull, without replay', async () => {
  const c = client({}, { retryPolicy: { methods: ['/demo.Echo/ClientStream'], maxAttempts: 4,
    initialBackoffMs: 1, maxBackoffMs: 2, retryableStatusCodes: [grpc.status.UNAVAILABLE], retryOnFetchError: true } });
  let fetches = 0, writeErrors = 0;
  try {
    await withFetch(async () => { fetches++; return response([], { code: grpc.status.UNAVAILABLE }); }, async () => {
      let call; const result = new Promise(resolve => { call = c.clientStream(error => resolve(error)); });
      call.on('error', () => {}); const terminal = finished(call);
      call.write({ text: 'pending' }, error => { if (error) writeErrors++; });
      assert.equal((await result).code, grpc.status.UNAVAILABLE); assert.equal((await terminal).code, grpc.status.UNAVAILABLE);
      await turn(); assert.equal(fetches, 1); assert.equal(writeErrors, 1); clean(call, c);
    });
  } finally { c.close(); }
});

for (const source of ['headers', 'trailers']) {
  for (const suffix of ['none', 'message', 'trailers']) {
    test(`REQUEST STREAMING ${source} closes upload before response EOF and rejects suffix ${suffix}`, async () => {
      const c = client(); let pendingRejected = 0, uploadEOF = false; const order = [];
      try {
        await withFetch(async (_url, init) => {
          const upload = init.body.getReader(); let ended = false;
          return new Response(new ReadableStream({
            start(controller) { if (source === 'trailers') controller.enqueue(trailers(7)); },
            async pull(controller) {
              if (ended) return; ended = true;
              const result = await upload.read();
              assert.equal(result.done, true, 'pending message is discarded after terminal status');
              uploadEOF = true; upload.releaseLock();
              if (suffix === 'message') controller.enqueue(encodeFrame(serialize({ text: 'forbidden' })));
              if (suffix === 'trailers') controller.enqueue(trailers(0));
              controller.close();
            },
          }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/grpc-web+proto',
            ...(source === 'headers' ? { 'grpc-status': '7' } : {}) } });
        }, async () => {
          let call;
          const result = new Promise(resolve => { call = c.clientStream({ deadline: Date.now() + 1000 }, error => resolve(error)); });
          call.on('error', () => {}); const terminal = finished(call);
          call.on('status', () => order.push('status'));
          call.write({ text: 'unsent' }, error => { if (error) pendingRejected++; order.push('write'); });
          const expected = suffix === 'none' ? grpc.status.PERMISSION_DENIED : grpc.status.INTERNAL;
          assert.equal((await result).code, expected); assert.equal((await terminal).code, expected);
          await turn(); assert.equal(pendingRejected, 1); assert.equal(uploadEOF, true);
          assert.deepEqual(order, ['status', 'write']); clean(call, c);
        });
      } finally { c.close(); }
    });
  }
}

test('REQUEST STREAMING terminal trailer still requires EOF and a deadline releases deferred writes', async () => {
  const c = client({ 'grpc.default_compression_algorithm': 2 }); let writeErrors = 0;
  try {
    await withFetch(async (_url, init) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(trailers(7));
      init.signal.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true });
    } }), { headers: { 'content-type': 'application/grpc-web+proto' } }), async () => {
      let call; const result = new Promise(resolve => {
        call = c.clientStream({ deadline: Date.now() + 100 }, error => resolve(error));
      });
      call.on('error', () => {}); const terminal = finished(call);
      call.write({ text: 'x'.repeat(4096) }, error => { if (error) writeErrors++; });
      assert.equal((await result).code, grpc.status.DEADLINE_EXCEEDED);
      assert.equal((await terminal).code, grpc.status.DEADLINE_EXCEEDED);
      await turn(); assert.equal(writeErrors, 1); clean(call, c);
    });
  } finally { c.close(); }
});

for (const pendingResponse of [false, true]) {
  test(`REQUEST STREAMING remote upload cancellation preserves ${pendingResponse ? 'the logical deadline' : 'the server status'}`, async () => {
    const c = client(); let writeErrors = 0;
    try {
      await withFetch(async (_url, init) => {
        await init.body.cancel();
        if (pendingResponse) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('controlled abort')), { once: true }));
        return response([], { code: grpc.status.PERMISSION_DENIED });
      }, async () => {
        let call; const result = new Promise(resolve => { call = c.clientStream({ deadline: Date.now() + (pendingResponse ? 30 : 1000) }, error => resolve(error)); });
        call.on('error', () => {}); const terminal = finished(call);
        call.write({ text: 'pending' }, error => { if (error) writeErrors++; });
        const expected = pendingResponse ? grpc.status.DEADLINE_EXCEEDED : grpc.status.PERMISSION_DENIED;
        assert.equal((await result).code, expected); assert.equal((await terminal).code, expected);
        await turn(); assert.equal(writeErrors, 1); clean(call, c);
      });
    } finally { c.close(); }
  });
}

for (const kind of ['cancel', 'deadline', 'close']) {
  test(`REQUEST STREAMING ${kind} clears a blocked producer and active transport`, async () => {
    const c = client(); const arrived = deferred(); let writeErrors = 0;
    try {
      await withFetch(async (_url, init) => {
        arrived.resolve(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('controlled abort')), { once: true }));
      }, async () => {
        let call; const result = new Promise(resolve => { call = c.clientStream({ deadline: Date.now() + (kind === 'deadline' ? 30 : 1000) }, error => resolve(error)); });
        call.on('error', () => {}); const terminal = finished(call);
        call.write({ text: 'pending' }, error => { if (error) writeErrors++; }); await arrived.promise;
        if (kind === 'cancel') call.cancel(); else if (kind === 'close') c.close();
        const expected = kind === 'cancel' ? 1 : kind === 'deadline' ? 4 : 14;
        assert.equal((await result).code, expected); assert.equal((await terminal).code, expected);
        await turn(); assert.equal(writeErrors, 1); clean(call, c);
      });
    } finally { c.close(); }
  });
}

test('REQUEST STREAMING serialization failure completes the public write callback exactly once', async () => {
  const c = client({}, {}, { clientStream: { ...methods.clientStream, requestSerialize() { throw new Error('controlled serializer'); } } });
  let writes = 0;
  try {
    await withFetch(async () => { assert.fail('serialization failure must precede Fetch'); }, async () => {
      let call; const result = new Promise(resolve => { call = c.clientStream(error => resolve(error)); });
      call.on('error', () => {}); const terminal = finished(call);
      call.write({ text: 'unserializable' }, error => { assert.ok(error); writes++; });
      assert.equal((await result).code, grpc.status.INTERNAL); assert.equal((await terminal).code, grpc.status.INTERNAL);
      await turn(); assert.equal(writes, 1); assert.equal(c.getChannel().activeCallCount(), 0);
    });
  } finally { c.close(); }
});
