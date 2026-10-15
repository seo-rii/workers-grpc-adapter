'use strict';
const { test } = require('node:test');
const { assert, grpc, client, response, unary, immediate } = require('./helpers.cjs');

for (const contentType of [undefined, 'text/html', 'application/json', 'application/grpc-web-text+proto']) {
  for (const [httpStatus, fallbackCode] of [[200, grpc.status.UNKNOWN], [403, grpc.status.PERMISSION_DENIED], [503, grpc.status.UNAVAILABLE]]) {
    for (const grpcStatus of [undefined, grpc.status.OK, grpc.status.PERMISSION_DENIED]) {
      for (const kind of ['unary', 'stream']) {
        test(`CLIENT invalid MIME ${contentType ?? 'missing'} HTTP ${httpStatus} status ${grpcStatus ?? 'missing'} ${kind}`, async () => {
          let fetches = 0, cancellations = 0;
          const headers = { 'x-error-context': 'preserved' };
          if (contentType !== undefined) headers['content-type'] = contentType;
          if (grpcStatus !== undefined) {
            headers['grpc-status'] = String(grpcStatus);
            headers['grpc-message'] = grpcStatus === grpc.status.OK ? 'incorrect%20success' : 'denied';
          }
          const c = client({}, { retryPolicy: { methods: ['/demo.Echo/Unary'], maxAttempts: 2,
            initialBackoffMs: 1, maxBackoffMs: 1, retryableStatusCodes: [grpc.status.UNAVAILABLE] },
            fetcher: { async fetch() {
              fetches++;
              const body = new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('<html>not an RPC</html>')); },
                cancel() { cancellations++; return new Promise(() => {}); } });
              return new Response(body, { status: httpStatus, headers });
            } } });
          const expectedCode = grpcStatus === grpc.status.PERMISSION_DENIED ? grpcStatus : fallbackCode;
          const expectedDetails = grpcStatus === grpc.status.PERMISSION_DENIED ? 'denied' : 'WGA_NOT_GRPC_WEB';
          const statuses = [], messages = [];
          try {
            let call, completion;
            if (kind === 'unary') ({ call, promise: completion } = unary(c));
            else {
              call = c.stream({ text: 'request' });
              completion = (async () => { for await (const message of call) messages.push(message); })();
            }
            call.on('status', value => statuses.push(value));
            await assert.rejects(completion, { code: expectedCode, details: expectedDetails });
            await immediate();
            assert.deepEqual(messages, []);
            assert.equal(statuses.length, 1);
            assert.equal(statuses[0].code, expectedCode);
            assert.equal(statuses[0].details, expectedDetails);
            if (grpcStatus === grpc.status.PERMISSION_DENIED) assert.deepEqual(statuses[0].metadata.get('x-error-context'), ['preserved']);
            assert.equal(cancellations, 1);
            assert.equal(fetches, 1, 'invalid MIME responses must not be retried');
            assert.equal(c.getChannel().activeCallCount(), 0);
          } finally { c.close(); }
        });
      }
    }
  }
}

for (const contentType of ['application/grpc-web', 'application/grpc-web+proto', 'Application/GRPC-Web+Proto; charset=utf-8']) {
  for (const kind of ['unary', 'stream']) {
    test(`CLIENT valid MIME ${contentType} ${kind} remains successful`, async () => {
      const c = client({}, { fetcher: { async fetch() {
        return response(kind === 'unary' ? [{ text: 'ok' }] : [], { headers: { 'content-type': contentType } });
      } } });
      try {
        if (kind === 'unary') assert.deepEqual(await unary(c).promise, { text: 'ok' });
        else {
          const messages = [], statuses = [];
          const call = c.stream({ text: 'request' });
          call.on('status', value => statuses.push(value.code));
          for await (const message of call) messages.push(message);
          assert.deepEqual(messages, []);
          assert.deepEqual(statuses, [grpc.status.OK]);
        }
      } finally { c.close(); }
    });
  }
}
