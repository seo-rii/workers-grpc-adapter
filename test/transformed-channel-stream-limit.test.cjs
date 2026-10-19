'use strict';
const { test } = require('node:test');
const { Readable, Duplex } = require('node:stream');
const { assert, grpc, immediate } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');

for (const kind of ['server', 'bidi']) {
  for (const [initialLimit, selectedLimit] of [[16, 1], [1, 3], [1, undefined]]) {
    test(`STREAM ${kind} transformer applies selected channel HWM ${initialLimit} -> ${selectedLimit ?? 'default'}`, async () => {
      await checkStream(kind, initialLimit, selectedLimit, false);
    });
  }
  test(`STREAM ${kind} transformer preserves a custom surface and its queue settings`, async () => {
    await checkStream(kind, 16, 1, true);
  });
}

async function checkStream(kind, initialLimit, selectedLimit, replaceSurface) {
  const reference = new Readable({ objectMode: true, read() {} });
  const defaultLimit = reference.readableHighWaterMark;
  reference.destroy();
  let pulls = 0, cancels = 0, metadata = 0, fetches = 0;
  const config = (target, limit, fetcher) => ({
    mode: 'grpc-web', endpoints: { [target]: 'https://gateway.test' }, experimentalRequestStreaming: true,
    resourceLimits: limit === undefined ? {} : { readableHighWaterMark: limit }, fetcher,
  });
  const originalTransport = createWorkersGrpcTransport(config('original.test', initialLimit, {
    async fetch() { assert.fail('The selected channel must own the transport'); },
  }));
  const selectedTransport = createWorkersGrpcTransport(config('selected.test', selectedLimit, {
    async fetch() {
      fetches++;
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(encodeFrame(Buffer.from(String(pulls++)))); },
        cancel() { cancels++; },
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/grpc-web+proto' } });
    },
  }));
  const selected = new grpc.Channel('selected.test', selectedTransport.channelCredentials, selectedTransport.grpcOptions());
  let transformedSurface, originalSurface, originalWritableLimit;
  const client = new grpc.Client('original.test', originalTransport.channelCredentials, originalTransport.grpcOptions({
    callInvocationTransformer(properties) {
      originalSurface = properties.call;
      originalWritableLimit = originalSurface.writableHighWaterMark;
      assert.equal(originalSurface.readableHighWaterMark, initialLimit);
      transformedSurface = replaceSurface ? customSurface(kind) : originalSurface;
      transformedSurface.on('metadata', () => metadata++);
      return { ...properties, channel: selected, call: transformedSurface };
    },
  }));
  let stream;
  try {
    stream = kind === 'server'
      ? client.makeServerStreamRequest('/demo.Stream/Watch', Buffer.from, buffer => buffer.toString(), 'request')
      : client.makeBidiStreamRequest('/demo.Stream/Chat', Buffer.from, buffer => buffer.toString());
    stream.on('error', () => {});
    const terminal = new Promise(resolve => stream.once('status', resolve));
    assert.strictEqual(stream, transformedSurface);
    assert.equal(stream === originalSurface, !replaceSurface);
    const expectedLimit = replaceSurface ? 7 : selectedLimit ?? defaultLimit;
    assert.equal(stream.readableHighWaterMark, expectedLimit);
    if (kind === 'bidi') assert.equal(stream.writableHighWaterMark, replaceSurface ? 5 : originalWritableLimit);
    stream.read(0);
    for (let tick = 0; tick < 5; tick++) await immediate();
    assert.equal(stream.readableLength, expectedLimit);
    assert.equal(pulls, expectedLimit + 1);
    assert.equal(metadata, 1);
    assert.equal(fetches, 1);
    assert.equal(originalTransport.resourceUsage().peakActiveCalls, 0);
    assert.equal(selectedTransport.resourceUsage().activeCalls, 1);
    stream.cancel();
    assert.equal((await terminal).code, grpc.status.CANCELLED);
    await immediate();
    assert.equal(cancels, 1);
    assert.equal(selectedTransport.resourceUsage().activeCalls, 0);
    assert.equal(selectedTransport.resourceUsage().bufferedBytes, 0);
  } finally {
    selected.close();
    client.close();
    stream?.destroy();
    if (originalSurface !== stream) originalSurface?.destroy();
  }
}

function customSurface(kind) {
  const options = { objectMode: true, read() { this.call?.startRead(); } };
  const stream = kind === 'server' ? new Readable({ ...options, highWaterMark: 7 }) : new Duplex({
    ...options, readableHighWaterMark: 7, writableHighWaterMark: 5,
    write(value, _encoding, callback) { this.call.sendMessageWithContext({ callback }, value); },
    final(callback) { this.call.halfClose(); callback(); },
  });
  stream.cancel = () => stream.call?.cancelWithStatus(grpc.status.CANCELLED, 'Custom surface cancelled');
  stream.getPeer = () => stream.call?.getPeer() ?? 'unknown';
  stream.getAuthContext = () => stream.call?.getAuthContext() ?? null;
  return stream;
}
