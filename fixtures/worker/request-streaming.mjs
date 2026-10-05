import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { credentials, makeGenericClientConstructor, Metadata, compressionAlgorithms } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

function encode(value) {
  let size = value.length; const prefix = [10];
  do { const low = size % 128; size = Math.floor(size / 128); prefix.push(low | (size ? 128 : 0)); } while (size);
  return Buffer.concat([Buffer.from(prefix), value]);
}
function decode(bytes) {
  assert.equal(bytes[0], 10); let size = 0, scale = 1, offset = 1;
  while (offset < bytes.length) { const byte = bytes[offset++]; size += (byte & 127) * scale; if (!(byte & 128)) break; scale *= 128; }
  assert.equal(size, bytes.length - offset); return bytes.subarray(offset);
}
const methods = Object.fromEntries(['ClientStream', 'Bidi'].map(name => [name[0].toLowerCase() + name.slice(1), {
  path: `/fixture.Streaming/${name}`, requestStream: true, responseStream: name === 'Bidi',
  requestSerialize: encode, responseDeserialize: decode,
}]));
const Streaming = makeGenericClientConstructor(methods, 'fixture.Streaming');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function transportCall(surface) {
  let call = surface.call;
  while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
  assert.ok(call); return call;
}

export default {
  async fetch(request, env) {
    const scenario = new URL(request.url).pathname.slice(1), id = `${env.MODE}-${scenario}`;
    const idleTargetMs = Number(env.IDLE_MS);
    assert.ok(Number.isSafeInteger(idleTargetMs) && idleTargetMs >= 1500 && idleTargetMs <= 120000);
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'stream.test': 'https://stream-gateway.invalid' },
      experimentalRequestStreaming: true });
    const client = new Streaming('stream.test', credentials.createSsl(), transport.grpcOptions({
      ...(['gzip', 'bidi-gzip'].includes(scenario) ? { 'grpc.default_compression_algorithm': compressionAlgorithms.gzip } : {}),
      ...(scenario === 'receive-limit' ? { 'grpc.max_receive_message_length': 3 } : {}),
    }));
    const metadata = new Metadata(); metadata.set('x-wga-case', id);
    const control = async (operation, count = 0) => {
      const response = await fetch(`https://stream-control.invalid/${id}/${operation}?count=${count}`, { method: 'POST' });
      assert.equal(response.status, 200); return response.json();
    };
    const timeout = scenario === 'deadline' || scenario === 'early-error' ? 300 : scenario === 'bidi-idle' ? idleTargetMs + 6000 : 5000;
    let call, writes = 0, writeCallbacks = 0, writeErrors = 0, responseBeforeSecondRequest = false, idleGapMs = 0;
    const seen = [];
    try {
      let responsePromise;
      if (scenario.startsWith('bidi')) {
        call = client.bidi(metadata, { deadline: Date.now() + timeout });
        const firstResponse = new Promise(resolve => call.once('data', resolve));
        call.on('data', value => seen.push(value[0])); call.on('error', () => {});
        const terminal = new Promise(resolve => call.on('status', resolve));
        await new Promise((resolve, reject) => call.write(Buffer.from([1]), error => { writeCallbacks++; error ? reject(error) : resolve(); })); writes++;
        assert.equal((await firstResponse)[0], 1); responseBeforeSecondRequest = true;
        if (scenario === 'bidi-idle') {
          const idleStart = Date.now(); await sleep(idleTargetMs); idleGapMs = Date.now() - idleStart;
          const stillOpen = await control('observed');
          assert.equal(stillOpen.messages, 1); assert.equal(stillOpen.halfClosed, false); assert.equal(stillOpen.cancelled, false);
        }
        if (scenario === 'bidi-cancel-after-response') {
          call.cancel(); assert.equal((await terminal).code, 1); assert.deepEqual(seen, [1]);
        } else {
          await new Promise((resolve, reject) => call.write(Buffer.from([2]), error => { writeCallbacks++; error ? reject(error) : resolve(); })); writes++;
          call.end(); assert.equal((await terminal).code, 0); assert.deepEqual(seen, [1, 2]);
        }
      } else {
        responsePromise = new Promise(resolve => {
          call = client.clientStream(metadata, { deadline: Date.now() + timeout }, (error, value) => resolve({ error, value }));
        });
        call.on('error', () => {}); const terminal = new Promise(resolve => call.on('status', resolve));
        if (scenario !== 'empty') {
          const first = Buffer.alloc(scenario === 'slow-consumer' ? 65536 : 1, scenario === 'early-error' ? 255 : 1);
          await new Promise((resolve, reject) => call.write(first, error => { writeCallbacks++; if (error) { writeErrors++; reject(error); } else resolve(); })); writes++;
          const arrival = await control('arrived', 1); assert.ok(!arrival.halfClosed);
        }
        if (scenario === 'cancel') call.cancel();
        else if (scenario === 'channel-close') client.close();
        else if (!['deadline', 'early-error'].includes(scenario)) {
          const count = scenario === 'empty' ? 0 : scenario === 'slow-consumer' ? 32 : 3;
          for (let index = 2; index <= count; index++) {
            await new Promise((resolve, reject) => call.write(Buffer.alloc(scenario === 'slow-consumer' ? 65536 : 1, index), error => {
              writeCallbacks++; if (error) { writeErrors++; reject(error); } else resolve();
            })); writes++;
          }
          call.end();
        }
        const { error, value } = await responsePromise, final = await terminal;
        const expected = { cancel: 1, deadline: 4, 'channel-close': 14, 'early-error': 4, 'error-after-end': 7, 'receive-limit': 8 }[scenario] ?? 0;
        assert.equal(error?.code ?? 0, expected); assert.equal(final.code, expected);
        if (expected === 0) assert.deepEqual([...value], [writes, writes * (writes + 1) / 2 % 256]);
      }
      assert.equal(client.getChannel().activeCallCount(), 0);
      assert.deepEqual(transportCall(call).diagnostics(), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
      // Local status and request half-close can precede the native peer's
      // cancellation event. Keep this invocation alive until it is observed.
      const requiresCancellation = ['cancel', 'deadline', 'channel-close', 'bidi-cancel-after-response'].includes(scenario);
      const nativeState = await control(requiresCancellation ? 'cancelled' : 'observed');
      if (requiresCancellation) assert.equal(nativeState.cancelled, true);
      return Response.json({ scenario, mode: env.MODE, outcome: 'supported', writes, writeCallbacks, writeErrors,
        responseBeforeSecondRequest, idleGapMs,
        grpcStatus: { cancel: 1, 'bidi-cancel-after-response': 1, deadline: 4, 'channel-close': 14, 'early-error': 4, 'error-after-end': 7, 'receive-limit': 8 }[scenario] ?? 0,
        activeCalls: 0, transportBytes: 0, nativeCancellation: nativeState.cancelled });
    } catch (error) {
      return Response.json({ scenario, mode: env.MODE, outcome: 'failed', error: error.message, code: error.code }, { status: 500 });
    } finally { call?.cancel(); client.close(); }
  },
};
