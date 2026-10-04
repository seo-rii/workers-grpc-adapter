'use strict';
// Finite workerd fault/concurrency gate, not a production load benchmark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { validateWorkersResilienceReport, summarizeHeap, evaluateEnvelope, sources, checks } = require('./workers-resilience-evidence.cjs');
const budgets = require('../fixtures/worker/resilience-budgets.json');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, CoreHeaders } = req('miniflare');
const { encodeFrame } = require('../dist/wire.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const compatibilityDate = '2026-09-21';
const report = { startedAt: new Date().toISOString(), status: 'running', runtimeExecuted: false, cloudflareTranslation: false,
  sourceBuild: false, liveGoogle: false, productionLoad: false, compatibilityDate, budgets, invocations: [], requests: [], controlRequests: 0,
  memory: { source: 'CDP.Runtime.getHeapUsage', scope: 'same-isolate-whole-worker', garbageCollectionForced: false,
    uncollectedHeap: true, isolateTotalMemoryMeasured: false, leakFreedomEstablished: false, checkpoints: [] } };
const trailer = code => encodeFrame(Buffer.from(`grpc-status: ${code}\r\n`), true);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function inspector(runtime, name) {
  const url = await runtime.getInspectorURL(); url.protocol = 'http:'; url.pathname = '/json/list';
  const targets = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
  const target = targets.find(value => value.id === `core:user:${name}`);
  assert.ok(target, 'RESILIENCE_WORKER_INSPECTOR_TARGET');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('INSPECTOR_CONNECT_TIMEOUT')); }, 5000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('INSPECTOR_CONNECT')); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.error) entry.reject(new Error(`INSPECTOR_METHOD:${message.error.code}`)); else entry.resolve(message.result);
  });
  const stop = () => {
    for (const value of pending.values()) { clearTimeout(value.timer); value.reject(new Error('INSPECTOR_CLOSED')); }
    pending.clear();
  };
  socket.addEventListener('close', stop); socket.addEventListener('error', stop);
  return { target: target.id, sample() {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('INSPECTOR_METHOD_TIMEOUT')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'Runtime.getHeapUsage' }));
    });
  }, close() { stop(); socket.close(); } };
}
async function positiveControl(script) {
  const result = report.positiveControl = { purpose: 'measurement-and-budget-sensitivity', separateIsolate: true,
    sameWorkload: false, source: 'CDP.Runtime.getHeapUsage', garbageCollectionForced: false, samples: [], outboundRequests: 0 };
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'resilience-retention', modules: true, script,
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], inspectorPort: 0, log: new Log(LogLevel.NONE),
    outboundService() { result.outboundRequests++; throw new Error('RETENTION_CONTROL_UNEXPECTED_NETWORK'); } }));
  let devtools;
  async function invoke(phase) {
    const response = await runtime.dispatchFetch(`https://fixture.test/retention-${phase}`, phase === 'step'
      ? { method: 'POST', body: JSON.stringify({ bytes: budgets.positiveControl.bytesPerWave }) } : {});
    const value = await response.json(); assert.equal(response.status, 200); assert.equal(value.status, 'passed'); return value;
  }
  try {
    const ready = await invoke('ready');
    result.workerInstanceId = ready.workerInstanceId;
    devtools = await inspector(runtime, 'resilience-retention'); result.inspectorTarget = devtools.target;
    result.samples.push({ label: 'ready', ...ready, ...await devtools.sample() });
    for (let index = 0; index < budgets.positiveControl.waves; index++) {
      const retained = await invoke('step');
      assert.equal(retained.workerInstanceId, result.workerInstanceId);
      assert.equal(retained.retainedBytes, (index + 1) * budgets.positiveControl.bytesPerWave);
      result.samples.push({ label: `retained-${index + 1}`, ...retained, ...await devtools.sample() });
    }
    result.summary = summarizeHeap(result.samples);
    result.violations = evaluateEnvelope(result.samples, result.samples);
    assert.ok(result.violations.includes('backing-growth'), 'retained backing stores must trip the normal smoke envelope');
    assert.ok(result.summary.metrics.backingStorageSize.finalDelta >= budgets.positiveControl.waves
      * budgets.positiveControl.bytesPerWave * budgets.positiveControl.minObservedGrowthRatio, 'retained backing store growth was not measured');
    const released = await invoke('clear');
    assert.deepEqual(released, { status: 'passed', workerInstanceId: result.workerInstanceId, buffers: 0, retainedBytes: 0, sentinels: [] });
    result.released = { ...released, ...await devtools.sample() };
    result.referencesReleasedBeforeDispose = true;
    result.status = 'passed';
  } finally { devtools?.close(); await runtime.dispose(); result.runtimeDisposed = true; }
}
async function main() {
  const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require: '+name);};`;
  const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/resilience.mjs')], bundle: true, write: false,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], metafile: true, banner: { js: banner } });
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  report.miniflare = req('miniflare/package.json').version;
  report.workerd = req('workerd/package.json').version;
  report.evidence = Object.fromEntries(sources.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.versions = { node: process.version, platform: process.platform, arch: process.arch,
    miniflare: report.miniflare, workerd: report.workerd, esbuild: req('esbuild').version };
  const installed = Object.keys(bundle.metafile.inputs).filter(file => file.includes('/node_modules/'));
  installed.push('fixtures/worker/node_modules/@grpc/grpc-js/package.json');
  assert.ok(installed.every(file => file.startsWith('fixtures/worker/node_modules/')), 'RESILIENCE_INSTALLED_DEPENDENCY_GRAPH');
  report.installedInputs = Object.fromEntries(installed.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const pending = new Set();
  const failures = [];
  const barriers = new Map();
  let devtools;
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'resilience', modules: true, script: bundle.outputFiles[0].text, inspectorPort: 0,
    // The fetcher callback bridge does not propagate response-body cancellation.
    // A Node handler exposes the actual loopback response close before disposal.
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), outboundService: { node: async (request, response) => {
      try {
        const headers = new Headers(request.headers);
        const url = new URL(headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `https://${headers.get('host')}`);
        if (url.hostname === 'resilience-control.invalid') {
          report.controlRequests++;
          assert.equal(url.pathname, '/checkpoint'); assert.equal(request.method, 'POST');
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const observed = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(observed.workerInstanceId, report.memory.workerInstanceId);
          assert.ok(['cold', 'warm'].includes(observed.invocation));
          assert.ok(['start', 'wave-0', 'wave-1', 'wave-2', 'wave-3', 'closed'].includes(observed.label));
          assert.ok(['cloudflare', 'grpc-web'].includes(observed.mode));
          const key = `${observed.invocation}:${observed.label}`;
          let entry = barriers.get(key);
          if (!entry) {
            let release, reject; const ready = new Promise((resolve, fail) => { release = resolve; reject = fail; });
            entry = { modes: [], ready, release, reject }; barriers.set(key, entry);
          }
          assert.ok(!entry.modes.some(value => value.mode === observed.mode)); entry.modes.push(observed);
          if (entry.modes.length === 2) {
            try {
              const end = Date.now() + 5000;
              while (pending.size && Date.now() < end) await delay(10);
              assert.equal(pending.size, 0, 'peer sources close before heap checkpoint');
              const usage = await devtools.sample();
              report.memory.checkpoints.push({ invocation: observed.invocation, label: observed.label,
                modes: entry.modes.sort((a, b) => a.mode.localeCompare(b.mode)), pendingResponseSources: pending.size,
                sequence: report.memory.checkpoints.length, ...usage });
              entry.release();
            } catch (error) { entry.reject(error); }
          }
          await entry.ready; response.writeHead(200); response.end('sampled'); return;
        }
        const mode = headers.get('x-fixture-mode'), kind = headers.get('x-fixture-kind');
        const invocation = headers.get('x-fixture-invocation'), round = Number(headers.get('x-fixture-round'));
        assert.ok(['cloudflare', 'grpc-web'].includes(mode));
        assert.equal(url.origin, mode === 'cloudflare' ? 'https://resilience.test' : 'https://gateway.test');
        const contentType = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
        assert.equal(request.method, 'POST');
        assert.equal(headers.get('content-type'), contentType);
        assert.equal(headers.get('accept'), contentType);
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const wire = Buffer.concat(chunks);
        assert.equal(wire[0], 0);
        assert.equal(wire.readUInt32BE(1), wire.length - 5);
        assert.ok(round >= 0 && round < 4);
        assert.ok(['cold', 'warm'].includes(invocation));
        const entry = { invocation, round, mode, kind, sourceClosed: false, sourceCancelled: false };
        report.requests.push(entry);
        let frames, hold = false;
        if (url.pathname === '/fixture.Resilience/Unary') {
          assert.equal(wire.subarray(5).toString(), `${invocation}:${round}:${mode}:${kind}`);
          if (kind === 'unavailable') { entry.sourceClosed = true; response.writeHead(503); response.end('controlled HTTP outage'); return; }
          if (kind === 'quota' || kind === 'denied') frames = [trailer(kind === 'quota' ? 8 : 7)];
          else if (kind === 'truncated') frames = [Buffer.from([0, 0, 0, 0, 10, 1])];
          else if (kind === 'receive-limit') frames = [encodeFrame(Buffer.alloc(2049)), trailer(0)];
          else if (kind === 'empty') frames = [trailer(0)];
          else {
            assert.ok(['success', 'recovery'].includes(kind));
            frames = [wire, trailer(0)];
          }
        } else {
          assert.equal(url.pathname, '/fixture.Resilience/Stream');
          assert.ok(['slow', 'cancel', 'close', 'deadline'].includes(kind));
          assert.equal(wire.subarray(5).toString(), kind);
          hold = kind !== 'slow';
          frames = Array.from({ length: hold ? 1 : 128 }, (_, index) => {
            const payload = Buffer.alloc(1024, mode === 'cloudflare' ? 1 : 2);
            payload.writeUInt32BE(index);
            return encodeFrame(payload);
          });
          if (!hold) frames.push(trailer(0));
        }
        if (hold) {
          pending.add(entry);
          response.on('close', () => { entry.sourceCancelled = !response.writableEnded; pending.delete(entry); });
        }
        response.writeHead(200, { 'content-type': contentType });
        for (const frame of frames) {
          if (!response.write(frame)) await once(response, 'drain');
        }
        if (!hold) { entry.sourceClosed = true; response.end(); }
      } catch (error) { failures.push(error); report.boundaryFailures = failures.map(item => item.message); throw error; }
    } } }));
  try {
    const ready = await runtime.dispatchFetch('https://fixture.test/ready'); assert.equal(ready.status, 200);
    report.memory.workerInstanceId = (await ready.json()).workerInstanceId;
    devtools = await inspector(runtime, 'resilience'); report.memory.inspectorTarget = devtools.target;
    for (const invocation of ['cold', 'warm']) {
      let watchdog;
      const result = await Promise.race([
        (async () => {
          const response = await runtime.dispatchFetch(`https://fixture.test/${invocation}`);
          const text = await response.text();
          assert.equal(response.status, 200, text.slice(0, 1000));
          return JSON.parse(text);
        })(),
        new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('Worker resilience invocation exceeded 30 seconds')), 30000); }),
      ]).finally(() => clearTimeout(watchdog));
      assert.equal(result.status, 'passed');
      assert.equal(result.workerInstanceId, report.memory.workerInstanceId);
      assert.equal(result.invocationCount, invocation === 'cold' ? 1 : 2);
      report.runtimeExecuted = true;
      const end = Date.now() + 5000;
      while (pending.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(pending.size, 0, 'all cancelled/deadline/closed response sources must be cancelled before isolate disposal');
      assert.equal(failures.length, 0);
      for (const mode of ['cloudflare', 'grpc-web']) {
        const actual = result.cases.find(item => item.mode === mode);
        assert.equal(actual.calls, 52);
        assert.equal(actual.results.length, 4);
        for (let round = 0; round < 4; round++) {
          const seen = report.requests.filter(entry => entry.invocation === invocation && entry.mode === mode && entry.round === round);
          assert.equal(seen.length, 12);
          assert.equal(new Set(seen.map(entry => entry.kind)).size, 12, 'no automatic retry or duplicate request');
          for (const entry of seen.filter(item => ['cancel', 'deadline', 'close'].includes(item.kind))) assert.equal(entry.sourceCancelled, true);
        }
      }
      report.invocations.push({ invocation, ...result, pendingResponseSources: pending.size });
    }
    report.totalCalls = report.invocations.flatMap(item => item.cases).reduce((total, item) => total + item.calls, 0);
    report.rpcFetches = report.requests.length;
    const samples = report.memory.checkpoints, warm = samples.filter(sample => sample.invocation === 'warm');
    report.memory.warmup = { invocation: 'cold', completedWaves: 4, baseline: 'warm:start' };
    report.memory.fullSummary = summarizeHeap(samples); report.memory.warmSummary = summarizeHeap(warm);
    report.memory.envelopeViolations = evaluateEnvelope(samples, warm);
    assert.deepEqual(report.memory.envelopeViolations, [], 'local uncollected-heap smoke envelope');
    report.pendingResponseSourcesBeforeDispose = pending.size;
    report.boundaryFailures = failures.map(item => item.message);
    report.checks = checks;
  } finally {
    for (const entry of barriers.values()) entry.release();
    devtools?.close(); await runtime.dispose(); report.runtimeDisposed = true;
  }
  await positiveControl(bundle.outputFiles[0].text);
  report.status = 'passed'; validateWorkersResilienceReport(report);
}
main().catch(error => { report.status = 'failed'; report.reason = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-resilience.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, calls: report.totalCalls, rpcFetches: report.rpcFetches, report: 'verification/workers-resilience.json' }));
});
