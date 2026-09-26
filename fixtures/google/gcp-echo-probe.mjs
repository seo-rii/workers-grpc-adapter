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
  error: { method: 'SpecificError', body: Buffer.concat([Buffer.from([8, 3]), field(reason, 18)]), code: 3 },
};
function origin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.run.app') || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin');
  return url;
}
export default {
  async fetch(request, env) {
    const key = env.WGA_TEST_KEY;
    const actual = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from(`Bearer ${key}`);
    if (typeof key !== 'string' || key.length < 32 || request.method !== 'POST' || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return new Response('Not found', { status: 404 });
    const route = /^\/echo\/(cloudflare|grpc-web)\/(unary|stream|error|raw|raw-convert|raw-passthrough)$/.exec(new URL(request.url).pathname);
    if (!route) return new Response('Not found', { status: 404 });
    const [, mode, name] = route;
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
      const test = cases[name], messages = [];
      let callbackCode = 0;
      const started = Date.now();
      const terminal = await new Promise(resolve => {
        const args = [`/grpcbin.GRPCBin/${test.method}`, value => value, value => value, test.body, metadata, { deadline: Date.now() + 25000 }];
        const call = test.stream ? client.makeServerStreamRequest(...args) : client.makeUnaryRequest(...args, (error, value) => { callbackCode = error?.code ?? 0; if (value) messages.push(value); });
        if (test.stream) call.on('data', value => { messages.push(value); if (messages.length > 10) call.cancel(); });
        call.on('error', error => { callbackCode = error.code; });
        call.on('status', resolve);
      });
      await Promise.resolve();
      const passed = terminal.code === (test.code ?? 0) && callbackCode === (test.code ?? 0) &&
        (test.code ? terminal.details === reason && messages.length === 0 : messages.length === test.count && messages.every(value => Buffer.from(value).equals(echo)));
      return Response.json({ mode, name, passed, grpcStatus: terminal.code, callbackCode, messageCount: messages.length,
        diagnostic: /^WGA_[A-Z_]+$/.test(terminal.details) ? terminal.details : undefined, elapsedMs: Date.now() - started });
    } catch { return Response.json({ mode, name, passed: false, code: 'ECHO_PROBE_ERROR' }, { status: 500 }); }
    finally { client?.close(); }
  },
};
