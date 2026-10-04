import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

// These are application messages, not gRPC-Web frames. Both the native server
// and the two adapter runtimes use this exact public Client scenario table.
export const SCENARIOS = Object.freeze([
  { id: 'FLOW-001', scenario: 'slow', count: 128, size: 1024 },
  { id: 'FLOW-002', scenario: 'pause', count: 96, size: 1024 },
  { id: 'FLOW-003', scenario: 'total', count: 513, size: 65536 },
  { id: 'FLOW-004', scenario: 'cancel', count: 4096, size: 1024 },
  { id: 'FLOW-005', scenario: 'partial', count: 8, size: 1024 },
].map(Object.freeze));

const zeroExecution = Object.freeze({ activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 });
const maxBufferedBytes = 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Timer eligibility and the observed clock can differ by a millisecond. Keep
// the full measured pause instead of treating one timer callback as its proof.
export function schedulePauseWindow(schedule, now, duration, complete) {
  const start = now();
  function check() {
    const elapsed = now() - start;
    if (elapsed < duration) { schedule(Math.max(1, duration - elapsed), check); return; }
    complete(elapsed);
  }
  schedule(duration, check);
}

function transportCall(surface) {
  let current = surface;
  const seen = new Set();
  while (current && !seen.has(current)) {
    if (typeof current.executionDiagnostics === 'function') return current;
    seen.add(current); current = current.call ?? current.nextCall;
  }
  assert.fail('public call must expose its adapter transport owner');
}

