import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, Metadata, credentials, status } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { version } from '../../package.json';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function headerBudgets() {
  const results = [], limit = 65536;
  const bytes = headers => [...headers].reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value) + 32, 0);
  for (const mode of ['cloudflare', 'grpc-web']) for (const scenario of ['initial', 'retry', 'refreshed-auth']) for (const delta of [-1, 0, 1]) {
    const targetAttempt = scenario === 'initial' ? 1 : 2;
    const tokens = ['Bearer first', scenario === 'refreshed-auth' ? `Bearer ${'n'.repeat(128)}` : 'Bearer first'];
    const type = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
    const expected = new Headers({ 'content-type': type, accept: type, 'x-grpc-web': '1', 'grpc-encoding': 'identity',
      'grpc-accept-encoding': 'identity,deflate,gzip', 'x-user-agent': `workers-grpc-adapter/${version}`,
      authorization: tokens[targetAttempt - 1], 'x-padding': '' });
    if (targetAttempt > 1) expected.set('grpc-previous-rpc-attempts', '1');
    const metadata = new Metadata(); metadata.set('x-padding', 'p'.repeat(limit + delta - bytes(expected)));
    const sent = []; let generations = 0;
    const transport = createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'budget.test': 'https://budget-gateway.test' } } : {}),
      retryPolicy: { methods: ['/fixture.Retry/Budget'], maxAttempts: 2, initialBackoffMs: 1, maxBackoffMs: 1, retryableStatusCodes: [14] },
      fetcher: { async fetch(_url, init) {
        sent.push(new Headers(init.headers));
        // Empty successful protobuf message followed by a separately encoded status frame.
        const code = sent.length < targetAttempt ? 14 : 0;
        const trailer = Buffer.from(`grpc-status: ${code}\r\n`), prefix = Buffer.alloc(5);
        prefix[0] = 128; prefix.writeUInt32BE(trailer.length, 1);
        return new Response(Buffer.concat([...(code ? [] : [Buffer.alloc(5)]), prefix, trailer]), { headers: { 'content-type': type } });
      } } });
    const auth = credentials.createFromMetadataGenerator((_options, done) => {
      const value = new Metadata(); value.set('authorization', tokens[generations++]); done(null, value);
    });
    const c = new Client('budget.test', credentials.combineChannelCredentials(transport.channelCredentials, auth), transport.grpcOptions());
    try {
      const result = await new Promise(resolve => c.makeUnaryRequest('/fixture.Retry/Budget', value => value, value => value,
        Buffer.alloc(0), metadata, (error, value) => resolve({ code: error?.code ?? 0, details: error?.details, value })));
      assert.equal(result.code, delta > 0 ? status.RESOURCE_EXHAUSTED : status.OK);
      if (delta > 0) assert.equal(result.details, 'WGA_METADATA_SIZE');
      else assert.deepEqual(result.value, Buffer.alloc(0));
      assert.equal(generations, targetAttempt);
      assert.equal(sent.length, targetAttempt - Number(delta > 0));
      for (const [index, headers] of sent.entries()) {
        assert.ok(bytes(headers) <= limit);
        assert.equal(headers.get('authorization'), tokens[index]);
        assert.equal(headers.get('grpc-previous-rpc-attempts'), index === 0 ? null : '1');
      }
      if (delta <= 0) assert.equal(bytes(sent.at(-1)), limit + delta);
      assert.equal(c.getChannel().activeCallCount(), 0);
      results.push({ mode, scenario, delta, code: result.code, attempts: sent.length, generations });
    } finally { c.close(); }
  }
  return results;
}
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
  return Response.json({ status: 'passed', results, headerBudgets: await headerBudgets() });
} };
