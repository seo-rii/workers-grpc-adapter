'use strict';
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const path = require('node:path');
const req = createRequire(path.join(__dirname, '../fixtures/native/package.json'));
module.exports = async function nativeOracle() {
  const grpc = req('@grpc/grpc-js');
  const { frame, serialize, deserialize, traceUnary, options } = await import('../fixtures/shared/catalog-api.mjs');
  const server = http2.createServer(); const sessions = new Set(); let scenario, receipts = [], emissions = [], rawControl; 
  server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
  server.on('stream', stream => {
    stream.on('error', () => {});
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      const request = Buffer.concat(chunks); receipts.push(request.toString('hex'));
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => { emissions.push({ kind: 'trailers', status: 0 }); stream.sendTrailers({ 'grpc-status': '0' }); });
      stream.on('finish', () => emissions.push({ kind: 'end-stream' }));
      const payloads = scenario === 'API-009' ? [Buffer.from([10, 127])] : scenario === 'API-010' ? [] : scenario === 'API-011' ? [serialize({ text: 'first' }), serialize({ text: 'second' })] : [serialize({ text: 'reply' })];
      for (const payload of payloads) emissions.push({ kind: 'data', frame: frame(payload).toString('hex') });
      stream.end(Buffer.concat(payloads.map(payload => frame(payload))));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const results = [];
  try {
    for (const id of ['control-one-message', 'API-007', 'API-008', 'API-009', 'API-010', 'API-011']) {
      scenario = id; receipts = []; emissions = []; const order = [], receivedMessages = [];
      if (id === 'API-011') {
        const session = http2.connect(`http://127.0.0.1:${server.address().port}`);
        try {
          const request = session.request({ ':method': 'POST', ':path': '/catalog.api.nested.Echo/Unary', 'content-type': 'application/grpc', te: 'trailers' });
          const chunks = []; let trailers;
          request.on('data', chunk => chunks.push(chunk)); request.on('trailers', value => { trailers = value; });
          request.end(frame(serialize({ text: 'request' }))); await once(request, 'end');
          const bytes = Buffer.concat(chunks), expected = Buffer.concat([frame(serialize({ text: 'first' })), frame(serialize({ text: 'second' }))]);
          assert.deepEqual(bytes, expected); assert.equal(trailers['grpc-status'], '0');
          rawControl = { responseHex: bytes.toString('hex'), grpcStatus: 0, endStream: true, messages: 2 };
        } finally { const closed = once(session, 'close'); session.destroy(); await closed; }
        receipts = []; emissions = [];
      }
      const client = new grpc.Client(`127.0.0.1:${server.address().port}`, grpc.credentials.createInsecure(), { 'grpc.enable_retries': 0, ...options(grpc, id, order), ...(id === 'API-011' ? { interceptors: [(opts, next) => new grpc.InterceptingCall(next(opts), { start(metadata, listener, done) { done(metadata, { onReceiveMessage(value, send) { receivedMessages.push(value.text); send(value); } }); } })] } : {}) });
      try {
        const call = traceUnary(grpc, client, { id, callOptions: { deadline: Date.now() + (id === 'API-011' ? 1000 : 5000) }, ...(id === 'API-008' ? { serializer() { throw new Error('catalog serializer failure'); } } : {}) });
        await call.done; await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(call.callbacks.length, 1); assert.equal(call.statuses.length, 1);
        results.push({ id, trace: call.trace, callbacks: call.callbacks, statuses: call.statuses, order, serverArrivals: receipts.length, wires: receipts, emissions, receivedMessages });
      } finally { client.close(); }
    }
  } finally { const closed = [...sessions].map(session => once(session, 'close')); for (const session of sessions) session.destroy(); await Promise.all(closed); await new Promise(resolve => server.close(resolve)); }
  return { version: req('@grpc/grpc-js/package.json').version, transport: 'independent-loopback-http2', results, rawControl, sessionsClosed: sessions.size === 0 };
};
