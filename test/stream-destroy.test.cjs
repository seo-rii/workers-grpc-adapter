'use strict';
const { test } = require('node:test');
const { once } = require('node:events');
const { assert, grpc, client, Echo, response, withFetch, serialize, immediate, deferred, transportCall } = require('./helpers.cjs');
const { encodeFrame, decodeFrames } = require('../dist/wire.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
function streamingClient(options = {}) {
  const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true });
  return new Echo('echo.test', transport.channelCredentials, transport.grpcOptions(options));
}
function observe(stream) {
  const statuses = [], errors = [];
  const terminal = new Promise(resolve => stream.on('status', status => { statuses.push(status); resolve(status); }));
  stream.on('error', error => errors.push(error));
  return { statuses, errors, terminal };
}
function clean(stream, c, fetches) {
  assert.equal(c.getChannel().activeCallCount(), 0);
  assert.deepEqual(transportCall(stream).diagnostics(), { terminal: true, fetchCount: fetches, requestBytes: 0, responseBytes: 0, timerActive: false });
}
function hangingResponse(cancel) {
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encodeFrame(serialize({ text: 'one' }))); }, cancel }),
    { headers: { 'content-type': 'application/grpc-web+proto' } });
}

test('DESTROY readable releases response reader, preserves explicit error, and emits one terminal status', { timeout: 3000 }, async () => {
  for (const explicitError of [undefined, new Error('consumer stopped')]) {
    const c = client(); let cancelled = 0;
    try {
      await withFetch(async () => hangingResponse(() => cancelled++), async () => {
        const stream = c.stream({ text: 'request' }, { deadline: Date.now() + 2000 });
        const observed = observe(stream), first = once(stream, 'data');
        let cancellationCalls = 0;
        const cancel = stream.call.cancelWithStatus.bind(stream.call);
        stream.call.cancelWithStatus = (...args) => { cancellationCalls++; cancel(...args); };
        await first;
        stream.destroy(explicitError); stream.destroy(explicitError);
        assert.equal((await observed.terminal).code, grpc.status.CANCELLED);
        await immediate();
        assert.equal(cancelled, 1); assert.equal(cancellationCalls, 1); assert.equal(observed.statuses.length, 1);
        assert.deepEqual(observed.errors, explicitError ? [explicitError] : []);
        clean(stream, c, 1);
        await withFetch(async () => response(), async () => {
          const values = []; for await (const value of c.stream({ text: 'next' })) values.push(value.text);
          assert.deepEqual(values, ['ok']);
        });
      });
    } finally { c.close(); }
  }
});

test('DESTROY async iterator break cancels raw readable RPC and releases its reader', { timeout: 3000 }, async () => {
  const c = client(); let cancelled = 0;
  try {
    await withFetch(async () => hangingResponse(() => cancelled++), async () => {
      const stream = c.stream({ text: 'request' }, { deadline: Date.now() + 2000 }), observed = observe(stream);
      for await (const value of stream) { assert.equal(value.text, 'one'); break; }
      assert.equal((await observed.terminal).code, grpc.status.CANCELLED);
      await immediate(); assert.equal(cancelled, 1); assert.equal(observed.statuses.length, 1);
      assert.equal(observed.errors.length, 1); assert.equal(observed.errors[0].code, 'ABORT_ERR'); clean(stream, c, 1);
    });
  } finally { c.close(); }
});

test('DESTROY normal readable EOF retains successful status through autoDestroy', { timeout: 3000 }, async () => {
  const c = client();
  try {
    await withFetch(async () => response(), async () => {
      const stream = c.stream({ text: 'request' }), observed = observe(stream), values = [];
      let cancellationCalls = 0;
      const cancel = stream.call.cancelWithStatus.bind(stream.call);
      stream.call.cancelWithStatus = (...args) => { cancellationCalls++; cancel(...args); };
      for await (const value of stream) values.push(value.text);
      await immediate(); assert.deepEqual(values, ['ok']); assert.ok(stream.destroyed);
      assert.equal((await observed.terminal).code, 0); assert.equal(cancellationCalls, 0); assert.equal(observed.statuses.length, 1); assert.deepEqual(observed.errors, []); clean(stream, c, 1);
    });
  } finally { c.close(); }
});

for (const kind of ['clientStream', 'bidi']) {
  test(`DESTROY ${kind} rejects pending and queued writes once when upload has no demand`, { timeout: 3000 }, async () => {
    const c = streamingClient(), entered = deferred(), responsePending = deferred(); let signal;
    try {
      await withFetch(async (_url, init) => { signal = init.signal; entered.resolve(); return responsePending.promise; }, async () => {
        let callbackCalls = 0, callbackError;
        const stream = kind === 'clientStream' ? c.clientStream({ deadline: Date.now() + 2000 }, error => { callbackCalls++; callbackError = error; })
          : c.bidi({ deadline: Date.now() + 2000 });
        const observed = observe(stream), writes = [[], []];
        stream.write({ text: 'pending' }, error => writes[0].push(error));
        stream.write({ text: 'queued' }, error => writes[1].push(error));
        await entered.promise; stream.destroy();
        assert.equal((await observed.terminal).code, 1); await immediate();
        assert.ok(signal.aborted); assert.equal(observed.statuses.length, 1);
        for (const callbacks of writes) { assert.equal(callbacks.length, 1); assert.equal(callbacks[0].code, 1); }
        if (kind === 'clientStream') { assert.equal(callbackCalls, 1); assert.equal(callbackError.code, 1); }
        clean(stream, c, 1);
        responsePending.resolve(response()); await immediate();
        for (const callbacks of writes) assert.equal(callbacks.length, 1);
      });
    } finally { c.close(); }
  });
}

