'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, CoreHeaders } = req('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const report = { status: 'running', sourceBuild, cloudflareTranslation: false, liveGoogle: false, results: [], requests: [] };
function frame(bytes, flag = 0) { const head = Buffer.alloc(5); head[0] = flag; head.writeUInt32BE(bytes.length, 1); return Buffer.concat([head, bytes]); }
async function main() {
  const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const modules={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(Object.hasOwn(modules,n))return modules[n];throw new Error('Unexpected builtin');};`;
  const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/retries.mjs')], bundle: true, write: false,
    format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
    ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
  report.bundleSha256 = digest(bundle.outputFiles[0].contents);
  report.evidence = Object.fromEntries(['scripts/test-workers-retries.cjs','fixtures/worker/retries.mjs','fixtures/worker/package-lock.json'].map(file => [file,digest(fs.readFileSync(path.join(root,file)))]));
  const attempts = new Map(), errors = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), outboundService: { node: async (request, response) => {
      try {
        const headers = new Headers(request.headers), mode = headers.get('x-retry-mode'), kind = headers.get('x-retry-kind'), invocation = headers.get('x-retry-invocation');
        const key = `${invocation}/${mode}/${kind}`, attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
        const url = new URL(headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `https://${headers.get('host')}`);
        assert.equal(url.origin, mode === 'cloudflare' ? 'https://retry.test' : 'https://retry-gateway.test');
        assert.equal(url.pathname, '/fixture.Retry/Get');
        assert.equal(headers.get('grpc-previous-rpc-attempts'), attempt === 1 ? null : String(attempt - 1));
        assert.equal(headers.get('authorization'), `Bearer synthetic-${attempt}`);
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), frame(Buffer.from('immutable')));
        report.requests.push({ invocation, mode, kind, attempt });
        const code = kind === 'denied' ? 7 : kind === 'recovery' && attempt === 3 ? 0 : 14;
        response.writeHead(200, { 'content-type': headers.get('content-type'), 'x-attempt': String(attempt) });
        if (code === 0 || kind === 'partial') response.write(frame(Buffer.from('recovered')));
        response.end(frame(Buffer.from(`grpc-status: ${code}\r\n${['cancel','deadline'].includes(kind) ? '' : 'grpc-retry-pushback-ms: 0\r\n'}`), 128));
      } catch (error) { errors.push(error.code === 'ERR_ASSERTION' ? error.message : 'PEER_FAILURE'); response.destroy(); }
    } } }));
  try {
    for (const invocation of ['cold', 'warm']) {
      const response = await runtime.dispatchFetch(`https://fixture.test/${invocation}`, { signal: AbortSignal.timeout(15000) });
      const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.status, 'passed');
      assert.equal(result.results.length, 14); assert.deepEqual(errors, []);
      for (const row of result.results) assert.equal(attempts.get(`${invocation}/${row.mode}/${row.kind}`), row.attempts);
      report.results.push(...result.results);
    }
    report.rpcCount = report.requests.length; assert.equal(report.rpcCount, 44); report.status = 'passed';
  } finally { await runtime.dispose(); }
}
main().catch(error => { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }).finally(() => {
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/workers-retries.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, rpcCount: report.rpcCount, error: report.error }));
});
