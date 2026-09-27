'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const { CompressionFilter } = nativeRequire('@grpc/grpc-js/build/src/compression-filter');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild, liveCloud: false,
    incomingCloudflareTranslation: false, nativeOracle: nativeRequire('@grpc/grpc-js/package.json').version,
    compatibilityDate: '2026-09-21', invocations: [], wireCases: [] };
function frame(payload, flag = 0) {
    const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
}
function read(bytes) {
    const messages = []; let trailers, offset = 0;
    while (offset < bytes.length) {
        assert.ok(bytes.length - offset >= 5, 'complete frame header');
        const flag = bytes[offset], size = bytes.readUInt32BE(offset + 1); offset += 5;
        assert.ok(bytes.length - offset >= size, 'complete frame payload');
        const payload = bytes.subarray(offset, offset + size); offset += size;
        assert.equal(trailers, undefined, 'trailers must be last');
        if (flag === 128) trailers = Object.fromEntries(payload.toString().trim().split('\r\n').map(line => {
            const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()];
        }));
        else { assert.equal(flag, 0); messages.push(payload); }
    }
    assert.ok(trailers, 'terminal status is required');
    return { messages, code: Number(trailers['grpc-status']), details: decodeURIComponent(trailers['grpc-message'] || ''), trailers };
}
async function main() {
    const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';import * as _zlib from 'node:zlib';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream,'node:zlib':_zlib};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require');};`;
    const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/server.mjs')], bundle: true, write: false,
        format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
        ...(sourceBuild ? { alias: { '@grpc/grpc-js/server': path.join(root, 'dist/server.js'),
            '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    report.evidence = Object.fromEntries(['scripts/test-workers-server.cjs', 'fixtures/worker/server.mjs', 'fixtures/worker/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE),
        outboundService: () => { throw new Error('The server gate must not call an external service'); } }));
    try {
        for (const invocation of ['cold', 'warm']) {
            const response = await runtime.dispatchFetch(`https://fixture.test/run/${invocation}`, { signal: AbortSignal.timeout(30000) });
            const data = await response.json();
            assert.equal(response.status, 200, data.diagnostic);
            assert.equal(data.status, 'passed');
            assert.equal(data.results.length, 60);
            assert.equal(data.state.active, 0);
            assert.equal(data.state.finalized, 24);
            report.invocations.push({ invocation, ...data });
        }
        const payload = Buffer.from('0a03686579', 'hex');
        for (const algorithm of [0, 1, 2]) {
            const oracle = new CompressionFilter({ 'grpc.default_compression_algorithm': algorithm }, {});
            const body = (await oracle.sendMessage(Promise.resolve({ message: payload, flags: 0 }))).message;
            const response = await runtime.dispatchFetch('https://fixture.test/fixture.Server/Echo', { method: 'POST',
                headers: { 'content-type': 'application/grpc-web', 'grpc-encoding': ['identity', 'deflate', 'gzip'][algorithm] }, body });
            const actual = read(Buffer.from(await response.arrayBuffer()));
            assert.equal(actual.code, 0);
            assert.deepEqual(actual.messages, [payload]);
            assert.equal(response.headers.get('x-fixture-handler'), 'yes');
            assert.equal(actual.trailers['trace-bin'], 'AID/');
            report.wireCases.push({ kind: 'native-codec-request', algorithm, code: actual.code });
        }
        for (const [kind, body, code, extra] of [
            ['duplicate', Buffer.concat([frame(payload), frame(payload)]), 3, {}],
            ['trailer', frame(Buffer.from('grpc-status: 0\r\n'), 128), 3, {}],
            ['malformed-gzip', frame(Buffer.from('not gzip'), 1), 13, { 'grpc-encoding': 'gzip' }],
            ['oversized', frame(Buffer.alloc(513)), 8, {}],
        ]) {
            const response = await runtime.dispatchFetch('https://fixture.test/fixture.Server/Echo', { method: 'POST', headers: { 'content-type': 'application/grpc-web+proto', ...extra }, body });
            const actual = read(Buffer.from(await response.arrayBuffer()));
            assert.equal(actual.code, code); assert.equal(actual.messages.length, 0);
            assert.equal(response.headers.get('x-fixture-handler'), null);
            report.wireCases.push({ kind, code: actual.code, handlerInvoked: false });
        }
        const response = await runtime.dispatchFetch('https://fixture.test/fixture.Server/Echo', { method: 'POST', headers: {
            'content-type': 'application/grpc-web', 'x-fixture-kind': 'server-deadline', 'grpc-timeout': '10m',
        }, body: frame(payload) });
        assert.equal(read(Buffer.from(await response.arrayBuffer())).code, 4);
        report.wireCases.push({ kind: 'server-deadline', code: 4 });
        report.rpcCount = report.invocations.reduce((sum, item) => sum + item.state.requests, 0);
        report.status = 'passed';
    } finally { await runtime.dispose(); }
}
main().catch(error => {
    report.status = 'failed'; report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'SERVER_GATE_FAILURE';
    process.exitCode = 1;
}).finally(() => {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/workers-server.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, rpcCount: report.rpcCount, wireCases: report.wireCases.length,
        ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/workers-server.json' }));
});
