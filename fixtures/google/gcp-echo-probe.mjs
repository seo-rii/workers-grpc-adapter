import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { Client, Metadata } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const field = (value, tag = 10) => {
  const bytes = Buffer.from(value);
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
};
const echo = field('wga deployed probe % / 한글');
const reason = 'wga probe % / 한글';
const cases = {
  unary: { method: 'DummyUnary', body: echo, count: 1 },
  stream: { method: 'DummyServerStream', body: echo, count: 10, stream: true },
  cancel: { method: 'DummyServerStream', body: echo, count: 1, stream: true, cancel: true, code: 1 },
  error: { method: 'SpecificError', body: Buffer.concat([Buffer.from([8, 3]), field(reason, 18)]), code: 3 },
};
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.run.app') || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
  return url;
}

// Probe-only, per-channel observation. These counters describe adapter-owned
// work and buffers, not the Worker heap or the native backend's cancellation.
async function recovery(client, transport, metadata, mode) {
  const channel = client.getChannel(), captured = [];
  const original = channel.createCallForMethod;
  channel.createCallForMethod = function(...args) {
    const call = original.apply(this, args);
    captured.push(call);
    return call;
  };
  const started = Date.now(), deadline = started + 20000, steps = [];
  const definitions = [['initial-unary', 'unary'], ['expected-error', 'error'],
    ['cancel-stream', 'cancel'], ['recovered-unary', 'unary']];
  try {
    for (const [id, name] of definitions) {
      const test = cases[name], start = Date.now();
      const step = { id, passed: false, statusCode: null, callbackCode: null,
        callbackCount: 0, errorCount: 0, statusCount: 0, messageCount: 0,
        messagesMatch: true, detailsMatch: true, fetchCount: 0, elapsedMs: 0 };
      const prior = captured.length;
      await new Promise(resolve => {
        const args = [`/grpcbin.GRPCBin/${test.method}`, value => value, value => value,
          test.body, metadata, { deadline }];
        const message = value => {
          step.messageCount++;
          step.messagesMatch &&= Buffer.from(value).equals(echo);
        };
        const call = test.stream ? client.makeServerStreamRequest(...args)
          : client.makeUnaryRequest(...args, (error, value) => {
            step.callbackCount++;
            step.callbackCode = error?.code ?? 0;
            if (value !== undefined) message(value);
          });
        if (test.stream) call.on('data', value => { message(value); call.cancel(); });
        call.on('error', error => {
          step.errorCount++;
          if (error.code !== 1 || !test.cancel) step.detailsMatch = false;
        });
        call.on('status', status => {
          step.statusCount++;
          step.statusCode = status.code;
          if (name === 'error') step.detailsMatch &&= status.details === reason;
          resolve();
        });
      });
      // Stream errors and cancellation unwinding can follow the status event.
      await new Promise(resolve => setTimeout(resolve, 0));
      step.fetchCount = captured.slice(prior).reduce((sum, call) => sum + call.diagnostics().fetchCount, 0);
      step.elapsedMs = Date.now() - start;
      steps.push(step);
    }
    const snapshot = () => {
      const usage = transport.resourceUsage();
      const cleanup = { beforeClose: true, channelOpen: channel.closed === false,
        channelActiveCalls: channel.activeCallCount(), activeCalls: usage.activeCalls,
        queuedCalls: usage.queuedCalls, bufferedBytes: usage.bufferedBytes,
        activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0, pendingWriteCallbacks: 0,
        parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0,
        requestBytes: 0, responseBytes: 0, timers: 0, nonterminalCalls: 0, capturedCalls: captured.length };
      for (const call of captured) {
        const state = call.diagnostics(), execution = call.executionDiagnostics();
        for (const key of ['activePumps', 'pendingMessages', 'pendingMessageBytes', 'pendingWriteCallbacks',
          'parserAssemblies', 'parserAssemblyBytes', 'runtimeChunkBytes']) cleanup[key] += execution[key];
        cleanup.requestBytes += state.requestBytes;
        cleanup.responseBytes += state.responseBytes;
        cleanup.timers += Number(state.timerActive);
        cleanup.nonterminalCalls += Number(!state.terminal);
      }
      return cleanup;
    };
    const idle = cleanup => cleanup.channelOpen && Object.entries(cleanup)
      .filter(([key]) => !['beforeClose', 'channelOpen', 'capturedCalls'].includes(key))
      .every(([, value]) => value === 0);
    let cleanup = snapshot();
    for (let turn = 0; !idle(cleanup) && turn < 100; turn++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      cleanup = snapshot();
    }
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index], stream = index === 2;
      step.passed = step.statusCode === [0, 3, 1, 0][index] && step.statusCount === 1 &&
        step.callbackCode === [0, 3, null, 0][index] && step.callbackCount === (stream ? 0 : 1) &&
        step.errorCount === (stream ? 1 : 0) && step.messageCount === [1, 0, 1, 1][index] &&
        step.messagesMatch && step.detailsMatch && step.fetchCount === 1;
    }
    return { schemaVersion: 1, name: 'recovery', mode,
      passed: steps.every(step => step.passed) && captured.length === 4 && idle(cleanup),
      clientCount: 1, steps, cleanup, elapsedMs: Date.now() - started };
  } finally {
    delete channel.createCallForMethod;
  }
}
export default {
  async fetch(request, env) {
    const key = env.WGA_TEST_KEY;
    const actual = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${key}`);
    if (typeof key !== 'string' || key.length < 32 || request.method !== 'POST' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return new Response('Not found', { status: 404 });
    const route = /^\/echo\/(cloudflare|grpc-web)\/(unary|stream|error|cancel|recovery|raw|raw-convert|raw-passthrough)$/.exec(new URL(request.url).pathname);
    if (!route) return new Response('Not found', { status: 404 });
    const [, mode, name] = route;
    if (name === 'recovery' && env.WGA_PROBE_MODE !== mode) return new Response('Not found', { status: 404 });
    let client;
    try {
      const native = origin(env.WGA_NATIVE_ORIGIN), gateway = origin(env.WGA_GATEWAY_ORIGIN);
      if (typeof env.WGA_GATEWAY_ID_TOKEN !== 'string' || env.WGA_GATEWAY_ID_TOKEN.length < 20) throw new Error('Missing token');
      const metadata = new Metadata();
      metadata.set('x-serverless-authorization', `Bearer ${env.WGA_GATEWAY_ID_TOKEN}`);
      if (mode === 'grpc-web') metadata.set('x-wga-upstream-authorization', `Bearer ${env.WGA_GATEWAY_ID_TOKEN}`);
      if (name.startsWith('raw')) {
        const head = Buffer.alloc(5); head.writeUInt32BE(echo.length, 1);
        const response = await fetch(`${mode === 'cloudflare' ? native.origin : gateway.origin}/grpcbin.GRPCBin/DummyUnary`, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000),
          headers: { ...metadata.getMap(), 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
          body: Buffer.concat([head, echo]),
          ...(name === 'raw' ? {} : { cf: { grpcWeb: name.slice(4) } }),
        });
        const result = { httpStatus: response.status, contentType: response.headers.get('content-type'), grpcStatusHeader: response.headers.get('grpc-status'),
          requestedConversion: name === 'raw' ? 'default' : name.slice(4), messageFrames: 0, trailerFrames: 0, grpcWebStatuses: [], echoMatches: false, grpcWebValid: false };
        // Keep only protocol assertions, never remote body text or credentials.
        const chunks = [];
        let length = 0;
        const reader = response.body?.getReader();
        if (reader) try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > 65536) { result.bodyLimitExceeded = true; break; }
            chunks.push(Buffer.from(next.value));
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
        if (result.bodyLimitExceeded) return Response.json(result);
        const bytes = Buffer.concat(chunks);
        let offset = 0, malformed = false;
        while (offset < bytes.length) {
          if (bytes.length - offset < 5) { malformed = true; break; }
          const flag = bytes[offset], size = bytes.readUInt32BE(offset + 1);
          offset += 5;
          if (![0, 128].includes(flag) || size > bytes.length - offset || result.trailerFrames) { malformed = true; break; }
          const frame = bytes.subarray(offset, offset + size); offset += size;
          if (flag === 0) { result.messageFrames++; result.echoMatches = frame.equals(echo); }
          else {
            result.trailerFrames++;
            result.grpcWebStatuses = [...frame.toString('ascii').matchAll(/(?:^|\r\n)grpc-status:[ \t]*(\d+)(?=\r\n)/g)].map(match => Number(match[1]));
          }
        }
        result.grpcWebValid = response.status === 200 && /^application\/grpc-web(?:\+proto)?(?:;|$)/i.test(result.contentType ?? '') &&
          !malformed && result.messageFrames === 1 && result.echoMatches && result.trailerFrames === 1 &&
          result.grpcWebStatuses.length === 1 && result.grpcWebStatuses[0] === 0;
        return Response.json(result);
      }
      const transport = createWorkersGrpcTransport({ ...(mode === 'cloudflare' ? { mode } : { mode, endpoints: { [`${native.hostname}:443`]: gateway.origin } }), defaultTimeoutMs: 25000, transportMaxReceiveBytes: 1024 * 1024 });
      client = new Client(`${native.hostname}:443`, transport.channelCredentials, transport.grpcOptions());
      if (name === 'recovery') return Response.json(await recovery(client, transport, metadata, mode));
      const test = cases[name], messages = [];
      let callbackCode = 0;
      const started = Date.now();
      const terminal = await new Promise(resolve => {
        const args = [`/grpcbin.GRPCBin/${test.method}`, value => value, value => value, test.body, metadata, { deadline: Date.now() + 25000 }];
        const call = test.stream ? client.makeServerStreamRequest(...args) : client.makeUnaryRequest(...args, (error, value) => { callbackCode = error?.code ?? 0; if (value) messages.push(value); });
        if (test.stream) call.on('data', value => { messages.push(value); if (test.cancel || messages.length > 10) call.cancel(); });
        call.on('error', error => { callbackCode = error.code; });
        call.on('status', resolve);
      });
      await Promise.resolve();
      const passed = terminal.code === (test.code ?? 0) && callbackCode === (test.code ?? 0) &&
        (test.code && !test.cancel ? terminal.details === reason && messages.length === 0 : messages.length === test.count && messages.every(value => Buffer.from(value).equals(echo)));
      return Response.json({ mode, name, passed, grpcStatus: terminal.code, callbackCode, messageCount: messages.length,
        diagnostic: /^WGA_[A-Z_]+$/.test(terminal.details) ? terminal.details : undefined, elapsedMs: Date.now() - started });
    } catch { return Response.json({ mode, name, passed: false, code: 'ECHO_PROBE_ERROR' }, { status: 500 }); }
    finally { client?.close(); }
  },
};
