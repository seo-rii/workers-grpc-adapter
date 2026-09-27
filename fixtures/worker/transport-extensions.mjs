import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, Metadata, credentials } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { decodeGrpcStatusDetails } from '@grpc/grpc-js/status-details';
const cjsGrpc = require('@grpc/grpc-js');
const cjsAdapter = require('@grpc/grpc-js/adapter');
const cjsDetails = require('@grpc/grpc-js/status-details');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const method = '/fixture.TransportExtensions/Unary';
const policy = { methods: [method], maxAttempts: 10, initialBackoffMs: 1, maxBackoffMs: 100, retryableStatusCodes: [14] };
const serialize = value => Buffer.from(value);
const deserialize = value => value.toString();
const payload = 'controlled-request', reply = 'controlled-response';
function frame(value, flag = 0) {
  const bytes = Buffer.from(value), head = Buffer.alloc(5); head[0] = flag; head.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([head, bytes]);
}
function field(id, value) { const bytes = Buffer.from(value); assert.ok(bytes.length < 128); return Buffer.concat([Buffer.from([(id << 3) | 2, bytes.length]), bytes]); }
function rich(code = 7) {
  return Buffer.concat([Buffer.from([8, code]), field(2, 'controlled-rich-status'),
    field(3, Buffer.concat([field(1, 'type.example/First'), field(2, [1, 2])])),
    field(3, Buffer.concat([field(1, 'type.example/Second'), field(2, [3])]))]);
}
async function run() {
  assert.equal(cjsGrpc.Metadata, Metadata); assert.equal(cjsGrpc.Client, Client);
  assert.equal(cjsAdapter.createWorkersGrpcTransport, createWorkersGrpcTransport);
  assert.equal(cjsDetails.decodeGrpcStatusDetails, decodeGrpcStatusDetails);
  const clients = [], transports = [], bodies = [], results = [], receipts = [];
  let rpcCount = 0;
  async function until(check) {
    const end = Date.now() + 5000;
    while (!check()) { assert.ok(Date.now() < end, 'transport extension transition timed out'); await sleep(0); }
  }
  function response(code = 0, extra = '') {
    const chunks = code === 0 ? [frame(reply)] : [];
    chunks.push(frame(`grpc-status: ${code}\r\n${extra}`, 128));
    let index = 0, ended = false, cancellations = 0, deliveredBytes = 0;
    const body = new ReadableStream({ pull(controller) {
      if (index < chunks.length) { const next = chunks[index++]; deliveredBytes += next.length; controller.enqueue(next); }
      else { ended = true; controller.close(); }
    }, cancel() { cancellations++; } }, { highWaterMark: 0 });
    bodies.push({ state: () => ({ bodyLocked: body.locked, ended, cancellations, deliveredBytes }) });
    return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
  }
  function create(mode, kind, events, peer, overrides = {}) {
    let fetches = 0;
    const transport = createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'first.extensions.test': 'https://gateway.extensions.test', 'other.extensions.test': 'https://gateway.extensions.test' } } : {}),
      retryPolicy: policy, retryThrottling: { maxTokens: 4, tokenRatio: 1 }, observer: event => events.push(event),
      ...overrides,
      fetcher: { async fetch(url, init) {
        fetches++;
        assert.equal(init.cf?.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
        assert.deepEqual(Buffer.from(init.body), frame(payload));
        assert.ok(mode === 'cloudflare' ? ['first.extensions.test', 'other.extensions.test'].includes(new URL(url).hostname)
          : new URL(url).origin === 'https://gateway.extensions.test');
        receipts.push({ mode, kind, sentBytes: init.body.byteLength, retry: init.headers.get('grpc-previous-rpc-attempts') !== null });
        return peer(fetches, init);
      } },
    });
    transports.push(transport);
    const client = (target = 'first.extensions.test', auth = transport.channelCredentials) => {
      const value = new Client(target, auth, transport.grpcOptions()); clients.push(value); return value;
    };
    return { transport, client, fetches: () => fetches };
  }
  function unary(client) {
    rpcCount++; const callbacks = [], statuses = [];
    const surface = client.makeUnaryRequest(method, serialize, deserialize, payload, new Metadata(), { deadline: Date.now() + 5000 },
      (error, value) => callbacks.push({ error, value }));
    const done = new Promise(resolve => surface.on('status', status => { statuses.push(status); resolve(status); }));
    return { surface, callbacks, statuses, done };
  }
  async function complete(call, code) {
    const status = await call.done; await sleep(0);
    assert.equal(status.code, code); assert.equal(call.statuses.length, 1); assert.equal(call.callbacks.length, 1);
    assert.equal(call.callbacks[0].error?.code ?? 0, code);
    if (code === 0) assert.equal(call.callbacks[0].value, reply);
    return status;
  }
  function record(mode, kind, events, expectedCodes, extra = {}) {
    const starts = events.filter(event => event.type === 'call-start'); assert.equal(starts.length, expectedCodes.length);
    const calls = starts.map((start, index) => {
      const selected = events.filter(event => event.logicalCallId === start.logicalCallId);
      const ends = selected.filter(event => event.type === 'call-end'), end = ends[0];
      assert.equal(ends.length, 1); assert.equal(selected.at(-1), end); assert.equal(end.statusCode, expectedCodes[index]);
      assert.ok(selected.every(event => Object.isFrozen(event)));
      const attempts = selected.filter(event => event.type === 'attempt-end');
      assert.equal(attempts.length, end.attemptCount);
      assert.equal(selected.filter(event => event.type === 'fetch-start').length, end.fetchCount);
      assert.equal(selected.filter(event => event.type === 'auth-end').length, end.attemptCount);
      return { logicalCallId: start.logicalCallId, code: end.statusCode, statuses: 1, callbacks: 1, terminalLast: true,
        attempts: end.attemptCount, fetches: end.fetchCount, attemptFetches: attempts.map(event => event.fetchStarted),
        attemptCodes: attempts.map(event => event.statusCode),
        throttled: selected.filter(event => event.type === 'retry-throttled').length,
        scheduled: selected.filter(event => event.type === 'retry-scheduled').length };
    });
    results.push({ mode, kind, calls, ...extra });
  }
  try {
    for (const mode of ['cloudflare', 'grpc-web']) {
      {
        const events = []; let succeeds = false;
        const peer = () => response(succeeds ? 0 : 14);
        const shared = create(mode, 'shared-budget', events, peer), isolated = create(mode, 'shared-budget', events, peer);
        const a = shared.client(), b = shared.client(), other = shared.client('other.extensions.test'), separate = isolated.client();
        const tokens = [];
        await complete(unary(a), 14); tokens.push(shared.transport.retryUsage('FIRST.extensions.test:443').tokens);
        await complete(unary(b), 14); tokens.push(shared.transport.retryUsage('first.extensions.test').tokens);
        await complete(unary(other), 14); tokens.push(shared.transport.retryUsage('first.extensions.test').tokens);
        await complete(unary(separate), 14); tokens.push(shared.transport.retryUsage('first.extensions.test').tokens);
        assert.equal(shared.transport.retryUsage('other.extensions.test').tokens, 2);
        assert.equal(isolated.transport.retryUsage('first.extensions.test').tokens, 2);
        succeeds = true;
        for (const client of [a, b, a, b]) await complete(unary(client), 0);
        tokens.push(shared.transport.retryUsage('first.extensions.test').tokens);
        succeeds = false; await complete(unary(a), 14); tokens.push(shared.transport.retryUsage('first.extensions.test').tokens);
        assert.deepEqual(tokens, [2, 1, 1, 1, 4, 2]);
        assert.ok(Object.isFrozen(shared.transport.retryUsage('first.extensions.test')));
        assert.equal(shared.fetches() + isolated.fetches(), 13);
        record(mode, 'shared-budget', events, [14, 14, 14, 14, 0, 0, 0, 0, 14], {
          tokens, otherEndpointTokens: 2, otherFactoryTokens: 2, immutableUsage: true, recovered: true });
      }
      {
        const events = []; let release; const gate = new Promise(resolve => { release = resolve; }); let authCalls = 0;
        const shared = create(mode, 'concurrent-failures', events, async () => { await gate; return response(14); },
          { retryPolicy: { ...policy, initialBackoffMs: 50 }, retryThrottling: { maxTokens: 4, tokenRatio: 0.1 } });
        const auth = credentials.combineChannelCredentials(shared.transport.channelCredentials,
          credentials.createFromMetadataGenerator((_options, done) => { authCalls++; done(null, new Metadata()); }));
        const client = shared.client(undefined, auth);
        const calls = Array.from({ length: 8 }, () => unary(client));
        await until(() => shared.fetches() === 8); release(); await Promise.all(calls.map(call => complete(call, 14)));
        assert.equal(shared.fetches(), 8); assert.equal(authCalls, 8);
        assert.deepEqual(shared.transport.retryUsage('first.extensions.test'), { tokens: 0, maxTokens: 4, tokenRatio: 0.1, retriesAllowed: false, suppressedRetries: 8 });
        record(mode, 'concurrent-failures', events, Array(8).fill(14), { tokens: 0, authCalls, suppressedRetries: 8 });
      }
      {
        const events = []; let release, authCalls = 0;
        const shared = create(mode, 'pending-auth', events, count => response(14, count > 1 ? 'grpc-retry-pushback-ms: -1\r\n' : ''));
        const auth = credentials.combineChannelCredentials(shared.transport.channelCredentials,
          credentials.createFromMetadataGenerator((_options, done) => { authCalls++; if (authCalls === 2) release = done; else done(null, new Metadata()); }));
        const first = unary(shared.client(undefined, auth)); await until(() => typeof release === 'function');
        await complete(unary(shared.client()), 14);
        assert.equal(shared.transport.retryUsage('first.extensions.test').tokens, 2);
        release(null, new Metadata()); await complete(first, 14);
        assert.equal(shared.fetches(), 2); assert.equal(shared.transport.retryUsage('first.extensions.test').tokens, 2);
        assert.equal(shared.transport.retryUsage('first.extensions.test').suppressedRetries, 1);
        record(mode, 'pending-auth', events, [14, 14], { tokens: 2, authCalls, suppressedRetries: 1, lateRetryFetches: 0 });
      }
      {
        const events = []; let wire = rich();
        const shared = create(mode, 'rich-status', events, () => response(7, `grpc-status-details-bin: ${wire.toString('base64')}\r\n`));
        const client = shared.client(), diagnostics = [];
        const valid = await complete(unary(client), 7);
        const decoded = decodeGrpcStatusDetails(valid, { decoders: { 'type.example/First': bytes => { const first = bytes[0]; bytes.fill(99); return first; } } });
        assert.equal(decoded.status, valid); assert.equal(decoded.details.code, 7); assert.equal(decoded.details.details[0].decoded, 1);
        assert.deepEqual([...decoded.details.details[0].value], [1, 2]); assert.deepEqual([...decoded.details.details[1].value], [3]);
        assert.ok(Object.isFrozen(decoded) && Object.isFrozen(decoded.details) && Object.isFrozen(decoded.details.details));
        valid.metadata.get('grpc-status-details-bin')[0].fill(0); assert.deepEqual([...decoded.details.details[0].value], [1, 2]);
        diagnostics.push('valid');
        wire = Buffer.from([0x1a, 0x03, 0x12]); const invalid = await complete(unary(client), 7);
        const malformed = decodeGrpcStatusDetails(invalid); assert.equal(malformed.status, invalid); assert.equal(malformed.diagnostic, 'invalid-protobuf'); diagnostics.push(malformed.diagnostic);
        wire = rich(14); const mismatch = await complete(unary(client), 7); let invocations = 0;
        const wrong = decodeGrpcStatusDetails(mismatch, { decoders: { 'type.example/First': () => { invocations++; } } });
        assert.equal(wrong.status, mismatch); assert.equal(wrong.diagnostic, 'code-mismatch'); assert.equal(invocations, 0); diagnostics.push(wrong.diagnostic);
        wire = rich(); const failure = await complete(unary(client), 7);
        const failed = decodeGrpcStatusDetails(failure, { decoders: { 'type.example/First': () => { throw new Error('controlled'); }, 'type.example/Second': () => Promise.reject(new Error('controlled')) } });
        assert.equal(failed.status, failure); assert.deepEqual(failed.details.details.map(value => value.diagnostic), ['decoder-failed', 'decoder-failed']);
        diagnostics.push(...failed.details.details.map(value => value.diagnostic));
        for (const options of [{ maxBytes: 1 }, { maxDetails: 1 }]) { const limited = decodeGrpcStatusDetails(failure, options); assert.equal(limited.status, failure); assert.equal(limited.diagnostic, 'limit-exceeded'); diagnostics.push(limited.diagnostic); }
        const repeated = { ...failure, metadata: failure.metadata.clone() }; repeated.metadata.add('grpc-status-details-bin', rich());
        const multiple = decodeGrpcStatusDetails(repeated); assert.equal(multiple.status, repeated); assert.equal(multiple.diagnostic, 'multiple-values'); diagnostics.push(multiple.diagnostic);
        const absent = { ...failure, metadata: new Metadata() }, missing = decodeGrpcStatusDetails(absent);
        assert.equal(missing.status, absent); assert.equal(missing.diagnostic, 'absent'); diagnostics.push(missing.diagnostic);
        await sleep(0);
        record(mode, 'rich-status', events, [7, 7, 7, 7], { diagnostics, originalStatusPreserved: true, ownedValues: true, decoderMismatchCalls: invocations, frozenResults: true });
      }
    }
    await until(() => transports.every(transport => transport.resourceUsage().bufferedBytes === 0));
    assert.ok(transports.every(transport => ['activeCalls', 'queuedCalls', 'bufferedBytes'].every(key => transport.resourceUsage()[key] === 0)), 'all adapter resources idle');
    const cleanup = bodies.map(body => body.state());
    assert.equal(cleanup.length, receipts.length);
    assert.ok(cleanup.every(value => !value.bodyLocked && (value.ended || value.cancellations === 1)));
    const calls = results.flatMap(value => value.calls);
    assert.equal(calls.length, rpcCount); assert.equal(calls.reduce((sum, value) => sum + value.fetches, 0), receipts.length);
    return { status: 'passed', results, caseCount: results.length, rpcCount, fetchCount: receipts.length,
      attemptCount: calls.reduce((sum, call) => sum + call.attempts, 0), cleanup, receipts,
      resourcesIdle: true, moduleIdentity: true, activeClientCalls: clients.reduce((sum, client) => sum + client.getChannel().activeCallCount(), 0) };
  } finally { clients.forEach(client => client.close()); }
}
export default { async fetch() {
  try { return Response.json(await run()); }
  catch (error) { return Response.json({ status: 'failed', diagnostic: error.message, stack: error.stack }, { status: 500 }); }
} };
