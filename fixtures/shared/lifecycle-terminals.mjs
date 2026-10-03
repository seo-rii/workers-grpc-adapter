import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

const path = '/catalog.lifecycle.Echo/Stream';
const executionKeys = ['activePumps', 'pendingMessages', 'pendingMessageBytes', 'pendingWriteCallbacks',
  'parserAssemblies', 'parserAssemblyBytes', 'runtimeChunkBytes'];

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** The same schedules execute inside Node and workerd. No network or wall-clock deadlines. */
export async function runTerminalSchedules(h, mode) {
  const { grpc, createWorkersGrpcTransport, frame, trailers, drain } = h;
  assert.equal(typeof h.unhandled, 'function');
  const rows = [];

  function environment(peer) {
    const receipts = [], calls = [], bodies = [];
    const transport = createWorkersGrpcTransport({ mode,
      ...(mode === 'grpc-web' ? { endpoints: { 'lifecycle.test': 'https://gateway.lifecycle.test' } } : {}),
      resourceLimits: { maxConcurrentCalls: 128, maxQueuedCalls: 128, maxBufferedBytes: 1024 * 1024 },
      fetcher: { async fetch(url, init) {
        assert.equal(new URL(url).origin, mode === 'cloudflare' ? 'https://lifecycle.test' : 'https://gateway.lifecycle.test');
        assert.equal(init.cf.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
        const receipt = { aborted: init.signal.aborted, aborts: 0, credential: init.headers.get('x-lifecycle-call'),
          request: Buffer.from(init.body).toString('hex') };
        receipts.push(receipt);
        init.signal.addEventListener('abort', () => { receipt.aborted = true; receipt.aborts++; }, { once: true });
        return peer(init, receipt);
      } },
    });
    const channel = new grpc.Channel('lifecycle.test', transport.channelCredentials, transport.grpcOptions());
    return { channel, transport, receipts, calls, bodies, unhandledBefore: h.unhandled() };
  }

  function call(env, { credentials, onMessage, onStatus, autoRead = true, deadline = Infinity } = {}) {
    const wire = env.channel.createCallForMethod(path, false, true, { deadline, ...(credentials ? { credentials } : {}) });
    const final = deferred();
    const state = { wire, events: [], statuses: [], messages: [], writes: [], final: final.promise, started: false };
    state.start = () => {
      state.started = true;
      state.events.push('start');
      wire.start(new grpc.Metadata(), {
        onReceiveMetadata() { state.events.push('metadata'); },
        onReceiveMessage(value) {
          assert.equal(state.statuses.length, 0, 'message after terminal delivery');
          state.messages.push(Buffer.from(value).toString()); state.events.push('message');
          onMessage?.(state);
          if (autoRead) wire.startRead();
        },
        onReceiveStatus(value) {
          state.statuses.push(value.code); state.events.push(`status:${value.code}`);
          onStatus?.(state); final.resolve(value);
        },
      });
    };
    state.send = () => {
      state.events.push('send');
      wire.sendMessageWithContext({ callback(error) { state.writes.push(error?.message ?? null); state.events.push('write'); } }, Buffer.from('request'));
    };
    state.go = () => { state.start(); wire.startRead(); state.send(); wire.halfClose(); };
    state.cancel = () => { state.events.push('cancel'); wire.cancelWithStatus(grpc.status.CANCELLED, 'catalog cancellation'); };
    env.calls.push(state);
    return state;
  }

  function body(env, chunks = []) {
    let controller, index = 0, ended = false, pulls = 0, cancels = 0;
    const stream = new ReadableStream({
      start(value) { controller = value; },
      pull(value) { pulls++; if (index < chunks.length) value.enqueue(chunks[index++]); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 });
    const value = { stream, push(chunk) { controller.enqueue(chunk); },
      end() { controller.close(); ended = true; },
      error(error) { controller.error(error); },
      state: () => ({ pulls, cancels, ended, locked: stream.locked, chunksOffered: index }),
    };
    env.bodies.push(value);
    return value;
  }

  function response(value) {
    return new Response(value.stream, { headers: { 'content-type': 'application/grpc-web+proto' } });
  }

  async function until(predicate, description) {
    for (let i = 0; i < 30; i++) {
      if (predicate()) return;
      await drain();
    }
    assert.ok(predicate(), description);
  }

  async function finish(env, codes) {
    await Promise.all(env.calls.map(value => value.final));
    await until(() => env.calls.every(value => executionKeys.every(key => value.wire.executionDiagnostics()[key] === 0)), 'execution owners unwind');
    // A real event-loop turn lets the runtime report unhandled promise rejections.
    await drain();
    assert.equal(h.unhandled() - env.unhandledBefore, 0, 'unhandled rejections');
    const activeCalls = env.channel.activeCallCount();
    assert.equal(activeCalls, 0);
    const usage = env.transport.resourceUsage();
    assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
    const records = env.calls.map((value, index) => {
      assert.deepEqual(value.statuses, [codes[index]]);
      assert.ok(value.writes.length <= 1);
      if (value.events.includes('send')) assert.equal(value.writes.length, 1, 'every accepted write completes once');
      const diagnostics = value.wire.diagnostics(), execution = value.wire.executionDiagnostics();
      assert.equal(diagnostics.terminal, true); assert.equal(diagnostics.timerActive, false);
      assert.equal(diagnostics.requestBytes, 0); assert.equal(diagnostics.responseBytes, 0); assert.ok(diagnostics.fetchCount <= 1);
      for (const key of executionKeys) assert.equal(execution[key], 0, key);
      return { events: value.events, statuses: value.statuses, messages: value.messages, writes: value.writes,
        diagnostics, execution, resources: env.transport.resourceUsage(), activeCalls: env.channel.activeCallCount() };
    });
    const readers = env.bodies.map(value => value.state());
    for (const reader of readers) assert.equal(reader.locked, false);
    env.channel.close();
    return { calls: records, fetches: env.receipts.length, requests: env.receipts, readers, resources: usage,
      activeCalls, unhandledRejections: h.unhandled() - env.unhandledBefore };
  }

  async function report(id, variant, env, codes, extra = {}) {
    rows.push({ id, variant, mode, status: 'passed', ...extra, ...await finish(env, codes) });
  }

  // Cancel before the low-level listener exists, then prove a late start receives one final.
  {
    let authCalls = 0;
    const env = environment(() => { throw new Error('unexpected fetch'); });
    const credentials = grpc.credentials.createFromMetadataGenerator((_options, done) => { authCalls++; done(null, new grpc.Metadata()); });
    const value = call(env, { credentials });
    value.cancel(); value.cancel(); assert.equal(value.statuses.length, 0);
    value.start(); value.wire.startRead(); value.wire.halfClose();
    await value.final;
    assert.equal(authCalls, 0); assert.equal(env.receipts.length, 0);
    await report('LIFE-001', 'cancel-before-listener', env, [grpc.status.CANCELLED], { authCalls });
  }

  {
    let authCalls = 0;
    const env = environment(() => { throw new Error('unexpected fetch'); });
    const credentials = grpc.credentials.createFromMetadataGenerator((_options, done) => { authCalls++; done(null, new grpc.Metadata()); });
    const value = call(env, { credentials });
    value.start(); value.send();
    const afterSend = value.wire.executionDiagnostics();
    assert.equal(afterSend.pendingWriteCallbacks, 1);
    value.cancel(); value.wire.halfClose(); value.cancel();
    const afterCancel = value.wire.executionDiagnostics();
    assert.equal(afterCancel.pendingWriteCallbacks, 1, 'queued write completion survives logical terminal until delivered');
    await value.final;
    assert.equal(authCalls, 0); assert.equal(env.receipts.length, 0);
    await report('LIFE-005', 'send-immediate-cancel', env, [grpc.status.CANCELLED], { authCalls, afterSend, afterCancel });
  }

  // Deliberately ignored abort keeps the Fetch execution owner alive until rejection.
  {
    const pending = deferred();
    const env = environment(() => pending.promise), value = call(env);
    value.go(); await until(() => env.receipts.length === 1, 'pending fetch entered');
    value.cancel(); await value.final;
    const afterTerminal = value.wire.executionDiagnostics();
    assert.equal(afterTerminal.activePumps, 1); assert.equal(env.receipts[0].aborted, true);
    pending.reject(new Error('late fetch failure'));
    await report('LIFE-006', 'pending-fetch-reject-after-cancel', env, [grpc.status.CANCELLED], { afterTerminal });
  }

  // Both frames occupy the same Fetch chunk: cancellation must suppress the second.
  for (const reentrant of [false, true]) {
    let source, inMessage, afterCancel;
    const env = environment(() => { source = body(env, [Buffer.concat([frame(Buffer.from('first')), frame(Buffer.from('later')), trailers()])]); return response(source); });
    const value = call(env, { autoRead: false, onMessage(current) {
      inMessage = current.wire.executionDiagnostics();
      assert.equal(inMessage.activePumps, 1); assert.equal(inMessage.parserAssemblies, 1);
      assert.ok(inMessage.parserAssemblyBytes > 0); assert.ok(inMessage.runtimeChunkBytes > 0);
      if (reentrant) { current.wire.startRead(); current.wire.startRead(); }
      current.cancel();
      afterCancel = current.wire.executionDiagnostics();
      assert.equal(afterCancel.activePumps, 1); assert.equal(afterCancel.parserAssemblies, 1);
      if (reentrant) current.wire.startRead();
    } });
    value.go(); await value.final;
    assert.deepEqual(value.messages, ['first']);
    await report(reentrant ? 'LIFE-012' : 'LIFE-007', reentrant ? 'reentrant-demand-and-cancel' : 'cancel-with-later-frame-in-chunk', env, [grpc.status.CANCELLED], { inMessage, afterCancel });
    assert.equal(source.state().cancels, 1);
  }

  // EOF arrival is not terminal commitment: parser continuations still have to run.
  for (const variant of ['eof-then-cancel-same-turn', 'cancel-then-eof-same-turn', 'committed-eof-then-cancel']) {
    let source;
    const env = environment(() => { source = body(env, [trailers()]); return response(source); });
    const value = call(env);
    value.go(); await until(() => source?.state().pulls === 2, 'parser waits for EOF after trailer');
    if (variant === 'eof-then-cancel-same-turn') { value.events.push('peer-eof'); source.end(); value.cancel(); }
    else if (variant === 'cancel-then-eof-same-turn') {
      value.cancel(); value.events.push('peer-eof-attempt');
      // A cancelled Web stream is already closed; the peer's late close is rejected.
      assert.throws(() => source.end(), TypeError);
    } else {
      value.events.push('peer-eof'); source.end(); await value.final; value.cancel();
    }
    const expected = variant === 'committed-eof-then-cancel' ? grpc.status.OK : grpc.status.CANCELLED;
    await report('LIFE-008', variant, env, [expected], { eofArrivalIsNotTerminalCommit: true });
  }

  {
    const gates = [];
    const env = environment(() => { const gate = deferred(); gates.push(gate); return gate.promise; });
    const first = call(env), second = call(env); first.go(); second.go();
    await until(() => gates.length === 2, 'two active fetches');
    assert.equal(env.channel.activeCallCount(), 2);
    env.channel.close(); env.channel.close();
    await Promise.all([first.final, second.final]);
    const late = call(env); late.go(); await late.final;
    assert.equal(gates.length, 2); assert.ok(env.receipts.every(value => value.aborted));
    for (const gate of gates) gate.reject(new Error('closed channel fetch failure'));
    await report('LIFE-009', 'close-twice-two-active-and-new-call', env, [grpc.status.UNAVAILABLE, grpc.status.UNAVAILABLE, grpc.status.UNAVAILABLE]);
  }

  {
    const sources = new Map(), authCalls = { A: 0, B: 0 };
    const env = environment((_init, receipt) => {
      const source = body(env); sources.set(receipt.credential, source); return response(source);
    });
    const credentials = name => grpc.credentials.createFromMetadataGenerator((_options, done) => {
      authCalls[name]++; const metadata = new grpc.Metadata(); metadata.set('x-lifecycle-call', name); done(null, metadata);
    });
    const first = call(env, { credentials: credentials('A') }), second = call(env, { credentials: credentials('B') });
    first.go(); second.go();
    await until(() => sources.size === 2 && [...sources.values()].every(value => value.state().pulls === 1), 'independent readers waiting');
    first.cancel(); await first.final; await drain();
    assert.equal(sources.get('A').state().locked, false); assert.equal(sources.get('B').state().locked, true);
    assert.equal(second.statuses.length, 0); assert.equal(env.receipts.find(value => value.credential === 'B').aborted, false);
    sources.get('B').push(Buffer.concat([frame(Buffer.from('B-only')), trailers()])); sources.get('B').end();
    await second.final;
    assert.deepEqual(first.messages, []); assert.deepEqual(second.messages, ['B-only']); assert.deepEqual(authCalls, { A: 1, B: 1 });
    await report('LIFE-010', 'same-channel-credentials-and-readers-isolated', env, [grpc.status.CANCELLED, grpc.status.OK], { authCalls });
  }

  for (const stage of ['auth', 'fetch', 'read']) {
    const gate = deferred(); let source, authCalls = 0, pullCalls = 0, sourceRejects = 0;
    const env = environment(() => {
      if (stage === 'fetch') return gate.promise;
      assert.equal(stage, 'read');
      let cancels = 0;
      const stream = new ReadableStream({ pull() { pullCalls++; return gate.promise; }, cancel() { cancels++; } }, { highWaterMark: 0 });
      source = { stream, state: () => ({ locked: stream.locked, cancels, pulls: pullCalls }) };
      env.bodies.push(source); return response(source);
    });
    const credentials = stage === 'auth' ? grpc.credentials.createFromMetadataGenerator(() => { authCalls++; return gate.promise; }) : undefined;
    const value = call(env, { credentials }); value.go();
    await until(() => stage === 'auth' ? authCalls === 1 : stage === 'fetch' ? env.receipts.length === 1 : pullCalls === 1, `pending ${stage}`);
    value.cancel(); await value.final;
    sourceRejects++; gate.reject(new Error(`late ${stage} failure`));
    await report('LIFE-011', `late-${stage}-rejection`, env, [grpc.status.CANCELLED], {
      stage, authCalls, sourceRejects, mechanism: stage === 'read' ? 'standard-stream-late-source-pull-rejection' : `controlled-${stage}-promise`,
      ...(stage === 'read' ? { readContract: 'standard reader cancellation resolves pending read; later underlying pull rejects' } : {}),
    });
  }

  // A fault-injecting reader delays the real reader's result. Unlike a standard
  // reader, its exposed read promise can reject after forwarded cancel completes.
  {
    const gate = deferred(); let readCalls = 0, readRejects = 0, cancellations = 0, releases = 0;
    let stream;
    const env = environment(() => {
      stream = new ReadableStream({ cancel() { cancellations++; } }, { highWaterMark: 0 });
      const actual = new Response(stream, { headers: { 'content-type': 'application/grpc-web+proto' } });
      const wrapped = { getReader() {
        const reader = stream.getReader();
        return {
          read() {
            readCalls++;
            return reader.read().then(result => gate.promise.then(() => result)).catch(error => { readRejects++; throw error; });
          },
          cancel(reason) { return reader.cancel(reason); },
          releaseLock() { releases++; reader.releaseLock(); },
        };
      } };
      env.bodies.push({ state: () => ({ locked: stream.locked, cancels: cancellations, reads: readCalls, rejects: readRejects, releases }) });
      // Explicit controlled Fetch response; only its body reader is substituted.
      return { status: actual.status, headers: actual.headers, body: wrapped };
    });
    const value = call(env); value.go(); await until(() => readCalls === 1, 'wrapped read pending');
    value.cancel(); await value.final;
    const afterTerminal = value.wire.executionDiagnostics();
    assert.equal(afterTerminal.activePumps, 1); assert.equal(readRejects, 0); assert.equal(stream.locked, true);
    gate.reject(new Error('injected read failure after terminal'));
    const receipt = await finish(env, [grpc.status.CANCELLED]);
    assert.equal(readRejects, 1); assert.equal(cancellations, 1); assert.equal(releases, 1);
    rows.push({ id: 'LIFE-011', variant: 'late-controlled-reader-rejection', mode, status: 'passed',
      mechanism: 'fault-injecting-reader-delays-standard-reader-result', standardReaderCancelBehavior: false,
      afterTerminal, readCalls, readRejects, cancellations, releases, ...receipt });
  }

  // Every outcome runs exactly 100 times, retaining per-call diagnostics in the receipt.
  {
    let kind, sourceCount = 0;
    const gates = [];
    const env = environment(() => {
      if (kind === 'cancel') { const gate = deferred(); gates.push(gate); return gate.promise; }
      sourceCount++;
      const source = body(env);
      source.push(kind === 'success' ? Buffer.concat([frame(Buffer.from('ok')), trailers()]) : trailers(grpc.status.INTERNAL));
      source.end(); return response(source);
    });
    const counts = { success: 0, error: 0, cancel: 0 }, waveResources = [];
    for (kind of ['success', 'error', 'cancel']) {
      const wave = Array.from({ length: 100 }, () => { const value = call(env, { deadline: Date.now() + 30000 }); value.go(); return value; });
      const initialTimers = wave.filter(value => value.wire.diagnostics().timerActive).length;
      const initialWriteCallbacks = wave.reduce((sum, value) => sum + value.wire.executionDiagnostics().pendingWriteCallbacks, 0);
      assert.equal(initialTimers, 100); assert.equal(initialWriteCallbacks, 100);
      if (kind === 'cancel') {
        await until(() => gates.length === 100, 'all repeated cancellation fetches entered');
        for (const value of wave) value.cancel();
        await Promise.all(wave.map(value => value.final));
        for (const gate of gates) gate.reject(new Error('repeated cancelled fetch'));
      }
      await Promise.all(wave.map(value => value.final));
      await until(() => wave.every(value => executionKeys.every(key => value.wire.executionDiagnostics()[key] === 0)), 'repeated execution cleanup');
      const expected = kind === 'success' ? grpc.status.OK : kind === 'error' ? grpc.status.INTERNAL : grpc.status.CANCELLED;
      for (const value of wave) { assert.deepEqual(value.statuses, [expected]); assert.equal(value.writes.length, 1); counts[kind]++; }
      const usage = env.transport.resourceUsage();
      assert.equal(env.channel.activeCallCount(), 0); assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
      waveResources.push({ kind, calls: wave.length, initialTimers, initialWriteCallbacks, activeCalls: env.channel.activeCallCount(), usage });
    }
    assert.deepEqual(counts, { success: 100, error: 100, cancel: 100 });
    assert.equal(env.receipts.length, 300); assert.equal(sourceCount, 200);
    assert.equal(env.transport.resourceUsage().peakActiveCalls, 100);
    assert.ok(env.transport.resourceUsage().peakBufferedBytes > 0);
    await report('LIFE-017', 'one-hundred-of-each-terminal-outcome', env,
      [...Array(100).fill(grpc.status.OK), ...Array(100).fill(grpc.status.INTERNAL), ...Array(100).fill(grpc.status.CANCELLED)], { counts, waveResources });
  }
  return rows;
}
