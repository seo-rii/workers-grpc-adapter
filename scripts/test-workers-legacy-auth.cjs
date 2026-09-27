'use strict';
// Local workerd boundary check. No cloud credentials or live upstreams.
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
const report = { startedAt: new Date().toISOString(), status: 'running', runtimeExecuted: false, liveGoogle: false,
    cloudflareTranslation: false, sourceBuild, compatibilityDate, runs: [], requests: [] };
const successful = ['sync', 'async', 'duplicate', 'empty', 'modern', 'success-throw'];
function check(value, diagnostic) { assert.ok(value, diagnostic); }
async function main() {
    const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require');};`;
    const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/legacy-auth.mjs')], bundle: true, write: false,
        format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
        ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    report.miniflare = req('miniflare/package.json').version;
    report.workerd = req('workerd/package.json').version;
    report.evidence = Object.fromEntries(['scripts/test-workers-legacy-auth.cjs', 'fixtures/worker/legacy-auth.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    let boundaryFailure;
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate, compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE), outboundService: async request => {
            try {
                const url = new URL(request.url);
                if (url.href === 'https://control.fixture.invalid/turn') return new Response('ready');
                const mode = request.headers.get('x-fixture-mode');
                const scenario = request.headers.get('x-fixture-scenario');
                const invocation = request.headers.get('x-fixture-invocation');
                check(['cloudflare', 'grpc-web'].includes(mode), 'RPC_MODE');
                check(successful.includes(scenario), 'UNEXPECTED_RPC_AFTER_AUTH_FAILURE');
                check(['cold', 'warm'].includes(invocation), 'RPC_INVOCATION');
                check(url.origin === (mode === 'cloudflare' ? 'https://legacy-auth.test' : 'https://legacy-gateway.test'), 'RPC_ORIGIN');
                check(url.pathname === '/fixture.Legacy/Echo' && request.method === 'POST', 'RPC_PATH');
                const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
                check(request.headers.get('content-type') === mime && request.headers.get('accept') === mime, 'RPC_CONTENT_TYPE');
                check(request.headers.get('authorization') === (scenario === 'empty' ? null : `Bearer ${invocation}-${scenario}`), 'RPC_AUTHORIZATION');
                if (['sync', 'duplicate', 'success-throw'].includes(scenario)) check(request.headers.get('x-goog-user-project') === 'fixture-project', 'RPC_QUOTA');
                const wire = Buffer.from(await request.arrayBuffer());
                check(wire[0] === 0 && wire.readUInt32BE(1) === wire.length - 5 && wire.subarray(5).toString() === scenario, 'RPC_PAYLOAD');
                report.requests.push({ mode, scenario, invocation });
                return new Response(Buffer.concat([wire, encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': mime } });
            } catch (error) {
                boundaryFailure = error.code === 'ERR_ASSERTION' ? error.message : 'BOUNDARY_FAILURE';
                return new Response('Fixture boundary rejected request', { status: 500 });
            }
        } }));
    try {
        for (const invocation of ['cold', 'warm']) {
            const response = await runtime.dispatchFetch(`https://fixture.test/${invocation}`, { signal: AbortSignal.timeout(20000) });
            const result = await response.json();
            report.runtimeExecuted = true;
            check(!boundaryFailure, boundaryFailure || 'BOUNDARY_FAILURE');
            check(response.status === 200 && result.status === 'passed', 'WORKER_INVOCATION');
            check(result.cases.length === 32, 'SCENARIO_COUNT');
            report.runs.push(...result.cases.map(entry => ({ invocation, ...entry })));
            for (const mode of ['cloudflare', 'grpc-web']) {
                const seen = report.requests.filter(entry => entry.mode === mode && entry.invocation === invocation);
                check(seen.length === 6 && new Set(seen.map(entry => entry.scenario)).size === 6, 'RPC_COUNT');
            }
        }
        report.status = 'passed';
        report.rpcCount = report.requests.length;
        report.scenarios = report.runs.length;
    } finally { await runtime.dispose(); }
}
main().catch(error => {
    report.status = 'failed';
    report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERS_LEGACY_AUTH_FAILED';
    console.error(JSON.stringify({ status: 'failed', diagnostic: report.diagnostic, errorClass: error.constructor?.name || 'Error' }));
    process.exitCode = 1;
}).finally(() => {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/workers-legacy-auth.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios, rpcCount: report.rpcCount, report: 'verification/workers-legacy-auth.json' }));
});
