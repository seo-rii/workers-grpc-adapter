'use strict';
const { test } = require('node:test');
const { assert, grpc, withFetch, trailers, deferred } = require('./helpers.cjs');
const { encodeFrame } = require('../dist/wire.js');
const { HealthClient, HealthServingStatus } = require('../dist/health.js');
const fc = require('fast-check');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'health condition timed out'); await wait(2); }
}
const reply = (bytes, code = 0) => new Response(Buffer.concat([...(bytes === null ? [] : [encodeFrame(bytes)]), trailers(code)]),
  { headers: { 'content-type': 'application/grpc-web+proto' } });
function health() {
  const client = new grpc.Client('health.test', grpc.credentials.createSsl());
  return { client, health: new HealthClient(client) };
}
function held(bytes) {
  let controller, cancelled = 0;
  const body = new ReadableStream({ start(value) { controller = value; if (bytes) value.enqueue(encodeFrame(bytes)); }, cancel() { cancelled++; } });
  return { response: new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } }),
    push: value => controller.enqueue(encodeFrame(value)), cancelled: () => cancelled };
}
let codec;
new HealthClient({ makeUnaryRequest(method, serialize, deserialize, service, metadata, options, callback) {
  codec = { serialize, deserialize }; callback(null, { status: 0 }); return { cancel() {} };
} }).check();

test('HEALTH protobuf UTF-8 requests, defaults, duplicate enum and forward-compatible unknown fields', () => {
  assert.deepEqual(codec.serialize(''), Buffer.alloc(0));
  assert.deepEqual(codec.serialize('é/한글'), Buffer.concat([Buffer.from([10, 9]), Buffer.from('é/한글')]));
  assert.deepEqual(codec.deserialize(Buffer.alloc(0)), { status: 0 });
  assert.deepEqual(codec.deserialize(Buffer.from([8, 3, 8, 1])), { status: 1 });
  // Unknown varint, fixed64, bytes, nested group and fixed32 around status.
  const unknown = Buffer.from([16, 150, 1, 25, 0, 1, 2, 3, 4, 5, 6, 7, 34, 3, 0, 255, 128,
    43, 51, 8, 3, 52, 44, 61, 1, 2, 3, 4, 8, 99]);
  assert.deepEqual(codec.deserialize(unknown), { status: 99 });
  assert.deepEqual(codec.deserialize(Buffer.from([8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1])), { status: -1 });
  assert.throws(() => codec.serialize(null), { code: grpc.status.INVALID_ARGUMENT });
});

test('HEALTH malformed protobuf fails closed, including truncated and mismatched unknown fields', () => {
  for (const bytes of [[0], [8], [10, 0], [15], [16, 128], [25, 0], [34, 2, 0], [43], [44], [43, 52],
    [8, ...Array(10).fill(128)], [8, ...Array(9).fill(255), 2], [128, 128, 128, 128, 16]]) {
    assert.throws(() => codec.deserialize(Buffer.from(bytes)), { code: grpc.status.INTERNAL, details: 'WGA_HEALTH_INVALID_PROTOBUF' });
  }
  assert.throws(() => codec.deserialize(Buffer.from([...Array(65).fill(43), ...Array(65).fill(44)])), { code: grpc.status.INTERNAL });
});

test('HEALTH protobuf fuzz always terminates with int32 status or a sanitized parse error', () => {
  fc.assert(fc.property(fc.uint8Array({ maxLength: 1024 }), bytes => {
    try {
      const result = codec.deserialize(Buffer.from(bytes));
      assert.ok(Number.isInteger(result.status) && result.status >= -2147483648 && result.status <= 2147483647);
    } catch (error) {
      assert.equal(error.code, grpc.status.INTERNAL);
      assert.equal(error.details, 'WGA_HEALTH_INVALID_PROTOBUF');
    }
  }), { seed: 735021, numRuns: 2500 });
});

