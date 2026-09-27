'use strict';
// Finite workerd fault/concurrency gate, not a production load benchmark.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, CoreHeaders } = req('miniflare');
const { encodeFrame } = require('../dist/wire.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const compatibilityDate = '2026-09-21';
const report = { startedAt: new Date().toISOString(), status: 'running', runtimeExecuted: false, cloudflareTranslation: false,
  liveGoogle: false, productionLoad: false, compatibilityDate, invocations: [], requests: [] };
const trailer = code => encodeFrame(Buffer.from(`grpc-status: ${code}\r\n`), true);
async function main() {
  const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require: '+name);};`;
  const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/resilience.mjs')], bundle: true, write: false,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner } });
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  report.miniflare = req('miniflare/package.json').version;
  report.workerd = req('workerd/package.json').version;
  report.evidence = Object.fromEntries(['scripts/test-workers-resilience.cjs', 'fixtures/worker/resilience.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const pending = new Set();
  const failures = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    // The fetcher callback bridge does not propagate response-body cancellation.
    // A Node handler exposes the actual loopback response close before disposal.
    compatibilityDate, compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), outboundService: { node: async (request, response) => {
      try {
        const headers = new Headers(request.headers);
        const mode = headers.get('x-fixture-mode'), kind = headers.get('x-fixture-kind');
        const invocation = headers.get('x-fixture-invocation'), round = Number(headers.get('x-fixture-round'));
        const url = new URL(headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `https://${headers.get('host')}`);
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
          if (kind === 'unavailable') { response.writeHead(503); response.end('controlled HTTP outage'); return; }
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
    report.checks = ['concurrent-mixed-faults', 'repeated-client-reuse', 'two-modes-in-one-isolate', 'http-503', 'grpc-quota-and-permission',
      'malformed-response', 'send-and-receive-limits', 'empty-unary', 'slow-stream-order-and-buffering', 'cancel-and-deadline', 'channel-close',
      'one-terminal-event', 'no-retained-transport-bytes-or-timers', 'zero-active-calls-after-each-wave', 'upstream-source-cancel-before-disposal', 'no-adapter-retry'];
    report.status = 'passed';
  } finally { await runtime.dispose(); }
}
main().catch(error => { report.status = 'failed'; report.reason = error.message; console.error(error); process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-resilience.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, calls: report.totalCalls, rpcFetches: report.rpcFetches, report: 'verification/workers-resilience.json' }));
});