/** Public streaming observations; native rows contain no invented transport counters. */
export async function runPublicFlowSuite({ grpc, createWorkersGrpcTransport, fetcher, target, runtime, mode }) {
  const adapter = typeof createWorkersGrpcTransport === 'function';
  assert.equal(adapter, runtime !== 'native');
  if (adapter) assert.ok(['cloudflare', 'grpc-web'].includes(mode));
  else mode = 'native';
  const rows = [];
  for (const spec of SCENARIOS) {
    const requestId = `${runtime}:${mode}:${spec.scenario}`;
    const transport = adapter ? createWorkersGrpcTransport({ mode, fetcher,
      ...(mode === 'grpc-web' ? { endpoints: { [target]: 'https://gateway.flow.test' } } : {}),
      resourceLimits: { readableHighWaterMark: 1, maxBufferedBytes },
    }) : null;
    const client = new grpc.Client(target, adapter ? transport.channelCredentials : grpc.credentials.createInsecure(),
      adapter ? transport.grpcOptions() : { 'grpc.enable_retries': 0 });
    const channel = client.getChannel();
    let surface, wire, monitor, failure;
    const scheduled = new Set();
    let deliveredCount = 0, deliveredBytes = 0, payloadByteSum = 0, endCount = 0;
    let maxReadableLength = 0, cancelCount = 0, deliveredAtCancel = null;
    let pauseDeliveredDuringWindow = null, pauseWindowMs = null, pausedSample = null;
    let cancelSample = null, readableLengthAfterCancel = null;
    let controlPending = false, completed = false;
    const codes = [], errorCodes = [], events = [];
    let dataAfterTerminal = 0;
    const maxExecution = adapter ? { ...zeroExecution } : null;
    const bufferOwnership = adapter ? { scope: 'adapter-visible-buffer-references', additive: false,
      highWater: { requestBytes: 0, pendingMessageBytes: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0, readableBytes: 0 },
      samples: { requestRetained: null, backpressured: null, released: null } } : null;
    const started = Date.now();
    const ownedBytes = () => {
      const execution = wire.executionDiagnostics();
      return { requestBytes: wire.diagnostics().requestBytes, pendingMessageBytes: execution.pendingMessageBytes,
        parserAssemblyBytes: execution.parserAssemblyBytes, runtimeChunkBytes: execution.runtimeChunkBytes,
        // Identity-deserialized Buffers have a known byte length. This does not
        // estimate arbitrary SDK objects, allocator overhead or total heap.
        readableBytes: surface.readableLength * spec.size };
    };
    const sample = () => {
      maxReadableLength = Math.max(maxReadableLength, surface.readableLength);
      assert.ok(codes.length <= 1, 'one terminal status');
      assert.ok(surface.readableLength <= surface.readableHighWaterMark, 'public queue stays within its object high-water mark');
      if (!adapter) return;
      const value = wire.executionDiagnostics();
      for (const key of Object.keys(maxExecution)) maxExecution[key] = Math.max(maxExecution[key], value[key]);
      const bytes = ownedBytes();
      for (const key of Object.keys(bytes)) bufferOwnership.highWater[key] = Math.max(bufferOwnership.highWater[key], bytes[key]);
      if (!bufferOwnership.samples.backpressured && value.pendingMessages === 1 && surface.readableLength === 1) {
        bufferOwnership.samples.backpressured = bytes;
      }
      assert.ok(value.pendingMessages <= 1, 'one decoded message awaits demand');
      assert.ok(value.parserAssemblies <= 1, 'one parser assembly is live');
      assert.ok(value.activePumps <= 1, 'one transport pump');
      assert.ok(transport.resourceUsage().bufferedBytes <= maxBufferedBytes, 'configured byte budget');
    };
    const fail = error => {
      failure ??= error;
      try { surface?.cancel(); } catch { /* Preserve the original assertion. */ }
    };
    const later = (ms, callback) => {
      const handle = setTimeout(() => {
        scheduled.delete(handle);
        try { callback(); } catch (error) { fail(error); }
      }, ms);
      scheduled.add(handle);
    };
    const until = async (predicate, message, timeout = 5000) => {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (failure) throw failure;
        assert.ok(Date.now() < deadline, `${requestId}: ${message}`);
        sample(); await sleep(1);
      }
      sample();
    };
    const snapshot = () => ({ deliveredCount, readableLength: surface.readableLength,
      execution: adapter ? wire.executionDiagnostics() : null,
      resources: adapter ? transport.resourceUsage() : null });
    const onData = value => {
      try {
        assert.equal(deliveredAtCancel, null, 'no data delivered after cancellation');
        if (codes.length) dataAfterTerminal++;
        assert.ok(Buffer.isBuffer(value), 'identity deserializer preserves a Buffer');
        assert.equal(value.length, spec.size);
        assert.equal(value.readUInt32BE(0), deliveredCount, 'message sequence');
        const fill = deliveredCount % 251;
        for (let i = 0; i < value.length; i++) {
          if (i >= 4) assert.equal(value[i], fill, 'payload byte');
          payloadByteSum += value[i];
        }
        events.push(`data:${deliveredCount}`);
        deliveredCount++; deliveredBytes += value.length; sample();
        if (spec.scenario === 'slow' || spec.scenario === 'partial') {
          surface.pause(); later(1, () => { sample(); surface.resume(); });
        } else if (spec.scenario === 'pause' && deliveredCount === 8) {
          surface.pause(); controlPending = true;
          const pausedCount = deliveredCount;
          schedulePauseWindow(later, Date.now, 20, elapsed => {
            sample(); pausedSample = snapshot(); pauseWindowMs = elapsed;
            pauseDeliveredDuringWindow = deliveredCount - pausedCount;
            assert.equal(pauseDeliveredDuringWindow, 0, 'pause suppresses public data events');
            controlPending = false; surface.resume();
          });
        } else if (spec.scenario === 'cancel' && deliveredCount === 1) {
          surface.pause(); controlPending = true;
          // Wait for genuine backpressure, not just a scheduled pause. The
          // native queue and adapter queue have deliberately different limits.
          void (async () => {
            await until(() => surface.readableLength === surface.readableHighWaterMark
              && (!adapter || wire.executionDiagnostics().pendingMessages === 1), 'queue and pending message become occupied');
            cancelSample = snapshot(); deliveredAtCancel = deliveredCount; cancelCount++;
            surface.cancel();
            await until(() => codes.length === 1, 'cancel terminal arrives');
            await sleep(20); sample();
            assert.equal(deliveredCount, deliveredAtCancel, 'paused cancelled stream delivers nothing further');
            readableLengthAfterCancel = surface.readableLength;
            controlPending = false;
          })().catch(fail);
        }
      } catch (error) { fail(error); }
    };
    try {
      surface = client.makeServerStreamRequest('/flow.Test/Stream', value => Buffer.from(JSON.stringify(value)), value => value,
        { ...spec, id: requestId, catalogId: spec.id, requestId }, { deadline: Date.now() + 30000 });
      if (adapter) {
        wire = transportCall(surface);
        bufferOwnership.samples.requestRetained = ownedBytes();
        assert.ok(bufferOwnership.samples.requestRetained.requestBytes > 0, 'serialized request owner is actually occupied');
        sample();
      }
      surface.on('data', onData);
      surface.on('error', error => { errorCodes.push(error.code); events.push(`error:${error.code}`); });
      surface.on('status', value => { codes.push(value.code); events.push(`status:${value.code}`); });
      surface.on('end', () => { endCount++; events.push('end'); });
      monitor = setInterval(() => { try { sample(); } catch (error) { fail(error); } }, 1);
      await until(() => codes.length === 1 && !controlPending && (spec.scenario === 'cancel' || endCount === 1),
        'public stream completes', 30000);
      if (adapter) await until(() => Object.keys(zeroExecution).every(key => wire.executionDiagnostics()[key] === 0), 'adapter owners unwind');
      await sleep(5); sample();
      if (failure) throw failure;
      const expectedCode = spec.scenario === 'cancel' ? grpc.status.CANCELLED
        : spec.scenario === 'partial' ? grpc.status.UNAVAILABLE : grpc.status.OK;
      assert.deepEqual(codes, [expectedCode]);
      assert.deepEqual(errorCodes, expectedCode ? [expectedCode] : []);
      assert.equal(deliveredCount, spec.scenario === 'cancel' ? 1 : spec.count);
      assert.equal(cancelCount, spec.scenario === 'cancel' ? 1 : 0);
      if (spec.scenario === 'partial') {
        assert.ok(events.indexOf('data:0') < events.indexOf(`error:${expectedCode}`), 'partial data precedes the server error');
        assert.ok(events.indexOf(`error:${expectedCode}`) < events.indexOf(`status:${expectedCode}`), 'error precedes status');
        assert.ok(events.indexOf(`data:${spec.count - 1}`) < events.indexOf('end'), 'queued partial data drains before public end');
      }
      if (spec.scenario === 'total') assert.ok(deliveredBytes > 32 * 1024 * 1024, 'cumulative bytes exceed the per-message transport ceiling');
      if (spec.scenario === 'pause') {
        assert.equal(pauseDeliveredDuringWindow, 0); assert.ok(pauseWindowMs >= 20);
        assert.equal(pausedSample.deliveredCount, 8);
      }
      const finalExecution = adapter ? wire.executionDiagnostics() : null;
      const finalDiagnostics = adapter ? wire.diagnostics() : null;
      const finalResources = adapter ? transport.resourceUsage() : null;
      if (adapter) {
        assert.deepEqual(finalExecution, zeroExecution);
        assert.equal(finalDiagnostics.terminal, true); assert.equal(finalDiagnostics.timerActive, false);
        assert.equal(finalDiagnostics.fetchCount, 1); assert.equal(finalDiagnostics.requestBytes, 0);
        assert.equal(finalDiagnostics.responseBytes, 0); assert.equal(channel.activeCallCount(), 0);
        assert.equal(finalResources.activeCalls, 0); assert.equal(finalResources.queuedCalls, 0);
        assert.equal(finalResources.bufferedBytes, 0); assert.equal(finalResources.peakActiveCalls, 1);
        assert.ok(finalResources.peakBufferedBytes > 0); assert.ok(finalResources.peakBufferedBytes <= maxBufferedBytes);
        assert.equal(surface.readableHighWaterMark, 1);
        if (['slow', 'pause', 'partial', 'cancel'].includes(spec.scenario)) {
          assert.equal(maxReadableLength, 1, 'the public queue was actually exercised');
          assert.equal(maxExecution.pendingMessages, 1, 'the demand wait was actually exercised');
          assert.equal(maxExecution.parserAssemblies, 1, 'the parser retained an actual assembly');
        }
        if (spec.scenario === 'cancel') {
          assert.equal(cancelSample.readableLength, 1); assert.equal(cancelSample.execution.pendingMessages, 1);
          assert.ok(cancelSample.execution.pendingMessageBytes > 0); assert.equal(cancelSample.execution.parserAssemblies, 1);
          assert.ok(cancelSample.execution.parserAssemblyBytes > 0); assert.ok(cancelSample.execution.runtimeChunkBytes > 0);
        }
      }
      // Cancellation ends RPC ownership; an already queued public object can
      // remain until the application reads/discards it. Record both boundaries.
      const readableLengthBeforeDiscard = surface.readableLength;
      surface.removeListener('data', onData);
      let discardedMessages = 0;
      while (surface.read() !== null) discardedMessages++;
      surface.destroy();
      assert.equal(surface.readableLength, 0);
      if (adapter) {
        bufferOwnership.samples.released = ownedBytes();
        assert.ok(Object.values(bufferOwnership.samples.released).every(value => value === 0), 'every measured byte owner is released');
      }
      rows.push({ id: spec.id, scenario: spec.scenario, requestId, runtime, mode, status: 'passed',
        requestedCount: spec.count, messageSize: spec.size, deliveredCount, deliveredBytes, payloadByteSum,
        codes: [...codes], terminalCount: codes.length, errorCodes: [...errorCodes], endCount, cancelCount,
        deliveredAtCancel, events: [...events], dataAfterTerminal,
        readableHighWaterMark: surface.readableHighWaterMark, maxReadableLength,
        pauseDeliveredDuringWindow, pauseWindowMs, pausedSample, cancelSample, readableLengthAfterCancel,
        readableLengthBeforeDiscard, discardedMessages, readableLengthAfterDiscard: surface.readableLength,
        maxExecution, finalExecution, finalDiagnostics, finalResources, bufferOwnership,
        activeCallsBeforeClose: adapter ? channel.activeCallCount() : null,
        cleanupVerifiedBeforeClose: true, elapsedMs: Date.now() - started });
      completed = true;
    } finally {
      clearInterval(monitor);
      for (const handle of scheduled) clearTimeout(handle);
      if (!completed) { surface?.removeListener('data', onData); surface?.cancel(); surface?.destroy(); }
      client.close();
    }
  }
  return { runtime, mode, status: 'passed', rows };
}
