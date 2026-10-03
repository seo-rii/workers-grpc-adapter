'use strict';
// Node-only allocation evidence. This imports the installed package's internal
// parser by path; it does not introduce a supported public entry point.
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Buffer } = require('node:buffer');
const root = path.resolve(__dirname, '..');
const zeroParser = { parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
let observing = false;

function bindings(sourceBuild) {
  const directory = sourceBuild ? path.join(root, 'dist')
    : path.dirname(require.resolve('@grpc/grpc-js', { paths: [path.join(root, 'fixtures/worker')] }));
  return { ...require(path.join(directory, 'wire.js')), ...require(path.join(directory, 'resources.js')) };
}

function installSpies() {
  assert.equal(observing, false, 'Buffer allocation observation must run sequentially');
  observing = true;
  const descriptors = [Object.getOwnPropertyDescriptor(Buffer, 'allocUnsafe'),
    Object.getOwnPropertyDescriptor(Buffer.prototype, 'set'), Object.getOwnPropertyDescriptor(Buffer, 'concat')];
  const originals = [Buffer.allocUnsafe, Buffer.prototype.set, Buffer.concat];
  const metrics = { allocUnsafeSizes: [], allocUnsafeBytes: 0, setCalls: 0, setBytes: 0, concatCalls: 0, concatBytes: 0 };
  Buffer.allocUnsafe = function(size) {
    metrics.allocUnsafeSizes.push(size); metrics.allocUnsafeBytes += size;
    return originals[0].call(this, size);
  };
  Buffer.prototype.set = function(source, offset) {
    metrics.setCalls++; metrics.setBytes += source.length;
    return originals[1].call(this, source, offset);
  };
  Buffer.concat = function(list, totalLength) {
    metrics.concatCalls++; metrics.concatBytes += totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
    return originals[2].call(this, list, totalLength);
  };
  return { metrics, restore() {
    for (const [index, owner, key] of [[0, Buffer, 'allocUnsafe'], [1, Buffer.prototype, 'set'], [2, Buffer, 'concat']]) {
      if (descriptors[index]) Object.defineProperty(owner, key, descriptors[index]);
      else delete owner[key];
    }
    observing = false;
    assert.equal(Buffer.allocUnsafe, originals[0]); assert.equal(Buffer.prototype.set, originals[1]);
    assert.equal(Buffer.concat, originals[2]);
  } };
}

function positiveControl() {
  const first = Uint8Array.of(1, 2), second = Uint8Array.of(3, 4), copied = Uint8Array.of(5, 6, 7);
  const spy = installSpies();
  let joined, target;
  try {
    target = Buffer.allocUnsafe(7); target.set(copied, 2);
    joined = Buffer.concat([first, second]);
  } finally { spy.restore(); }
  assert.ok(spy.metrics.allocUnsafeSizes.includes(7));
  assert.ok(spy.metrics.setCalls >= 1 && spy.metrics.setBytes >= 3);
  assert.equal(spy.metrics.concatCalls, 1); assert.equal(spy.metrics.concatBytes, 4);
  assert.deepEqual([...target.subarray(2, 5)], [5, 6, 7]); assert.deepEqual([...joined], [1, 2, 3, 4]);
  return { ...spy.metrics, copiedBytes: [...target.subarray(2, 5)], concatenatedBytes: [...joined], spyRestored: true };
}

/** Fixtures and streams are constructed before observation; only parser work is measured. */
async function measureParser({ chunks, maxMessageBytes = 1024, maxWireBytes = maxMessageBytes,
  encoding = 'identity', sourceBuild = false, sourceError = null }) {
  const { decodeFrames, ResourceBudget } = bindings(sourceBuild);
  const budget = new ResourceBudget({ maxBufferedBytes: 96 * 1024 * 1024 });
  const diagnostics = { ...zeroParser }, frames = [], pulledChunkSizes = [];
  let index = 0, pulls = 0, cancels = 0, error = null;
  const body = new ReadableStream({ pull(controller) {
    pulls++;
    if (index < chunks.length) {
      const chunk = chunks[index++]; pulledChunkSizes.push(chunk.byteLength); controller.enqueue(chunk);
    } else if (sourceError) throw sourceError;
    else controller.close();
  }, cancel() { cancels++; } }, { highWaterMark: 0 });
  const spy = installSpies();
  try {
    for await (const frame of decodeFrames(body, maxMessageBytes, undefined, { encoding, maxWireBytes, budget, diagnostics })) {
      frames.push(frame);
    }
  } catch (caught) { error = caught; }
  finally { spy.restore(); }
  // Hashing, assertions, and report serialization occur outside the spy.
  const result = { code: error?.code ?? (error ? null : 0), errorId: error?.message ?? null,
    frames: frames.map(frame => ({ trailer: frame.trailer, bytes: frame.payload.length,
      sha256: createHash('sha256').update(frame.payload).digest('hex') })), ...spy.metrics,
    pulls, pulledChunkSizes, cancels, finalParser: { ...diagnostics }, finalResources: budget.diagnostics(),
    readerLocked: body.locked, spyRestored: true };
  assert.deepEqual(result.finalParser, zeroParser);
  assert.equal(result.readerLocked, false);
  for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(result.finalResources[key], 0);
  return result;
}

// Independent protocol fixtures deliberately do not call adapter encoding code.
function header(length, flag = 0) {
  const result = new Uint8Array(5); result[0] = flag;
  new DataView(result.buffer).setUint32(1, length, false); return result;
}
function join(...chunks) {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function framed(payload, flag = 0) { return join(header(payload.length, flag), payload); }
function signature(payload, trailer = false) {
  return { trailer, bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
}
function randomChunks(bytes, seed) {
  const chunks = []; let offset = 0, state = seed >>> 0;
  while (offset < bytes.length) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const next = Math.min(bytes.length, offset + 1 + ((state >>> 0) % 17));
    chunks.push(bytes.subarray(offset, next)); offset = next;
  }
  return chunks;
}

async function runAllocationChecks({ sourceBuild = false } = {}) {
  const positive = positiveControl(), rows = [];
  const payload = Uint8Array.of(0, 10, 255, 128, 4, 5, 6);
  const trailer = new TextEncoder().encode('grpc-status: 0\r\n');
  const response = join(framed(payload), framed(trailer, 128));
  const empty = new Uint8Array(0);
  async function check(id, scenario, spec, expected) {
    const actual = await measureParser({ ...spec, sourceBuild });
    const label = `${id}/${scenario}`;
    assert.equal(actual.code, expected.code, `${label} error code`);
    assert.deepEqual(actual.frames, expected.frames, `${label} exact yielded frame bytes`);
    assert.deepEqual(actual.allocUnsafeSizes, expected.allocations, `${label} exact allocation sequence`);
    assert.equal(actual.allocUnsafeBytes, expected.allocations.reduce((sum, bytes) => sum + bytes, 0), `${label} allocated bytes`);
    assert.equal(actual.setBytes, expected.copiedBytes, `${label} linear copied bytes`);
    assert.equal(actual.concatCalls, 0, `${label} no parser concatenation`);
    assert.equal(actual.concatBytes, 0, `${label} no concatenated bytes`);
    assert.equal(actual.pulls, expected.pulls, `${label} exact input demand`);
    assert.equal(actual.cancels, expected.cancels, `${label} source disposal`);
    if (expected.setCalls !== undefined) assert.equal(actual.setCalls, expected.setCalls, `${label} exact copy operation count`);
    if (expected.errorId) assert.equal(actual.errorId, expected.errorId, `${label} error identity`);
    rows.push({ id, scenario, status: 'passed', ...actual });
  }
  function success(chunks, payloads) {
    return { code: 0, frames: payloads.map(([bytes, flag]) => signature(bytes, flag === 128)),
      allocations: [...payloads.flatMap(([bytes]) => [5, bytes.length]), 5],
      copiedBytes: chunks.reduce((sum, bytes) => sum + bytes.length, 0), pulls: chunks.length + 1, cancels: 0 };
  }
  await check('WIRE-001', 'unary', { chunks: [response] }, success([response], [[payload, 0], [trailer, 128]]));
  const emptyResponse = join(framed(empty), framed(trailer, 128));
  await check('WIRE-002', 'empty-message', { chunks: [emptyResponse] }, success([emptyResponse], [[empty, 0], [trailer, 128]]));
  await check('WIRE-003', 'empty-stream', { chunks: [framed(trailer, 128)] }, success([framed(trailer, 128)], [[trailer, 128]]));
  for (let split = 1; split < 5; split++) {
    const chunks = [response.subarray(0, split), response.subarray(split)];
    await check('WIRE-004', `header-split-${split}`, { chunks }, success(chunks, [[payload, 0], [trailer, 128]]));
  }
  for (const size of [31, 257, 4096]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 29) & 255);
    const encoded = join(framed(bytes), framed(trailer, 128));
    const chunks = Array.from({ length: encoded.length }, (_, index) => encoded.subarray(index, index + 1));
    const expected = success(chunks, [[bytes, 0], [trailer, 128]]); expected.setCalls = encoded.length;
    await check('WIRE-005', `bytewise-${size}`, { chunks, maxMessageBytes: size }, expected);
  }
  const payloads = [[payload, 0], [empty, 0], [Uint8Array.of(255, 0, 77), 0], [trailer, 128]];
  const multiple = join(...payloads.map(([bytes, flag]) => framed(bytes, flag)));
  for (const [name, chunks] of [['coalesced', [multiple]], ['fragmented', randomChunks(multiple, 0x91faded)]]) {
    await check('WIRE-006', name, { chunks }, success(chunks, payloads));
  }
  for (const seed of [1, 0xc0ffee, 0x12345678, 0xffffffff]) {
    const chunks = randomChunks(multiple, seed);
    await check('WIRE-007', `seed-${seed}`, { chunks }, success(chunks, payloads));
  }
  for (const [name, maxMessageBytes, maxWireBytes] of [['message-cap', 32, 64], ['wire-cap', 64, 32]]) {
    for (const size of [31, 32, 33]) {
      const bytes = new Uint8Array(size).fill(97), chunks = [header(size), bytes];
      const expected = size <= 32 ? success(chunks, [[bytes, 0]]) : { code: 8, frames: [], allocations: [5],
        copiedBytes: 5, setCalls: 1, pulls: 1, cancels: 1, errorId: 'WGA_FRAME_SIZE' };
      await check('WIRE-008', `${name}-${size}`, { chunks, maxMessageBytes, maxWireBytes }, expected);
    }
  }
  const large = new Uint8Array(4 * 1024 * 1024 + 1).fill(71), largeChunks = [header(large.length), large];
  await check('WIRE-008', 'parser-cap-32MiB-above-4MiB', { chunks: largeChunks, maxMessageBytes: 32 * 1024 * 1024 }, success(largeChunks, [[large, 0]]));
  await check('WIRE-009', 'uint32-max', { chunks: [header(0xffffffff), Uint8Array.of(99)] },
    { code: 8, frames: [], allocations: [5], copiedBytes: 5, setCalls: 1, pulls: 1, cancels: 1, errorId: 'WGA_FRAME_SIZE' });
  for (let bytes = 1; bytes < 5; bytes++) {
    await check('WIRE-010', `truncated-header-${bytes}`, { chunks: [header(8).subarray(0, bytes)] },
      { code: 13, frames: [], allocations: [5], copiedBytes: bytes, setCalls: 1, pulls: 2, cancels: 0, errorId: 'WGA_TRUNCATED_FRAME' });
  }
  await check('WIRE-011', 'truncated-payload', { chunks: [join(header(12), Uint8Array.of(1, 2, 3))] },
    { code: 13, frames: [], allocations: [5, 12], copiedBytes: 8, setCalls: 2, pulls: 2, cancels: 0, errorId: 'WGA_TRUNCATED_FRAME' });
  for (let flag = 0; flag <= 255; flag++) {
    if ([0, 1, 128, 129].includes(flag)) continue;
    await check('WIRE-012', `reserved-flag-${flag}`, { chunks: [header(17, flag), new Uint8Array(17)] },
      { code: 13, frames: [], allocations: [5], copiedBytes: 5, setCalls: 1, pulls: 1, cancels: 1, errorId: 'WGA_FRAME_FLAGS' });
  }
  for (const [name, flag, encoding, code, errorId] of [
    ['identity', 1, 'identity', 13, 'WGA_COMPRESSED_WITH_IDENTITY'],
    ['unknown-codec', 1, 'snappy', 12, 'WGA_COMPRESSION_ENCODING'],
    ['compressed-trailer', 129, 'gzip', 12, 'WGA_COMPRESSED_TRAILER'],
  ]) {
    await check('WIRE-013', name, { chunks: [header(17, flag), new Uint8Array(17)], encoding },
      { code, frames: [], allocations: [5], copiedBytes: 5, setCalls: 1, pulls: 1, cancels: 1, errorId });
  }
  for (const [id, scenario, flag] of [['WIRE-014', 'duplicate-trailer', 128], ['WIRE-015', 'data-after-trailer', 0]]) {
    await check(id, scenario, { chunks: [framed(trailer, 128), header(99, flag), new Uint8Array(99)] },
      { code: 13, frames: [signature(trailer, true)], allocations: [5, trailer.length, 5],
        copiedBytes: 10 + trailer.length, setCalls: 3, pulls: 2, cancels: 1, errorId: 'WGA_FRAME_AFTER_TRAILER' });
  }
  return { status: 'passed', runtime: 'node', layer: 'internal-parser', sourceBuild,
    nodeVersion: process.versions.node, positiveControl: positive, rows, spyRestored: !observing };
}

module.exports = { runAllocationChecks, measureParser };
