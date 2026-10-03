import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { runDeadlineSchedules } from './lifecycle-deadlines.mjs';
import { runTerminalSchedules } from './lifecycle-terminals.mjs';

// Independent binary peer: deliberately does not import the adapter's codec.
export function frame(payload, flags = 0) {
  const bytes = Buffer.from(payload), result = Buffer.alloc(5 + bytes.length);
  result[0] = flags; result.writeUInt32BE(bytes.length, 1); bytes.copy(result, 5);
  return result;
}
export function trailers(code = 0) { return frame(Buffer.from(`grpc-status: ${code}\r\n`), 128); }
const zeroExecution = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
  parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };

async function runPreparationSchedules(h, mode) {
  const { grpc, createWorkersGrpcTransport, drain } = h, rows = [];
  const method = '/lifecycle.Test/Unary';
  function setup(options = {}) {
    const receipts = [], calls = [], statuses = [], messages = [], writes = [];
    let auths = 0, releaseAuth;
    const auth = grpc.credentials.createFromMetadataGenerator((_input, done) => {
      auths++; releaseAuth = () => done(null, new grpc.Metadata());
    });
    const transport = createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'lifecycle.test': 'https://gateway.lifecycle.test' } } : {}),
      resourceLimits: { maxBufferedBytes: 65536 },
      fetcher: { async fetch(url, init) {
        const request = Buffer.from(init.body);
        assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
        assert.equal(new URL(url).hostname, mode === 'cloudflare' ? 'lifecycle.test' : 'gateway.lifecycle.test');
        assert.equal(request[0], 0); assert.equal(request.readUInt32BE(1), request.length - 5);
        const entry = { payload: [...request.subarray(5)], cancelled: 0, body: null, retries: init.headers.has('grpc-previous-rpc-attempts') };
        const body = new ReadableStream({ start(controller) {
          if (options.http === undefined) controller.enqueue(Buffer.concat([frame(Buffer.from('ok')), trailers()]));
          else controller.enqueue(Buffer.from('not grpc'));
          controller.close();
        }, cancel() { entry.cancelled++; } });
        entry.body = body; receipts.push(entry);
        return new Response(body, { status: options.http ?? 200,
          headers: options.http === undefined ? { 'content-type': 'application/grpc-web+proto' } : {} });
      } },
    });
    const client = new grpc.Client('lifecycle.test', transport.channelCredentials, transport.grpcOptions());
    const channel = client.getChannel();
    const call = channel.createCallForMethod(method, false, options.stream ?? false,
      { deadline: Infinity, credentials: auth });
    calls.push(call);
    const start = () => call.start(new grpc.Metadata(), { onReceiveMetadata() {},
      onReceiveMessage(value) { assert.equal(statuses.length, 0, 'no data after terminal'); messages.push(value.toString()); },
      onReceiveStatus(value) { statuses.push(value.code); } });
    const send = bytes => call.sendMessageWithContext({ callback(error) { writes.push(error?.message ?? null); } }, bytes);
    async function complete(id, variant, expected = 0) {
      for (let i = 0; i < 20 && (statuses.length === 0 || call.executionDiagnostics().activePumps); i++) await drain();
      await drain();
      assert.deepEqual(statuses, [expected]); assert.deepEqual(writes, [null]);
      assert.equal(receipts.length, 1); assert.equal(receipts[0].retries, false);
      assert.equal(channel.activeCallCount(), 0);
      assert.deepEqual(call.executionDiagnostics(), zeroExecution);
      assert.equal(transport.resourceUsage().bufferedBytes, 0);
      assert.equal(transport.resourceUsage().activeCalls, 0);
      assert.equal(transport.resourceUsage().queuedCalls, 0);
      assert.equal(call.diagnostics().timerActive, false);
      assert.ok(receipts.every(item => !item.body.locked));
      const row = { id, variant, mode, status: 'passed', authCount: auths, fetchCount: receipts.length,
        terminalCount: statuses.length, code: statuses[0], writeCompletions: writes.length,
        messages: [...messages], activeCalls: channel.activeCallCount(), diagnostics: call.diagnostics(),
        execution: call.executionDiagnostics(), resources: transport.resourceUsage(),
        requestPayload: receipts[0].payload, replayCount: 0, readerUnlocked: true, unhandledRejections: h.unhandled() };
      rows.push(row); return row;
    }
    return { call, client, channel, start, send, complete, receipts, statuses, messages, writes,
      releaseAuth() { assert.equal(typeof releaseAuth, 'function'); releaseAuth(); } };
  }
  for (const variant of ['half-close-before-auth', 'auth-before-message']) {
    const p = setup();
    try {
      p.start(); p.call.startRead(); await drain();
      if (variant === 'auth-before-message') { p.releaseAuth(); await drain(); }
      p.send(Buffer.from([1, 2, 3])); await drain();
      assert.equal(p.receipts.length, 0, 'no fetch before half-close');
      p.call.halfClose(); await drain();
      if (variant === 'half-close-before-auth') {
        assert.equal(p.receipts.length, 0, 'no fetch before auth'); p.releaseAuth();
      }
      const row = await p.complete(variant === 'half-close-before-auth' ? 'LIFE-002' : 'LIFE-003', variant);
      row.fetchBeforeReady = 0; assert.deepEqual(row.requestPayload, [1, 2, 3]);
    } finally { p.client.close(); }
  }
  for (const [variant, payload] of [['empty-request', Buffer.alloc(0)], ['caller-buffer-mutation', Buffer.from([10, 20, 30])]]) {
    const p = setup(), original = [...payload];
    try {
      p.start(); p.call.startRead(); p.send(payload); payload.fill(255); p.call.halfClose();
      await drain(); assert.equal(p.receipts.length, 0); p.releaseAuth();
      const row = await p.complete(variant === 'empty-request' ? 'LIFE-004' : 'LIFE-018', variant);
      assert.deepEqual(row.requestPayload, original); row.acceptedBytesPreserved = true;
    } finally { p.client.close(); }
  }
  for (const [http, code] of [[400, 13], [401, 16], [403, 7], [404, 12], [429, 14], [502, 14], [503, 14], [504, 14], [200, 2]]) {
    const p = setup({ http });
    try {
      p.start(); p.call.startRead(); p.send(Buffer.from([7])); p.call.halfClose(); await drain(); p.releaseAuth();
      const row = await p.complete('WIRE-018', `http-${http}`, code);
      assert.deepEqual(row.messages, []); row.httpStatus = http;
    } finally { p.client.close(); }
  }
  // The low-level callback control above measures write completion; these two
  // extra rows verify caller Buffer ownership through the public Client API.
  for (const stream of [false, true]) {
    let releaseAuth, fetchCount = 0, callbackCount = 0;
    const auth = grpc.credentials.createFromMetadataGenerator((_input, done) => { releaseAuth = () => done(null, new grpc.Metadata()); });
    const payload = Buffer.from([42, 43]), expected = frame(payload), messages = [], statuses = [];
    const transport = createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'lifecycle.test': 'https://gateway.lifecycle.test' } } : {}),
      fetcher: { async fetch(_url, init) {
        fetchCount++; assert.deepEqual(Buffer.from(init.body), expected);
        return new Response(Buffer.concat([frame(Buffer.from('ok')), trailers()]), { headers: { 'content-type': 'application/grpc-web+proto' } });
      } },
    });
    const client = new grpc.Client('lifecycle.test', transport.channelCredentials, transport.grpcOptions());
    try {
      const args = [method, bytes => bytes, bytes => bytes.toString(), payload, { credentials: auth, deadline: Infinity }];
      const surface = stream ? client.makeServerStreamRequest(...args)
        : client.makeUnaryRequest(...args, (error, value) => { assert.ifError(error); callbackCount++; messages.push(value); });
      payload.fill(255);
      surface.on('status', value => statuses.push(value.code));
      if (stream) { surface.on('data', value => messages.push(value)); surface.on('error', error => { throw error; }); }
      await drain(); assert.equal(fetchCount, 0); releaseAuth();
      for (let i = 0; i < 20 && statuses.length === 0; i++) await drain();
      await drain();
      let call = surface; const seen = new Set();
      while (!call.executionDiagnostics && !seen.has(call)) { seen.add(call); call = call.call ?? call.nextCall; assert.ok(call); }
      assert.deepEqual(statuses, [0]); assert.deepEqual(messages, ['ok']); assert.equal(fetchCount, 1);
      assert.equal(callbackCount, stream ? 0 : 1); assert.deepEqual(call.executionDiagnostics(), zeroExecution);
      assert.equal(client.getChannel().activeCallCount(), 0); assert.equal(transport.resourceUsage().bufferedBytes, 0);
      rows.push({ id: 'LIFE-018', variant: stream ? 'public-server-stream-buffer' : 'public-unary-buffer', mode,
        status: 'passed', acceptedBytesPreserved: true, fetchCount, terminalCount: statuses.length, callbackCount,
        execution: call.executionDiagnostics(), diagnostics: call.diagnostics(), resources: transport.resourceUsage(),
        activeCalls: 0, unhandledRejections: h.unhandled() });
    } finally { client.close(); }
  }
  return rows;
}

export async function runLifecycleSuite(bindings, runtime) {
  // Capture the real timer before deadline cases replace global timer functions.
  const schedule = globalThis.setTimeout.bind(globalThis);
  const h = { ...bindings, frame, trailers, drain: () => new Promise(resolve => schedule(resolve, 0)) };
  const rows = [];
  for (const mode of ['cloudflare', 'grpc-web']) {
    rows.push(...await runPreparationSchedules(h, mode));
    rows.push(...await runDeadlineSchedules(h, mode));
    rows.push(...await runTerminalSchedules(h, mode));
  }
  await h.drain(); await h.drain(); assert.equal(h.unhandled(), 0);
  return { runtime, status: 'passed', rows, unhandledRejections: h.unhandled() };
}
