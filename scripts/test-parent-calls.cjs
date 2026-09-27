'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, CoreHeaders } = req('miniflare');
const sourceBuild = process.argv.includes('--source-build');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, ms = 10000) => {
    let timer; return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PARENT_GATE_TIMEOUT')), ms); })])
        .finally(() => clearTimeout(timer));
};
function frame(payload, flag = 0) { const head = Buffer.alloc(5); head[0] = flag; head.writeUInt32BE(payload.length, 1); return Buffer.concat([head, payload]); }
function reply(text) { return new Response(Buffer.concat([frame(Buffer.from(text)), frame(Buffer.from('grpc-status: 0\r\n'), 128)]), { headers: { 'content-type': 'application/grpc-web' } }); }
const report = { status: 'running', sourceBuild, startedAt: new Date().toISOString(), liveCloud: false,
    cloudflareConversion: false, nativeOracle: nativeRequire('@grpc/grpc-js/package.json').version,
    compatibilityDate: '2026-09-21', types: [], native: [], invocations: [], requests: [], cancellations: 0 };
async function nativeParents() {
    const definition = Object.fromEntries(['parent', 'child'].map(name => [name, { path: `/fixture.Parent/${name}`,
        requestStream: false, responseStream: false, requestSerialize: value => value, requestDeserialize: value => value,
        responseSerialize: value => value, responseDeserialize: value => value }]));
    const server = new native.Server(); let current; const pendingTimers = new Set();
    const later = (fn, ms) => { const timer = setTimeout(() => { pendingTimers.delete(timer); fn(); }, ms); pendingTimers.add(timer); };
    server.addService(definition, {
        parent(parent, callback) {
            const item = current; assert.equal(typeof parent.getDeadline, 'function');
            assert.equal(parent.cancelled, false); item.parent = parent; item.listenerBaseline = parent.listenerCount('cancelled');
            item.client.makeUnaryRequest('/fixture.Parent/child', value => value, value => value, parent.request,
                { parent, propagate_flags: item.flags }, (error, value) => {
                    item.done.resolve({ code: error?.code ?? 0, text: value?.toString(), cancelled: parent.cancelled });
                    if (item.scenario !== 'finish') callback(error, value);
                });
            if (item.scenario === 'finish') void item.arrived.promise.then(() => callback(null, Buffer.from('parent complete')));
        },
        child(call, callback) {
            current.arrived.resolve();
            if (call.request.toString() === 'no-propagation') later(() => callback(null, Buffer.from('ok')), 160);
        },
    });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
    const channel = `127.0.0.1:${port}`;
    const nativeClient = new native.Client(channel, native.credentials.createInsecure());
    const outer = new native.Client(channel, native.credentials.createInsecure());
    const transport = createWorkersGrpcTransport({ mode: 'cloudflare', fetcher: { async fetch(_url, init) {
        const item = current; item.arrived.resolve();
        if (item.scenario === 'no-propagation') { await new Promise(resolve => later(resolve, 160)); return reply('ok'); }
        return new Promise((_resolve, reject) => {
            const abort = () => reject(new Error('cancelled'));
            init.signal.addEventListener('abort', abort, { once: true }); if (init.signal.aborted) abort();
        });
    } } });
    const adapter = new grpc.Client('child.test', transport.channelCredentials, transport.grpcOptions());
    try {
        for (const kind of ['native', 'adapter']) for (const scenario of ['cancel', 'deadline', 'no-propagation', 'finish']) {
            current = { client: kind === 'native' ? nativeClient : adapter, scenario, arrived: deferred(), done: deferred(),
                flags: scenario === 'deadline' ? 1 : scenario === 'no-propagation' ? 0 : 8 };
            let call;
            const outerDone = new Promise(resolve => { call = outer.makeUnaryRequest('/fixture.Parent/parent', value => value, value => value,
                Buffer.from(scenario), { deadline: Date.now() + (scenario === 'deadline' ? 180 : 4000) }, error => resolve(error?.code ?? 0)); });
            await bounded(current.arrived.promise);
            if (scenario === 'cancel' || scenario === 'no-propagation') call.cancel();
            const child = await bounded(current.done.promise);
            await bounded(outerDone);
            assert.equal(child.code, scenario === 'deadline' ? 4 : scenario === 'no-propagation' ? 0 : 1);
            if (kind === 'adapter') {
                assert.equal(adapter.getChannel().activeCallCount(), 0);
                // Native server has its own cancellation observers. No adapter
                // cancellation observer may survive completion.
                assert.equal(current.parent.listenerCount('cancelled'), current.listenerBaseline);
            }
            report.native.push({ kind, scenario, childCode: child.code, actualServerParent: true });
        }
    } finally {
        for (const timer of pendingTimers) clearTimeout(timer);
        outer.close(); nativeClient.close(); adapter.close(); server.forceShutdown();
    }
}
function types() {
    const { compile, toolchain } = require('./toolchain.cjs'); const { ts } = toolchain();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-parent-types-'));
    try {
        fs.mkdirSync(path.join(dir, 'node_modules/@grpc'), { recursive: true });
        fs.symlinkSync(root, path.join(dir, 'node_modules/@grpc/grpc-js'), 'dir');
        fs.symlinkSync(path.dirname(nativeRequire.resolve('@grpc/grpc-js/package.json')), path.join(dir, 'node_modules/native-grpc-js'), 'dir');
        const source = fs.readFileSync(path.join(root, 'test/types-parent-calls.cts'), 'utf8');
        for (const [mode, module, moduleResolution] of [['node16', ts.ModuleKind.Node16, ts.ModuleResolutionKind.Node16], ['nodenext', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext], ['bundler', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler]]) {
            const files = ['consumer.mts', 'consumer.cts'].map(name => { const file = path.join(dir, name); fs.writeFileSync(file, source); return file; });
            compile({ module, moduleResolution, noEmit: true, declaration: false, rootDir: dir }, files);
            report.types.push({ mode, status: 'passed', strict: true, skipLibCheck: false, moduleKinds: ['esm', 'cjs'], nativeParentKinds: 4 });
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function workers() {
    const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const builtins={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=name=>{if(Object.hasOwn(builtins,name))return builtins[name];throw new Error('Unsupported runtime require');};`;
    const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/parent-calls.mjs')], bundle: true, write: false,
        format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner },
        ...(sourceBuild ? { alias: { '@grpc/grpc-js/server': path.join(root, 'dist/server.js'),
            '@grpc/grpc-js/adapter': path.join(root, 'dist/adapter.mjs'), '@grpc/grpc-js': path.join(root, 'dist/index.mjs') } } : {}) });
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    report.evidence = Object.fromEntries(['scripts/test-parent-calls.cjs', 'fixtures/worker/parent-calls.mjs', 'test/types-parent-calls.cts',
        'fixtures/worker/package-lock.json', 'fixtures/native/package-lock.json'].map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    const pendingTimers = new Set(), pending = new Set(), failures = [];
    const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
        compatibilityDate: report.compatibilityDate, compatibilityFlags: ['nodejs_compat'], log: new Log(LogLevel.NONE),
        // Use the Node HTTP boundary: Miniflare's Fetcher callback bridge does
        // not expose response-body cancellation to its returned ReadableStream.
        outboundService: { node: async (request, response) => {
            try {
                const headers = new Headers(request.headers);
                const url = new URL(headers.get(CoreHeaders.ORIGINAL_URL) ?? request.url, 'https://child.test');
                assert.equal(url.hostname, 'child.test'); assert.equal(url.pathname, '/fixture.Child/Echo'); assert.equal(request.method, 'POST');
                const chunks = []; for await (const chunk of request) chunks.push(chunk);
                const bytes = Buffer.concat(chunks); assert.equal(bytes[0], 0); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
                const scenario = bytes.subarray(5).toString(); const timeout = headers.get('grpc-timeout');
                if (scenario === 'no-propagation') assert.equal(timeout, null);
                else assert.match(timeout, /^\d+m$/);
                const entry = { scenario, inheritedTimeout: timeout !== null, sourceCancelled: false };
                report.requests.push(entry);
                if (scenario === 'success' || scenario === 'no-propagation') {
                    if (scenario === 'no-propagation') await new Promise(resolve => {
                        const timer = setTimeout(() => { pendingTimers.delete(timer); resolve(); }, 180); pendingTimers.add(timer);
                    });
                    response.writeHead(200, { 'content-type': 'application/grpc-web' });
                    response.end(Buffer.concat([frame(Buffer.from(scenario === 'success' ? 'success' : 'survived')), frame(Buffer.from('grpc-status: 0\r\n'), 128)]));
                    return;
                }
                assert.ok(['abort', 'deadline'].includes(scenario));
                pending.add(response);
                response.on('close', () => {
                    pending.delete(response); entry.sourceCancelled = !response.writableEnded;
                    if (entry.sourceCancelled) report.cancellations++;
                });
                response.writeHead(200, { 'content-type': 'application/grpc-web' });
                response.write(frame(Buffer.from('waiting')));
            } catch (error) { failures.push(error.message); response.destroy(); }
        } } }));
    try {
        for (const invocation of ['cold', 'warm']) {
            const response = await bounded(runtime.dispatchFetch('https://fixture.test/' + invocation), 15000);
            const data = await response.json(); assert.equal(response.status, 200); assert.equal(data.status, 'passed'); assert.equal(data.results.length, 8);
            report.invocations.push({ invocation, ...data });
        }
        assert.equal(report.requests.length, 16);
        const until = Date.now() + 3000;
        while (report.cancellations < 8 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(report.cancellations, 8); assert.equal(pending.size, 0); assert.deepEqual(failures, []);
        report.pendingResponsesBeforeDisposal = pending.size;
    } finally { for (const response of pending) response.destroy(); await runtime.dispose(); for (const timer of pendingTimers) clearTimeout(timer); }
}
(async () => {
    types(); await nativeParents(); await workers(); report.status = 'passed';
})().catch(error => { report.status = 'failed'; report.diagnostic = error.message; process.exitCode = 1; }).finally(() => {
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/parent-calls.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ status: report.status, nativeCases: report.native.length, workerRequests: report.requests.length,
        cancellations: report.cancellations, typeModes: report.types.length, diagnostic: report.diagnostic, report: 'verification/parent-calls.json' }));
});
