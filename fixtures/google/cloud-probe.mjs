// Temporary deployed probe. All outbound targets and RPC payloads are fixed.
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { Client } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { OAuth2Client } from 'google-auth-library';
import { protobufFromJSON } from 'google-gax';
import schema from '@google-cloud/datastore/build/protos/protos.json';

const echo = 'wga deployed probe % / 한글';
const reason = 'wga probe % / 한글';
const field = (text, tag = 10) => {
  const bytes = Buffer.from(text);
  if (bytes.length >= 128) throw new Error('Probe payload too large');
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
};
const cases = {
  'cloudflare-unary': { mode: 'cloudflare', path: '/grpcbin.GRPCBin/DummyUnary', body: field(echo), count: 1 },
  'cloudflare-stream': { mode: 'cloudflare', path: '/grpcbin.GRPCBin/DummyServerStream', body: field(echo), stream: true, count: 10 },
  'cloudflare-error': { mode: 'cloudflare', path: '/grpcbin.GRPCBin/SpecificError', body: Buffer.concat([Buffer.from([8, 3]), field(reason, 18)]), code: 3 },
  'fallback-unary': { mode: 'grpc-web', path: '/connectrpc.eliza.v1.ElizaService/Say', body: field('Hello') },
  'fallback-stream': { mode: 'grpc-web', path: '/connectrpc.eliza.v1.ElizaService/Introduce', body: field('WGA probe'), stream: true },
};
async function bootstrap() {
  const authClient = new OAuth2Client();
  const options = { projectId: 'wga-offline-probe', authClient };
  const datastore = new Datastore({ ...options, fallback: false });
  const firestore = new Firestore({ ...options, preferRest: false });
  const secret = new SecretManagerServiceClient({ ...options, fallback: false });
  try {
    const entity = protobufFromJSON(schema).lookupType('google.datastore.v1.Entity');
    const input = entity.fromObject({ properties: { text: { stringValue: echo } } });
    const decoded = entity.decode(entity.encode(input).finish());
    const passed = decoded.properties.text.stringValue === echo && datastore.key(['Probe', 'never-written']).kind === 'Probe';
    return { passed, constructors: ['Datastore', 'Firestore', 'SecretManagerServiceClient', 'OAuth2Client'], staticProtobufRoundtrip: passed, googleApiCalled: false };
  } finally {
    await Promise.all([...[...datastore.clients_.values()].map(client => client.close()), firestore.terminate(), secret.close()]);
  }
}
async function rpc(test) {
  const transport = createWorkersGrpcTransport({
    ...(test.mode === 'cloudflare' ? { mode: 'cloudflare' } : { mode: 'grpc-web', endpoints: { 'eliza.probe.invalid:443': 'https://demo.connectrpc.com' } }),
    defaultTimeoutMs: 25000, transportMaxReceiveBytes: 1024 * 1024,
  });
  const client = new Client(test.mode === 'cloudflare' ? 'grpcb.in:443' : 'eliza.probe.invalid:443', transport.channelCredentials, transport.grpcOptions());
  const messages = [];
  let callbackCode = 0;
  const started = Date.now();
  try {
    const terminal = await new Promise(resolve => {
      const args = [test.path, value => value, value => value, test.body, { deadline: Date.now() + 25000 }];
      const call = test.stream
        ? client.makeServerStreamRequest(...args)
        : client.makeUnaryRequest(...args, (error, value) => { callbackCode = error?.code ?? 0; if (value) messages.push(value); });
      if (test.stream) call.on('data', value => { messages.push(value); if (messages.length > 20) call.cancel(); });
      call.on('error', error => { callbackCode = error.code; });
      call.on('status', resolve);
    });
    // Unary callbacks may run immediately after the status event.
    await Promise.resolve();
    const expectedCode = test.code ?? 0;
    const passed = terminal.code === expectedCode && callbackCode === expectedCode &&
      (test.code ? terminal.details === reason : messages.length > 0) &&
      (test.count === undefined || messages.length === test.count) &&
      (test.mode !== 'cloudflare' || test.code || messages.every(bytes => Buffer.from(bytes).equals(test.body)));
    return { passed: Boolean(passed), mode: test.mode, grpcStatus: terminal.code, callbackCode,
      details: terminal.details.slice(0, 240), messageCount: messages.length, elapsedMs: Date.now() - started };
  } finally { client.close(); }
}
async function raw() {
  const payload = field(echo);
  const frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
  const response = await fetch('https://grpcb.in/grpcbin.GRPCBin/DummyUnary', {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), body: frame,
    headers: { 'content-type': 'application/grpc-web+proto', accept: 'application/grpc-web+proto', 'x-grpc-web': '1' },
  });
  const reader = response.body?.getReader();
  let bytes = 0;
  if (reader) try {
    while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 1024 * 1024) throw new Error('Response limit'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return { httpStatus: response.status, contentType: response.headers.get('content-type'), grpcStatusHeader: response.headers.get('grpc-status'), responseBytes: bytes };
}
export default {
  async fetch(request, env) {
    const expected = env.WGA_TEST_KEY;
    const actual = request.headers.get('authorization') ?? '';
    const wanted = `Bearer ${expected}`;
    if (typeof expected !== 'string' || expected.length < 32 || request.method !== 'POST' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(wanted) || !timingSafeEqual(Buffer.from(actual), Buffer.from(wanted))) {
      return new Response('Not found', { status: 404 });
    }
    const name = new URL(request.url).pathname.slice('/protocol/'.length);
    if (name !== 'bootstrap' && name !== 'raw' && !Object.hasOwn(cases, name)) return new Response('Not found', { status: 404 });
    try {
      return Response.json(name === 'bootstrap' ? await bootstrap() : name === 'raw' ? await raw() : await rpc(cases[name]));
    } catch (error) {
      return Response.json({ passed: false, code: typeof error.code === 'number' ? error.code : 'PROBE_ERROR', name: error.name }, { status: 500 });
    }
  },
};
