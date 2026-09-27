import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, Metadata, credentials, status } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export default { async fetch(request) {
  const invocation = new URL(request.url).pathname.slice(1), results = [];
  for (const mode of ['grpc-web', 'cloudflare']) for (const kind of ['recovery', 'exhausted', 'denied', 'partial', 'auth-denied', 'cancel', 'deadline']) {
    let generations = 0;
    const slow = kind === 'cancel' || kind === 'deadline';
    const transport = createWorkersGrpcTransport({ mode, ...(mode === 'grpc-web' ? { endpoints: { 'retry.test': 'https://retry-gateway.test' } } : {}),
      retryPolicy: { methods: ['/fixture.Retry/Get'], maxAttempts: 3, initialBackoffMs: slow ? 300 : 1, maxBackoffMs: 300, retryableStatusCodes: [14] } });
    const c = new Client('retry.test', credentials.createSsl(), transport.grpcOptions());
    const auth = credentials.createFromMetadataGenerator((_o, cb) => {
      generations++;
      if (kind === 'auth-denied' && generations === 2) { cb(Object.assign(new Error('synthetic denial'), { code: 16 })); return; }
      const m = new Metadata(); m.set('authorization', `Bearer synthetic-${generations}`); cb(null, m);
    });
    const metadata = new Metadata();
    for (const [key, value] of Object.entries({ kind, mode, invocation })) metadata.set('x-retry-' + key, value);
    const observed = [], statuses = [];
    let call, timer;
    try {
      const completed = new Promise(resolve => {
        call = c.makeUnaryRequest('/fixture.Retry/Get', value => Buffer.from(value), bytes => bytes.toString(), 'immutable', metadata,
          { credentials: auth, deadline: Date.now() + (kind === 'deadline' ? 120 : 3000) }, (error, value) => resolve({ code: error?.code ?? 0, value }));
        call.on('metadata', m => observed.push(m.get('x-attempt')[0]));
        call.on('status', s => statuses.push(s.code));
      });
      if (kind === 'cancel') timer = setTimeout(() => call.cancel(), 120);
      const value = await completed;
      const expected = ({ recovery: 0, exhausted: 14, denied: 7, partial: 14, 'auth-denied': 16, cancel: 1, deadline: 4 })[kind];
      assert.equal(value.code, expected);
      assert.deepEqual(statuses, [expected]);
      const attempts = ['recovery', 'exhausted'].includes(kind) ? 3 : 1;
      assert.equal(generations, kind === 'auth-denied' ? 2 : attempts);
      if (kind === 'recovery') { assert.equal(value.value, 'recovered'); assert.deepEqual(observed, ['3']); }
      if (slow) await sleep(330);
      assert.equal(c.getChannel().activeCallCount(), 0);
      results.push({ invocation, mode, kind, attempts, generations, code: expected });
    } finally { clearTimeout(timer); c.close(); }
  }
  return Response.json({ status: 'passed', results });
} };
