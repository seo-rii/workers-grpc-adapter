'use strict';
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
async function main() {
    let Miniflare, convertV4MiniflareOptions, esbuild;
    try {
        ({ Miniflare, convertV4MiniflareOptions } = req('miniflare'));
        esbuild = req('esbuild');
        req.resolve('@grpc/grpc-js');
    }
    catch {
        const report = { status: 'blocked', runtimeExecuted: false, reason: 'miniflare/esbuild/fixture package is not installed' };
        fs.writeFileSync(path.join(root, 'verification/workers.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = 2;
        return;
    }
    // Finite CJS builtin bridge for this prototype's three Node imports. Not a general require polyfill.
    const banner = `import * as _buffer from 'node:buffer';import * as _events from 'node:events';import * as _stream from 'node:stream';const _builtins={'node:buffer':_buffer,'node:events':_events,'node:stream':_stream};const require=name=>{if(Object.hasOwn(_builtins,name))return _builtins[name];throw new Error('Unsupported runtime require: '+name);};`;
    const bundle = await esbuild.build({ entryPoints: [path.join(root, 'fixtures/worker/smoke.mjs')], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner } });
    const { encodeFrame } = require('../dist/wire.js');
    const requests = [];
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
        outboundService: async (request) => {
            const mode = request.headers.get('x-fixture-mode');
            assert.ok(['cloudflare', 'grpc-web'].includes(mode));
            const url = new URL(request.url);
            assert.equal(url.origin, mode === 'cloudflare' ? 'https://echo.test' : 'https://gateway.test');
            assert.ok(['/demo.Echo/Unary', '/demo.Echo/Stream'].includes(url.pathname));
            assert.equal(request.method, 'POST');
            assert.equal(request.headers.get('x-fixture'), 'worker-runtime');
            const contentType = mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
            assert.equal(request.headers.get('content-type'), contentType);
            assert.equal(request.headers.get('accept'), contentType);
            assert.equal(request.headers.get('x-grpc-web'), '1');
            const requestBytes = Buffer.from(await request.arrayBuffer());
            assert.deepEqual(requestBytes, encodeFrame(Buffer.from([10, 2, 111, 107])));
            requests.push({ mode, url: request.url, contentType });
            const messages = url.pathname.endsWith('/Stream') ? [requestBytes, requestBytes] : [requestBytes];
            // Controlled response only: local workerd does not emulate the beta edge translator.
            return new Response(Buffer.concat([...messages, encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': contentType } });
        } }));
    try {
        const response = await runtime.dispatchFetch('https://fixture.test');
        const data = await response.json();
        assert.equal(response.status, 200);
        assert.deepEqual(data.cases, ['cloudflare', 'grpc-web'].map(mode => ({ mode, value: '0a026f6b', streamed: ['0a026f6b', '0a026f6b'], status: 'passed' })));
        assert.equal(requests.length, 4);
        for (const mode of ['cloudflare', 'grpc-web']) {
            assert.deepEqual(requests.filter(request => request.mode === mode).map(request => new URL(request.url).pathname).sort(), ['/demo.Echo/Stream', '/demo.Echo/Unary']);
        }
        const report = { miniflare: req('miniflare/package.json').version, workerd: req('workerd/package.json').version, compatibilityDate: '2026-09-21', status: 'passed', runtimeExecuted: true, realGoogleSDK: false, cloudflareTranslation: false, transportModes: data.cases, requests, checks: ['static-import', 'alias-installed-package', 'unary', 'server-streaming', 'metadata', 'protobuf-bytes', 'cloudflare-direct-routing', 'grpc-web-gateway-routing', 'concurrent-mode-isolation', 'cleanup'] };
        fs.writeFileSync(path.join(root, 'verification/workers.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify(report, null, 2));
    }
    finally {
        await runtime.dispose();
    }
}
main().catch(error => {
    fs.writeFileSync(path.join(root, 'verification/workers.json'), JSON.stringify({ status: 'failed', runtimeExecuted: false, reason: 'See local stderr; not certified' }, null, 2) + '\n');
    console.error(error);
    process.exitCode = 1;
});
