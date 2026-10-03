'use strict';
// A loopback native grpc-js oracle and a demand-driven HTTP/2 -> grpc-web peer.
// This fixture deliberately does not import the adapter's framing implementation.
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { createRequire } = require('node:module');
const path = require('node:path');
const nativeRequire = createRequire(path.join(__dirname, '../fixtures/native/package.json'));

async function createFlowPeer() {
  const nativeGrpc = nativeRequire('@grpc/grpc-js');
  const server = new nativeGrpc.Server(), serverCalls = [], receipts = [];
  const sessions = new Set(), bridges = new Map(), backendCalls = new Set();
  let pendingDrainWaiters = 0, pendingPulls = 0, serverClosed = false, nextReceipt = 0;

  server.addService({ stream: { path: '/flow.Test/Stream', requestStream: false, responseStream: true,
    requestDeserialize: bytes => JSON.parse(bytes.toString()), requestSerialize: value => Buffer.from(JSON.stringify(value)),
    responseSerialize: bytes => bytes, responseDeserialize: bytes => bytes } }, { stream(call) {
    const request = call.request;
    const record = { id: request.id, catalogId: request.catalogId, scenario: request.scenario,
      count: request.count, size: request.size, messagesProduced: 0, bytesProduced: 0,
      drainWaits: 0, cancelled: false, cancellationEvents: 0, cancelledBeforeFinish: false,
      finished: false, generatorSettled: false, status: null };
    serverCalls.push(record); backendCalls.add(call);
    let cancelled = false, releaseDrain;
    call.on('cancelled', () => {
      cancelled = true; record.cancelled = true; record.cancellationEvents++;
      record.cancelledBeforeFinish ||= !record.finished;
      releaseDrain?.(false); call.end();
    });
    call.on('error', () => {});
    async function produce() {
      try {
        assert.ok(['slow', 'pause', 'total', 'cancel', 'partial', 'chunk'].includes(request.scenario));
        assert.ok(Number.isInteger(request.count) && request.count >= 1 && request.count <= 4096);
        assert.ok(Number.isInteger(request.size) && request.size >= 4 && request.size <= 65536);
        const metadata = new nativeGrpc.Metadata(); metadata.set('x-flow-peer', 'native-loopback');
        call.sendMetadata(metadata);
        for (let index = 0; index < request.count && !cancelled; index++) {
          const payload = Buffer.alloc(request.size, index % 251); payload.writeUInt32BE(index, 0);
          const accepted = call.write(payload);
          record.messagesProduced++; record.bytesProduced += payload.length;
          if (!accepted && !cancelled) {
            record.drainWaits++; pendingDrainWaiters++;
            const drained = await new Promise(resolve => {
              let settled = false;
              const finish = result => {
                if (settled) return; settled = true;
                call.removeListener('drain', onDrain); call.removeListener('close', onClose);
                releaseDrain = undefined; pendingDrainWaiters--; resolve(result);
              };
              const onDrain = () => finish(true), onClose = () => finish(false);
              releaseDrain = finish; call.once('drain', onDrain); call.once('close', onClose);
              if (cancelled || call.destroyed) finish(false);
            });
            if (!drained) break;
          }
        }
        if (!cancelled) {
          // End/error goes through Writable's existing queued writes; no payload
          // array or synthetic response is substituted for native server output.
          record.status = request.scenario === 'partial' ? nativeGrpc.status.UNAVAILABLE : nativeGrpc.status.OK;
          record.finished = true;
          if (record.status) call.emit('error', Object.assign(new Error('controlled partial stream failure'), { code: record.status }));
          else call.end();
        }
      } catch (error) {
        record.failure = String(error.message); record.status = nativeGrpc.status.INTERNAL;
        call.emit('error', Object.assign(new Error('controlled flow peer failure'), { code: record.status }));
      } finally {
        releaseDrain?.(false); record.generatorSettled = true; backendCalls.delete(call);
      }
    }
    void produce();
  } });
  const nativePort = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0',
    nativeGrpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  const nativeTarget = `127.0.0.1:${nativePort}`;

  async function fetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.ok(['flow.test', 'gateway.flow.test'].includes(url.hostname), 'FLOW_PEER_LOGICAL_HOST');
    assert.equal(url.protocol, 'https:'); assert.equal(url.pathname, '/flow.Test/Stream');
    assert.equal(url.port, ''); assert.equal(url.search, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
    const method = init?.method ?? input.method ?? 'GET'; assert.equal(method, 'POST');
    const signal = init?.signal ?? input.signal;
    let body = init?.body ?? input.body, bytes;
    if (ArrayBuffer.isView(body)) bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else if (body instanceof ArrayBuffer) bytes = Buffer.from(body);
    else {
      assert.ok(body && typeof body.getReader === 'function', 'FLOW_PEER_REQUEST_BODY');
      const reader = body.getReader(), chunks = []; let length = 0;
      try {
        while (true) {
          const item = await reader.read(); if (item.done) break;
          length += item.value.byteLength; assert.ok(length <= 65536, 'FLOW_PEER_REQUEST_LIMIT'); chunks.push(Buffer.from(item.value));
        }
        bytes = Buffer.concat(chunks, length);
      } finally { reader.releaseLock(); }
    }
    assert.ok(bytes.length >= 5 && bytes.length <= 65536); assert.equal(bytes[0], 0);
    assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
    const request = JSON.parse(bytes.subarray(5).toString());
    const record = { sequence: ++nextReceipt, id: request.id, catalogId: request.catalogId,
      scenario: request.scenario, host: url.hostname, path: url.pathname, requestBytes: bytes.length,
      pulls: 0, chunks: 0, responseBytes: 0, trailerBytes: 0, peakReadableBytes: 0,
      cancelled: false, abortObserved: false, bodyCancelled: false, explicitCancellation: false,
      status: null, statusSource: 'not-observed', ended: false, bodyClosed: false, sessionClosed: false };
    receipts.push(record);
    if (signal?.aborted) { record.cancelled = true; record.abortObserved = true; throw signal.reason ?? new Error('FLOW_PEER_ABORTED'); }
    const session = http2.connect(`http://${nativeTarget}`); sessions.add(session);
    session.once('close', () => { sessions.delete(session); record.sessionClosed = true; });
    const headers = Object.fromEntries(new Headers(init?.headers ?? input.headers));
    for (const name of ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'proxy-connection']) delete headers[name];
    const stream = session.request({ ...headers, ':method': 'POST', ':path': url.pathname, 'content-type': 'application/grpc', te: 'trailers' });
    stream.pause();
    let ended = false, closed = false, terminal, failure, wakePull, controller, responseResolved = false;
    let resolveResponse, rejectResponse;
    const responseReady = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    function wake() { const wake = wakePull; wakePull = undefined; wake?.(); }
    function detach() { signal?.removeEventListener('abort', abort); }
    function clean(cancelled) {
      if (closed) return; closed = true; detach(); bridges.delete(record.sequence); wake();
      if (cancelled) { stream.close(http2.constants.NGHTTP2_CANCEL); session.destroy(); }
      else session.close();
    }
    function fail(error) {
      if (closed) return; failure = error;
      record.failure = String(error.message);
      if (!responseResolved) rejectResponse(error);
      else { try { controller.error(error); } catch {} }
      clean(true);
    }
    function cancel(kind) {
      if (closed) return;
      record.cancelled = true; record[kind] = true;
      if (!responseResolved) rejectResponse(new Error('FLOW_PEER_CANCELLED'));
      else if (kind !== 'bodyCancelled') { try { controller.error(new Error('FLOW_PEER_CANCELLED')); } catch {} }
      clean(true);
    }
    function abort() { cancel('abortObserved'); }
    bridges.set(record.sequence, { id: record.id, cancel: () => cancel('explicitCancellation') });
    session.on('error', fail); stream.on('error', fail);
    stream.on('readable', () => { record.peakReadableBytes = Math.max(record.peakReadableBytes, stream.readableLength); wake(); });
    stream.on('trailers', value => { terminal = value; });
    stream.on('end', () => { ended = true; record.ended = true; wake(); });
    stream.on('close', () => {
      if (!closed && !ended) fail(new Error('FLOW_PEER_PREMATURE_CLOSE'));
      wake();
    });
    const responseBody = new ReadableStream({
      start(value) { controller = value; },
      async pull(value) {
        record.pulls++; pendingPulls++;
        try {
          while (!closed) {
            if (failure) throw failure;
            const chunk = stream.read();
            if (chunk !== null) {
              record.chunks++; record.responseBytes += chunk.length; value.enqueue(chunk); return;
            }
            if (ended) {
              assert.ok(terminal && terminal['grpc-status'] !== undefined, 'FLOW_PEER_MISSING_NATIVE_STATUS');
              record.status = Number(terminal['grpc-status']); assert.ok(Number.isInteger(record.status));
              record.statusSource = 'observed-native-http2-trailers';
              const text = Object.entries(terminal).filter(([name]) => !name.startsWith(':'))
                .flatMap(([name, raw]) => (Array.isArray(raw) ? raw : [raw]).map(item => `${name}: ${item}\r\n`)).join('');
              const payload = Buffer.from(text), trailer = Buffer.alloc(5 + payload.length);
              trailer[0] = 128; trailer.writeUInt32BE(payload.length, 1); payload.copy(trailer, 5);
              record.trailerBytes = trailer.length; value.enqueue(trailer); value.close(); record.bodyClosed = true; clean(false); return;
            }
            await new Promise(resolve => { wakePull = resolve; });
          }
        } catch (error) { fail(error); }
        finally { pendingPulls--; }
      },
      cancel() { cancel('bodyCancelled'); },
    }, { highWaterMark: 0 });
    stream.once('response', value => {
      if (closed) return;
      record.httpStatus = value[':status']; if (value['grpc-status'] !== undefined) terminal = value;
      const responseHeaders = new Headers();
      for (const [name, raw] of Object.entries(value)) {
        if (name.startsWith(':') || ['content-length', 'content-type', 'grpc-status', 'grpc-message'].includes(name)) continue;
        for (const item of Array.isArray(raw) ? raw : [raw]) responseHeaders.append(name, String(item));
      }
      responseHeaders.set('content-type', 'application/grpc-web+proto');
      responseResolved = true;
      resolveResponse(new Response(responseBody, { status: value[':status'], headers: responseHeaders }));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort(); else stream.end(bytes);
    return responseReady;
  }

  function snapshot() { return { activeSessions: sessions.size, activeBridges: bridges.size,
    activeBackendCalls: backendCalls.size, pendingDrainWaiters, pendingPulls, serverClosed }; }
  function cancel(id) {
    let count = 0;
    for (const bridge of bridges.values()) if (bridge.id === id) { bridge.cancel(); count++; }
    return count;
  }
  async function close() {
    for (const bridge of [...bridges.values()]) bridge.cancel();
    const closedSessions = [...sessions].map(session => new Promise(resolve => session.once('close', resolve)));
    for (const session of sessions) session.destroy();
    for (const call of backendCalls) call.destroy();
    await Promise.all(closedSessions);
    await new Promise(resolve => server.tryShutdown(resolve)); serverClosed = true;
  }
  return { nativeGrpc, nativeTarget, nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version,
    fetch, receipts, serverCalls, snapshot, cancel, close };
}

module.exports = { createFlowPeer };