test('HEALTH Check uses standard route and retains explicit metadata and bounded deadline', async () => {
  const { client, health: h } = health();
  let arrivals = 0;
  try {
    await withFetch(async (url, options) => {
      arrivals++; assert.equal(url, 'https://health.test/grpc.health.v1.Health/Check');
      assert.equal(options.headers.get('x-health-fixture'), 'marker');
      assert.equal(options.headers.get('authorization'), 'Bearer health-fixture');
      assert.ok(options.headers.get('grpc-timeout'));
      assert.deepEqual(Buffer.from(options.body).subarray(5), codec.serialize('service/한글'));
      return reply(Buffer.from([8, 1]));
    }, async () => {
      const metadata = new grpc.Metadata(); metadata.set('x-health-fixture', 'marker');
      const credentials = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
        const auth = new grpc.Metadata(); auth.set('authorization', 'Bearer health-fixture'); callback(null, auth);
      });
      assert.deepEqual(await h.check('service/한글', { metadata, credentials }), { status: HealthServingStatus.SERVING });
      await assert.rejects(h.check('', { deadline: Date.now() - 1 }), { code: grpc.status.DEADLINE_EXCEEDED });
      await assert.rejects(h.check('', { deadline: Infinity }), { code: grpc.status.INVALID_ARGUMENT });
      const abort = new AbortController(); abort.abort();
      await assert.rejects(h.check('', { signal: abort.signal }), { code: grpc.status.CANCELLED });
      assert.equal(arrivals, 1);
    });
  } finally { client.close(); }
});

test('HEALTH Check abort cancels the outstanding fetch and malformed response is INTERNAL', async () => {
  const { client, health: h } = health();
  const arrived = deferred(); let aborted = false;
  try {
    await withFetch(async (_url, options) => { arrived.resolve(); return new Promise((_resolve, reject) =>
      options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('fixture aborted')); }, { once: true })); }, async () => {
      const abort = new AbortController(); const result = h.check('', { signal: abort.signal });
      const rejected = assert.rejects(result, { code: grpc.status.CANCELLED });
      await arrived.promise; abort.abort(); await rejected; await until(() => aborted);
    });
    await withFetch(async () => reply(Buffer.from([8, 128])), async () => {
      await assert.rejects(h.check(), { code: grpc.status.INTERNAL });
    });
  } finally { client.close(); }
});

test('HEALTH Watch observes UNKNOWN and SERVICE_UNKNOWN before SERVING without claiming connectivity', async () => {
  const { client, health: h } = health(); const body = held(Buffer.from([8, 3])); let monitor;
  try {
    await withFetch(async url => { assert.ok(url.endsWith('/grpc.health.v1.Health/Watch')); return body.response; }, async () => {
      monitor = h.monitor('delayed');
      await until(() => monitor.getState().phase === 'not-serving');
      assert.equal(monitor.getState().servingStatus, 3);
      const waiting = monitor.waitForServing({ deadline: Date.now() + 1000 });
      body.push(Buffer.from([8, 99])); await until(() => monitor.getState().servingStatus === 99);
      body.push(Buffer.from([8, 1]));
      const state = await waiting; assert.equal(state.phase, 'serving'); assert.ok(Object.isFrozen(state));
      body.push(Buffer.from([8, 2])); await until(() => monitor.getState().phase === 'not-serving');
      await assert.rejects(monitor.waitForServing({ deadline: Date.now() + 15 }), { code: grpc.status.DEADLINE_EXCEEDED });
      monitor.close(); await until(() => body.cancelled() === 1);
      assert.equal(monitor.getState().phase, 'closed');
      assert.equal(client.getChannel().getConnectivityState(false), grpc.connectivityState.IDLE);
    });
  } finally { monitor?.close(); client.close(); }
});

