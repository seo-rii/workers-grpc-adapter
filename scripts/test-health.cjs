'use strict';
// Standard grpc.health.v1 oracle through native HTTP/2 and a framing-only local
// bridge. This does not emulate Cloudflare's deployed conversion service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http2 = require('node:http2');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const grpc = nativeRequire('@grpc/grpc-js');
const loader = nativeRequire('@grpc/proto-loader');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, CoreHeaders } = workerRequire('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const report = { status: 'running', sourceBuild, startedAt: new Date().toISOString(), controlledNativeGrpcServer: true,
  cloudflareTranslation: false, liveGoogle: false, productionLoad: false, nativeResults: [], workerResults: [], requests: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms = 10000) {
  let timeout;
  return Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('health gate timeout')), ms); })])
    .finally(() => clearTimeout(timeout));
}
function trailer(headers) {
  const bytes = Buffer.from(Object.entries(headers).filter(([key]) => !key.startsWith(':'))
    .map(([key, value]) => `${key}: ${value}\r\n`).join(''));
  const prefix = Buffer.alloc(5); prefix[0] = 128; prefix.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([prefix, bytes]);
}
async function main() {
  const files = ['src/health.ts', 'test/health.test.cjs', 'fixtures/health/health.proto', 'fixtures/worker/health.mjs',
    'scripts/test-health.cjs', 'fixtures/native/package-lock.json', 'fixtures/worker/package-lock.json'];
  report.evidence = Object.fromEntries(files.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const definition = loader.loadSync(path.join(root, 'fixtures/health/health.proto'), { defaults: true });
  const Health = grpc.loadPackageDefinition(definition).grpc.health.v1.Health;
  const server = new grpc.Server(), active = new Set(), sessions = new Set(), timers = new Set();
  const attempts = new Map(), errors = [];
  let runtime;
  function arrival(call, method) {
    const service = call.request.service;
    const source = call.metadata.get('x-health-runtime')[0];
    assert.ok(['native', 'workerd-grpc-web', 'workerd-cloudflare'].includes(source));
    const record = { runtime: source, method, service, cancelled: false };
    report.requests.push(record); return record;
  }
  try {
    server.addService(Health.service, {
      check(call, callback) {
        try {
          arrival(call, 'Check');
          if (call.request.service === 'missing') callback({ code: grpc.status.NOT_FOUND, details: 'unknown service' });
          else callback(null, { status: call.request.service === 'not-serving' ? 2 : call.request.service === 'unknown-enum' ? 99 : 1 });
        } catch (error) { errors.push(error.message); callback({ code: grpc.status.INTERNAL }); }
      },
      watch(call) {
        try {
          const record = arrival(call, 'Watch');
          const key = `${record.runtime}/${record.service}`;
          const count = (attempts.get(key) ?? 0) + 1; attempts.set(key, count);
          if (record.service === 'unsupported') { call.emit('error', { code: grpc.status.UNIMPLEMENTED }); return; }
          if (record.service === 'reconnect' && count === 1) { call.emit('error', { code: grpc.status.UNAVAILABLE }); return; }
          active.add(call);
          call.on('cancelled', () => { record.cancelled = true; active.delete(call); });
          if (record.service === 'silent') return;
          if (record.service === 'transition') {
            call.write({ status: 3 }); call.write({ status: 2 });
            const timer = setTimeout(() => { timers.delete(timer); if (!call.cancelled) call.write({ status: 1 }); }, 15);
            timers.add(timer);
          } else call.write({ status: 1 });
        } catch (error) { errors.push(error.message); call.emit('error', { code: grpc.status.INTERNAL }); }
      },
    });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(),
      (error, value) => error ? reject(error) : resolve(value)));
    const native = new Health(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const metadata = new grpc.Metadata(); metadata.set('x-health-runtime', 'native');
    try {
      for (const [service, status] of [['', 1], ['not-serving', 2], ['unknown-enum', 99]]) {
        const response = await new Promise((resolve, reject) => native.check({ service }, metadata,
          { deadline: Date.now() + 3000 }, (error, value) => error ? reject(error) : resolve(value)));
        assert.equal(response.status, status); report.nativeResults.push({ scenario: `check-${service || 'overall'}`, status });
      }
      await assert.rejects(new Promise((resolve, reject) => native.check({ service: 'missing' }, metadata,
        { deadline: Date.now() + 3000 }, (error, value) => error ? reject(error) : resolve(value))), { code: grpc.status.NOT_FOUND });
      report.nativeResults.push({ scenario: 'check-missing', code: grpc.status.NOT_FOUND });
      const stream = native.watch({ service: 'transition' }, metadata, { deadline: Date.now() + 3000 });
      const values = [];
      await bounded(new Promise((resolve, reject) => {
        stream.on('data', value => { values.push(value.status); if (value.status === 1) stream.cancel(); });
        stream.on('error', error => { if (error.code !== grpc.status.CANCELLED) reject(error); });
        stream.on('status', value => { assert.equal(value.code, grpc.status.CANCELLED); resolve(); });
      }));
      assert.deepEqual(values, [3, 2, 1]); report.nativeResults.push({ scenario: 'watch-transition', statuses: values });
    } finally { native.close(); }
    const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require: '+name);};`;
    const bundle = await workerRequire('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/health.mjs')], bundle: true,
      write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
      ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    report.workerdVersion = workerRequire('workerd/package.json').version;
    for (const mode of ['grpc-web', 'cloudflare']) {
      runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
        bindings: { MODE: mode }, compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE),
        outboundService: { node: async (request, response) => {
          try {
            const headers = new Headers(request.headers);
            const url = new URL(headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `https://${headers.get('host')}`);
            assert.equal(url.origin, mode === 'cloudflare' ? 'https://health.test' : 'https://health-gateway.test');
            const contentType = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
            assert.equal(headers.get('content-type'), contentType); assert.equal(headers.get('accept'), contentType);
            assert.equal(request.method, 'POST');
            const session = http2.connect(`http://127.0.0.1:${port}`); sessions.add(session);
            session.on('close', () => sessions.delete(session)); session.on('error', () => response.destroy());
            const outgoing = Object.fromEntries(Object.entries(request.headers).filter(([key]) =>
              !['host', 'connection', 'transfer-encoding', 'content-length', 'content-type'].includes(key) && !key.startsWith('mf-')));
            const upstream = session.request({ ...outgoing, ':method': 'POST', ':path': url.pathname,
              'content-type': 'application/grpc', te: 'trailers' });
            let ended = false, hasStatus = false, locallyCancelled = false;
            upstream.on('response', value => {
              response.writeHead(200, { 'content-type': contentType });
              if (value['grpc-status'] !== undefined) { hasStatus = true; response.write(trailer(value)); }
            });
            upstream.on('data', chunk => response.write(chunk));
            upstream.on('trailers', value => { hasStatus = true; response.write(trailer(value)); });
            upstream.on('end', () => {
              ended = true;
              if (!hasStatus && !locallyCancelled) { errors.push('native health status missing'); response.destroy(); }
              else if (!locallyCancelled) response.end();
              session.close();
            });
            upstream.on('error', () => { ended = true; response.destroy(); session.destroy(); });
            response.on('close', () => { if (!ended) { locallyCancelled = true; upstream.close(http2.constants.NGHTTP2_CANCEL); session.destroy(); } });
            request.pipe(upstream);
          } catch (error) { errors.push(error.message); response.destroy(); }
        } },
      }));
      try {
        const response = await bounded(runtime.dispatchFetch('https://fixture.test/health'), 15000);
        const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.status, 'passed'); assert.equal(body.results.length, 9);
        assert.deepEqual(body.results.slice(0, 4), report.nativeResults.slice(0, 4));
        const end = Date.now() + 3000;
        while ([...active].some(call => call.metadata.get('x-health-runtime')[0] === `workerd-${mode}`) && Date.now() < end) await pause(5);
        assert.equal([...active].filter(call => call.metadata.get('x-health-runtime')[0] === `workerd-${mode}`).length, 0,
          'all native Watch calls cancelled before isolate disposal');
        const calls = report.requests.filter(item => item.runtime === `workerd-${mode}`);
        assert.equal(calls.length, 10);
        assert.equal(calls.filter(item => item.method === 'Watch' && item.cancelled).length, 3);
        assert.equal(attempts.get(`workerd-${mode}/unsupported`), 1);
        assert.equal(attempts.get(`workerd-${mode}/reconnect`), 2);
        report.workerResults.push({ mode, status: 'passed', results: body.results, rpcCount: calls.length,
          cancelledWatchesBeforeDisposal: 3 });
      } finally { await runtime.dispose(); runtime = undefined; }
    }
    assert.deepEqual(errors, []);
    assert.equal(active.size, 0);
    report.rpcCount = report.requests.length;
    assert.equal(report.rpcCount, 25);
    report.status = 'passed';
  } finally {
    server.forceShutdown();
    for (const timer of timers) clearTimeout(timer);
    for (const session of sessions) session.destroy();
    if (runtime) await runtime.dispose();
  }
}
main().catch(error => { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/health.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, rpcCount: report.rpcCount, error: report.error, report: 'verification/health.json' }));
});
