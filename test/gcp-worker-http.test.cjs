'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { fetchWorkerHttp, parseWorkerHttpArgs } = require('../scripts/gcp-worker-http.cjs');

let certificateDirectory, ca, key;
test.before(() => {
  certificateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-worker-http-'));
  fs.chmodSync(certificateDirectory, 0o700);
  const certificateFile = path.join(certificateDirectory, 'localhost.pem');
  const keyFile = path.join(certificateDirectory, 'localhost.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    '-keyout', keyFile, '-out', certificateFile], { stdio: 'ignore' });
  fs.chmodSync(certificateFile, 0o600); fs.chmodSync(keyFile, 0o600);
  ca = fs.readFileSync(certificateFile); key = fs.readFileSync(keyFile);
});
test.after(() => { if (certificateDirectory) fs.rmSync(certificateDirectory, { recursive: true, force: true }); });

async function localServer(t, handler) {
  const requests = [], connections = [], rawSockets = new Map();
  const server = https.createServer({ cert: ca, key }, (request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    handler(request, response, rawSockets.get(request.socket.remotePort));
  });
  server.on('connection', socket => {
    rawSockets.set(socket.remotePort, socket);
    socket.on('close', () => rawSockets.delete(socket.remotePort));
  });
  server.on('secureConnection', socket => { connections.push(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const dispatched = [];
  const requestImpl = (url, options, callback) => {
    dispatched.push({ url: url.toString(), method: options.method, agent: options.agent });
    return https.request(url, { ...options, ca }, callback);
  };
  return { url: `https://127.0.0.1:${server.address().port}`, requests, connections, dispatched, requestImpl };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function socketClosed(socket) {
  if (socket.destroyed) return;
  await once(socket, 'close');
}

test('Worker HTTPS caller uses one fresh connection for each POST and preserves text', { timeout: 5000 }, async t => {
  const server = await localServer(t, (request, response) => {
    request.resume(); request.on('end', () => response.end('plain response ☃'));
  });
  for (let index = 0; index < 2; index++) {
    const response = await fetchWorkerHttp(server.url + '/first', {
      headers: { authorization: 'Bearer synthetic-local-test', 'x-probe-id': String(index) },
      requestImpl: server.requestImpl,
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'plain response ☃');
  }
  assert.equal(server.requests.length, 2);
  assert.equal(server.connections.length, 2);
  assert.equal(server.dispatched.length, 2);
  assert.ok(server.dispatched.every(row => row.method === 'POST' && row.agent === false));
  assert.ok(server.requests.every(row => row.method === 'POST'
    && row.headers.authorization === 'Bearer synthetic-local-test'));
});

test('Worker HTTPS caller returns headers before the body completes', { timeout: 5000 }, async t => {
  let responseBody;
  const server = await localServer(t, (request, response) => {
    responseBody = response; response.statusCode = 202; response.flushHeaders();
  });
  const response = await fetchWorkerHttp(server.url, { requestImpl: server.requestImpl });
  assert.equal(response.status, 202);
  let settled = false;
  const text = response.text().then(value => { settled = true; return value; });
  await nextTurn(); assert.equal(settled, false);
  responseBody.end('later body');
  assert.equal(await text, 'later body');
  assert.equal(server.requests.length, 1);
});

test('Worker HTTPS caller does not retry a POST reset before response headers', { timeout: 5000 }, async t => {
  const server = await localServer(t, (request, response, socket) => { socket.resetAndDestroy(); });
  await assert.rejects(fetchWorkerHttp(server.url, { requestImpl: server.requestImpl }), { code: 'ECONNRESET' });
  await nextTurn();
  assert.equal(server.requests.length, 1);
  assert.equal(server.connections.length, 1);
  assert.equal(server.dispatched.length, 1);
});

test('Worker HTTPS caller preserves HTTP status when response body is reset', { timeout: 5000 }, async t => {
  let socket;
  const server = await localServer(t, (request, response, rawSocket) => {
    socket = rawSocket; response.statusCode = 207; response.write('partial');
  });
  const response = await fetchWorkerHttp(server.url, { requestImpl: server.requestImpl });
  assert.equal(response.status, 207);
  const body = response.text(); socket.resetAndDestroy();
  await assert.rejects(body, { code: 'ECONNRESET' });
  assert.equal(response.status, 207);
  assert.equal(server.requests.length, 1);
  assert.equal(server.dispatched.length, 1);
});

test('Worker HTTPS caller retains a body failure until text is consumed', { timeout: 5000 }, async t => {
  let socket;
  const server = await localServer(t, (request, response, rawSocket) => {
    socket = rawSocket; response.write('partial');
  });
  const response = await fetchWorkerHttp(server.url, { requestImpl: server.requestImpl });
  socket.resetAndDestroy();
  // A caller can inspect status before choosing to consume the body. A body
  // failure in that gap must not become an unhandled rejection.
  await nextTurn(); await nextTurn();
  await assert.rejects(response.text(), { code: 'ECONNRESET' });
  assert.equal(server.requests.length, 1);
});

test('Worker HTTPS caller sends no request for an already cancelled signal', { timeout: 5000 }, async t => {
  const server = await localServer(t, (request, response) => { response.end('unexpected'); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchWorkerHttp(server.url, { signal: controller.signal, requestImpl: server.requestImpl }),
    { code: 'ABORT_ERR' });
  await nextTurn();
  assert.equal(server.requests.length, 0);
  assert.equal(server.connections.length, 0);
});

test('Worker HTTPS caller cancellation closes a request waiting for headers', { timeout: 5000 }, async t => {
  let received;
  const requestReceived = new Promise(resolve => { received = resolve; });
  const server = await localServer(t, (request, response, socket) => { received(socket); });
  const controller = new AbortController();
  const result = fetchWorkerHttp(server.url, { signal: controller.signal, requestImpl: server.requestImpl });
  const socket = await requestReceived;
  const closed = socketClosed(socket); controller.abort();
  await assert.rejects(result, { code: 'ABORT_ERR' }); await closed;
  assert.equal(server.requests.length, 1);
  assert.equal(server.dispatched.length, 1);
});

test('Worker HTTPS caller cancellation closes a response body waiting for EOF', { timeout: 5000 }, async t => {
  let socket;
  const server = await localServer(t, (request, response, rawSocket) => {
    socket = rawSocket; response.statusCode = 206; response.write('partial');
  });
  const controller = new AbortController();
  const response = await fetchWorkerHttp(server.url, { signal: controller.signal, requestImpl: server.requestImpl });
  assert.equal(response.status, 206);
  const body = response.text(), closed = socketClosed(socket); controller.abort();
  await assert.rejects(body); await closed;
  assert.equal(server.requests.length, 1);
  assert.equal(server.dispatched.length, 1);
});

test('Worker HTTPS caller limits encoded body bytes and closes excess output', { timeout: 5000 }, async t => {
  let socket;
  const server = await localServer(t, (request, response, rawSocket) => {
    socket = rawSocket; response.write('☃☃');
  });
  const response = await fetchWorkerHttp(server.url, { maxResponseBytes: 5, requestImpl: server.requestImpl });
  const closed = socketClosed(socket);
  await assert.rejects(response.text(), { code: 'WGA_WORKER_HTTP_BODY_TOO_LARGE' }); await closed;
  assert.equal(server.requests.length, 1);
  assert.equal(server.dispatched.length, 1);
});

test('Worker HTTPS caller returns redirects without following them', { timeout: 5000 }, async t => {
  const server = await localServer(t, (request, response) => {
    response.statusCode = 307; response.setHeader('location', '/second'); response.end('redirect text');
  });
  const response = await fetchWorkerHttp(server.url + '/first', { requestImpl: server.requestImpl });
  assert.equal(response.status, 307); assert.equal(await response.text(), 'redirect text');
  assert.deepEqual(server.requests.map(row => row.url), ['/first']);
  assert.equal(server.dispatched.length, 1);
});

test('Worker HTTPS caller rejects credentials, fragments and non-HTTPS inputs before networking', async () => {
  const marker = 'private-marker-must-not-appear';
  let calls = 0;
  const requestImpl = () => { calls++; throw new Error('unexpected network'); };
  for (const url of [`https://user:${marker}@example.test/path`, `https://example.test/path#${marker}`,
    `http://example.test/${marker}`, `invalid-${marker}`]) {
    await assert.rejects(fetchWorkerHttp(url, { requestImpl }), error => {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message.includes(marker), false);
      assert.equal(JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(marker), false);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('Worker HTTPS caller rejects invalid status and handles the resulting body error', { timeout: 5000 }, async t => {
  let socket;
  const server = await localServer(t, (request, response, rawSocket) => {
    socket = rawSocket; response.statusCode = 999; response.write('invalid status');
  });
  await assert.rejects(fetchWorkerHttp(server.url, { requestImpl: server.requestImpl }),
    { code: 'WGA_WORKER_HTTP_STATUS_INVALID' });
  await socketClosed(socket);
  assert.equal(server.requests.length, 1);
  assert.equal(server.dispatched.length, 1);
});

test('Worker HTTPS caller transport control is explicit and rejects malformed or duplicate flags', () => {
  assert.equal(parseWorkerHttpArgs([]), 'fetch');
  assert.equal(parseWorkerHttpArgs(['--catalog']), 'fetch');
  assert.equal(parseWorkerHttpArgs(['--worker-http=fetch']), 'fetch');
  assert.equal(parseWorkerHttpArgs(['--catalog', '--worker-http=fresh']), 'fresh');
  for (const args of [
    ['--worker-http'], ['--worker-http', 'fresh'], ['--worker-http='], ['--worker-http=Fresh'],
    ['--worker-http=unknown'], ['--worker-http=fresh '], ['--worker-http-other=fresh'],
    ['--worker-http=fresh', '--worker-http=fresh'], ['--worker-http=fetch', '--worker-http=fresh'],
  ]) assert.throws(() => parseWorkerHttpArgs(args), /^Error: INVALID_WORKER_HTTP_OPTION$/);
});
