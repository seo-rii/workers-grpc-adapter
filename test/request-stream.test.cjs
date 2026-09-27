'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { RequestStreamBody } = require('../dist/request-stream.js');
const { status } = require('../dist/status.js');
const turn = () => new Promise(resolve => setImmediate(resolve));
function make(options = {}) { return new RequestStreamBody({ maxMessageBytes: 1024, maxWireBytes: 1024, compression: 'identity', ...options }); }
function message(frame) { assert.equal(frame.readUInt32BE(1), frame.length - 5); return frame.subarray(5); }

test('REQUEST STREAM holds exactly one immutable frame until downstream pull accepts it', async () => {
  const request = make(), input = Buffer.from([1, 2, 3]); let acknowledged = 0;
  const write = request.write(input).then(() => { acknowledged++; });
  input.fill(99); await turn();
  assert.equal(acknowledged, 0); assert.equal(request.bufferedBytes(), 8);
  await assert.rejects(request.write(Buffer.from([4])), { code: status.RESOURCE_EXHAUSTED, diagnostic: 'WGA_REQUEST_STREAM_BACKPRESSURE' });
  const reader = request.body.getReader(); assert.equal(acknowledged, 0);
  const first = await reader.read(); await write;
  assert.deepEqual([...message(first.value)], [1, 2, 3]); assert.equal(first.value[0], 0);
  assert.equal(acknowledged, 1); assert.equal(request.bufferedBytes(), 0);
  request.end(); assert.equal((await reader.read()).done, true); reader.releaseLock();
});

test('REQUEST STREAM preserves frame order and closes only after final pending write', async () => {
  const request = make(), reader = request.body.getReader(), received = [];
  for (let index = 0; index < 6; index++) {
    const read = reader.read(); const write = request.write(Buffer.from([index]));
    if (index === 5) request.end();
    const value = await read; await write; received.push(message(value.value)[0]);
  }
  assert.deepEqual(received, [0, 1, 2, 3, 4, 5]); assert.equal((await reader.read()).done, true);
  await assert.rejects(request.write(Buffer.from([7])), { diagnostic: 'WGA_REQUEST_STREAM_CLOSED' });
  assert.equal(request.bufferedBytes(), 0); request.end(); request.abort(); reader.releaseLock();
});

test('REQUEST STREAM zero-message half-close produces EOF and no synthetic frame', async () => {
  const request = make(); request.end(); request.end();
  const reader = request.body.getReader(); assert.deepEqual(await reader.read(), { value: undefined, done: true });
  assert.equal(request.bufferedBytes(), 0); reader.releaseLock();
});

for (const compression of ['gzip', 'deflate']) {
  test(`REQUEST STREAM ${compression} snapshots input and honors half-close during encoding`, async () => {
    const request = make({ maxMessageBytes: 65536, compression }), input = Buffer.alloc(65536, 0x51);
    const write = request.write(input); input.fill(0x99); request.end();
    const reader = request.body.getReader(), frame = (await reader.read()).value; await write;
    assert.equal(frame[0], 1);
    const actual = compression === 'gzip' ? zlib.gunzipSync(message(frame)) : zlib.inflateSync(message(frame));
    assert.equal(actual.length, 65536); assert.ok(actual.every(value => value === 0x51));
    assert.equal((await reader.read()).done, true); assert.equal(request.bufferedBytes(), 0); reader.releaseLock();
  });
}

test('REQUEST STREAM per-message NoCompress preserves identity bytes with configured gzip', async () => {
  const request = make({ compression: 'gzip' }), reader = request.body.getReader();
  const write = request.write(Buffer.from('uncompressed'), true);
  const frame = (await reader.read()).value; await write;
  assert.equal(frame[0], 0); assert.equal(message(frame).toString(), 'uncompressed');
  request.end(); assert.equal((await reader.read()).done, true); reader.releaseLock();
});

