import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

export function wireFrame(value, trailer = false) {
  const bytes = Buffer.from(value), result = Buffer.alloc(5 + bytes.length);
  result[0] = trailer ? 128 : 0; result.writeUInt32BE(bytes.length, 1); bytes.copy(result, 5); return result;
}
const trailers = () => wireFrame('grpc-status: 0\r\n', true);
const zero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const drain = () => new Promise(resolve => setTimeout(resolve, 1));
async function until(predicate) {
  for (let n = 0; n < 2000 && !predicate(); n++) await drain();
  assert.ok(predicate(), 'FLOW_WIRE_WAIT_TIMEOUT');
}
function idle(call, client, transport) {
  assert.deepEqual(call.executionDiagnostics(), zero);
  assert.deepEqual(call.diagnostics(), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
  const resources = transport.resourceUsage();
  for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(resources[key], 0);
  assert.equal(client.getChannel().activeCallCount(), 0);
  return { execution: call.executionDiagnostics(), diagnostics: call.diagnostics(), resources, activeCalls: 0 };
}
export async function runWireFlowSuite({ grpc, createWorkersGrpcTransport, fetcher, runtime, mode }) {
  const rows = [], route = mode === 'grpc-web' ? { endpoints: { 'flow.test': 'https://gateway.flow.test' } } : {};
  for (const count of [1, 2]) {
    let fetchCount = 0, call, readDemands = 0, body;
    const maxExecution = { ...zero }, callbacks = [], statuses = [], decoded = [];
    const sample = () => { if (call) for (const [key, value] of Object.entries(call.executionDiagnostics())) maxExecution[key] = Math.max(maxExecution[key], value); };
    const transport = createWorkersGrpcTransport({ mode, ...route, resourceLimits: { maxBufferedBytes: 65536 },
      fetcher: { async fetch(_url, init) {
        fetchCount++; assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
        assert.deepEqual(Buffer.from(init.body), wireFrame(Buffer.from([count])));
        body = new ReadableStream({ start(controller) {
          controller.enqueue(Buffer.concat([...Array.from({ length: count }, (_, i) => wireFrame(i ? 'two' : 'one')), trailers()]));
          controller.close();
        } });
        return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
      } } });
    const client = new grpc.Client('flow.test', transport.channelCredentials, transport.grpcOptions());
    const channel = client.getChannel(), create = channel.createCallForMethod;
    channel.createCallForMethod = function (...args) {
      call = create.apply(this, args); const read = call.startRead;
      call.startRead = function () { readDemands++; return read.call(this); }; return call;
    };
    try {
      const surface = client.makeUnaryRequest('/flow.Test/Unary', value => value,
        value => { sample(); decoded.push(value.toString()); return value.toString(); }, Buffer.from([count]),
        { deadline: Date.now() + 5000 }, (error, value) => callbacks.push({ code: error?.code ?? 0, value: value ?? null }));
      surface.on('status', value => { sample(); statuses.push(value.code); });
      await until(() => statuses.length > 0 && call.executionDiagnostics().activePumps === 0);
      await drain();
      assert.deepEqual(statuses, [count === 1 ? 0 : 12]);
      assert.deepEqual(callbacks, [{ code: count === 1 ? 0 : 12, value: count === 1 ? 'one' : null }]);
      assert.deepEqual(decoded, count === 1 ? ['one'] : ['one', 'two']);
      assert.equal(readDemands, 1); assert.equal(fetchCount, 1); assert.equal(body.locked, false);
      rows.push({ id: 'FLOW-006', scenario: count === 1 ? 'unary-one' : 'unary-duplicate', runtime, mode, status: 'passed',
        peer: 'controlled-binary-response', fetchCount, readDemands, callbacks, statuses, decoded, maxExecution,
        readerUnlocked: !body.locked, cleanup: idle(call, client, transport) });
    } finally { client.close(); }
  }
  // Real native server response, deliberately coalesced by this bounded fixture.
  // The allocation belongs to the peer, not to the adapter response parser.
  const count = 128, size = 256, requestId = `${runtime}:${mode}:chunk`;
  let fetchCount = 0, body, chunkBytes = 0, enqueues = 0, writes = 0;
  const maxExecution = { ...zero }, seen = [], statuses = [];
  const transport = createWorkersGrpcTransport({ mode, ...route, resourceLimits: { maxBufferedBytes: 65536 },
    fetcher: { async fetch(url, init) {
      fetchCount++; const response = await fetcher.fetch(url, init), reader = response.body.getReader();
      const pieces = []; let total = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          total += next.value.byteLength; assert.ok(total <= 65536, 'fixture coalescing must be bounded'); pieces.push(Buffer.from(next.value));
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(pieces); chunkBytes = bytes.length;
      body = new ReadableStream({ start(controller) { enqueues++; controller.enqueue(bytes); controller.close(); } });
      return new Response(body, { status: response.status, headers: response.headers });
    } } });
  const client = new grpc.Client('flow.test', transport.channelCredentials, transport.grpcOptions());
  const call = client.getChannel().createCallForMethod('/flow.Test/Stream', false, true, { deadline: Date.now() + 10000 });
  const sample = () => { for (const [key, value] of Object.entries(call.executionDiagnostics())) maxExecution[key] = Math.max(maxExecution[key], value); };
  try {
    call.start(new grpc.Metadata(), { onReceiveMetadata() {}, onReceiveMessage(value) {
      assert.equal(statuses.length, 0); assert.equal(value.length, size); const index = seen.length;
      assert.equal(value.readUInt32BE(0), index);
      for (let i = 4; i < size; i++) assert.equal(value[i], index % 251);
      sample(); seen.push(index);
    }, onReceiveStatus(value) { sample(); statuses.push(value.code); } });
    call.sendMessageWithContext({ callback(error) { assert.ifError(error); writes++; } },
      Buffer.from(JSON.stringify({ scenario: 'chunk', count, size, id: requestId, catalogId: 'FLOW-007' })));
    call.halfClose();
    await until(() => call.executionDiagnostics().pendingMessages === 1); sample();
    const beforeDemand = call.executionDiagnostics();
    assert.equal(beforeDemand.pendingMessageBytes, size); assert.equal(beforeDemand.parserAssemblies, 1);
    assert.equal(beforeDemand.parserAssemblyBytes, size + 5); assert.equal(beforeDemand.runtimeChunkBytes, chunkBytes);
    assert.equal(seen.length, 0); assert.ok(chunkBytes >= count * (size + 5));
    for (let i = 0; i < count; i++) {
      call.startRead(); await until(() => seen.length === i + 1); sample();
      assert.ok(call.executionDiagnostics().pendingMessages <= 1);
      assert.ok(call.executionDiagnostics().parserAssemblies <= 1);
    }
    await until(() => statuses.length > 0 && call.executionDiagnostics().activePumps === 0); await drain();
    assert.deepEqual(statuses, [0]); assert.equal(writes, 1); assert.equal(fetchCount, 1); assert.equal(enqueues, 1);
    assert.deepEqual(seen, Array.from({ length: count }, (_, i) => i)); assert.equal(body.locked, false);
    rows.push({ id: 'FLOW-007', scenario: 'coalesced-native-stream', runtime, mode, status: 'passed',
      peer: 'native-grpc-js-with-bounded-fixture-rechunking', requestId, count, size, received: seen.length,
      fetchCount, writes, statuses, fixtureBufferLimit: 65536, chunkBytes, enqueues, beforeDemand, maxExecution,
      readerUnlocked: !body.locked, cleanup: idle(call, client, transport) });
  } finally { client.close(); }
  return rows;
}
