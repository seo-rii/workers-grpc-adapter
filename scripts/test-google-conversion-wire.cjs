'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

// Only synthetic credentials and an intercepted fetch are available to this test.
const env = {
  WGA_TEST_KEY: 'synthetic-test-key/?'.repeat(4),
  WGA_GOOGLE_ACCESS_TOKEN: 'synthetic-access-token/+?'.repeat(4),
  WGA_SECRET_NAME: `projects/123456789/secrets/wga-probe-${'a'.repeat(130)}-missing`,
};
const endpoint = 'https://secretmanager.googleapis.com/google.cloud.secretmanager.v1.SecretManagerService/GetSecret';
const wires = {
  'web-proto': 'application/grpc-web+proto',
  web: 'application/grpc-web',
  'native-proto': 'application/grpc+proto',
  native: 'application/grpc',
};
const modes = ['default', 'convert', 'passthrough'];
const baseUrl = 'https://wire-probe.invalid';
const originalFetch = globalThis.fetch;
let handler;
let requests = 0;
let scenarios = 0;

function request(route = '/probe/default/web-proto', options = {}) {
  return new Request(baseUrl + route, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WGA_TEST_KEY}`, 'cf-ray': 'synthetic-worker-ray' },
    ...options,
  });
}

function trailerFrame(text) {
  const body = Buffer.from(text);
  const frame = Buffer.alloc(body.length + 5);
  frame[0] = 128;
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, 5);
  return frame;
}

function assertNoCredentials(value) {
  const text = JSON.stringify(value);
  for (const secret of [env.WGA_TEST_KEY, env.WGA_GOOGLE_ACCESS_TOKEN]) {
    assert.equal(text.includes(secret), false, 'Plaintext credential must be redacted');
    assert.equal(text.includes(encodeURIComponent(secret)), false, 'Encoded credential must be redacted');
  }
}

function assertGetSecretRequest(options) {
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.equal(options.headers.authorization, `Bearer ${env.WGA_GOOGLE_ACCESS_TOKEN}`);
  assert.equal(options.headers['grpc-timeout'], '20000m');
  assert.ok(options.body instanceof Uint8Array);
  const bytes = Buffer.from(options.body);
  assert.equal(bytes[0], 0);
  assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
  assert.equal(bytes[5], 10, 'GetSecret name is protobuf field 1');
  let offset = 6, size = 0, shift = 0;
  while (true) {
    assert.ok(offset < bytes.length);
    const byte = bytes[offset++];
    size += (byte & 127) * 2 ** shift;
    shift += 7;
    if (!(byte & 128)) break;
    assert.ok(shift < 35);
  }
  assert.ok(size > 127, 'Exercise a multibyte protobuf length varint');
  assert.equal(size, bytes.length - offset);
  assert.equal(bytes.subarray(offset).toString(), env.WGA_SECRET_NAME);
}

async function main() {
  globalThis.fetch = async (target, options) => {
    requests++;
    assert.equal(target, endpoint, 'Request target must remain fixed');
    if (!handler) throw new Error('Unexpected outbound fetch in guarded request');
    return handler(options);
  };
  try {
    const worker = (await import(pathToFileURL(path.join(__dirname, '../fixtures/google/conversion-wire.mjs')).href)).default;
    const guards = [
      [request('/probe/default/web-proto', { method: 'GET' }), env, 404],
      [request('/probe/default/web-proto', { headers: {} }), env, 404],
      [request('/probe/default/web-proto', { headers: { authorization: 'Bearer short' } }), env, 404],
      [request('/probe/default/web-proto', { headers: { authorization: `Bearer ${'x'.repeat(env.WGA_TEST_KEY.length)}` } }), env, 404],
      [request(), { ...env, WGA_TEST_KEY: 'short' }, 404],
      [request('/probe/default/web-proto/extra'), env, 404],
      [request('/probe/arbitrary/web-proto'), env, 404],
      [request('/probe/default/json'), env, 404],
      [request(), { ...env, WGA_SECRET_NAME: 'projects/123456789/secrets/existing' }, 500],
      [request(), { ...env, WGA_SECRET_NAME: 'projects/name/secrets/wga-probe-fixture-missing' }, 500],
      [request(), { ...env, WGA_GOOGLE_ACCESS_TOKEN: 'short' }, 500],
    ];
    for (const [input, bindings, expectedStatus] of guards) {
      assert.equal((await worker.fetch(input, bindings)).status, expectedStatus);
      assert.equal(requests, 0, 'Rejected requests must not fetch');
      scenarios++;
    }

    const details = `Missing ${env.WGA_SECRET_NAME}; ${env.WGA_GOOGLE_ACCESS_TOKEN}; ${env.WGA_TEST_KEY}`;
    const frame = trailerFrame(`grpc-status: 5\r\ngrpc-message: ${encodeURIComponent(details)}\r\n`);
    for (const mode of modes) for (const [wire, contentType] of Object.entries(wires)) {
      handler = async options => {
        assertGetSecretRequest(options);
        assert.equal(options.headers['content-type'], contentType);
        assert.equal(options.headers['x-grpc-web'], wire.startsWith('web') ? '1' : undefined);
        assert.deepEqual(options.cf, mode === 'default' ? undefined : { grpcWeb: mode });
        return new Response(frame, { headers: {
          'content-type': 'application/grpc-web+proto; charset=utf-8',
          'grpc-status': '5', 'grpc-message': env.WGA_GOOGLE_ACCESS_TOKEN,
          server: env.WGA_TEST_KEY, 'cf-ray': 'synthetic-upstream-ray', 'x-request-id': 'synthetic-request-id',
        } });
      };
      const response = await worker.fetch(request(`/probe/${mode}/${wire}`), env);
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.mode, mode);
      assert.equal(result.wire, wire);
      assert.equal(result.httpStatus, 200);
      assert.equal(result.grpcStatusHeader, '5');
      assert.equal(result.grpcMessageHeader, '[redacted]');
      assert.equal(result.server, '[redacted]');
      assert.equal(result.cfRay, 'synthetic-upstream-ray');
      assert.equal(result.workerCfRay, 'synthetic-worker-ray');
      assert.equal(result.requestId, 'synthetic-request-id');
      assert.equal(result.messageFrames, 0);
      assert.equal(result.trailerFrames, 1);
      assert.deepEqual(result.grpcWebStatuses, [5]);
      assert.deepEqual(result.grpcWebMessages, [`Missing ${env.WGA_SECRET_NAME}; [redacted]; [redacted]`]);
      assert.equal(result.malformedFrames, false);
      assert.equal(result.bodyLimitExceeded, false);
      assert.equal(result.bodyBytes, frame.length);
      assert.equal(result.capturedBytes, frame.length);
      assert.equal(result.bodySha256, createHash('sha256').update(frame).digest('hex'));
      assert.equal('nonGrpcBodyPrefix' in result, false, 'Never emit binary response bodies');
      assertNoCredentials(result);
      scenarios++;
    }
    assert.equal(requests, 12);

    const textBody = Buffer.from(`${env.WGA_TEST_KEY} ${env.WGA_GOOGLE_ACCESS_TOKEN} ${encodeURIComponent(env.WGA_GOOGLE_ACCESS_TOKEN)} ` + 'x'.repeat(70000));
    let cancelled = false;
    handler = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(textBody); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/plain' } });
    const capped = await (await worker.fetch(request(), env)).json();
    assert.equal(capped.bodyLimitExceeded, true);
    assert.equal(capped.bodyBytes, textBody.length);
    assert.equal(capped.capturedBytes, 65536);
    assert.equal(capped.bodySha256, createHash('sha256').update(textBody.subarray(0, 65536)).digest('hex'));
    assert.equal(capped.nonGrpcBodyPrefix.length, 1500);
    assert.ok(capped.nonGrpcBodyPrefix.startsWith('[redacted] [redacted] [redacted]'));
    assert.equal(cancelled, true, 'Oversized body stream must be cancelled');
    assertNoCredentials(capped);
    scenarios++;

    handler = async () => new Response(Buffer.from([128, 0, 0, 0, 10]), { headers: { 'content-type': 'application/grpc-web' } });
    const malformed = await (await worker.fetch(request(), env)).json();
    assert.equal(malformed.malformedFrames, true);
    assert.equal(malformed.trailerFrames, 0);
    assert.equal('nonGrpcBodyPrefix' in malformed, false);
    scenarios++;

    handler = async () => { throw new TypeError(`Synthetic failure ${env.WGA_GOOGLE_ACCESS_TOKEN} ${env.WGA_TEST_KEY}`); };
    const failureResponse = await worker.fetch(request(), env);
    const failure = await failureResponse.json();
    assert.equal(failureResponse.status, 502);
    assert.equal(failure.error, 'WIRE_PROBE_ERROR');
    assert.equal(failure.errorName, 'TypeError');
    assert.equal(failure.message, 'Synthetic failure [redacted] [redacted]');
    assertNoCredentials(failure);
    scenarios++;

    console.log(`google-conversion-wire: ${scenarios} local contract scenarios passed; ${requests} intercepted requests, no network`);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
