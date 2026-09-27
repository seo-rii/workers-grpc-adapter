'use strict';
// Two actual local workerd service bindings; no mTLS handshake or cloud call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const { encodeFrame } = require('../dist/wire.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const compatibilityDate = '2026-09-21';
const sourceBuild = process.argv.includes('--source-build');
const report = { startedAt: new Date().toISOString(), status: 'running', runtimeExecuted: false,
  serviceBindings: true, mtlsHandshake: false, cloudflareTranslation: false, liveCloud: false,
  realGoogleSDK: false, gaxChannelTokenForwarding: true, sourceBuild, compatibilityDate, runs: [], requests: [] };
function check(value, diagnostic) { assert.ok(value, diagnostic); }
async function main() {
  const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require');};`;
  const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/fetcher.mjs')], bundle: true, write: false,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
    ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  report.miniflare = req('miniflare/package.json').version;
  report.workerd = req('workerd/package.json').version;
  report.evidence = Object.fromEntries(['scripts/test-workers-fetcher.cjs', 'fixtures/worker/fetcher.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
  const backend = `export default { async fetch(request, env) {
    try {
      const owner = env.LABEL, id = request.headers.get('x-fixture-id'), mode = request.headers.get('x-fixture-mode');
      const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
      const url = new URL(request.url);
      const origin = mode === 'cloudflare' ? 'https://echo.fixture.invalid' : 'https://gateway.fixture.invalid';
      if (!['cloudflare','grpc-web'].includes(mode) || request.method !== 'POST' || url.origin !== origin || url.pathname !== '/fixture.Binding/Echo'
        || request.headers.get('x-fixture-owner') !== owner || request.headers.get('authorization') !== 'Bearer ' + id
        || request.headers.get('content-type') !== mime || request.headers.get('accept') !== mime) throw new Error();
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes[0] !== 0 || new DataView(bytes.buffer).getUint32(1) !== bytes.length - 5 || new TextDecoder().decode(bytes.subarray(5)) !== id) throw new Error();
      const receipt = await fetch('https://receipt.fixture.invalid', { method:'POST', body:JSON.stringify({id, mode, owner, origin, authorizationMatched:true}) });
      if (!receipt.ok) throw new Error();
      const value = new TextEncoder().encode(owner + ':' + id), trailer = new TextEncoder().encode('grpc-status: 0\\r\\n');
      const wire = new Uint8Array(10 + value.length + trailer.length), view = new DataView(wire.buffer);
      view.setUint32(1, value.length); wire.set(value, 5); wire[5 + value.length] = 128;
      view.setUint32(6 + value.length, trailer.length); wire.set(trailer, 10 + value.length);
      return new Response(wire, {headers:{'content-type':mime}});
    } catch { return new Response('Binding fixture rejected request', {status:500}); }
  } };`;
  report.backendSha256 = digest(backend);
  let boundaryFailure;
  const outboundService = async request => {
    try {
      const url = new URL(request.url);
      if (url.href === 'https://receipt.fixture.invalid/') {
        const data = await request.json();
        check(['a', 'b'].includes(data.owner) && data.authorizationMatched === true, 'SERVICE_BINDING_RECEIPT');
        report.requests.push({ ...data, via: 'service-binding' });
        return new Response('recorded');
      }
      const id = request.headers.get('x-fixture-id'), mode = request.headers.get('x-fixture-mode');
      check(request.headers.get('x-fixture-owner') === 'default', 'EXPLICIT_BINDING_REACHED_GLOBAL_FETCH');
      check(['cloudflare', 'grpc-web'].includes(mode), 'DEFAULT_MODE');
      check(url.origin === (mode === 'cloudflare' ? 'https://echo.fixture.invalid' : 'https://gateway.fixture.invalid')
        && url.pathname === '/fixture.Binding/Echo' && request.method === 'POST', 'DEFAULT_ROUTE');
      check(request.headers.get('authorization') === `Bearer ${id}`, 'DEFAULT_AUTHORIZATION');
      const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
      check(request.headers.get('content-type') === mime && request.headers.get('accept') === mime, 'DEFAULT_CONTENT_TYPE');
      const bytes = Buffer.from(await request.arrayBuffer());
      check(bytes[0] === 0 && bytes.readUInt32BE(1) === bytes.length - 5 && bytes.subarray(5).toString() === id, 'DEFAULT_BODY');
      report.requests.push({ id, mode, owner: 'default', origin: url.origin, authorizationMatched: true, via: 'global-fetch' });
      return new Response(Buffer.concat([encodeFrame(Buffer.from(`default:${id}`)), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': mime } });
    } catch (error) {
      boundaryFailure = error.code === 'ERR_ASSERTION' ? error.message : 'BOUNDARY_FAILURE';
      return new Response('Fetch fixture rejected request', { status: 500 });
    }
  };
  const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), workers: [
    { name: 'consumer', modules: true, script: bundle.outputFiles[0].text, compatibilityDate, compatibilityFlags: ['nodejs_compat'],
      serviceBindings: { GATEWAY_A: 'backend-a', GATEWAY_B: 'backend-b' }, outboundService },
    ...['a', 'b'].map(label => ({ name: `backend-${label}`, modules: true, script: backend, compatibilityDate,
      bindings: { LABEL: label }, outboundService })),
  ] }));
  try {
    for (const invocation of ['cold', 'warm']) {
      const response = await runtime.dispatchFetch(`https://fixture.test/${invocation}`, { signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      report.runtimeExecuted = true;
      check(!boundaryFailure, boundaryFailure || 'BOUNDARY_FAILURE');
      check(response.status === 200 && result.status === 'passed', 'WORKER_INVOCATION');
      check(result.results.length === 10, 'SCENARIO_COUNT');
      for (const entry of result.results) {
        const matches = report.requests.filter(request => request.id === entry.id);
        check(matches.length === 1 && matches[0].owner === entry.expected && matches[0].mode === entry.mode, 'BINDING_ISOLATION');
      }
      report.runs.push(...result.results);
    }
    check(report.requests.length === 20 && report.requests.filter(request => request.via === 'service-binding').length === 12, 'EXACT_REQUEST_COUNTS');
    report.rpcCount = report.requests.length;
    report.serviceBindingRPCs = 12;
    report.globalFetchRPCs = 8;
    report.status = 'passed';
  } finally { await runtime.dispose(); }
}
main().catch(error => {
  report.status = 'failed';
  report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERS_FETCHER_FAILED';
  console.error(JSON.stringify({ status: 'failed', diagnostic: report.diagnostic, errorClass: error.constructor?.name || 'Error' }));
  process.exitCode = 1;
}).finally(() => {
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-fetcher.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, scenarios: report.runs.length, rpcCount: report.rpcCount, report: 'verification/workers-fetcher.json' }));
});
