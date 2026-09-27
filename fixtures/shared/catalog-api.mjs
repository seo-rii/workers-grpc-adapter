import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
export const path = '/catalog.api.nested.Echo/Unary';
export const sleep = () => new Promise(resolve => setTimeout(resolve, 0));
export function serialize(value) {
  const text = Buffer.from(value.text); assert.ok(text.length < 128);
  return Buffer.concat([Buffer.from([10, text.length]), text]);
}
export function deserialize(bytes) {
  if (!bytes.length) return { text: '' };
  if (bytes[0] !== 10 || bytes[1] !== bytes.length - 2) throw new Error('catalog invalid protobuf');
  return { text: bytes.subarray(2).toString() };
}
export function frame(bytes, flag = 0) {
  const head = Buffer.alloc(5); head[0] = flag; head.writeUInt32BE(bytes.length, 1); return Buffer.concat([head, bytes]);
}
export const definition = { unary: { path, requestStream: false, responseStream: false,
  requestSerialize: serialize, requestDeserialize: deserialize, responseSerialize: serialize,
  responseDeserialize: deserialize, originalName: 'Unary' } };
export function options(grpc, id, trace) {
  const intercept = name => (opts, next) => {
    trace.push(`${name}:construct`);
    return new grpc.InterceptingCall(next(opts), {
      start(metadata, listener, done) { trace.push(`${name}:start`); metadata.add('x-order', name); done(metadata, {
        onReceiveMetadata(value, send) { trace.push(`${name}:metadata`); send(value); },
        onReceiveMessage(value, send) { trace.push(`${name}:message-in`); send({ text: `${value.text}|${name}` }); },
        onReceiveStatus(value, send) { trace.push(`${name}:status`); send(value); },
      }); },
      sendMessage(value, send) { trace.push(`${name}:message-out`); send({ text: `${value.text}|${name}` }); },
      halfClose(send) { trace.push(`${name}:half-close`); send(); },
    });
  };
  return id === 'API-007' ? { callInvocationTransformer(properties) {
    trace.push('transformer'); properties.argument.text = `${properties.argument.text}|transformer`;
    properties.metadata.set('x-transformer', 'yes'); return properties;
  }, interceptors: [intercept('one'), intercept('two')] } : {};
}
export function traceUnary(grpc, client, { id, serializer = serialize, deserializer = deserialize, argument = { text: 'request' }, invoke, callOptions = {}, callbackThrow } = {}) {
  const trace = [], callbacks = [], statuses = []; let returned = false;
  let resolve; const done = new Promise(yes => { resolve = yes; });
  const callback = (error, value) => {
    callbacks.push({ code: error?.code ?? 0, details: error?.details ?? '', value: value ?? null, asynchronous: returned });
    trace.push(['callback', error?.code ?? 0, error?.details ?? '', value ?? null]);
    if (callbackThrow) callbackThrow();
  };
  const call = invoke ? invoke(callback) : client.makeUnaryRequest(path, serializer, deserializer, argument, new grpc.Metadata(), { deadline: Date.now() + 5000, ...callOptions }, callback);
  call.on('metadata', () => trace.push(['metadata']));
  call.on('status', status => { statuses.push({ code: status.code, details: status.code ? status.details : '', asynchronous: returned }); trace.push(['status', status.code, status.code ? status.details : '']); resolve(); });
  returned = true;
  return { id, call, callbacks, statuses, trace, done };
}
function bottom(surface) {
  const seen = new Set(); let value = surface;
  while (value && !seen.has(value)) { if (typeof value.diagnostics === 'function') return value; seen.add(value); value = value.call ?? value.nextCall; }
  return null;
}
export function createApiRunner(grpc, adapter, config, mode, loadedDefinition) {
  let activePeer; const fetcher = { fetch(url, init) { assert.ok(activePeer); return activePeer(url, init); } };
  const transportConfig = { mode, fetcher, ...(mode === 'grpc-web' ? { endpoints: { 'catalog-api.test': 'https://gateway.catalog-api.test' } } : {}) };
  config.configureWorkersGrpc(transportConfig);
  return async function run({ callbackThrow = false } = {}) {
    const results = [], allClients = [], allBodies = [], usages = [], observer = [];
    let rpcCount = 0, fetchCount = 0;
    for (const number of callbackThrow ? [16] : Array.from({ length: 15 }, (_, i) => i + 1)) {
      const id = `API-${String(number).padStart(3, '0')}`, receipts = [], bodies = [], calls = [], order = [], events = [];
      let authCalls = 0, responseGate;
      const transport = adapter.createWorkersGrpcTransport({ ...transportConfig, observer: event => events.push(event) }); usages.push(transport);
      const clients = [];
      function client(ctor = grpc.Client, opts = {}, explicit = true) {
        const value = new ctor('catalog-api.test', transport.channelCredentials, explicit ? transport.grpcOptions(opts) : opts);
        clients.push(value); allClients.push(value); return value;
      }
      activePeer = async (url, init) => {
        fetchCount++;
        assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
        assert.equal(new URL(url).origin, mode === 'cloudflare' ? 'https://catalog-api.test' : 'https://gateway.catalog-api.test');
        const bytes = Buffer.from(init.body);
        assert.equal(bytes[0], 0); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
        const request = deserialize(bytes.subarray(5));
        receipts.push({ wire: bytes.toString('hex'), request, metadata: { order: init.headers.get('x-order'), transformer: init.headers.get('x-transformer'), rewrite: init.headers.get('x-rewrite') }, timeout: init.headers.get('grpc-timeout') });
        if (responseGate) await responseGate(init);
        const values = number === 4 ? [serialize(request)] : number === 9 ? [Buffer.from([10, 127])] : number === 10 ? [] : number === 11 ? [serialize({ text: 'first' }), serialize({ text: 'second' })] : [serialize({ text: 'reply' })];
        const chunks = [...values.map(value => frame(value)), frame(Buffer.from('grpc-status: 0\r\n'), 128)];
        let index = 0, ended = false, cancelled = 0;
        const body = new ReadableStream({ pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else { ended = true; controller.close(); } }, cancel() { cancelled++; } }, { highWaterMark: 0 });
        bodies.push({ state: () => ({ locked: body.locked, ended, cancelled }) }); allBodies.push(bodies.at(-1));
        return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto' } });
      };
      async function call(c, input = {}) {
        rpcCount++; const value = traceUnary(grpc, c, { id, ...input }); calls.push(value);
        await value.done; await sleep(); return value;
      }
      let extra = {}; const deadlineCodes = [];
      try {
        if (number === 1) {
          await call(client(grpc.Client, {}, false)); await call(client());
          assert.equal(receipts[0].wire, receipts[1].wire); assert.deepEqual(calls[0].trace, calls[1].trace);
          extra = { aliasWithoutOptions: true, factoryCompared: true };
        } else if (number === 2) {
          class Extended extends grpc.Client { unary(value, cb) { return this.makeUnaryRequest(path, serialize, deserialize, value, cb); } }
          const c = client(Extended, {}, false); await call(c, { invoke: cb => c.unary({ text: 'request' }, cb) }); extra.subclassWithoutHook = true;
        } else if (number === 3) {
          const Generated = grpc.makeGenericClientConstructor(definition, 'catalog.api.nested.Echo');
          assert.equal(Generated.service, definition); assert.equal(Generated.serviceName, 'catalog.api.nested.Echo');
          assert.equal(Generated.prototype.unary, Generated.prototype.Unary);
          const c = client(Generated); await call(c, { invoke: cb => c.Unary({ text: 'request' }, cb) });
          extra = { serviceIdentity: true, serviceName: Generated.serviceName, methodAliasIdentity: true };
        } else if (number === 4) {
          const tree = grpc.loadPackageDefinition(loadedDefinition);
          const nested = tree.catalog.api.nested;
          assert.equal(nested.Envelope, loadedDefinition['catalog.api.nested.Envelope']); assert.equal(nested.State, loadedDefinition['catalog.api.nested.State']);
          assert.equal(nested.State.type.value[1].name, 'READY'); assert.equal(nested.Envelope.type.field[0].name, 'text');
          assert.equal(nested.Echo.service, loadedDefinition['catalog.api.nested.Echo']);
          const c = client(nested.Echo); const payloads = ['', '안녕 ☃', 'x'.repeat(96)];
          for (const text of payloads) { const value = await call(c, { invoke: cb => c.Unary({ text }, cb) }); assert.deepEqual(value.callbacks[0].value, { text }); }
          assert.ok(nested.Envelope.fileDescriptorProtos.every(value => Buffer.isBuffer(value)));
          extra.descriptorGraph = JSON.stringify(loadedDefinition);
          extra = { ...extra, payloads: ['', '안녕 ☃', 'x'.repeat(96)], nestedPackage: 'catalog.api.nested', enumIdentity: true, messageIdentity: true, serviceIdentity: true, enumName: 'READY', fieldName: 'text' };
        } else if (number === 5) {
          const interceptor = (opts, next) => new grpc.InterceptingCall(next(opts), {
            start(metadata, listener, send) { metadata.set('x-rewrite', 'changed'); send(metadata, listener); },
            sendMessage(value, send) { send({ text: `${value.text}|rewritten` }); },
          });
          await call(client(grpc.Client, { interceptors: [interceptor] }));
          assert.equal(receipts[0].request.text, 'request|rewritten'); assert.equal(receipts[0].metadata.rewrite, 'changed'); extra.rewriteVerified = true;
        } else if (number === 6) {
          const finalDeadline = Date.now() + 45000, originalDeadline = finalDeadline + 60000;
          const interceptor = (opts, next) => next({ ...opts, deadline: finalDeadline });
          const c = client(grpc.Client, { interceptors: [interceptor] }); await call(c, { callOptions: { deadline: originalDeadline } });
          const match = /^(\d+)([HMSmun])$/.exec(receipts[0].timeout); assert.ok(match);
          const milliseconds = Number(match[1]) * { H: 3600000, M: 60000, S: 1000, m: 1, u: .001, n: .000001 }[match[2]];
          assert.ok(milliseconds > 40000 && milliseconds <= 45000);
          extra = { finiteDeadlineReplaced: true, originalWindowMs: 105000, headerWindowMs: milliseconds, finalWindowMs: 45000 };
          responseGate = init => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('controlled deadline aborted')), { once: true }); });
          const shortStarted = Date.now();
          const shortening = client(grpc.Client, { interceptors: [(opts, next) => next({ ...opts, deadline: Date.now() + 500 })] });
          const short = await call(shortening, { callOptions: { deadline: Date.now() + 5000 } });
          assert.equal(short.callbacks[0].code, 4); const shorteningMs = Date.now() - shortStarted; assert.ok(shorteningMs >= 400 && shorteningMs < 4000);
          responseGate = () => new Promise(resolve => setTimeout(resolve, 350));
          const extended = client(grpc.Client, { interceptors: [(opts, next) => next({ ...opts, deadline: Date.now() + 5000 })] });
          const long = await call(extended, { callOptions: { deadline: Date.now() + 150 } });
          assert.equal(long.callbacks[0].code, 0); extra.deadlineOutcomes = [0, 4, 0]; extra.shorteningMs = shorteningMs; extra.extensionOutlivedOriginalMs = 150;
          deadlineCodes.push(0, 4, 0);
        } else if (number === 7) {
          await call(client(grpc.Client, options(grpc, id, order)));
          assert.equal(receipts[0].request.text, 'request|transformer|one|two');
          assert.equal(receipts[0].metadata.order, 'one, two'); assert.equal(receipts[0].metadata.transformer, 'yes');
          extra = { order };
        } else if (number === 8) await call(client(), { serializer() { throw new Error('catalog serializer failure'); } });
        else if (number >= 9 && number <= 11) await call(client());
        else if (number === 12 || number === 13) {
          const auth = grpc.credentials.createFromMetadataGenerator((_params, done) => { authCalls++; done(null, new grpc.Metadata()); });
          const c = client();
          const trace = [], callbacks = [], statuses = []; let returned = false, resolve;
          const done = new Promise(yes => { resolve = yes; }); rpcCount++;
          const stream = number === 12 ? c.makeClientStreamRequest(path, serialize, deserialize, { credentials: auth }, error => { callbacks.push({ code: error.code, asynchronous: returned }); trace.push(['callback', error.code]); })
            : c.makeBidiStreamRequest(path, serialize, deserialize, { credentials: auth });
          stream.on('error', error => { trace.push(['error', error.code]); assert.equal(returned, true); });
          stream.on('status', status => { statuses.push({ code: status.code, asynchronous: returned }); trace.push(['status', status.code]); resolve(); });
          returned = true; stream.end(); await done; await sleep();
          assert.equal(statuses.length, 1); assert.equal(statuses[0].code, 12); assert.equal(statuses[0].asynchronous, true);
          assert.equal(callbacks.length, number === 12 ? 1 : 0); if (number === 12) assert.equal(callbacks[0].asynchronous, true);
          assert.equal(authCalls, 0); assert.equal(receipts.length, 0);
          calls.push({ call: stream, callbacks, statuses, trace }); extra = { defaultRequestStreamingDisabled: true, authCalls, callbacksAsynchronous: true, statusesAsynchronous: true };
        } else if (number === 14) {
          const c = client(); let returned = false;
          assert.equal(c.getChannel().getConnectivityState(), grpc.connectivityState.IDLE);
          const ready = new Promise(resolve => c.waitForReady(Date.now() + 5000, error => resolve({ code: error.code, asynchronous: returned })));
          returned = true; const outcome = await ready; assert.deepEqual(outcome, { code: 12, asynchronous: true });
          assert.equal(c.getChannel().getConnectivityState(), grpc.connectivityState.IDLE); extra = { ...outcome, state: 'IDLE', healthFetches: 0 };
        } else if (number === 15) {
          assert.equal(typeof grpc.Server, 'function'); assert.throws(() => new grpc.Server(), { code: 'WGA_SERVER_UNSUPPORTED' }); extra = { importSucceeded: true, useError: 'WGA_SERVER_UNSUPPORTED' };
        } else {
          const c = client(); rpcCount++;
          const value = traceUnary(grpc, c, { id, callbackThrow() { globalThis.__catalogApiThrowReceipt = () => ({ mode, id, trace: value.trace, callbacks: value.callbacks, statuses: value.statuses, diagnostics: bottom(value.call)?.diagnostics(), activeCalls: c.getChannel().activeCallCount(), usage: transport.resourceUsage(), observer: events.filter(event => event.type === 'call-end'), cleanup: bodies.map(body => body.state()), receipts, fetchCount: receipts.length }); throw new Error(`CATALOG_API016_APPLICATION_THROW_${mode}`); } }); calls.push(value);
          // The real uncaught exception is captured by the host, outside the RPC and outside this fixture.
          for (let i = 0; i < 100 && value.callbacks.length === 0; i++) await sleep();
          await sleep(); await sleep();
          assert.equal(value.callbacks.length, 1); assert.equal(value.callbacks[0].code, 0); assert.equal(value.statuses.length, 0);
          assert.equal(events.filter(event => event.type === 'call-end').length, 1); assert.equal(events.find(event => event.type === 'call-end').statusCode, 0);
          extra = { applicationThrow: true, observerTerminalCode: 0, observerTerminalCount: 1, callbackStatus: 0, statusEvents: 0 };
        }
        await sleep();
        const expectedCodes = number === 8 || number === 9 ? 13 : number === 10 || number === 11 || number === 12 || number === 13 ? 12 : 0;
        for (const [callIndex, value] of calls.entries()) {
          const code = number === 6 ? deadlineCodes[callIndex] : expectedCodes;
          if (number !== 16) {
            assert.equal(value.statuses.length, 1); assert.equal(value.statuses[0].code, number === 10 ? 0 : code);
            if (number !== 13) { assert.equal(value.callbacks.length, 1); assert.equal(value.callbacks[0].code, code); }
          }
          const call = bottom(value.call); if (call) { const state = call.diagnostics(); assert.equal(state.terminal, true); assert.equal(state.timerActive, false); assert.equal(state.requestBytes, 0); assert.equal(state.responseBytes, 0); assert.ok(state.fetchCount <= 1); }
        }
        assert.equal(receipts.length, [8, 12, 13, 14, 15].includes(number) ? 0 : number === 1 ? 2 : number === 4 || number === 6 ? 3 : 1);
        for (const c of clients) assert.equal(c.getChannel().activeCallCount(), 0);
        const usage = transport.resourceUsage(); for (const key of ['activeCalls', 'queuedCalls', 'bufferedBytes']) assert.equal(usage[key], 0);
        assert.ok(bodies.every(body => !body.state().locked && (body.state().ended || body.state().cancelled === 1)));
        results.push({ id, status: 'passed', mode, rpcCount: calls.length, fetchCount: receipts.length, authCalls,
          receipts, calls: calls.map(value => ({ trace: value.trace, callbacks: value.callbacks, statuses: value.statuses, diagnostics: bottom(value.call)?.diagnostics() ?? null })),
          cleanup: bodies.map(body => body.state()), activeCalls: 0, resourcesIdle: true, ...extra });
      } finally { clients.forEach(value => value.close()); }
    }
    assert.ok(allClients.every(value => value.getChannel().activeCallCount() === 0));
    assert.ok(allBodies.every(value => !value.state().locked));
    return { status: 'passed', mode, rpcCount, fetchCount, results, resourcesIdle: true };
  };
}
