'use strict';
// Bounded local microbenchmarks. These measure adapter CPU/buffering with a
// controlled fetch source, not network, deployed workerd, or Google latency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');
const repetitions = 12;
const warmups = 2;
const chunkBytes = 16 * 1024;
const trailer = encodeFrame(Buffer.from('grpc-status: 0\r\n'), true);
const cases = [
    { name: 'large-unary', requestBytes: 512 * 1024, messageBytes: 512 * 1024, messages: 1, concurrency: 1, delayMs: 0, stream: false },
    { name: 'many-small', requestBytes: 32, messageBytes: 1024, messages: 256, concurrency: 1, delayMs: 0, stream: true },
    { name: 'slow-consumer', requestBytes: 32, messageBytes: 1024, messages: 64, concurrency: 1, delayMs: 1, stream: true },
    { name: 'concurrent-unary', requestBytes: 64 * 1024, messageBytes: 64 * 1024, messages: 1, concurrency: 8, delayMs: 0, stream: false },
];
const round = value => Number(value.toFixed(3));
function summary(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: values.length, min: round(sorted[0]), p50: round(sorted[Math.ceil(sorted.length * 0.5) - 1]), p95: round(sorted[Math.ceil(sorted.length * 0.95) - 1]), max: round(sorted.at(-1)) };
}
function wireSource(config) {
    let index = 0;
    let current;
    let offset = 0;
    return new ReadableStream({ pull(controller) {
        if (!current || offset === current.length) {
            if (index > config.messages) return controller.close();
            current = index === config.messages ? trailer : encodeFrame(Buffer.alloc(config.messageBytes, index & 255));
            index++;
            offset = 0;
        }
        const end = Math.min(current.length, offset + chunkBytes);
        controller.enqueue(current.subarray(offset, end));
        offset = end;
    } }, { highWaterMark: 0 });
}
function transportCall(surface) {
    let call = surface.call;
    while (call && typeof call.diagnostics !== 'function') call = call.call ?? call.nextCall;
    assert.ok(call, 'missing transport diagnostics');
    return call;
}
async function scenario(config) {
    const generated = grpc.makeGenericClientConstructor({ run: {
        path: '/benchmark.Bytes/Run', requestStream: false, responseStream: config.stream,
        requestSerialize: value => value, responseDeserialize: value => value,
    } }, 'benchmark.Bytes');
    const factory = createWorkersGrpcTransport();
    const client = new generated('benchmark.invalid', factory.channelCredentials, factory.grpcOptions());
    let fetches = 0;
    let peakBufferedBytes = 0;
    let peakTransportRequestBytes = 0;
    let peakTransportResponseBytes = 0;
    let peakHeapDelta = 0;
    let peakArrayBufferDelta = 0;
    let peakRssDelta = 0;
    let readableHighWaterMark = 0;
    const active = new Set();
    const baseline = process.memoryUsage();
    const sample = () => {
        let buffered = 0, request = 0, response = 0;
        for (const entry of active) {
            buffered += (entry.surface.readableLength ?? 0) * config.messageBytes;
            const diagnostics = entry.transport.diagnostics();
            request += diagnostics.requestBytes;
            response += diagnostics.responseBytes;
        }
        peakBufferedBytes = Math.max(peakBufferedBytes, buffered);
        peakTransportRequestBytes = Math.max(peakTransportRequestBytes, request);
        peakTransportResponseBytes = Math.max(peakTransportResponseBytes, response);
        const memory = process.memoryUsage();
        peakHeapDelta = Math.max(peakHeapDelta, memory.heapUsed - baseline.heapUsed);
        peakArrayBufferDelta = Math.max(peakArrayBufferDelta, memory.arrayBuffers - baseline.arrayBuffers);
        peakRssDelta = Math.max(peakRssDelta, memory.rss - baseline.rss);
    };
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetches++;
        sample();
        return new Response(wireSource(config), { headers: { 'content-type': 'application/grpc-web+proto' } });
    };
    const single = async () => {
        const request = Buffer.alloc(config.requestBytes, 3);
        if (config.stream) {
            const surface = client.run(request);
            const entry = { surface, transport: transportCall(surface) };
            active.add(entry);
            readableHighWaterMark = surface.readableHighWaterMark;
            let received = 0;
            for await (const value of surface) {
                assert.equal(value.length, config.messageBytes);
                assert.equal(value[0], received & 255);
                received++;
                sample();
                if (config.delayMs) await new Promise(resolve => setTimeout(resolve, config.delayMs));
            }
            assert.equal(received, config.messages);
            assert.deepEqual(entry.transport.diagnostics(), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
            active.delete(entry);
        } else {
            let surface;
            const completed = new Promise((resolve, reject) => {
                surface = client.run(request, (error, value) => error ? reject(error) : resolve(value));
            });
            const entry = { surface, transport: transportCall(surface) };
            active.add(entry);
            const value = await completed;
            assert.equal(value.length, config.messageBytes);
            sample();
            assert.equal(entry.transport.diagnostics().fetchCount, 1);
            assert.equal(entry.transport.diagnostics().requestBytes, 0);
            active.delete(entry);
        }
    };
    try {
        const timings = [];
        for (let iteration = 0; iteration < warmups + repetitions; iteration++) {
            const start = performance.now();
            await Promise.all(Array.from({ length: config.concurrency }, single));
            assert.equal(client.getChannel().activeCallCount(), 0);
            if (iteration >= warmups) timings.push(performance.now() - start);
        }
        assert.equal(fetches, (warmups + repetitions) * config.concurrency);
        const bufferedBoundPerCall = readableHighWaterMark * config.messageBytes;
        // Conservative logical upper bound: retained request plus framed body,
        // one parser payload/header/chunk, readable queue, and current consumer
        // response. Excludes opaque Node/Fetch internals, allocator and fixture.
        const logicalBoundPerCall = 2 * config.requestBytes + 5 + Math.max(config.messageBytes, 65536) + 5 + chunkBytes + bufferedBoundPerCall + config.messageBytes;
        return {
            ...config, repetitions, warmups, fetches,
            latencyMs: summary(timings),
            payloadMiBPerSecondAtP50: round(config.concurrency * config.messages * config.messageBytes / (1024 * 1024) / (summary(timings).p50 / 1000)),
            buffering: { readableHighWaterMark, peakObservedReadableBytes: peakBufferedBytes, peakObservedTransportRequestBytes: peakTransportRequestBytes, peakObservedTransportResponseBytes: peakTransportResponseBytes, conservativeLogicalBytesBound: logicalBoundPerCall * config.concurrency, boundScope: 'Adapter-visible payload/frame/request/stream data, plus one consumer message; excludes opaque Fetch/Node internals and fixture allocations. Derived from protocol limits, not allocator measurement.' },
            processMemoryDeltaBytes: { peakHeapUsed: peakHeapDelta, peakArrayBuffers: peakArrayBufferDelta, peakRss: peakRssDelta, scope: 'Noisy process-wide sample deltas; includes fixtures and GC effects; not adapter-owned allocation measurements.' },
            cleanAfterEveryIteration: true,
        };
    } finally {
        client.close();
        globalThis.fetch = savedFetch;
    }
}
async function bundleSizes() {
    const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
    let esbuild;
    try { esbuild = req('esbuild'); } catch { return { status: 'unavailable', reason: 'Worker fixture esbuild is not installed' }; }
    const output = await esbuild.build({ entryPoints: [path.join(root, 'dist/index.mjs')], bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], minify: true });
    const bytes = output.outputFiles[0].contents;
    return { status: 'measured', esbuild: esbuild.version, minifiedBytes: bytes.length, gzipBytes: zlib.gzipSync(bytes).length, scope: 'Client root entry only; Node compatibility builtins external; does not include Google SDKs or a Workers CJS require bridge.' };
}
async function main() {
    const cold = [];
    for (let sample = 0; sample < 7; sample++) {
        cold.push(Number(execFileSync(process.execPath, ['-e', `const start=performance.now();require(${JSON.stringify(path.join(root, 'dist/index.js'))});process.stdout.write(String(performance.now()-start));`], { encoding: 'utf8' })));
    }
    const results = [];
    for (const config of cases) results.push(await scenario(config));
    const report = { status: 'measured', createdAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch }, scope: 'Controlled local Node fetch fixture; no network, Google SDK, or deployed Workers performance claims', budgetsChosen: false, responseChunkBytes: chunkBytes, coldRequireMs: { ...summary(cold), scope: 'Fresh Node process require only; process startup excluded; not workerd cold start' }, bundle: await bundleSizes(), scenarios: results };
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/benchmark.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, report: 'verification/benchmark.json', scenarios: results.map(result => ({ name: result.name, p50Ms: result.latencyMs.p50, p95Ms: result.latencyMs.p95 })) }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
