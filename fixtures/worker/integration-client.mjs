import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function expected(bytes, sequence = 0) {
  const result = Buffer.alloc(bytes.length);
  for (let i = 0; i < result.length; i++) result[i] = bytes[bytes.length - 1 - i] ^ (90 + sequence);
  return result;
}
function payload(length) { return Buffer.from(Array.from({ length }, (_, index) => index % 256)); }
async function control(binding) {
  const response = await binding.fetch('https://control.fixture.invalid/control');
  assert.equal(response.status, 200);
  return response.json();
}
async function run(request, env) {
  const invocation = new URL(request.url).pathname.slice(1);
  assert.ok(['cold', 'warm'].includes(invocation));
  const start = await env.BACKEND.fetch('https://control.fixture.invalid/invocation', { method: 'POST' });
  assert.equal((await start.json()).invocations, invocation === 'cold' ? 1 : 2);
  const clients = [], results = [], audiences = [], calls = [], cancellations = [];
  let sequence = 0;
  function client(mode, algorithm, owner) {
    const transport = createWorkersGrpcTransport({ mode, fetcher: env.BACKEND,
      ...(mode === 'grpc-web' ? { endpoints: { 'integration.fixture.invalid': 'https://gateway.fixture.invalid' } } : {}) });
    const auth = credentials.combineChannelCredentials(credentials.createSsl(), credentials.createFromGoogleCredential({
      getRequestHeaders(audience) {
        audiences.push({ owner, audience });
        return { authorization: `Bearer fixture-${invocation}-${owner}` };
      },
    }));
    const value = new Client('integration.fixture.invalid', auth, transport.grpcOptions({ 'grpc.default_compression_algorithm': algorithm }));
    clients.push(value);
    return value;
  }
  function callOptions(mode, algorithm, owner, kind, bytes, deadline = 5000) {
    const id = `${invocation}-${mode}-${algorithm}-${kind}-${owner}-${sequence++}`;
    const responseAlgorithm = (algorithm + 1) % 3;
    const metadata = new Metadata();
    for (const [name, value] of Object.entries({ 'x-case-id': id, 'x-mode': mode, 'x-owner': owner,
      'x-invocation': invocation, 'x-kind': kind, 'x-request-algorithm': String(algorithm),
      'x-response-algorithm': String(responseAlgorithm) })) metadata.set(name, value);
    metadata.set('request-bin', Buffer.from([0, 255, 128, 13, 10, 42]));
    const item = { id, invocation, mode, algorithm, responseAlgorithm, owner, kind, inputHex: bytes.toString('hex') };
    calls.push(item);
    return { item, metadata, options: { deadline: Date.now() + deadline } };
  }
  function observe(surface, item) {
    const events = { initial: 0, statuses: 0, errors: 0, code: undefined, details: undefined };
    surface.on('metadata', metadata => {
      try {
        events.initial++;
        assert.deepEqual(metadata.get('x-owner'), [item.owner]);
        assert.deepEqual(metadata.get('initial-bin'), [Buffer.from([255, 0, 128, 7])]);
      } catch (error) { events.failure = error; }
    });
    surface.on('error', () => { events.errors++; });
    const done = new Promise(resolve => surface.on('status', value => {
      try {
        events.statuses++; events.code = value.code; events.details = value.details;
        if (!['cancel', 'deadline', 'close'].includes(item.kind)) {
          assert.deepEqual(value.metadata.get('x-case-id'), [item.id]);
          assert.deepEqual(value.metadata.get('trailer-bin'), [Buffer.from([0, 255, 1, 254])]);
        }
        if (value.code === 7) assert.deepEqual(value.metadata.get('failure-bin'), [Buffer.from([0, 222, 173])]);
      } catch (error) { events.failure = error; }
      resolve();
    }));
    return { events, done };
  }
  async function unary(instance, mode, algorithm, owner, kind, bytes, record = true) {
    const { item, metadata, options } = callOptions(mode, algorithm, owner, kind, bytes);
    let callbacks = 0, callbackCode, observed;
    const completion = new Promise((resolve, reject) => {
      const surface = instance.makeUnaryRequest('/fixture.Integration/Unary', value => value, value => value, bytes,
        metadata, options, (error, value) => {
          try {
            callbacks++; callbackCode = error?.code ?? 0;
            if (!error) assert.deepEqual(value, expected(bytes));
            resolve();
          } catch (failure) { reject(failure); }
        });
      observed = observe(surface, item);
    });
    await Promise.all([completion, observed.done]);
    await sleep(0);
    assert.ifError(observed.events.failure);
    const code = kind === 'remote-error' ? 7 : 0;
    assert.equal(callbackCode, code);
    assert.equal(callbacks, 1);
    assert.equal(observed.events.statuses, 1);
    assert.equal(observed.events.initial, 1);
    assert.equal(observed.events.code, code);
    if (code === 7) assert.equal(observed.events.details, 'Denied: 한글 % integration');
    assert.equal(instance.getChannel().activeCallCount(), 0);
    if (record) results.push({ ...item, code, callbacks, statuses: 1, received: code ? 0 : 1 });
    return item;
  }
  async function stream(instance, mode, algorithm, kind, onFirst) {
    const bytes = payload(513);
    const timeout = kind === 'deadline' ? 180 : ['cancel', 'close'].includes(kind) ? 1000 : 5000;
    const { item, metadata, options } = callOptions(mode, algorithm, 'a', kind, bytes, timeout);
    const surface = instance.makeServerStreamRequest('/fixture.Integration/Stream', value => value, value => value, bytes, metadata, options);
    const observed = observe(surface, item);
    const values = [];
    let firstAction, dataFailure;
    surface.on('data', value => {
      try {
        assert.deepEqual(value, expected(bytes, values.length)); values.push(value);
        if (values.length === 1 && onFirst) firstAction = onFirst(surface);
      } catch (error) { dataFailure = error; surface.cancel(); }
    });
    await observed.done;
    const terminalAt = Date.now();
    if (firstAction) await firstAction;
    await sleep(0);
    assert.ifError(dataFailure);
    assert.ifError(observed.events.failure);
    const code = ({ cancel: 1, close: 14, deadline: 4, 'stream-error': 13 })[kind] ?? 0;
    assert.equal(observed.events.code, code, item.id);
    assert.equal(observed.events.statuses, 1);
    assert.equal(observed.events.initial, 1);
    assert.equal(observed.events.errors, code ? 1 : 0);
    assert.equal(values.length, kind === 'stream' ? 3 : 1);
    if (kind === 'stream-error') assert.equal(observed.events.details, 'Partial: 한글 % integration');
    assert.equal(instance.getChannel().activeCallCount(), 0);
    results.push({ ...item, code, statuses: 1, received: values.length });
    return { ...item, terminalAt, deadline: options.deadline };
  }
  try {
    for (const mode of ['cloudflare', 'grpc-web']) {
      for (const algorithm of [0, 1, 2]) {
        const a = client(mode, algorithm, 'a'), b = client(mode, algorithm, 'b');
        await Promise.all([unary(a, mode, algorithm, 'a', 'unary', payload(1024)),
          unary(b, mode, algorithm, 'b', 'empty', Buffer.alloc(0))]);
        await stream(a, mode, algorithm, 'stream');
        await unary(a, mode, algorithm, 'a', 'remote-error', payload(257));
        await stream(a, mode, algorithm, 'stream-error');
        a.close(); b.close();
      }
      for (const kind of ['cancel', 'deadline', 'close']) {
        const algorithm = ({ cancel: 0, deadline: 1, close: 2 })[kind];
        const a = client(mode, algorithm, 'a'), b = client(mode, algorithm, 'b');
        const item = await stream(a, mode, algorithm, kind, surface => {
          const peer = unary(b, mode, algorithm, 'b', 'peer', payload(299), false);
          if (kind === 'cancel') surface.cancel();
          if (kind === 'close') a.close();
          return peer;
        });
        await unary(kind === 'close' ? b : a, mode, algorithm, kind === 'close' ? 'b' : 'a', 'reuse', payload(321), false);
        const early = (await control(env.BACKEND)).receipts.find(value => value.id === item.id);
        const end = Date.now() + 1500;
        let receipt;
        do {
          receipt = (await control(env.BACKEND)).receipts.find(value => value.id === item.id);
          if (receipt?.finalized && !receipt.active) break;
          await sleep(10);
        } while (Date.now() < end);
        assert.ok(receipt?.finalized && !receipt.active && receipt.aborted, `BACKEND_CLEANUP:${item.id}`);
        if (kind !== 'deadline') {
          assert.ok(item.terminalAt < item.deadline - 400, 'LOCAL_CANCEL_MUST_PRECEDE_DEADLINE');
          cancellations.push({ id: item.id, kind, clientCode: kind === 'close' ? 14 : 1, backendActiveAfterClientCompletion: early.active,
            backendCleanup: receipt.abortedAt < receipt.deadline - 100 ? 'transport-cancellation' : 'grpc-timeout',
            terminalAt: item.terminalAt, backendAbortedAt: receipt.abortedAt, serverDeadline: receipt.deadline });
        }
        a.close(); b.close();
      }
    }
    const snapshot = await control(env.BACKEND);
    const current = snapshot.receipts.filter(item => item.invocation === invocation);
    assert.equal(current.length, calls.length);
    for (const item of calls) {
      const receipt = current.find(value => value.id === item.id);
      assert.ok(receipt && receipt.handled === 1 && receipt.finalized && !receipt.active, `EXACT_BACKEND_RECEIPT:${item.id}`);
      assert.equal(receipt.inputHex, item.inputHex);
      assert.equal(receipt.owner, item.owner);
      assert.equal(receipt.responseAlgorithm, item.responseAlgorithm);
      if (item.kind !== 'remote-error') assert.equal(receipt.responseEncoding, ['identity', 'deflate', 'gzip'][item.responseAlgorithm]);
    }
    assert.equal(audiences.length, calls.length);
    assert.ok(audiences.every(value => value.audience === 'https://integration.fixture.invalid/fixture.Integration'));
    assert.equal(snapshot.active, 0);
    assert.equal(results.length, 36);
    assert.equal(calls.length, 48);
    return { status: 'passed', invocation, results, rpcCount: calls.length, backend: snapshot, cancellations,
      credentialCalls: audiences.length, activeClientCalls: clients.reduce((sum, value) => sum + value.getChannel().activeCallCount(), 0) };
  } finally { clients.forEach(value => value.close()); }
}
export default {
  async fetch(request, env) {
    try { return Response.json(await run(request, env)); }
    catch (error) {
      return Response.json({ status: 'failed', diagnostic: error.code === 'ERR_ASSERTION' ? error.message : 'INTEGRATION_CLIENT',
        backend: await control(env.BACKEND) }, { status: 500 });
    }
  },
};
