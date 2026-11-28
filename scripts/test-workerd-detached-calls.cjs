'use strict';
// A Worker returns while an RPC it started is still running. workerd then ends
// that request context: it cancels the outstanding Fetch at the network layer
// and drops the context's timers and promise continuations, so the adapter
// observes no abort, stream error or deadline. This runs the installed client
// in workerd against a loopback gRPC-Web peer (workerd's own network, no Node
// callback bridge) and checks how later requests in the same isolate see it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const digest = value => createHash('sha256').update(value).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const sourceDist = process.env.WGA_DETACHED_SOURCE_DIST || path.join(root, 'dist');
const compatibilityDate = '2026-09-21';
// Must exceed the call deadline plus the adapter's detached-call grace period.
const DEADLINE_MS = 1000, TRAILER_HOLD_MS = 300, EXPIRED_AFTER_MS = DEADLINE_MS + 1000 + 300;
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild, liveCloud: false, nativeNetwork: true,
  nodeCallbackBridge: false, compatibilityDate, deadlineMs: DEADLINE_MS, trailerHoldMs: TRAILER_HOLD_MS, scenarios: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function frame(flag, payload) { const head = Buffer.alloc(5); head[0] = flag; head.writeUInt32BE(payload.length, 1); return Buffer.concat([head, payload]); }

function startPeer() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const row = { method: request.url.split('/').pop(), completed: false, cancelledByClient: false };
    requests.push(row);
    response.on('close', () => { if (!row.completed) row.cancelledByClient = true; });
    request.resume();
    request.on('end', () => {
      const headers = () => response.writeHead(200, { 'content-type': 'application/grpc-web+proto' });
      const message = () => response.write(frame(0, Buffer.from(JSON.stringify({ ok: row.method }))));
      const trailer = () => { if (response.destroyed) return; response.end(frame(0x80, Buffer.from('grpc-status: 0\r\n'))); row.completed = true; };
      if (row.method === 'Stream') { headers(); message(); setTimeout(trailer, TRAILER_HOLD_MS); }
      else setTimeout(() => { if (response.destroyed) return; headers(); message(); trailer(); }, TRAILER_HOLD_MS);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

async function main() {
  const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const modules={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(Object.hasOwn(modules,n))return modules[n];throw new Error('Unsupported runtime require');};`;
  const bundle = await req('esbuild').build({ absWorkingDir: root, entryPoints: ['fixtures/worker/detached-calls.mjs'],
    bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
    banner: { js: banner }, ...(sourceBuild ? { alias: {
      '@grpc/grpc-js/adapter': path.join(sourceDist, 'adapter.js'), '@grpc/grpc-js': path.join(sourceDist, 'index.js'),
    } } : {}) });
  const installed = Object.keys(bundle.metafile.inputs).filter(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/'));
  if (!sourceBuild) assert.ok(installed.length > 0, 'PUBLIC_API_MUST_USE_INSTALLED_PACKAGE');
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  report.installedInputs = Object.fromEntries(installed.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.evidence = Object.fromEntries(['scripts/test-workerd-detached-calls.cjs', 'fixtures/worker/detached-calls.mjs',
    'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  report.miniflare = req('miniflare/package.json').version;
  report.workerd = req('workerd/package.json').version;
  const peer = await startPeer();
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate, compatibilityFlags: ['nodejs_compat'],
    bindings: { PEER_PORT: String(peer.port), DEADLINE_MS: String(DEADLINE_MS) } }));
  const get = async (pathname, scenario) => {
    const response = await runtime.dispatchFetch(`https://entry.fixture.invalid${pathname}?scenario=${scenario}`, { signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const idle = { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0, channelCalls: 0 };
  const counts = usage => ({ activeCalls: usage.activeCalls, queuedCalls: usage.queuedCalls, bufferedBytes: usage.bufferedBytes, channelCalls: usage.channelCalls });
  try {
    for (const scenario of ['stream-drain', 'detached-unary', 'admission', 'wait-until']) {
      const before = peer.requests.length;
      const started = await get('/start', scenario);
      await sleep(TRAILER_HOLD_MS + 300);
      // The peer had answered by now, but the runtime cancelled the request.
      const stranded = await get('/observe', scenario);
      const row = { scenario, started: started.usage, stranded: stranded.usage, strandedEvents: stranded.events };
      if (scenario === 'admission') row.blocked = await get('/call', scenario);
      await sleep(EXPIRED_AFTER_MS - TRAILER_HOLD_MS - 300);
      row.expired = await get('/observe', scenario);
      row.recovered = await get('/call', scenario);
      row.peer = peer.requests.slice(before).map(({ method, completed, cancelledByClient }) => ({ method, completed, cancelledByClient }));
      report.scenarios.push(row);
      const later = row.peer.slice(-1)[0];
      assert.deepEqual(later, { method: 'Unary', completed: true, cancelledByClient: false }, `${scenario}: later call reaches the peer`);
      assert.equal(row.recovered.result.code, 0, `${scenario}: a later call succeeds`);
      assert.deepEqual(counts(row.recovered.usage), idle, `${scenario}: idle after the later call`);
      if (scenario === 'wait-until') {
        // Retaining the request lets the RPC finish normally on the wire.
        assert.deepEqual(row.peer[0], { method: 'Stream', completed: true, cancelledByClient: false });
        assert.deepEqual(counts(stranded.usage), idle);
        assert.deepEqual(stranded.events, [{ tag: 'wait-until', event: 'status', code: 0, details: '' }]);
        continue;
      }
      const detached = row.peer.slice(0, -1);
      assert.ok(detached.length >= 1 && detached.every(item => item.cancelledByClient && !item.completed),
        `${scenario}: workerd cancels the outstanding Fetch when the request ends`);
      // Nothing is observable in JavaScript: the call stays admitted.
      assert.equal(stranded.usage.activeCalls, detached.length, `${scenario}: still counted after the runtime cancelled it`);
      assert.ok(stranded.usage.bufferedBytes > 0);
      assert.deepEqual(stranded.events, [], `${scenario}: no abort, error or status reaches the adapter`);
      if (scenario === 'admission') {
        assert.equal(row.blocked.result.code, 8, 'stranded calls hold every admission slot');
        assert.equal(row.blocked.result.details, 'WGA_CALL_QUEUE_FULL');
      }
      // After deadline + grace the next adapter activity expires and releases them.
      assert.deepEqual(counts(row.expired.usage), idle, `${scenario}: released after the deadline`);
      const statuses = row.expired.events.filter(item => item.event !== 'error').map(item => item.code);
      assert.deepEqual(statuses, detached.map(() => 4), `${scenario}: one DEADLINE_EXCEEDED per stranded call`);
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.diagnostic = String(error?.stack ?? error).slice(0, 2000);
    throw error;
  } finally {
    await runtime.dispose();
    peer.server.closeAllConnections?.();
    peer.server.close();
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/workerd-detached-calls.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios.length, report: 'verification/workerd-detached-calls.json' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
