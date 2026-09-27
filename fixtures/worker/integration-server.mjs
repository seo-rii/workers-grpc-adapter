import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Metadata } from '@grpc/grpc-js';
import { createGrpcWebHandler, GrpcWebServerError } from '@grpc/grpc-js/server';

// Bounded test-only state, inspected over the service binding before disposal.
const receipts = new Map();
let invocations = 0;
const definition = {
  unary: { path: '/fixture.Integration/Unary', requestStream: false, responseStream: false,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes },
  stream: { path: '/fixture.Integration/Stream', requestStream: false, responseStream: true,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes },
};
const encodings = ['identity', 'deflate', 'gzip'];
function output(bytes, sequence = 0) {
  return Buffer.from(Array.from(bytes).reverse().map(value => value ^ (0x5a + sequence)));
}
function begin(context) {
  const id = context.metadata.get('x-case-id')[0];
  const receipt = receipts.get(id);
  assert.ok(receipt, 'BACKEND_RECEIPT');
  receipt.handled++;
  receipt.deadline = context.deadline;
  assert.equal(context.metadata.get('authorization')[0], `Bearer fixture-${receipt.invocation}-${receipt.owner}`);
  assert.deepEqual(context.metadata.get('request-bin'), [Buffer.from([0, 255, 128, 13, 10, 42])]);
  const initial = new Metadata();
  initial.set('x-owner', receipt.owner);
  initial.set('initial-bin', Buffer.from([255, 0, 128, 7]));
  context.sendMetadata(initial);
  const trailing = new Metadata();
  trailing.set('x-case-id', id);
  trailing.set('trailer-bin', Buffer.from([0, 255, 1, 254]));
  context.setTrailer(trailing);
  return receipt;
}
const handlers = {
  async unary(bytes, context) {
    const receipt = begin(context);
    receipt.inputHex = bytes.toString('hex');
    if (receipt.kind === 'remote-error') {
      const metadata = new Metadata(); metadata.set('failure-bin', Buffer.from([0, 222, 173]));
      receipt.finalized = true;
      receipt.complete();
      throw new GrpcWebServerError(7, 'Denied: 한글 % integration', metadata);
    }
    if (receipt.kind === 'peer') await new Promise(resolve => setTimeout(resolve, 30));
    receipt.finalized = true;
    receipt.complete();
    return output(bytes);
  },
  async *stream(bytes, context) {
    const receipt = begin(context);
    receipt.inputHex = bytes.toString('hex');
    receipt.active = true;
    try {
      yield output(bytes, 0);
      receipt.emitted++;
      if (['cancel', 'deadline', 'close'].includes(receipt.kind)) {
        if (!context.signal.aborted) await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
        receipt.aborted = context.signal.aborted;
        receipt.abortedAt = Date.now();
        return;
      }
      if (receipt.kind === 'stream-error') throw new GrpcWebServerError(13, 'Partial: 한글 % integration');
      yield output(bytes, 1); receipt.emitted++;
      yield output(bytes, 2); receipt.emitted++;
    } finally {
      receipt.active = false;
      receipt.finalized = true;
      receipt.complete();
    }
  },
};
const services = [0, 1, 2].map(compression => createGrpcWebHandler(definition, handlers,
  { compression, maxReceiveMessageBytes: 4096, maxSendMessageBytes: 4096, maxWireMessageBytes: 8192 }));

export default {
  async fetch(request, _env, context) {
    const url = new URL(request.url);
    if (url.pathname === '/control') {
      return Response.json({ invocations, active: [...receipts.values()].filter(item => item.active).length,
        receipts: [...receipts.values()] });
    }
    if (url.pathname === '/invocation') {
      assert.equal(request.method, 'POST');
      invocations++;
      return Response.json({ invocations });
    }
    try {
      assert.equal(request.method, 'POST');
      const id = request.headers.get('x-case-id');
      const mode = request.headers.get('x-mode');
      const owner = request.headers.get('x-owner');
      const invocation = request.headers.get('x-invocation');
      const requestAlgorithm = Number(request.headers.get('x-request-algorithm'));
      const responseAlgorithm = Number(request.headers.get('x-response-algorithm'));
      assert.ok(['cloudflare', 'grpc-web'].includes(mode));
      assert.ok(['a', 'b'].includes(owner));
      assert.ok(['cold', 'warm'].includes(invocation));
      assert.ok([0, 1, 2].includes(requestAlgorithm) && [0, 1, 2].includes(responseAlgorithm));
      assert.equal(url.origin, mode === 'cloudflare' ? 'https://integration.fixture.invalid' : 'https://gateway.fixture.invalid');
      const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
      assert.equal(request.headers.get('content-type'), mime);
      assert.equal(request.headers.get('accept'), mime);
      assert.equal(request.headers.get('grpc-encoding') || 'identity', encodings[requestAlgorithm]);
      assert.ok(id && !receipts.has(id) && receipts.size < 128);
      const receipt = { id, invocation, mode, owner, kind: request.headers.get('x-kind'), requestAlgorithm,
        responseAlgorithm, requestEncoding: encodings[requestAlgorithm], handled: 0, active: false, emitted: 0,
        finalized: false, aborted: false };
      // Keep deadline cleanup observable after the consuming Worker cancels the
      // service-binding request. No global control request resolves this promise.
      context.waitUntil(new Promise(resolve => Object.defineProperty(receipt, 'complete', { value: resolve })));
      receipts.set(id, receipt);
      const response = await services[responseAlgorithm](request);
      receipts.get(id).responseEncoding = response.headers.get('grpc-encoding') || 'identity';
      return response;
    } catch (error) {
      return Response.json({ diagnostic: error.code === 'ERR_ASSERTION' ? error.message : 'BACKEND_BOUNDARY' }, { status: 500 });
    }
  },
};
