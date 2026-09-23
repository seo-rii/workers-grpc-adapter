'use strict';
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
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
    let count = 0;
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-21', compatibilityFlags: ['nodejs_compat'],
        outboundService: async (request) => {
            count++;
            if (request.headers.get('x-fixture') !== 'worker-runtime') {
                throw new Error('Metadata not propagated');
            }
            const requestBytes = Buffer.from(await request.arrayBuffer());
            return new Response(Buffer.concat([requestBytes, encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]), { headers: { 'content-type': 'application/grpc-web+proto' } });
        } }));
    try {
        const response = await runtime.dispatchFetch('https://fixture.test');
        const data = await response.json();
        if (data.value !== '0a026f6b' || count !== 1) {
            throw new Error('Worker smoke assertion failed');
        }
        const report = { miniflare: req('miniflare/package.json').version, workerd: req('workerd/package.json').version, compatibilityDate: '2026-09-21', status: 'passed', runtimeExecuted: true, realGoogleSDK: false, cloudflareTranslation: false, checks: ['static-import', 'alias-installed-package', 'unary', 'metadata', 'protobuf-bytes', 'cleanup'] };
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
