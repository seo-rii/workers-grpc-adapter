'use strict';
const { test } = require('node:test');
const { fc, check } = require('./property-helpers.cjs');
const { assert, grpc, Echo, response, serialize, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

const invalidValues = [() => new Date(NaN), () => NaN, () => -Infinity, () => null,
  () => '1000', () => false, () => ({ valueOf: () => Infinity })];
const zeroExecution = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };

function setup(mode, interceptors = []) {
  const counts = { auth: 0, fetch: 0 };
  const transport = createWorkersGrpcTransport({ mode, defaultTimeoutMs: 1000,
    ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
    resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 2 },
    fetcher: { async fetch() { counts.fetch++; return response(); } },
  });
  const client = new Echo('echo.test', transport.channelCredentials, transport.grpcOptions({ interceptors }));
  const credentials = grpc.credentials.createFromMetadataGenerator((_options, done) => {
    counts.auth++; done(null, new grpc.Metadata());
  });
  return { client, transport, counts, credentials };
}

function begin(h, kind, deadline) {
  const record = { codes: [], details: [], events: [], callbacks: [], writes: [], returned: false };
  const options = { deadline, credentials: h.credentials };
  const onStatus = value => {
    assert.equal(record.returned, true, 'status is delivered after the call returns');
    record.codes.push(value.code); record.details.push(value.details); record.events.push('status');
  };
  if (kind === 'direct') {
    record.call = h.client.getChannel().createCallForMethod('/demo.Echo/Unary', false, false, options);
    record.call.start(new grpc.Metadata(), { onReceiveMetadata() {}, onReceiveMessage() { record.call.startRead(); }, onReceiveStatus: onStatus });
    record.call.startRead();
    record.call.sendMessageWithContext({ callback(error) { record.writes.push(error?.message ?? null); } }, serialize({ text: 'request' }));
    record.call.halfClose();
  } else if (kind === 'unary') {
    record.call = h.client.unary({ text: 'request' }, options, (error, value) => {
      assert.equal(record.returned, true, 'callback is delivered after the call returns');
      record.callbacks.push({ code: error?.code ?? 0, details: error?.details, value }); record.events.push('callback');
    });
    record.call.on('status', onStatus);
  } else {
    record.call = h.client.stream({ text: 'request' }, options);
    record.call.on('error', error => {
      assert.equal(record.returned, true, 'stream error is delivered after the call returns');
      record.callbacks.push({ code: error.code, details: error.details }); record.events.push('error');
    });
    record.call.on('status', onStatus);
    record.call.resume();
  }
  record.returned = true;
  record.cancel = () => kind === 'direct'
    ? record.call.cancelWithStatus(grpc.status.CANCELLED, 'late cancellation') : record.call.cancel();
  return record;
}

function assertInvalid(h, record, kind) {
  assert.deepEqual(record.codes, [grpc.status.INVALID_ARGUMENT]);
  assert.deepEqual(record.details, ['WGA_INVALID_DEADLINE']);
  assert.deepEqual(h.counts, { auth: 0, fetch: 0 });
  assert.equal(h.client.getChannel().activeCallCount(), 0);
  assert.deepEqual(transportCall(record.call).diagnostics(), {
    terminal: true, fetchCount: 0, requestBytes: 0, responseBytes: 0, timerActive: false,
  });
  assert.deepEqual(transportCall(record.call).executionDiagnostics(), zeroExecution);
  for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes', 'peakActiveCalls', 'peakQueuedCalls']) {
    assert.equal(h.transport.resourceUsage()[key], 0, `invalid calls never reserve ${key}`);
  }
  if (kind === 'direct') {
    assert.equal(record.writes.length, 1); assert.match(record.writes[0], /WGA_CALL_TERMINATED/);
    assert.deepEqual(record.events, ['status']);
  } else {
    assert.equal(record.callbacks.length, 1);
    assert.equal(record.callbacks[0].code, grpc.status.INVALID_ARGUMENT);
    assert.equal(record.callbacks[0].details, 'WGA_INVALID_DEADLINE');
    assert.deepEqual(record.events, [kind === 'unary' ? 'callback' : 'error', 'status']);
  }
}

