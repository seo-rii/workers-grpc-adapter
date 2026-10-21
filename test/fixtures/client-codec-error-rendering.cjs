'use strict';
const { assert, grpc, methods, response, immediate } = require('../helpers.cjs');
const { createWorkersGrpcTransport } = require('../../dist/adapter.js');
const kind = process.argv[2];
const uncaught = [];
let failures = 0, controls = 0, logged = 0;
process.on('uncaughtException', error => uncaught.push(error));
console.error = console.warn = () => { logged++; };
const watchdog = setTimeout(() => {
  process.stdout.write(JSON.stringify({ complete: false, failures, controls, uncaught: uncaught.length, logged }));
  process.exit(1);
}, 5000);
function failure() {
  switch (kind) {
    case 'ordinary': return new Error('controlled codec failure');
    case 'string': return 'controlled thrown value';
    case 'null': return null;
    case 'null-prototype': return Object.create(null);
    case 'message-getter': return Object.defineProperty(new Error(), 'message', { get() { throw new Error('PRIVATE_MESSAGE_GETTER'); } });
    case 'message-object': return Object.assign(new Error(), { message: { toString() { throw new Error('PRIVATE_MESSAGE_COERCION'); } } });
    case 'prototype-proxy': return new Proxy({}, { getPrototypeOf() { throw new Error('PRIVATE_PROTOTYPE_TRAP'); } });
    case 'message-proxy': return new Proxy(new Error(), { get() { throw new Error('PRIVATE_MESSAGE_TRAP'); } });
    case 'revoked-proxy': {
      const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy;
    }
    case 'primitive-getter': return { get [Symbol.toPrimitive]() { throw new Error('PRIVATE_PRIMITIVE_GETTER'); } };
    case 'throwing-string': return { toString() { throw new Error('PRIVATE_STRING_COERCION'); } };
  }
}
const expectedMessage = kind === 'ordinary' ? 'controlled codec failure' : kind === 'string' ? 'controlled thrown value'
  : kind === 'null' ? 'null' : 'Unknown error';

async function exercise(mode, shape, direction) {
  let broken = true, fetches = 0, callbacks = 0, callbackError;
  const definition = { ...methods[shape] };
  const codec = direction === 'request' ? 'requestSerialize' : 'responseDeserialize';
  const original = definition[codec];
  definition[codec] = value => { if (broken) throw failure(); return original(value); };
  const Constructor = grpc.makeGenericClientConstructor({ ...methods, [shape]: definition }, 'demo.Echo');
  const transport = createWorkersGrpcTransport({ mode, resourceLimits: { maxConcurrentCalls: 1 },
    ...(mode === 'grpc-web' ? { endpoints: { 'codec.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
    fetcher: { async fetch(_url, init) {
      fetches++;
      if (!Buffer.isBuffer(init.body)) for await (const _ of init.body) { /* Drain the upload. */ }
      return response();
    } },
  });
  const client = new Constructor('codec.test', transport.channelCredentials, transport.grpcOptions());
  try {
    const emittedErrors = [], statuses = [];
    const callback = error => { callbacks++; callbackError = error; };
    let call;
    if (shape === 'unary') call = client.unary({ text: 'request' }, callback);
    else if (shape === 'clientStream') call = client.clientStream(callback);
    else if (shape === 'stream') call = client.stream({ text: 'request' });
    else call = client.bidi();
    call.on('error', error => emittedErrors.push(error));
    const terminal = new Promise(resolve => call.on('status', status => { statuses.push(status); resolve(status); }));
    if (shape === 'clientStream' || shape === 'bidi') call.end({ text: 'request' });
    if (shape === 'stream' || shape === 'bidi') call.resume();
    const status = await terminal;
    await immediate();
    const detail = (direction === 'request' ? 'Request message serialization failure: ' : 'Response message parsing error: ') + expectedMessage;
    assert.equal(status.code, grpc.status.INTERNAL);
    assert.equal(status.details, detail);
    assert.equal(statuses.length, 1);
    if (shape === 'unary' || shape === 'clientStream') {
      assert.equal(callbacks, 1);
      assert.equal(callbackError.code, grpc.status.INTERNAL);
      assert.equal(callbackError.details, detail);
    } else {
      assert.equal(emittedErrors.length, 1);
      assert.equal(emittedErrors[0].code, grpc.status.INTERNAL);
    }
    assert.equal(grpc.getClientChannel(client).activeCallCount(), 0);
    assert.equal(transport.resourceUsage().activeCalls, 0);
    if (direction === 'request') assert.equal(fetches, 0, 'serialization failure must not start an RPC');
    failures++;
    broken = false;
    // A second call must acquire the released admission slot and use the client normally.
    assert.deepEqual(await new Promise((resolve, reject) => client.unary({ text: 'control' },
      (error, value) => error ? reject(error) : resolve(value))), { text: 'ok' });
    await immediate();
    assert.equal(grpc.getClientChannel(client).activeCallCount(), 0);
    assert.equal(transport.resourceUsage().activeCalls, 0);
    controls++;
  } finally { grpc.closeClient(client); }
}

async function main() {
  for (const mode of ['cloudflare', 'grpc-web']) {
    for (const shape of mode === 'grpc-web' ? ['unary', 'clientStream', 'stream', 'bidi'] : ['unary', 'stream']) {
      for (const direction of ['request', 'response']) await exercise(mode, shape, direction);
    }
  }
  assert.equal(uncaught.length, 0);
  assert.equal(logged, 0);
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify({ complete: true, failures, controls, uncaught: uncaught.length, logged }));
}
main().catch(() => { clearTimeout(watchdog); process.stderr.write('CLIENT_CODEC_REGRESSION_FAILED\n'); process.exitCode = 1; });
