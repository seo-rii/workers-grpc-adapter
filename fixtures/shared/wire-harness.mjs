import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { summary } from './wire-vectors.mjs';
import { frameCases } from './wire-frames.mjs';
import { metadataCases } from './wire-metadata.mjs';
const zero = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function metadata(value) {
  return Object.fromEntries([...value.entries()].map(([key, values]) => [key, values.map(item => Buffer.isBuffer(item) ? { hex: item.toString('hex') } : item)]));
}
function compact(value) {
  if (typeof value === 'string' && value.length > 128) return summary(Buffer.from(value));
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
  return value;
}
function selected(actual, expected) {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], Array.isArray(value) ? value : [value], `metadata ${key}`);
}
function headerBytes(headers) { return [...headers].reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value) + 32, 0); }

export async function runWireCatalog({ grpc, createWorkersGrpcTransport, runtime, mode }) {
  const rows = [];
  for (const spec of [...frameCases(), ...metadataCases(mode)]) {
    let fetchCount = 0, call, body, pulls = 0, cancels = 0, sourceBytes = 0, sourceChunks = 0, sourceEnded = false;
    let writeCompletions = 0, requestHeaders = null, terminalTime = 0, callbackCount = 0, callbackCode, trailerBudget = null;
    const initial = [], statuses = [], decoded = [], delivered = [], errors = [], events = [], maxExecution = { ...zero };
    const sample = () => {
      if (!call) return;
      const execution = call.executionDiagnostics();
      assert.ok(execution.activePumps <= 1 && execution.pendingMessages <= 1 && execution.parserAssemblies <= 1);
      for (const key of Object.keys(maxExecution)) maxExecution[key] = Math.max(maxExecution[key], execution[key]);
    };
    const transport = createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'wire.test': 'https://gateway.wire.test' } } : {}),
      resourceLimits: { readableHighWaterMark: 1, maxBufferedBytes: 40 * 1024 * 1024 }, ...spec.config,
      fetcher: { async fetch(url, init) {
        fetchCount++;
        assert.equal(new URL(url).hostname, mode === 'cloudflare' ? 'wire.test' : 'gateway.wire.test');
        assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
        assert.equal(init.headers.has('grpc-previous-rpc-attempts'), false);
        requestHeaders = new Headers(init.headers);
        for (const [key, value] of Object.entries(spec.expectRequestHeaders ?? {})) assert.equal(requestHeaders.get(key), value);
        const source = spec.chunks();
        const iterator = source[Symbol.iterator]();
        body = new ReadableStream({ pull(controller) {
          pulls++; const next = iterator.next();
          if (next.done) { sourceEnded = true; controller.close(); }
          else {
            sourceBytes += next.value.byteLength; sourceChunks++;
            if (spec.expectFinalTrailerBudget !== undefined) {
              // Boundary fixtures contain one complete trailer frame. Measure
              // its transmitted fields independently of the adapter parser.
              const bytes = Buffer.from(next.value);
              assert.equal(bytes[0], 128); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
              const lines = bytes.subarray(5).toString('ascii').split('\r\n');
              assert.equal(lines.pop(), '');
              trailerBudget = lines.reduce((total, line) => {
                const colon = line.indexOf(':'); assert.ok(colon > 0);
                return total + Buffer.byteLength(line.slice(0, colon)) + Buffer.byteLength(line.slice(colon + 1).trim()) + 32;
              }, 0);
            }
            controller.enqueue(next.value);
          }
        }, cancel() { cancels++; iterator.return?.(); } }, { highWaterMark: 0 });
        return new Response(body, { status: spec.httpStatus ?? 200,
          headers: spec.headers ?? [['content-type', 'application/grpc-web+proto']] });
      } } });
    const client = new grpc.Client('wire.test', transport.channelCredentials, { ...transport.grpcOptions(), ...spec.channelOptions });
    const channel = client.getChannel(), create = channel.createCallForMethod;
    channel.createCallForMethod = function (...args) {
      call = create.apply(this, args); const send = call.sendMessageWithContext;
      call.sendMessageWithContext = function (context, message) {
        const callback = context.callback;
        return send.call(this, { ...context, callback(error) { writeCompletions++; callback?.(error); } }, message);
      }; return call;
    };
    const deserialize = bytes => { sample(); const result = summary(bytes); decoded.push(result); return result; };
    const requestMetadata = spec.requestMetadata?.(grpc) ?? new grpc.Metadata();
    let timer;
    try {
      const finished = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`WIRE_CASE_TIMEOUT ${spec.id}/${spec.variant}`)), 20000);
        const args = ['/wire.Test/Call', bytes => bytes, deserialize, Buffer.from([7]), requestMetadata, { deadline: Infinity }];
        const surface = spec.kind === 'stream' ? client.makeServerStreamRequest(...args)
          : client.makeUnaryRequest(...args, (error, value) => {
            callbackCount++; callbackCode = error?.code ?? 0; if (value !== undefined) delivered.push(value); events.push('callback');
          });
        surface.on('metadata', value => { initial.push(metadata(value)); events.push('metadata'); });
        surface.on('data', value => { delivered.push(value); events.push('data'); });
        surface.on('error', error => { errors.push(error.code); events.push('error'); });
        surface.on('status', value => { sample(); terminalTime = Date.now(); statuses.push({ code: value.code, details: value.details, metadata: metadata(value.metadata) }); events.push('status'); resolve(); });
      });
      await finished;
      for (let i = 0; i < 100 && Object.keys(zero).some(key => call.executionDiagnostics()[key] !== 0); i++) await tick();
      // Flush public stream events without imposing an elapsed-time assertion.
      await tick(); clearTimeout(timer);
      assert.equal(statuses.length, 1); assert.equal(statuses[0].code, spec.expected.code, `${spec.id}/${spec.variant} status`);
      if (spec.expected.details !== undefined) assert.equal(statuses[0].details, spec.expected.details);
      assert.deepEqual(decoded, spec.expected.messages, `${spec.id}/${spec.variant} decoded bytes`);
      assert.equal(callbackCount, spec.kind === 'stream' ? 0 : 1);
      if (spec.kind !== 'stream') assert.equal(callbackCode, spec.expected.code);
      else assert.deepEqual(errors, spec.expected.code ? [spec.expected.code] : []);
      assert.deepEqual(delivered, spec.kind === 'stream' || spec.expected.code === 0 ? spec.expected.messages : []);
      assert.equal(fetchCount, spec.expectFetchCount ?? 1); assert.equal(writeCompletions, 1);
      assert.deepEqual(call.executionDiagnostics(), zero); assert.equal(channel.activeCallCount(), 0);
      assert.deepEqual(call.diagnostics(), { terminal: true, fetchCount, requestBytes: 0, responseBytes: 0, timerActive: false });
      const resources = transport.resourceUsage();
      for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(resources[key], 0);
      assert.ok(!body || !body.locked);
      if (body) assert.equal(cancels, sourceEnded ? 0 : 1, `${spec.id}/${spec.variant} response disposal`);
      if (spec.expectInitial) {
        assert.equal(initial.length, spec.expectInitial.length);
        initial.forEach((value, i) => selected(value, spec.expectInitial[i]));
      }
      if (spec.expectTrailing ?? spec.expected.metadata) selected(statuses[0].metadata, spec.expectTrailing ?? spec.expected.metadata);
      if (spec.expectFinalRequestHeaderBudget !== undefined && requestHeaders) assert.equal(headerBytes(requestHeaders), spec.expectFinalRequestHeaderBudget);
      if (spec.expectFinalHeaderBudget !== undefined) assert.equal(headerBytes(new Headers(spec.headers)), spec.expectFinalHeaderBudget);
      if (spec.expectFinalTrailerBudget !== undefined) assert.equal(trailerBudget, spec.expectFinalTrailerBudget);
      rows.push({ id: spec.id, variant: spec.variant, kind: spec.kind ?? 'unary', status: 'passed', catalogMatch: spec.catalogMatch !== false,
        fetchCount, callbackCount, callbackCode: callbackCode ?? null, writeCompletions, initial: compact(initial), statuses: compact(statuses), decoded, delivered, errors, events,
        source: { pulls, chunks: sourceChunks, bytes: sourceBytes, cancels, readerUnlocked: !body?.locked }, maxExecution,
        diagnostics: call.diagnostics(), execution: call.executionDiagnostics(), resources, activeCalls: channel.activeCallCount(),
        requestHeaders: requestHeaders ? compact(Object.fromEntries(requestHeaders)) : null,
        budgets: { header: spec.expectFinalHeaderBudget === undefined ? null : headerBytes(new Headers(spec.headers)), trailer: trailerBudget,
          request: spec.expectFinalRequestHeaderBudget === undefined ? null : headerBytes(requestHeaders) }, cleanupBeforeClose: true });
      assert.ok(terminalTime > 0);
    } finally { clearTimeout(timer); client.close(); }
  }
  return { runtime, mode, status: 'passed', rows };
}
