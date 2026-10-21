'use strict';
const { assert, grpc, methods, response, immediate } = require('../helpers.cjs');
const { createWorkersGrpcTransport } = require('../../dist/adapter.js');
const kind = process.argv[2];
// Initialize Fetch and Node's lazy reader-release error before changing its
// process-wide formatter; the regression targets client completion.
response().body.getReader().releaseLock();
const uncaught = [];
let coercions = 0, checked = 0;
process.on('uncaughtException', error => uncaught.push(error));
if (kind !== 'ordinary') Error.prepareStackTrace = (_error, frames) => {
  switch (kind) {
    case 'callsites': return frames;
    case 'object': return {};
    case 'symbol': return Symbol('structured stack');
    case 'null': return null;
    case 'undefined': return undefined;
    case 'throwing-formatter': throw new Error('private stack formatter error');
    case 'throwing-coercion': return { [Symbol.toPrimitive]() { coercions++; throw new Error('private stack coercion'); } };
  }
};
const watchdog = setTimeout(() => {
  process.stdout.write(JSON.stringify({ complete: false, checked, uncaught: uncaught.length, coercions }));
  process.exit(1);
}, 5000);

async function main() {
  for (const mode of ['cloudflare', 'grpc-web']) {
    let successful = false;
    const transport = createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'stack.test': 'https://gateway.test' }, experimentalRequestStreaming: true } : {}),
      fetcher: { async fetch(_url, init) {
        if (!Buffer.isBuffer(init.body)) for await (const _ of init.body) { /* Drain the upload. */ }
        return response(successful ? [{ text: 'ok' }] : [], { code: successful ? 0 : grpc.status.PERMISSION_DENIED, details: successful ? '' : 'denied' });
      } },
    });
    const Constructor = grpc.makeGenericClientConstructor(methods, 'demo.Echo');
    const client = new Constructor('stack.test', transport.channelCredentials, transport.grpcOptions());
    try {
      for (const shape of mode === 'grpc-web' ? ['unary', 'clientStream', 'stream', 'bidi'] : ['unary', 'stream']) {
        const errors = [], statuses = [];
        let callbacks = 0, call;
        if (shape === 'unary' || shape === 'clientStream') {
          const callback = error => { callbacks++; errors.push(error); };
          call = shape === 'unary' ? client.unary({ text: 'request' }, callback) : client.clientStream(callback);
          call.on('error', error => errors.push(error));
          if (shape === 'clientStream') call.end({ text: 'request' });
        } else {
          call = shape === 'stream' ? client.stream({ text: 'request' }) : client.bidi();
          call.on('error', error => errors.push(error));
          if (shape === 'bidi') call.end({ text: 'request' });
          call.resume();
        }
        await new Promise(resolve => call.on('status', status => { statuses.push(status); resolve(); }));
        await immediate();
        assert.equal(callbacks, shape === 'unary' || shape === 'clientStream' ? 1 : 0);
        assert.equal(errors.length, 1);
        assert.equal(errors[0].code, grpc.status.PERMISSION_DENIED);
        assert.equal(errors[0].details, 'denied');
        assert.equal(typeof errors[0].stack, 'string');
        assert.match(errors[0].stack, /for call at/);
        if (kind === 'ordinary') assert.match(errors[0].stack, /client-error-stack.cjs/);
        else assert.match(errors[0].stack, /no stack trace available/);
        assert.deepEqual(statuses.map(status => status.code), [grpc.status.PERMISSION_DENIED]);
        assert.equal(grpc.getClientChannel(client).activeCallCount(), 0);
        assert.equal(transport.resourceUsage().activeCalls, 0);
        checked++;
      }
      // Both Health entry points reuse the same unary/server-streaming error path.
      const health = new grpc.HealthClient(client);
      await assert.rejects(health.check(), { code: grpc.status.PERMISSION_DENIED, details: 'denied' });
      checked++;
      const watch = health.watch();
      const errors = [];
      watch.on('error', error => errors.push(error));
      watch.resume();
      const status = await new Promise(resolve => watch.once('status', resolve));
      assert.equal(status.code, grpc.status.PERMISSION_DENIED);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].code, grpc.status.PERMISSION_DENIED);
      checked++;
      successful = true;
      assert.deepEqual(await new Promise((resolve, reject) => client.unary({ text: 'request' },
        (error, value) => error ? reject(error) : resolve(value))), { text: 'ok' });
      checked++;
      await immediate();
      assert.equal(grpc.getClientChannel(client).activeCallCount(), 0);
      assert.equal(transport.resourceUsage().activeCalls, 0);
    } finally { grpc.closeClient(client); }
  }
  assert.equal(uncaught.length, 0);
  assert.equal(coercions, 0);
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify({ complete: true, checked, uncaught: uncaught.length, coercions }));
}
main().catch(() => { clearTimeout(watchdog); process.stderr.write('CLIENT_STACK_REGRESSION_FAILED\n'); process.exitCode = 1; });