test('HEALTH reconnects after UNAVAILABLE and OK; UNIMPLEMENTED disables retries and rejects pending gates', async () => {
  const { client, health: h } = health(); let monitor, arrivals = 0;
  try {
    await withFetch(async () => {
      arrivals++;
      return reply(null, arrivals === 1 ? grpc.status.UNAVAILABLE : arrivals === 2 ? grpc.status.OK : grpc.status.UNIMPLEMENTED);
    }, async () => {
      monitor = h.monitor('', { initialBackoffMs: 5, maxBackoffMs: 20, backoffMultiplier: 2, backoffJitter: 0 });
      await assert.rejects(monitor.waitForServing({ deadline: Date.now() + 1000 }), { code: grpc.status.UNIMPLEMENTED });
      assert.equal(monitor.getState().phase, 'disabled'); assert.equal(monitor.getState().attempt, 3);
      await assert.rejects(monitor.waitForServing({ deadline: Date.now() + 1000 }), { code: grpc.status.UNIMPLEMENTED });
      await wait(40); assert.equal(arrivals, 3);
    });
  } finally { monitor?.close(); client.close(); }
});

test('HEALTH wait abort is isolated; closing resolves cleanup and leaves the client reusable', async () => {
  const { client, health: h } = health(); const body = held(); let monitor, arrivals = 0;
  try {
    await withFetch(async url => { arrivals++; return url.endsWith('/Watch') ? body.response : reply(Buffer.from([8, 1])); }, async () => {
      monitor = h.monitor();
      const abort = new AbortController();
      const first = assert.rejects(monitor.waitForServing({ deadline: Date.now() + 1000, signal: abort.signal }), { code: grpc.status.CANCELLED });
      const second = monitor.waitForServing({ deadline: new Date(Date.now() + 1000) });
      abort.abort(); await first; body.push(Buffer.from([8, 1])); assert.equal((await second).phase, 'serving');
      body.push(Buffer.from([8, 2])); await until(() => monitor.getState().phase === 'not-serving');
      const third = assert.rejects(monitor.waitForServing({ deadline: Date.now() + 1000 }), { code: grpc.status.CANCELLED });
      monitor.close(); monitor.close(); await third; await until(() => body.cancelled() === 1);
      assert.deepEqual(await h.check(), { status: 1 }); assert.equal(arrivals, 2);
      await assert.rejects(monitor.waitForServing({ deadline: Date.now() + 1000 }), { code: grpc.status.CANCELLED });
    });
  } finally { monitor?.close(); client.close(); }
});

test('HEALTH invalid backoff and timeout settings fail before starting requests; close before first attempt', async () => {
  const { client, health: h } = health();
  try {
    for (const options of [{ initialBackoffMs: 0 }, { maxBackoffMs: 1 }, { backoffMultiplier: NaN },
      { backoffJitter: 2 }, { attemptTimeoutMs: Infinity }]) assert.throws(() => h.monitor('', options), { code: grpc.status.INVALID_ARGUMENT });
    await withFetch(async () => { assert.fail('closed observer must not issue a request'); }, async () => {
      const monitor = h.monitor(); monitor.close(); await wait(2);
      assert.equal(monitor.getState().attempt, 0);
    });
  } finally { client.close(); }
});

test('HEALTH optional attempt deadline retries and close cancels scheduled backoff', async () => {
  const { client, health: h } = health(); let monitor, arrivals = 0, cancelled = 0;
  try {
    await withFetch(async () => {
      arrivals++;
      return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/grpc-web+proto' } });
    }, async () => {
      monitor = h.monitor('', { attemptTimeoutMs: 15, initialBackoffMs: 50, maxBackoffMs: 50, backoffJitter: 0 });
      await until(() => monitor.getState().phase === 'reconnecting');
      assert.equal(monitor.getState().lastErrorCode, grpc.status.DEADLINE_EXCEEDED);
      monitor.close(); await wait(70); assert.equal(arrivals, 1); assert.equal(cancelled, 1);
    });
  } finally { monitor?.close(); client.close(); }
});
