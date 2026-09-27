'use strict';
// Raw workerd streaming Fetch -> unbuffered local HTTP forwarding -> pinned
// Envoy grpc_web -> native grpc-js. No adapter code or deployed service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, CoreHeaders } = req('miniflare');
const pin = require('../fixtures/envoy/binary.json');
const binary = process.env.WGA_ENVOY_BINARY || path.join(root, 'fixtures/envoy/.cache', `envoy-${pin.version}`);
const scenarios = ['client-stream', 'bidi', 'slow-consumer', 'early-error', 'cancel'];
const report = { status: 'running', startedAt: new Date().toISOString(), runtime: process.version,
  scope: 'local gateway protocol feasibility only', adapterStreamingEnabled: false, cloudflareEdgeConversionTested: false,
  officialGrpcWebClientUsed: false, liveCloud: false, results: [], nativeBaseline: [], serverCases: [], gatewayResponses: [], cleanup: {} };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(5); }
  throw new Error(`timeout-${label}`);
}
async function bounded(promise, label, timeout = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timeout-${label}`)), timeout); })])
    .finally(() => clearTimeout(timer));
}
async function unusedPort() {
  const server = net.createServer();
  try { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function serialize(payload) {
  let length = payload.length; const prefix = [10];
  do { const byte = length % 128; length = Math.floor(length / 128); prefix.push(byte | (length ? 128 : 0)); } while (length);
  return Buffer.concat([Buffer.from(prefix), payload]);
}
function deserialize(bytes) {
  assert.equal(bytes[0], 10); let length = 0, scale = 1, offset = 1;
  while (offset < bytes.length) { const byte = bytes[offset++]; length += (byte & 127) * scale; if (!(byte & 128)) break; scale *= 128; }
  assert.equal(length, bytes.length - offset); return bytes.subarray(offset);
}
const methods = Object.fromEntries(['ClientStream', 'Bidi'].map(method => [method[0].toLowerCase() + method.slice(1), {
  path: `/fixture.Streaming/${method}`, requestStream: true, responseStream: method === 'Bidi',
  requestSerialize: serialize, requestDeserialize: deserialize, responseSerialize: serialize, responseDeserialize: deserialize,
}]));
async function main() {
  assert.equal(hash(fs.readFileSync(binary)), pin.sha256, 'Pinned Envoy binary digest');
  report.envoy = { version: pin.version, sha256: pin.sha256 };
  report.workerd = req('workerd/package.json').version;
  report.evidence = Object.fromEntries(['scripts/test-streaming-feasibility.cjs', 'fixtures/worker/streaming-feasibility.mjs',
    'fixtures/envoy/envoy.yaml', 'fixtures/envoy/binary.json', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json']
    .map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
  const server = new native.Server(), states = new Map(), active = new Set(), timers = new Set(), forwarding = new Set();
  const errors = [];
  let envoy, envoyExit, envoyExited, worker, scratch, fd;
  function observe(call, method) {
    const id = call.metadata.get('x-wga-case')[0]; assert.equal(typeof id, 'string'); assert.ok(!states.has(id));
    const state = { id, method, messages: 0, bytes: 0, values: [], halfClosed: false, cancelled: false, pauses: 0,
      firstArrivalBeforeHalfClose: false, firstResponseBeforeSecondRequest: false };
    states.set(id, state); active.add(call);
    call.on('cancelled', () => { state.cancelled = true; active.delete(call); });
    call.on('end', () => { state.halfClosed = true; });
    return state;
  }
  try {
    server.addService(methods, {
      clientStream(call, callback) {
        const state = observe(call, 'ClientStream'); let replied = false;
        call.on('data', payload => {
          state.messages++; state.bytes += payload.length; state.values.push(payload[0]);
          if (state.messages === 1) state.firstArrivalBeforeHalfClose = !state.halfClosed;
          if (state.id.endsWith('early-error') && !replied) {
            replied = true; active.delete(call); callback({ code: native.status.PERMISSION_DENIED, details: 'controlled early refusal' }); return;
          }
          if (state.id.endsWith('slow-consumer')) {
            state.pauses++; call.pause();
            const timer = setTimeout(() => { timers.delete(timer); call.resume(); }, 5); timers.add(timer);
          }
        });
        call.on('end', () => {
          active.delete(call);
          if (!replied && !state.id.endsWith('cancel')) { replied = true; callback(null, Buffer.from([state.messages, state.values.reduce((a, b) => a + b, 0) % 256])); }
        });
      },
      bidi(call) {
        const state = observe(call, 'Bidi');
        call.on('data', payload => {
          state.messages++; state.bytes += payload.length; state.values.push(payload[0]);
          if (state.messages === 1) { state.firstArrivalBeforeHalfClose = !state.halfClosed; state.firstResponseBeforeSecondRequest = true; }
          call.write(payload);
        });
        call.on('end', () => { active.delete(call); call.end(); });
      },
    });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(),
      (error, value) => error ? reject(error) : resolve(value)));
    const Client = native.makeGenericClientConstructor(methods, 'fixture.Streaming');
    const client = new Client(`127.0.0.1:${port}`, native.credentials.createInsecure());
    try {
      const metadata = new native.Metadata(); metadata.set('x-wga-case', 'native-client-stream');
      await bounded(new Promise((resolve, reject) => {
        const stream = client.clientStream(metadata, { deadline: Date.now() + 3000 }, (error, result) => {
          if (error) reject(error); else { try { assert.deepEqual([...result], [3, 6]); resolve(); } catch (error) { reject(error); } }
        });
        stream.write(Buffer.from([1])); stream.write(Buffer.from([2])); stream.end(Buffer.from([3]));
      }), 'native-client-stream');
      report.nativeBaseline.push({ scenario: 'client-stream', status: 'passed', messages: 3 });
      metadata.set('x-wga-case', 'native-bidi');
      await bounded(new Promise((resolve, reject) => {
        const stream = client.bidi(metadata, { deadline: Date.now() + 3000 }); let responses = 0;
        stream.on('data', payload => {
          try {
            responses++; assert.equal(payload[0], responses);
            if (responses === 1) stream.write(Buffer.from([2])); else stream.end();
          } catch (error) { reject(error); stream.cancel(); }
        });
        stream.on('error', reject); stream.on('status', status => { try { assert.equal(status.code, 0); assert.equal(responses, 2); resolve(); } catch (error) { reject(error); } });
        stream.write(Buffer.from([1]));
      }), 'native-bidi');
      report.nativeBaseline.push({ scenario: 'bidi', status: 'passed', messages: 2, responseBeforeSecondRequest: true });
      metadata.set('x-wga-case', 'native-early-error');
      await bounded(new Promise((resolve, reject) => {
        const stream = client.clientStream(metadata, { deadline: Date.now() + 3000 }, error => {
          try { assert.equal(error?.code, native.status.PERMISSION_DENIED); resolve(); } catch (error) { reject(error); }
          finally { stream.cancel(); }
        });
        stream.write(Buffer.from([255]));
      }), 'native-early-error');
      report.nativeBaseline.push({ scenario: 'early-error', status: 'passed', grpcStatus: 7, requestHalfClosed: false });
    } finally { client.close(); }
    const [gatewayPort, adminPort] = await Promise.all([unusedPort(), unusedPort()]);
    const logs = path.join(os.homedir(), 'logs'); fs.mkdirSync(logs, { recursive: true, mode: 0o700 }); fs.chmodSync(logs, 0o700);
    const envoyLog = path.join(logs, `wga-streaming-envoy-${Date.now()}-${process.pid}.log`);
    fs.mkdirSync(path.join(root, '.wga-build'), { recursive: true });
    fd = fs.openSync(envoyLog, 'wx', 0o600); scratch = fs.mkdtempSync(path.join(root, '.wga-build/streaming-feasibility-'));
    const config = path.join(scratch, 'envoy.yaml');
    fs.writeFileSync(config, fs.readFileSync(path.join(root, 'fixtures/envoy/envoy.yaml'), 'utf8')
      .replaceAll('__NATIVE_PORT__', String(port)).replaceAll('__ENVOY_PORT__', String(gatewayPort)).replaceAll('__ADMIN_PORT__', String(adminPort)));
    envoy = spawn(binary, ['-c', config, '--concurrency', '1', '--disable-hot-restart', '--log-level', 'warning'], { stdio: ['ignore', fd, fd] });
    report.envoy.pid = envoy.pid; report.envoy.log = envoyLog;
    envoyExited = new Promise(resolve => {
      envoy.once('exit', (code, signal) => { envoyExit = { code, signal }; resolve(); });
      envoy.once('error', () => { envoyExit = { code: null, error: 'spawn-failed' }; resolve(); });
    });
    await until(async () => {
      assert.ok(!envoyExit, 'Envoy remains running');
      try { return (await fetch(`http://127.0.0.1:${adminPort}/ready`, { signal: AbortSignal.timeout(200) })).ok; } catch { return false; }
    }, 'envoy-readiness');
    const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/streaming-feasibility.mjs')],
      bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022' });
    report.bundleSha256 = hash(bundle.outputFiles[0].contents);
    for (const mode of ['passthrough', 'convert']) {
      worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'], bindings: { MODE: mode }, log: new Log(LogLevel.NONE),
        outboundService: { node: async (request, response) => {
          const headers = new Headers(request.headers);
          const url = new URL(headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `https://${headers.get('host')}`);
          try {
            if (url.hostname === 'stream-control.invalid') {
              const [id, operation] = url.pathname.slice(1).split('/'), count = Number(url.searchParams.get('count'));
              await until(() => {
                const state = states.get(id);
                return state && (operation === 'arrived' ? state.messages >= count : operation === 'cancelled' ? state.cancelled
                  : operation === 'ended' ? state.halfClosed : true);
              }, `control-${operation}`, 1800);
              response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(states.get(id))); return;
            }
            assert.equal(url.hostname, 'stream-gateway.invalid');
            const outgoing = Object.fromEntries(Object.entries(request.headers).filter(([key]) =>
              !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key) && !key.startsWith('mf-')));
            assert.equal(outgoing['content-type'], mode === 'convert' ? 'application/grpc-web' : 'application/grpc-web+proto');
            const upstream = http.request({ hostname: '127.0.0.1', port: gatewayPort, path: url.pathname, method: 'POST', headers: outgoing });
            forwarding.add(upstream); upstream.on('close', () => forwarding.delete(upstream));
            upstream.on('response', incoming => {
              const observed = { id: outgoing['x-wga-case'], statusCode: incoming.statusCode,
                grpcStatusHeader: incoming.headers['grpc-status'] ?? null, bodyBytes: 0,
                requestHalfClosedAtHeaders: upstream.writableEnded, headersAt: Date.now(), responseEnded: false, responseForwarded: false };
              report.gatewayResponses.push(observed);
              incoming.on('data', chunk => { observed.bodyBytes += chunk.length; });
              incoming.on('end', () => { observed.responseEnded = true; observed.endedAt = Date.now(); });
              response.on('finish', () => { observed.responseForwarded = true; observed.forwardedAt = Date.now(); });
              response.writeHead(incoming.statusCode, incoming.headers);
              response.flushHeaders();
              // pipe handles backpressure in both directions, without collecting
              // or awaiting the whole body before delivering any chunk.
              incoming.pipe(response);
              incoming.on('error', () => response.destroy());
            });
            upstream.on('error', () => response.destroy());
            response.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
            request.on('aborted', () => upstream.destroy());
            request.pipe(upstream);
          } catch (error) {
            if (url.hostname !== 'stream-control.invalid') errors.push(error.message);
            if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'controlled-observation-timeout' }));
          }
        } },
      }));
      try {
        for (const scenario of scenarios) {
          const response = await bounded(worker.dispatchFetch(`https://fixture.test/${scenario}`), `worker-${scenario}`, 12000);
          const result = await response.json(); assert.equal(response.status, 200); report.results.push(result);
          const id = `${mode}-${scenario}`;
          await until(() => [...active].every(call => call.metadata.get('x-wga-case')[0] !== id), `cleanup-${id}`);
          await until(() => forwarding.size === 0, 'http-forwarder-cleanup');
          result.cleanedBeforeIsolateDisposal = true;
          const state = states.get(id);
          if (result.outcome === 'supported') {
            assert.ok(state?.firstArrivalBeforeHalfClose);
            assert.equal(state.messages, result.writes);
            if (scenario === 'bidi') assert.ok(result.responseBeforeSecondRequest && state.firstResponseBeforeSecondRequest && state.halfClosed);
            if (scenario === 'cancel') assert.ok(state.cancelled);
            if (scenario === 'slow-consumer') assert.equal(state.pauses, 32);
          }
        }
      } finally { await worker.dispose(); worker = undefined; }
    }
    assert.deepEqual(errors, []);
    report.serverCases = [...states.values()];
    report.classification = Object.fromEntries(scenarios.map(scenario => [scenario,
      report.results.filter(item => item.scenario === scenario).every(item => item.outcome === 'supported') ? 'local-gateway-supported' : 'local-gateway-blocked']));
    report.status = 'passed';
  } finally {
    server.forceShutdown();
    for (const timer of timers) clearTimeout(timer);
    for (const upstream of forwarding) upstream.destroy();
    if (worker) await worker.dispose();
    if (envoy && !envoyExit) {
      envoy.kill('SIGTERM');
      try { await bounded(envoyExited, 'envoy-shutdown', 3000); } catch { envoy.kill('SIGKILL'); await bounded(envoyExited, 'envoy-kill', 3000); }
    }
    if (envoy) report.envoy.exit = envoyExit;
    if (fd !== undefined) fs.closeSync(fd);
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    report.cleanup = { nativeServerStopped: true, envoyExited: !envoy || !!envoyExit, scratchRemoved: !scratch || !fs.existsSync(scratch) };
  }
}
main().catch(error => { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/streaming-feasibility.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, error: report.error, cases: report.results.length,
    classification: report.classification, report: 'verification/streaming-feasibility.json' }));
});
