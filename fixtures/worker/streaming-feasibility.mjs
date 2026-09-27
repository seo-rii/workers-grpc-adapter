// Raw Fetch experiment: deliberately bypasses all adapter stream guards.
const scenarios = ['client-stream', 'bidi', 'slow-consumer', 'early-error', 'cancel'];
function check(condition, id) { if (!condition) throw new Error(id); }
function varint(value) {
  const result = [];
  do { const next = value % 128; value = Math.floor(value / 128); result.push(next | (value ? 128 : 0)); } while (value);
  return Uint8Array.from(result);
}
function frame(payload) {
  const length = varint(payload.length), result = new Uint8Array(6 + length.length + payload.length);
  new DataView(result.buffer).setUint32(1, 1 + length.length + payload.length);
  result[5] = 10; result.set(length, 6); result.set(payload, 6 + length.length); return result;
}
function payload(bytes) {
  check(bytes[0] === 10, 'response-protobuf-tag');
  let length = 0, scale = 1, offset = 1;
  while (offset < bytes.length) { const value = bytes[offset++]; length += (value & 127) * scale; if (!(value & 128)) break; scale *= 128; }
  check(length === bytes.length - offset, 'response-protobuf-length'); return bytes.subarray(offset);
}
async function bounded(promise, stage, milliseconds = 2000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout-${stage}`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function frames(reader) {
  let pending = new Uint8Array();
  return async () => {
    while (pending.length < 5 || pending.length < 5 + new DataView(pending.buffer, pending.byteOffset).getUint32(1)) {
      const { done, value } = await reader.read();
      check(!done, 'response-ended-before-frame');
      const next = new Uint8Array(pending.length + value.length); next.set(pending); next.set(value, pending.length); pending = next;
      check(pending.length <= 262144, 'bounded-response-buffer');
    }
    const length = new DataView(pending.buffer, pending.byteOffset).getUint32(1);
    const result = { flag: pending[0], bytes: pending.slice(5, 5 + length) };
    pending = pending.slice(5 + length); return result;
  };
}

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1);
    if (!scenarios.includes(scenario)) return new Response('Unknown scenario', { status: 404 });
    const id = `${env.MODE}-${scenario}`;
    const body = new TransformStream(undefined, { highWaterMark: 1 }, { highWaterMark: 0 });
    const writer = body.writable.getWriter(), abort = new AbortController();
    let reader, stage = 'fetch', closed = false, writes = 0, peakPendingProducerBytes = 0;
    const contentType = env.MODE === 'convert' ? 'application/grpc-web' : 'application/grpc-web+proto';
    const pendingFetch = fetch(`https://stream-gateway.invalid/fixture.Streaming/${scenario === 'bidi' ? 'Bidi' : 'ClientStream'}`, {
      method: 'POST', headers: { 'content-type': contentType, accept: contentType, 'x-grpc-web': '1', 'x-wga-case': id },
      body: body.readable, duplex: 'half', signal: abort.signal, cf: { grpcWeb: env.MODE },
    });
    pendingFetch.catch(() => {});
    const control = async (operation, count = 0) => {
      const response = await fetch(`https://stream-control.invalid/${id}/${operation}?count=${count}`, { method: 'POST' });
      check(response.ok, 'control-failed'); return response.json();
    };
    const write = async bytes => {
      const encoded = frame(bytes); peakPendingProducerBytes = Math.max(peakPendingProducerBytes, encoded.length);
      stage = `write-${writes + 1}`;
      await bounded(writer.write(encoded), stage); writes++;
    };
    try {
      const firstPayload = new Uint8Array(scenario === 'slow-consumer' ? 65536 : 1);
      firstPayload.fill(scenario === 'early-error' ? 255 : 1); await write(firstPayload);
      stage = 'arrival-before-half-close';
      const arrival = await bounded(control('arrived', 1), stage);
      check(arrival.messages >= 1 && !arrival.halfClosed && !closed, 'first-message-arrived-before-half-close');
      if (scenario === 'cancel') {
        abort.abort();
        stage = 'native-cancellation';
        const cancellation = await bounded(control('cancelled'), stage);
        check(cancellation.cancelled, 'upstream-cancellation');
        return Response.json({ scenario, mode: env.MODE, outcome: 'supported', writes, arrivalBeforeHalfClose: true,
          nativeCancellation: true, peakPendingProducerBytes });
      }
      if (scenario === 'bidi') {
        stage = 'first-response-before-second-request';
        const response = await bounded(pendingFetch, stage);
        check(response.status === 200, 'http-response-status'); reader = response.body.getReader();
        const next = frames(reader);
        const first = await bounded(next(), stage); check(first.flag === 0 && payload(first.bytes)[0] === 1, 'first-duplex-response');
        await write(Uint8Array.of(2));
        stage = 'second-duplex-response';
        const second = await bounded(next(), stage); check(second.flag === 0 && payload(second.bytes)[0] === 2, 'second-duplex-response');
        await bounded(writer.close(), 'half-close'); closed = true;
        const terminal = await bounded(next(), 'trailers');
        check(terminal.flag === 128 && /grpc-status: ?0(?:\r\n|$)/.test(new TextDecoder().decode(terminal.bytes)), 'duplex-status');
        check((await bounded(reader.read(), 'response-eof')).done, 'duplex-terminal-eof');
        const state = await control('ended'); check(state.messages === 2 && state.halfClosed, 'duplex-server-half-close');
        return Response.json({ scenario, mode: env.MODE, outcome: 'supported', writes, arrivalBeforeHalfClose: true,
          responseBeforeSecondRequest: true, responses: 2, nativeHalfClose: true, peakPendingProducerBytes });
      }
      if (scenario !== 'early-error') {
        const count = scenario === 'slow-consumer' ? 32 : 3;
        for (let index = 2; index <= count; index++) {
          const bytes = new Uint8Array(scenario === 'slow-consumer' ? 65536 : 1); bytes.fill(index); await write(bytes);
        }
        stage = 'half-close'; await bounded(writer.close(), stage); closed = true;
      }
      stage = scenario === 'early-error' ? 'error-before-half-close' : 'response-after-half-close';
      const response = await bounded(pendingFetch, stage); check(response.status === 200, 'http-response-status');
      if (scenario === 'early-error' && response.headers.get('grpc-status') === '7') {
        await response.body?.cancel();
        return Response.json({ scenario, mode: env.MODE, outcome: 'supported', writes, arrivalBeforeHalfClose: true,
          grpcStatus: 7, statusFromHeaders: true, earlyErrorBeforeHalfClose: !closed, peakPendingProducerBytes });
      }
      reader = response.body.getReader(); const next = frames(reader);
      let terminal;
      if (scenario === 'early-error') terminal = await bounded(next(), stage);
      else {
        const message = await bounded(next(), 'response-message'); const data = payload(message.bytes);
        check(message.flag === 0 && data[0] === writes && data[1] === ((writes * (writes + 1) / 2) % 256), 'client-stream-summary');
        terminal = await bounded(next(), 'trailers');
      }
      const code = scenario === 'early-error' ? 7 : 0;
      check(terminal.flag === 128 && new RegExp(`grpc-status: ?${code}(?:\\r\\n|$)`).test(new TextDecoder().decode(terminal.bytes)), 'grpc-status');
      check((await bounded(reader.read(), 'response-eof')).done, 'terminal-eof');
      const state = await control(scenario === 'early-error' ? 'state' : 'ended');
      check(state.messages === writes, 'exact-upstream-message-count');
      if (scenario !== 'early-error') check(state.halfClosed, 'server-observed-half-close');
      return Response.json({ scenario, mode: env.MODE, outcome: 'supported', writes, arrivalBeforeHalfClose: true,
        nativeHalfClose: state.halfClosed, grpcStatus: code, earlyErrorBeforeHalfClose: scenario === 'early-error' && !closed,
        peakPendingProducerBytes, producerPendingWritesLimit: 1, nativeReadPauses: state.pauses });
    } catch (error) {
      const blockedAt = Date.now(), requestHalfClosed = closed;
      const recovery = {};
      if (scenario === 'early-error' && !closed) {
        try {
          await bounded(writer.close(), 'diagnostic-half-close', 1000); closed = true;
          const response = await bounded(pendingFetch, 'diagnostic-response-after-half-close', 1000);
          recovery.responseRecoveredAfterHalfClose = true;
          recovery.grpcStatusAfterHalfClose = response.headers.get('grpc-status');
          await response.body?.cancel();
        } catch { recovery.responseRecoveredAfterHalfClose = false; }
      }
      return Response.json({ scenario, mode: env.MODE, outcome: 'blocked', stage, reason: error.message,
        writes, requestHalfClosed, peakPendingProducerBytes, blockedAt, ...recovery });
    } finally {
      abort.abort();
      const cleanup = [pendingFetch.catch(() => {}), writer.abort().catch(() => {}), ...(reader ? [reader.cancel().catch(() => {})] : [])];
      try { await bounded(Promise.allSettled(cleanup), 'worker-cleanup', 1000); } catch {}
    }
  },
};
