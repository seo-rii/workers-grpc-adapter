'use strict';
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { once } = require('node:events');
module.exports = async function unaryOracle(grpc) {
  const { wireFrame } = await import('../fixtures/shared/flow-wire.mjs');
  const server = http2.createServer(), sessions = new Set(), arrivals = [];
  server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
  server.on('stream', stream => {
    stream.on('error', () => {}); const pieces = [];
    stream.on('data', bytes => pieces.push(bytes));
    stream.on('end', () => {
      const bytes = Buffer.concat(pieces); assert.equal(bytes.length, 6); const count = bytes[5];
      assert.ok(count === 1 || count === 2);
      const receipt = { count, trailers: false, finished: false }; arrivals.push(receipt);
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => { stream.sendTrailers({ 'grpc-status': '0' }); receipt.trailers = true; });
      stream.on('finish', () => { receipt.finished = true; });
      stream.end(Buffer.concat(Array.from({ length: count }, (_, i) => wireFrame(i ? 'two' : 'one'))));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const target = `127.0.0.1:${server.address().port}`, rows = []; let rawControl;
  try {
    for (const count of [1, 2]) {
      const client = new grpc.Client(target, grpc.credentials.createInsecure(), { 'grpc.enable_retries': 0 });
      try {
        await new Promise((resolve, reject) => client.waitForReady(Date.now() + 5000, error => error ? reject(error) : resolve()));
        const channel = client.getChannel(), create = channel.createCall; let readDemands = 0;
        channel.createCall = function (...args) {
          const call = create.apply(this, args), read = call.startRead;
          call.startRead = function () { readDemands++; return read.call(this); }; return call;
        };
        const callbacks = [], statuses = [], decoded = [];
        const done = new Promise(resolve => {
          const call = client.makeUnaryRequest('/flow.Test/Unary', bytes => bytes,
            bytes => { decoded.push(bytes.toString()); return bytes.toString(); }, Buffer.from([count]),
            { deadline: Date.now() + (count === 1 ? 5000 : 300) }, (error, value) => callbacks.push({ code: error?.code ?? 0, value: value ?? null }));
          call.on('status', value => { statuses.push(value.code); resolve(); });
        });
        await done; assert.equal(readDemands, 1); assert.deepEqual(statuses, [count === 1 ? 0 : 4]);
        assert.deepEqual(decoded, ['one']); assert.equal(callbacks.length, 1);
        rows.push({ id: 'FLOW-006', scenario: count === 1 ? 'unary-one' : 'unary-duplicate', readDemands, callbacks, statuses, decoded });
      } finally { client.close(); }
    }
    const session = http2.connect(`http://${target}`);
    try {
      const request = session.request({ ':method': 'POST', ':path': '/flow.Test/Unary', 'content-type': 'application/grpc', te: 'trailers' });
      const pieces = []; let grpcStatus;
      request.on('data', bytes => pieces.push(bytes)); request.on('trailers', value => { grpcStatus = Number(value['grpc-status']); });
      request.end(wireFrame(Buffer.from([2]))); await once(request, 'end');
      const bytes = Buffer.concat(pieces); assert.deepEqual(bytes, Buffer.concat([wireFrame('one'), wireFrame('two')]));
      assert.equal(grpcStatus, 0); rawControl = { messages: 2, grpcStatus, endStream: true, bytes: bytes.toString('hex') };
    } finally { const closed = once(session, 'close'); session.destroy(); await closed; }
  } finally {
    const closed = [...sessions].map(session => once(session, 'close')); for (const session of sessions) session.destroy();
    await Promise.all(closed); await new Promise(resolve => server.close(resolve));
  }
  assert.equal(arrivals.length, 3); assert.ok(arrivals.every(row => row.trailers && row.finished));
  return { rows, rawControl, arrivals, sessionsClosed: sessions.size === 0, nativeParity: false };
};
