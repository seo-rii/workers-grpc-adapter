'use strict';
// Installed adapter client and Fetch server execute inside actual workerd isolates.
// Both a controlled in-Worker Fetch bridge and a real two-Worker service binding are tested; no deployed edge behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { validateWorkerdServerStreamingReport } = require('./server-streaming-evidence.cjs');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBuild = process.argv.includes('--source-build');
const sourceDist = process.env.WGA_SERVER_STREAM_DIST || path.join(root, 'dist');
const report = { status: 'running', startedAt: new Date().toISOString(), sourceBuild, liveCloud: false,
    incomingCloudflareTranslation: false, nativeHttp2: false, serviceBindings: true, controlledPeer: true,
    compatibilityDate: '2026-09-21', runs: [], externalRequests: 0, cleanupVerifiedBeforeDispose: false };
async function main() {
    const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const modules={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=n=>{if(Object.hasOwn(modules,n))return modules[n];throw new Error('Unsupported runtime require');};`;
    const build = entry => req('esbuild').build({ absWorkingDir: root, entryPoints: [entry],
        bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'],
        banner: { js: banner }, ...(sourceBuild ? { alias: { '@grpc/grpc-js/server': path.join(sourceDist, 'server.js'),
            '@grpc/grpc-js/adapter': path.join(sourceDist, 'adapter.js'), '@grpc/grpc-js': path.join(sourceDist, 'index.js') } } : {}) });
    const [bundle, backend] = await Promise.all([build('fixtures/worker/server-request-streaming.mjs'), build('fixtures/worker/server-request-streaming-backend.mjs')]);
    report.bundleSha256 = hash(bundle.outputFiles[0].contents); report.backendBundleSha256 = hash(backend.outputFiles[0].contents);
    const installed = [...new Set([...Object.keys(bundle.metafile.inputs), ...Object.keys(backend.metafile.inputs)])].filter(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/'));
    if (!sourceBuild) assert.ok(installed.length > 0, 'PUBLIC_API_MUST_USE_INSTALLED_PACKAGE');
    report.installedInputs = Object.fromEntries(installed.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    report.evidence = Object.fromEntries(['scripts/test-workerd-server-streaming.cjs', 'fixtures/worker/server-request-streaming.mjs',
        'fixtures/worker/server-request-streaming-backend.mjs', 'fixtures/worker/package-lock.json', 'src/server.ts'].map(file => [file, hash(fs.readFileSync(path.join(root, file)))]));
    report.miniflare = req('miniflare/package.json').version; report.workerd = req('workerd/package.json').version;
    const runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), workers: [
        { name: 'entry', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: report.compatibilityDate,
            compatibilityFlags: ['nodejs_compat'], serviceBindings: { RPC: 'backend' },
            outboundService() { report.externalRequests++; throw new Error('SERVER_STREAM_EXTERNAL_REQUEST'); } },
        { name: 'backend', modules: true, script: backend.outputFiles[0].text, compatibilityDate: report.compatibilityDate,
            compatibilityFlags: ['nodejs_compat'],
            outboundService() { report.externalRequests++; throw new Error('SERVER_STREAM_EXTERNAL_REQUEST'); } },
    ] }));
    try {
        for (const [route, caseCount, transport] of [['/server-streaming', 10, 'controlled-fetch'], ['/bindings', 4, 'service-binding']]) {
            const response = await runtime.dispatchFetch(`https://entry.fixture.invalid${route}`, { signal: AbortSignal.timeout(30000) });
            const result = await response.json(); report.runs.push({ ...result, transport });
            assert.equal(response.status, 200, result.diagnostic); assert.equal(result.status, 'passed');
            assert.equal(result.caseCount, caseCount); assert.equal(result.rpcCount, caseCount); assert.equal(result.fetchCount, caseCount);
            assert.ok(result.cases.every(value => value.uploadUnlocked && value.activeCalls === 0 && value.bufferedBytes === 0));
            assert.equal(report.externalRequests, 0); assert.equal(result.cleanupVerifiedBeforeDispose, true);
        }
        report.caseCount = 14; report.rpcCount = 14; report.fetchCount = 14;
        report.cleanupVerifiedBeforeDispose = true; report.status = 'passed';
    } finally { await runtime.dispose(); report.runtimeDisposed = true; }
    if (!sourceBuild) validateWorkerdServerStreamingReport(report);
}
main().catch(error => {
    report.status = 'failed'; report.diagnostic = error.code === 'ERR_ASSERTION' ? error.message : 'WORKERD_SERVER_STREAM_FAILURE';
    report.errorClass = error.constructor?.name || 'Error'; report.errorMessage = String(error.message).slice(0, 500);
    process.exitCode = 1;
}).finally(() => {
    report.finishedAt = new Date().toISOString(); fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/workerd-server-streaming.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, cases: report.caseCount, rpcCount: report.rpcCount,
        ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: 'verification/workerd-server-streaming.json' }));
});