test('DESTROY writable finish is only half-close and does not cancel a pending response', { timeout: 3000 }, async () => {
  const c = streamingClient(), requestDone = deferred(), reply = deferred();
  try {
    await withFetch(async (_url, init) => { for await (const _ of decodeFrames(init.body, 1024)) {} requestDone.resolve(); return reply.promise; }, async () => {
      let stream;
      const result = new Promise((resolve, reject) => { stream = c.clientStream({ deadline: Date.now() + 2000 }, (error, value) => error ? reject(error) : resolve(value)); });
      const observed = observe(stream), finished = once(stream, 'finish');
      stream.end({ text: 'request' }); await finished; await requestDone.promise; await immediate();
      assert.equal(c.getChannel().activeCallCount(), 1); assert.equal(stream.destroyed, false);
      reply.resolve(response()); assert.deepEqual(await result, { text: 'ok' }); assert.equal((await observed.terminal).code, 0);
      await immediate(); assert.equal(stream.destroyed, true); assert.equal(observed.statuses.length, 1); assert.deepEqual(observed.errors, []); clean(stream, c, 1);
    });
  } finally { c.close(); }
});

for (const phase of ['start', 'auth', 'sendMessage']) {
  test(`DESTROY stalled ${phase} releases writes and ignores late continuation`, { timeout: 3000 }, async () => {
    const held = deferred(); let resume, fetches = 0, completions = 0;
    const options = {};
    if (phase !== 'auth') options.interceptors = [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), phase === 'start' ? {
      start(metadata, listener, next) { resume = () => next(metadata, listener); held.resolve(); },
    } : { sendMessage(message, next) { resume = () => next(message); held.resolve(); } })];
    const c = streamingClient(options);
    const credentials = phase === 'auth' ? grpc.credentials.createFromMetadataGenerator((_options, next) => {
      resume = () => next(null, new grpc.Metadata()); held.resolve();
    }) : undefined;
    try {
      await withFetch(async () => { fetches++; return response(); }, async () => {
        const stream = c.clientStream({ deadline: Date.now() + 2000, ...(credentials ? { credentials } : {}) }, error => {
          completions++; assert.equal(error.code, 1);
        });
        const observed = observe(stream), writes = [];
        stream.write({ text: 'pending' }, error => writes.push(error));
        await held.promise; stream.destroy();
        assert.equal((await observed.terminal).code, 1); await immediate();
        assert.equal(writes.length, 1); assert.equal(writes[0].code, 1); assert.equal(completions, 1);
        resume(); await immediate();
        assert.equal(fetches, 0); assert.equal(writes.length, 1); assert.equal(observed.statuses.length, 1); clean(stream, c, 0);
      });
    } finally { c.close(); }
  });
}

test('DESTROY readable during held credentials terminates without a Fetch or duplicate error', { timeout: 3000 }, async () => {
  const held = deferred(); let resume, fetches = 0;
  const credentials = grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), grpc.credentials.createFromMetadataGenerator((_options, next) => {
    resume = () => next(null, new grpc.Metadata()); held.resolve();
  }));
  const c = new Echo('echo.test', credentials);
  try {
    await withFetch(async () => { fetches++; return response(); }, async () => {
      const stream = c.stream({ text: 'request' }, { deadline: Date.now() + 2000 }), observed = observe(stream);
      await held.promise; stream.destroy(); assert.equal((await observed.terminal).code, 1); await immediate();
      resume(); await immediate(); assert.equal(fetches, 0); assert.deepEqual(observed.errors, []);
      assert.equal(observed.statuses.length, 1); clean(stream, c, 0);
    });
  } finally { c.close(); }
});

for (const kind of ['clientStream', 'bidi']) {
  test(`DESTROY ${kind} after upload EOF still cancels the unfinished response`, { timeout: 3000 }, async () => {
    const c = streamingClient(), requestDone = deferred(), reply = deferred(); let signal;
    try {
      await withFetch(async (_url, init) => {
        signal = init.signal;
        for await (const _ of decodeFrames(init.body, 1024)) {}
        requestDone.resolve(); return reply.promise;
      }, async () => {
        let callbackCalls = 0;
        const stream = kind === 'clientStream' ? c.clientStream({ deadline: Date.now() + 2000 }, error => { callbackCalls++; assert.equal(error.code, 1); })
          : c.bidi({ deadline: Date.now() + 2000 });
        const observed = observe(stream), finished = once(stream, 'finish');
        stream.end({ text: 'request' }); await finished; await requestDone.promise;
        stream.destroy(); assert.equal((await observed.terminal).code, 1); await immediate();
        assert.ok(signal.aborted); assert.equal(observed.statuses.length, 1); assert.deepEqual(observed.errors, []);
        if (kind === 'clientStream') assert.equal(callbackCalls, 1);
        clean(stream, c, 1); reply.resolve(response()); await immediate();
      });
    } finally { c.close(); }
  });
}