for (const mode of ['cloudflare', 'grpc-web']) for (const kind of ['direct', 'unary', 'stream']) {
  test(`DEADLINE invalid ${kind} input is asynchronous INVALID_ARGUMENT before auth or admission in ${mode}`, async () => {
    const h = setup(mode);
    try {
      for (const createValue of invalidValues) {
        const record = begin(h, kind, createValue());
        assert.deepEqual(record.events, [], 'no application event during call construction/start');
        await immediate(); assertInvalid(h, record, kind);
        record.cancel(); await immediate(); assertInvalid(h, record, kind);
      }
      // Invalid calls cannot poison a shared client or consume its only slot.
      const recovered = await new Promise((resolve, reject) => h.client.unary({ text: 'after invalid' },
        { deadline: Infinity, credentials: h.credentials }, (error, value) => error ? reject(error) : resolve(value)));
      assert.deepEqual(recovered, { text: 'ok' });
      await immediate(); assert.deepEqual(h.counts, { auth: 1, fetch: 1 });
      assert.equal(h.client.getChannel().activeCallCount(), 0);
      for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(h.transport.resourceUsage()[key], 0);
    } finally { h.client.close(); }
  });
}

test('DEADLINE a synchronous interceptor constructor supplying invalid Date cannot enter requester startup', async () => {
  let starts = 0, sends = 0;
  const h = setup('cloudflare', [(options, nextCall) => new grpc.InterceptingCall(nextCall({ ...options, deadline: new Date(NaN) }), {
    start(_metadata, _listener, _next) { starts++; }, sendMessage(_value, _next) { sends++; },
  })]);
  try {
    const record = begin(h, 'unary', Infinity);
    await immediate(); assertInvalid(h, record, 'unary');
    assert.equal(starts, 0); assert.equal(sends, 0);
  } finally { h.client.close(); }
});

test('DEADLINE finite past Date and number retain DEADLINE_EXCEEDED while explicit Infinity overrides a default', async t => {
  t.mock.method(Date, 'now', () => 1000);
  for (const mode of ['cloudflare', 'grpc-web']) for (const kind of ['direct', 'unary']) {
    const h = setup(mode);
    try {
      for (const deadline of [999, new Date(999)]) {
        const record = begin(h, kind, deadline);
        assert.deepEqual(record.events, []);
        await immediate();
        assert.deepEqual(record.codes, [grpc.status.DEADLINE_EXCEEDED]);
        assert.deepEqual(record.details, ['WGA_DEADLINE']);
        assert.deepEqual(h.counts, { auth: 0, fetch: 0 });
        assert.equal(h.client.getChannel().activeCallCount(), 0);
      }
      const record = begin(h, kind, Infinity);
      await immediate();
      assert.deepEqual(record.codes, [grpc.status.OK]);
      assert.deepEqual(h.counts, { auth: 1, fetch: 1 });
      assert.equal(transportCall(record.call).diagnostics().timerActive, false);
    } finally { h.client.close(); }
  }
});

test('FUZZ invalid deadline remains terminal across generated cancel, close, read and microtask schedules', { timeout: 30000 }, async () => {
  await check(fc.asyncProperty(fc.integer({ min: 0, max: invalidValues.length - 1 }),
    fc.constantFrom('direct', 'unary', 'stream'), fc.constantFrom('cloudflare', 'grpc-web'),
    fc.array(fc.constantFrom('cancel', 'close', 'read', 'microtask'), { maxLength: 20 }),
    async (index, kind, mode, schedule) => {
      const h = setup(mode);
      try {
        const record = begin(h, kind, invalidValues[index]());
        for (const action of schedule) {
          if (action === 'cancel') record.cancel();
          else if (action === 'close') h.client.close();
          else if (action === 'read') transportCall(record.call).startRead();
          else await Promise.resolve();
        }
        await immediate(); assertInvalid(h, record, kind);
        record.cancel(); h.client.close(); await immediate(); assertInvalid(h, record, kind);
      } finally { h.client.close(); }
    }), { examples: [[0, 'unary', 'cloudflare', ['close', 'cancel', 'read']],
      [1, 'direct', 'grpc-web', ['cancel', 'microtask', 'close']],
      [2, 'stream', 'cloudflare', ['microtask', 'cancel', 'close']]] });
});
