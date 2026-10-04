import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, credentials, Metadata, status } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const rounds = 4;
const retained = [];
let workerInstanceId;
let invocationCount = 0;
const executionZero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
function transportCall(surface) {
  let call = surface.call;
  while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
  assert.ok(call, 'missing internal transport diagnostics');
  return call;
}
async function clean(surface, ownedCalls, fetchCount = 1) {
  const call = transportCall(surface);
  for (let attempt = 0; attempt < 200 && Object.values(call.executionDiagnostics()).some(value => value !== 0); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const diagnostics = call.diagnostics(), execution = call.executionDiagnostics();
  assert.deepEqual(diagnostics, {
    terminal: true, fetchCount, requestBytes: 0, responseBytes: 0, timerActive: false,
  });
  assert.deepEqual(execution, executionZero);
  ownedCalls.push(call);
  return { diagnostics, execution };
}
function metadata(mode, invocation, round, kind) {
  const value = new Metadata();
  for (const [key, entry] of Object.entries({ mode, invocation, round: String(round), kind })) value.set(`x-fixture-${key}`, entry);
  return value;
}
async function unary(client, mode, invocation, round, kind, expectedCode, ownedCalls) {
  let surface, callbacks = 0;
  const statuses = [];
  const input = kind === 'send-limit' ? Buffer.alloc(2049) : Buffer.from(`${invocation}:${round}:${mode}:${kind}`);
  const settled = new Promise(resolve => {
    surface = client.makeUnaryRequest('/fixture.Resilience/Unary', value => value, value => value,
      input, metadata(mode, invocation, round, kind), { deadline: Date.now() + 10000 }, (error, value) => {
        callbacks++;
        resolve({ code: error?.code ?? status.OK, value });
      });
  });
  surface.on('status', result => statuses.push(result.code));
  const result = await settled;
  await turn();
  assert.equal(result.code, expectedCode, kind);
  assert.equal(callbacks, 1);
  // grpc-js synthesizes an empty-unary callback error after the wire status OK.
  assert.deepEqual(statuses, [kind === 'empty' ? status.OK : expectedCode]);
  if (expectedCode === status.OK) assert.deepEqual(result.value, input);
  const cleanup = await clean(surface, ownedCalls, kind === 'send-limit' ? 0 : 1);
  return { kind, code: result.code, calls: 1, callbacks, statuses, ...cleanup };
}
async function stream(client, mode, invocation, round, kind, ownedCalls) {
  let received = 0, errors = 0, ends = 0, peakReadableMessages = 0, peakTransportBytes = 0;
  const statuses = [];
  const surface = client.makeServerStreamRequest('/fixture.Resilience/Stream', value => Buffer.from(value), value => value,
    kind, metadata(mode, invocation, round, kind), { deadline: Date.now() + (kind === 'deadline' ? 1000 : 10000) });
  const transport = transportCall(surface);
  const completed = new Promise(resolve => surface.on('status', result => { statuses.push(result.code); resolve(result.code); }));
  const ended = new Promise(resolve => {
    surface.on('error', () => { errors++; resolve(); });
    surface.on('end', () => { ends++; resolve(); });
  });
  const pauses = [];
  surface.on('data', value => {
    assert.equal(value.length, 1024);
    assert.equal(value.readUInt32BE(0), received);
    assert.equal(value[4], mode === 'cloudflare' ? 1 : 2);
    received++;
    peakReadableMessages = Math.max(peakReadableMessages, surface.readableLength);
    peakTransportBytes = Math.max(peakTransportBytes, transport.diagnostics().responseBytes);
    if (kind === 'cancel') surface.cancel();
    if (kind === 'close') client.close();
    if (kind === 'slow' && received % 8 === 0) {
      surface.pause();
      pauses.push(new Promise(resolve => setTimeout(() => {
        peakReadableMessages = Math.max(peakReadableMessages, surface.readableLength);
        peakTransportBytes = Math.max(peakTransportBytes, transport.diagnostics().responseBytes);
        surface.resume(); resolve();
      }, 2)));
    }
  });
  const code = await completed;
  await ended;
  await Promise.all(pauses);
  await turn();
  const expected = { slow: status.OK, cancel: status.CANCELLED, close: status.UNAVAILABLE, deadline: status.DEADLINE_EXCEEDED }[kind];
  assert.deepEqual(statuses, [expected]);
  assert.equal(code, expected);
  assert.equal(errors, expected === status.OK ? 0 : 1, `${kind} error count`);
  // grpc-js also ends its Readable after an error status; only OK requires end.
  if (expected === status.OK) assert.equal(ends, 1, `${kind} end count`);
  assert.equal(received, kind === 'slow' ? 128 : 1, `${kind} received count`);
  assert.ok(peakReadableMessages <= surface.readableHighWaterMark);
  assert.ok(peakTransportBytes <= 1024);
  if (kind === 'slow') assert.ok(peakReadableMessages > 0 || peakTransportBytes > 0, 'paused consumer must exercise buffering');
  const cleanup = await clean(surface, ownedCalls);
  return { kind, code, calls: 1, received, errors, ends, statuses, peakReadableMessages,
    readableHighWaterMark: surface.readableHighWaterMark, peakTransportBytes, ...cleanup };
}
async function exercise(mode, invocation) {
  const transport = createWorkersGrpcTransport({ mode, ...(mode === 'grpc-web' ? { endpoints: { 'resilience.test': 'https://gateway.test' } } : {}) });
  const makeClient = () => new Client('resilience.test', credentials.createSsl(), transport.grpcOptions({
    'grpc.max_send_message_length': 2048, 'grpc.max_receive_message_length': 2048,
  }));
  const client = makeClient();
  const results = [], ownedCalls = [], checkpoints = [];
  async function checkpoint(label, channels) {
    const diagnostics = ownedCalls.map(call => call.diagnostics());
    const ownership = { ...executionZero };
    for (const call of ownedCalls) for (const [key, value] of Object.entries(call.executionDiagnostics())) ownership[key] += value;
    assert.deepEqual(ownership, executionZero);
    const resources = transport.resourceUsage();
    for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(resources[key], 0);
    const observed = { mode, invocation, label, workerInstanceId, completedCalls: results.length * 13, observedCalls: ownedCalls.length,
      terminalCalls: diagnostics.filter(call => call.terminal).length,
      requestBytes: diagnostics.reduce((sum, call) => sum + call.requestBytes, 0),
      responseBytes: diagnostics.reduce((sum, call) => sum + call.responseBytes, 0),
      activeTimers: diagnostics.filter(call => call.timerActive).length, ownership, resources,
      channelActiveCalls: channels.map(channel => channel.activeCallCount()), clientsClosed: label === 'closed' };
    assert.ok(observed.channelActiveCalls.every(count => count === 0));
    assert.equal(observed.terminalCalls, observed.observedCalls);
    assert.equal(observed.requestBytes + observed.responseBytes + observed.activeTimers, 0);
    if (label === 'closed') assert.ok(channels.every(channel => channel.closed));
    // Both modes wait here. The host samples this Worker through CDP only after
    // both have reported their actual owners and all peer sources have closed.
    const response = await fetch('https://resilience-control.invalid/checkpoint', { method: 'POST', body: JSON.stringify(observed) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'sampled');
    checkpoints.push(observed);
    ownedCalls.length = 0;
  }
  try {
    await checkpoint('start', [client.getChannel()]);
    for (let round = 0; round < rounds; round++) {
      const closing = makeClient();
      try {
        const batch = await Promise.all([
          ...Object.entries({ success: status.OK, unavailable: status.UNAVAILABLE, quota: status.RESOURCE_EXHAUSTED,
            denied: status.PERMISSION_DENIED, truncated: status.INTERNAL, 'receive-limit': status.RESOURCE_EXHAUSTED,
            'send-limit': status.RESOURCE_EXHAUSTED, empty: status.UNIMPLEMENTED }).map(([kind, code]) => unary(client, mode, invocation, round, kind, code, ownedCalls)),
          ...['slow', 'cancel', 'deadline'].map(kind => stream(client, mode, invocation, round, kind, ownedCalls)),
          stream(closing, mode, invocation, round, 'close', ownedCalls),
        ]);
        assert.equal(client.getChannel().activeCallCount(), 0);
        assert.equal(closing.getChannel().activeCallCount(), 0);
        // Reuse the client after each mixed failure wave, before closing it.
        const recovered = await unary(client, mode, invocation, round, 'recovery', status.OK, ownedCalls);
        assert.equal(client.getChannel().activeCallCount(), 0);
        results.push({ round, batch, recovered, activeCalls: client.getChannel().activeCallCount() });
      } finally { closing.close(); }
      await checkpoint(`wave-${round}`, [client.getChannel(), closing.getChannel()]);
    }
  } finally { client.close(); }
  await checkpoint('closed', [client.getChannel()]);
  return { mode, results, checkpoints, calls: rounds * 13, status: 'passed' };
}
export default {
  async fetch(request) {
    workerInstanceId ??= crypto.randomUUID();
    const invocation = new URL(request.url).pathname.slice(1);
    // Separate-isolate positive control: intentionally root backing stores so
    // the host must observe growth and reject the normal workload envelope.
    if (invocation.startsWith('retention-')) {
      if (invocation === 'retention-step') {
        const input = await request.json();
        assert.equal(input.bytes, 4 * 1024 * 1024);
        const value = new Uint8Array(input.bytes); value.fill(retained.length + 1); retained.push(value);
      } else if (invocation === 'retention-clear') retained.length = 0;
      else assert.equal(invocation, 'retention-ready');
      return Response.json({ status: 'passed', workerInstanceId, buffers: retained.length,
        retainedBytes: retained.reduce((sum, value) => sum + value.byteLength, 0),
        sentinels: retained.map(value => [value[0], value.at(-1)]) });
    }
    if (invocation === 'ready') return Response.json({ status: 'passed', workerInstanceId });
    assert.ok(['cold', 'warm'].includes(invocation));
    assert.equal(invocation, invocationCount === 0 ? 'cold' : 'warm');
    invocationCount++;
    const cases = await Promise.all(['cloudflare', 'grpc-web'].map(mode => exercise(mode, invocation)));
    return Response.json({ status: 'passed', workerInstanceId, invocationCount, cases });
  },
};
