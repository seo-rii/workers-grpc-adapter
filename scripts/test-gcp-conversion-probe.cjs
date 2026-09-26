'use strict';
// Inspect the raw diagnostic fetch path without deploying or contacting a service.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const key = 'local-conversion-probe-key-at-least-32-characters';
const identity = 'local-conversion-identity-token-never-valid';
const env = {
  WGA_TEST_KEY: key,
  WGA_NATIVE_ORIGIN: 'https://wga-test-native.run.app',
  WGA_GATEWAY_ORIGIN: 'https://wga-test-gateway.run.app',
  WGA_GATEWAY_ID_TOKEN: identity,
};
const remoteDetail = 'remote-detail-must-not-appear';
function frame(flag, body) {
  const bytes = Buffer.from(body), header = Buffer.alloc(5);
  header[0] = flag; header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
const trailers = text => frame(128, text ?? `grpc-status: 0\r\ngrpc-message: ${remoteDetail}\r\n`);

async function main() {
  const worker = (await import(pathToFileURL(path.join(__dirname, '../fixtures/google/gcp-echo-probe.mjs')))).default;
  const originalFetch = globalThis.fetch;
  const requests = [];
  let respond = () => { throw new Error('Unexpected fetch'); };
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), ...options, headers: new Headers(options.headers), body: Buffer.from(options.body) };
    requests.push(request);
    return respond(request);
  };
  const call = async ({ route = '/echo/cloudflare/raw-convert', method = 'POST', authorization = `Bearer ${key}`, bindings } = {}) => {
    const headers = authorization === null ? {} : { authorization };
    return worker.fetch(new Request(`https://probe.invalid${route}`, { method, headers }), { ...env, ...bindings });
  };
  const json = async options => {
    const response = await call(options);
    assert.equal(response.status, 200);
    const result = await response.json();
    const serialized = JSON.stringify(result);
    for (const value of [key, identity, remoteDetail, 'wga deployed probe']) assert.ok(!serialized.includes(value), 'Diagnostics must not expose remote bodies or credentials');
    return result;
  };
  let guards = 0, routes = 0, malformed = 0;
  try {
    for (const test of [
      { authorization: null },
      { authorization: `Bearer ${key}x` },
      { method: 'GET' },
      { bindings: { WGA_TEST_KEY: 'short' } },
      { route: '/echo/cloudflare/raw-unknown' },
      { route: '/echo/other/raw-convert' },
    ]) {
      assert.equal((await call(test)).status, 404);
      guards++;
    }
    for (const bindings of [
      { WGA_NATIVE_ORIGIN: 'https://unapproved.invalid' },
      { WGA_GATEWAY_ORIGIN: 'http://wga-test-gateway.run.app' },
      { WGA_GATEWAY_ID_TOKEN: '' },
    ]) {
      assert.equal((await call({ bindings })).status, 500);
      guards++;
    }
    assert.equal(requests.length, 0, 'Invalid requests cannot reach fetch');

    for (const mode of ['cloudflare', 'grpc-web']) for (const variant of ['raw', 'raw-convert', 'raw-passthrough']) {
      respond = request => new Response(Buffer.concat([request.body, trailers()]), { headers: { 'content-type': 'application/grpc-web+proto' } });
      const result = await json({ route: `/echo/${mode}/${variant}?target=https://ignored.invalid` });
      assert.equal(result.grpcWebValid, true);
      assert.equal(result.echoMatches, true);
      assert.equal(result.messageFrames, 1);
      assert.equal(result.trailerFrames, 1);
      assert.deepEqual(result.grpcWebStatuses, [0]);
      assert.equal(result.requestedConversion, variant === 'raw' ? 'default' : variant.slice(4));
      const request = requests.at(-1);
      assert.equal(request.url, `${mode === 'cloudflare' ? env.WGA_NATIVE_ORIGIN : env.WGA_GATEWAY_ORIGIN}/grpcbin.GRPCBin/DummyUnary`);
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'manual');
      assert.ok(request.signal instanceof AbortSignal);
      assert.equal(request.headers.get('x-serverless-authorization'), `Bearer ${identity}`);
      assert.equal(request.headers.get('x-wga-upstream-authorization'), mode === 'grpc-web' ? `Bearer ${identity}` : null);
      assert.equal(request.headers.get('authorization'), null, 'Inbound test credential must not be forwarded');
      assert.equal(request.headers.get('content-type'), 'application/grpc-web+proto');
      assert.equal(request.headers.get('x-grpc-web'), '1');
      if (variant === 'raw') assert.equal(Object.hasOwn(request, 'cf'), false);
      else assert.deepEqual(request.cf, { grpcWeb: variant.slice(4) });
      assert.equal(request.body[0], 0);
      assert.equal(request.body.readUInt32BE(1), request.body.length - 5);
      routes++;
    }

    const cases = [
      { name: 'plain text', make: () => Buffer.from(remoteDetail), type: 'text/plain' },
      { name: 'empty body', make: () => Buffer.alloc(0) },
      { name: 'truncated frame header', make: () => Buffer.from([0, 0, 0]) },
      { name: 'truncated payload', make: request => request.body.subarray(0, -1) },
      { name: 'compressed unsupported flag', make: request => Buffer.concat([frame(1, request.body.subarray(5)), trailers()]) },
      { name: 'unknown trailer flag', make: request => Buffer.concat([request.body, frame(129, 'grpc-status: 0\r\n')]) },
      { name: 'missing trailers', make: request => request.body },
      { name: 'missing status', make: request => Buffer.concat([request.body, trailers(`grpc-message: ${remoteDetail}\r\n`)]) },
      { name: 'duplicate adjacent status', make: request => Buffer.concat([request.body, trailers('grpc-status: 0\r\ngrpc-status: 0\r\n')]) },
      { name: 'duplicate trailers', make: request => Buffer.concat([request.body, trailers(), trailers()]) },
      { name: 'message after trailers', make: request => Buffer.concat([request.body, trailers(), request.body]) },
      { name: 'multiple messages', make: request => Buffer.concat([request.body, request.body, trailers()]) },
      { name: 'different echo', make: () => Buffer.concat([frame(0, 'different echo'), trailers()]) },
      { name: 'error grpc status', make: request => Buffer.concat([request.body, trailers('grpc-status: 12\r\n')]) },
      { name: 'error HTTP status', make: request => Buffer.concat([request.body, trailers()]), status: 502 },
      { name: 'native gRPC media type', make: request => Buffer.concat([request.body, trailers()]), type: 'application/grpc+proto' },
    ];
    for (const test of cases) {
      respond = request => new Response(test.make(request), { status: test.status ?? 200, headers: { 'content-type': test.type ?? 'application/grpc-web+proto' } });
      assert.equal((await json()).grpcWebValid, false, test.name);
      malformed++;
    }

    let reads = 0, cancelled = 0, released = 0;
    respond = () => ({ status: 200, headers: new Headers({ 'content-type': 'application/grpc-web+proto' }), body: {
      getReader() { return {
        async read() { reads++; assert.ok(reads <= 2, 'Stop once the response exceeds the limit'); return { value: new Uint8Array(reads === 1 ? 65536 : 1), done: false }; },
        async cancel() { cancelled++; },
        releaseLock() { released++; },
      }; },
    } });
    const limited = await json();
    assert.equal(limited.bodyLimitExceeded, true);
    assert.equal(limited.grpcWebValid, false);
    assert.equal(reads, 2);
    assert.equal(cancelled, 1);
    assert.equal(released, 1);
    assert.deepEqual(limited.grpcWebStatuses, []);

    respond = () => { throw new Error(`${identity} ${remoteDetail}`); };
    const failed = await call();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { mode: 'cloudflare', name: 'raw-convert', passed: false, code: 'ECHO_PROBE_ERROR' });
    console.log(JSON.stringify({ status: 'passed', guardedRequests: guards, conversionRoutes: routes,
      malformedResponses: malformed, responseLimitBytes: 65536, cancellationChecked: true, networkRequests: 0 }));
  } finally { globalThis.fetch = originalFetch; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
