'use strict';
// Local workerd with independent Node zlib peer; no deployed conversion claims.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, CoreHeaders } = req('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const report = { status: 'running', startedAt: new Date().toISOString(), runtimeExecuted: false, sourceBuild,
    cloudflareTranslation: false, liveGoogle: false, codecPeer: 'Node zlib', compatibilityDate: '2026-09-21', results: [], requests: [] };
function frame(payload, flag = 0) {
    const header = Buffer.alloc(5);
    header[0] = flag;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}
function check(value, diagnostic) { assert.ok(value, diagnostic); }
async function main() {
    const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require');};`;
    const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/compression.mjs')], bundle: true, write: false,
        format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
        ...(sourceBuild ? { alias: { '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    report.miniflare = req('miniflare/package.json').version;
    report.workerd = req('workerd/package.json').version;
    report.evidence = Object.fromEntries(['scripts/test-workers-compression.cjs', 'fixtures/worker/compression.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    const pending = new Set(), failures = [];
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE),
        outboundService: { node: async (request, response) => {
            try {
                const headers = new Headers(request.headers);
                const mode = headers.get('x-fixture-mode'), kind = headers.get('x-fixture-kind');
                const algorithm = Number(headers.get('x-fixture-algorithm')), invocation = headers.get('x-fixture-invocation');
                const url = new URL(headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url, `https://${headers.get('host')}`);
                const encoding = ['identity', 'deflate', 'gzip'][algorithm];
                check(!!encoding && ['cloudflare', 'grpc-web'].includes(mode), 'RPC_MODE');
                check(url.origin === (mode === 'cloudflare' ? 'https://compression.test' : 'https://compression-gateway.test'), 'RPC_ORIGIN');
                const mime = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
                check(request.method === 'POST' && headers.get('content-type') === mime && headers.get('accept') === mime, 'RPC_CONTENT_TYPE');
                check(headers.get('grpc-encoding') === encoding && headers.get('grpc-accept-encoding') === 'identity,deflate,gzip', 'COMPRESSION_HEADERS');
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                const wire = Buffer.concat(chunks);
                check(wire.length >= 5 && wire.readUInt32BE(1) === wire.length - 5, 'REQUEST_FRAME');
                check(wire[0] === (encoding !== 'identity' && kind !== 'no-compress' ? 1 : 0), 'REQUEST_COMPRESSED_FLAG');
                const decoded = wire[0] === 0 ? wire.subarray(5)
                    : encoding === 'gzip' ? zlib.gunzipSync(wire.subarray(5)) : zlib.inflateSync(wire.subarray(5));
                check(decoded.equals(kind === 'empty' ? Buffer.alloc(0) : Buffer.alloc(128, 65)), 'REQUEST_ROUNDTRIP');
                const entry = { mode, algorithm, invocation, kind, sourceCancelled: false };
                report.requests.push(entry);
                const replyEncoding = encoding === 'identity' ? 'gzip' : encoding;
                const zip = replyEncoding === 'gzip' ? zlib.gzipSync : zlib.deflateSync;
                const replyHeaders = { 'content-type': mime, 'grpc-encoding': replyEncoding };
                let frames, hold = false;
                if (['stream', 'cancel', 'deadline'].includes(kind)) {
                    check(url.pathname === '/fixture.Compression/Stream', 'STREAM_PATH');
                    hold = kind !== 'stream';
                    frames = Array.from({ length: hold ? 1 : 3 }, (_, index) => index === 1 ? frame(Buffer.alloc(128, 65 + index)) : frame(zip(Buffer.alloc(128, 65 + index)), 1));
                } else {
                    check(url.pathname === '/fixture.Compression/Unary', 'UNARY_PATH');
                    let payload = zip(decoded), flag = 1;
                    if (kind === 'malformed') payload = Buffer.from('not a compressed message');
                    if (kind === 'truncated') payload = payload.subarray(0, payload.length - 2);
                    if (kind === 'decoded-limit') payload = zip(Buffer.alloc(513, 65));
                    if (kind === 'compressed-trailer') flag = 0x81;
                    if (kind === 'unsupported-encoding') replyHeaders['grpc-encoding'] = 'fixture-unknown';
                    if (kind === 'identity-flag') replyHeaders['grpc-encoding'] = 'identity';
                    if (kind === 'unknown-plain') { replyHeaders['grpc-encoding'] = 'fixture-unknown'; flag = 0; payload = decoded; }
                    frames = kind === 'wire-limit' ? [Buffer.from([1, 0, 0, 4, 1])] : [frame(payload, flag)];
                }
                if (hold) {
                    pending.add(entry);
                    response.on('close', () => { entry.sourceCancelled = !response.writableEnded; pending.delete(entry); });
                } else frames.push(frame(Buffer.from('grpc-status: 0\r\n'), 0x80));
                response.writeHead(200, replyHeaders);
                for (const bytes of frames) response.write(bytes);
                if (!hold) response.end();
            } catch (error) {
                failures.push(error.code === 'ERR_ASSERTION' ? error.message : 'PEER_FAILURE');
                response.destroy();
            }
        } } }));
    try {
        for (const invocation of ['cold', 'warm']) {
            const response = await runtime.dispatchFetch(`https://fixture.test/${invocation}`, { signal: AbortSignal.timeout(30000) });
            const result = await response.json();
            report.runtimeExecuted = true;
            check(failures.length === 0, failures[0] || 'PEER_FAILURE');
            check(response.status === 200 && result.status === 'passed', result.stage || 'WORKER_RESULT');
            check(result.results.length === 84, 'SCENARIO_COUNT');
            report.results.push(...result.results);
            const deadline = Date.now() + 3000;
            while (pending.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            check(pending.size === 0, 'HELD_RESPONSE_NOT_CANCELLED');
            for (const mode of ['cloudflare', 'grpc-web']) for (const algorithm of [0, 1, 2]) {
                const requests = report.requests.filter(entry => entry.mode === mode && entry.algorithm === algorithm && entry.invocation === invocation);
                check(requests.length === 14 && new Set(requests.map(entry => entry.kind)).size === 14, 'EXACT_REQUEST_COUNT');
                for (const item of requests.filter(entry => ['cancel', 'deadline'].includes(entry.kind))) check(item.sourceCancelled, 'SOURCE_CANCELLATION');
            }
        }
        report.status = 'passed';
        report.rpcCount = report.requests.length;
        report.sourceCancellations = report.requests.filter(entry => entry.sourceCancelled).length;
    } finally { await runtime.dispose(); }
}
main().catch(error => {
    report.status = 'failed';
    report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERS_COMPRESSION_FAILED';
    process.exitCode = 1;
}).finally(() => {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/workers-compression.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, scenarios: report.results.length, rpcCount: report.rpcCount,
        ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/workers-compression.json' }));
});