test('REQUEST STREAM enforces decoded message size before compression and encoded wire ceiling', async () => {
  const decoded = make({ maxMessageBytes: 2, compression: 'gzip' });
  await assert.rejects(decoded.write(Buffer.alloc(3)), { code: status.RESOURCE_EXHAUSTED, diagnostic: 'WGA_REQUEST_SIZE' });
  assert.equal(decoded.bufferedBytes(), 0);
  const decodedReader = decoded.body.getReader();
  await assert.rejects(decodedReader.read(), { diagnostic: 'WGA_REQUEST_SIZE' }); decodedReader.releaseLock();
  const encoded = make({ maxWireBytes: 2 });
  await assert.rejects(encoded.write(Buffer.alloc(3)), { code: status.RESOURCE_EXHAUSTED, diagnostic: 'WGA_FRAME_SIZE' });
  assert.equal(encoded.bufferedBytes(), 0);
  const encodedReader = encoded.body.getReader();
  await assert.rejects(encodedReader.read(), { diagnostic: 'WGA_FRAME_SIZE' }); encodedReader.releaseLock();
});

test('REQUEST STREAM abort rejects one pending write once and clears all adapter-owned bytes', async () => {
  let cancelled = 0, rejected = 0;
  const request = make({ onCancel() { cancelled++; } });
  const failure = new Error('controlled termination');
  const write = request.write(Buffer.from([1])).catch(error => { assert.strictEqual(error, failure); rejected++; });
  await turn(); request.abort(failure); request.abort(new Error('ignored')); await write;
  assert.equal(rejected, 1); assert.equal(cancelled, 0); assert.equal(request.bufferedBytes(), 0);
  const reader = request.body.getReader(); await assert.rejects(reader.read(), error => error === failure);
  await assert.rejects(request.write(Buffer.from([2])), error => error === failure); reader.releaseLock();
});

test('REQUEST STREAM abort during gzip does not later enqueue or acknowledge a stale frame', async () => {
  const request = make({ maxMessageBytes: 1024 * 1024, maxWireBytes: 1024 * 1024, compression: 'gzip' });
  let resolved = 0, rejected = 0;
  const write = request.write(Buffer.alloc(1024 * 1024, 5)).then(() => { resolved++; }, error => { assert.equal(error.code, status.CANCELLED); rejected++; });
  request.abort(); await write; await turn();
  assert.equal(resolved, 0); assert.equal(rejected, 1); assert.equal(request.bufferedBytes(), 0);
  const reader = request.body.getReader(); await assert.rejects(reader.read(), { code: status.CANCELLED }); reader.releaseLock();
});

test('REQUEST STREAM downstream cancellation rejects the pending producer and notifies once', async () => {
  let cancelled = 0;
  const request = make({ onCancel(error) { assert.equal(error.code, status.CANCELLED); cancelled++; } });
  const write = assert.rejects(request.write(Buffer.from([1])), { diagnostic: 'WGA_REQUEST_STREAM_CANCELLED' });
  await request.body.cancel('do not retain arbitrary consumer data'); await write;
  await request.body.cancel(); request.abort();
  assert.equal(cancelled, 1); assert.equal(request.bufferedBytes(), 0);
});

test('REQUEST STREAM abort resolves an outstanding downstream read with an error', async () => {
  const request = make(), reader = request.body.getReader();
  const read = assert.rejects(reader.read(), { diagnostic: 'WGA_REQUEST_STREAM_ABORTED' });
  request.abort(); await read; reader.releaseLock();
});

test('REQUEST STREAM configuration and invalid messages fail explicitly', async () => {
  for (const options of [{ maxMessageBytes: -1 }, { maxWireBytes: Infinity }, { maxWireBytes: 2.5 }, { compression: 'brotli' }]) {
    assert.throws(() => make(options));
  }
  const request = make(); await assert.rejects(request.write('not bytes'), { diagnostic: 'WGA_REQUEST_STREAM_INVALID_MESSAGE' });
  request.end(); const reader = request.body.getReader(); assert.equal((await reader.read()).done, true); reader.releaseLock();
});

test('REQUEST STREAM a zero decoded-message limit still permits an empty protobuf message', async () => {
  const request = make({ maxMessageBytes: 0 }), reader = request.body.getReader();
  const write = request.write(Buffer.alloc(0)); const frame = (await reader.read()).value; await write;
  assert.equal(frame.length, 5); request.end(); assert.equal((await reader.read()).done, true); reader.releaseLock();
});
