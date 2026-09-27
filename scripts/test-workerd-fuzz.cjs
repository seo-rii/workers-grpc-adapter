'use strict';
// The property generator/oracle runs in Node, the installed adapter and hostile
// peer in separate real workerd Workers. No production wire helpers are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const fc = require('fast-check');
const root = path.resolve(__dirname, '..');
const req = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = req('miniflare');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const reportPath = path.resolve(root, process.env.WGA_WORKER_FUZZ_OUTPUT ?? 'verification/workerd-fuzz.json');
const report = { status: 'running', startedAt: new Date().toISOString(), runtimeExecuted: false,
    installedPackage: true, independentWireOracle: true, independentCompressionOracle: 'Node zlib',
    serviceBindings: true, externalNetworkAllowed: false, cloudflareTranslation: false, liveCloud: false,
    compatibilityDate: '2026-09-21', properties: [], boundaries: [], caseExecutions: 0, successfulCaseExecutions: 0, rpcCount: 0, rpcCalls: 0,
    responseCancellations: 0, responseReadersReleased: 0, emptyChunksDelivered: 0, offsetChunksDelivered: 0,
    outboundAttempts: 0, runtimeDisposed: false };
let runtime;
function save() {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, (_key, value) => value instanceof Uint8Array ? Array.from(value) : value, 2) + '\n', { mode: 0o600 });
}
function integer(name, fallback, min, max) {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max)
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    return Number(raw);
}
function record(payload, flag = 0, declaredLength = payload.length) {
    const result = new Uint8Array(5 + payload.length);
    result[0] = flag;
    new DataView(result.buffer).setUint32(1, declaredLength, false);
    result.set(payload, 5);
    return Buffer.from(result);
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
const text = value => Buffer.from(value, 'utf8');
const trailer = value => record(text(value), 128);
const ok = () => trailer('grpc-status: 0\r\n');
const defaultPlan = { sizes: [1, 2, 5, 13], empties: [true, false], padding: 3 };
const fragmentation = fc.record({ sizes: fc.array(fc.integer({ min: 1, max: 61 }), { minLength: 1, maxLength: 8 }),
    empties: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), padding: fc.integer({ min: 1, max: 11 }) });
const payload = fc.uint8Array({ maxLength: 192 });
function sample(wire, input, streaming, plan, headers, expected) {
    return { wire: b64(wire), request: b64(input), streaming, plan, headers, expected };
}
function expected(payloads, streaming, code, details = '', trace = []) {
    return { code, ...(streaming ? { payloads: payloads.map(b64) } : { callbackCode: code || (payloads.length ? 0 : 12),
        ...(code === 0 && payloads.length ? { value: b64(payloads[0]) } : {}) }), details, trace };
}
const recovery = sample(Buffer.concat([record(text('after-fault')), ok()]), text('reuse'), false, defaultPlan, {},
    expected([text('after-fault')], false, 0));

function valid(value, streaming) {
    const payloads = streaming ? value.payloads : [value.payload];
    const frames = payloads.map((data, index) => {
        if (value.encoding === 'identity' || (value.mixed && index % 2)) return record(data);
        return record((value.encoding === 'gzip' ? zlib.gzipSync : zlib.deflateSync)(data), 1);
    });
    const message = `${value.message} 한글`;
    frames.push(trailer(`grpc-status: ${value.code}\r\ngrpc-message: ${encodeURIComponent(message)}\r\ntrace-bin: ${b64(value.trace)}\r\n`));
    return sample(Buffer.concat(frames), value.input, streaming, value.plan, { 'grpc-encoding': value.encoding },
        expected(payloads, streaming, value.code, message, [b64(value.trace)]));
}
const malformedKinds = ['flags', 'oversize', 'truncated-header', 'truncated-payload', 'missing-trailer',
    'duplicate-trailer', 'after-trailer', 'invalid-binary', 'duplicate-status', 'invalid-status',
    'invalid-trailer', 'nonascii-trailer', 'compressed-trailer', 'unsupported-encoding', 'compressed-identity',
    'corrupt-gzip', 'decoded-limit', 'invalid-header-metadata', 'body-after-header-status', 'trailer-without-status'];
function malformed(value) {
    const prefix = value.prefix ? [value.payload] : [];
    let tail, code = 13, headers = {}, received = prefix;
    switch (value.kind) {
        case 'flags': {
            const flag = [2, 3, 7, 127, 129, 130, 255][value.selector % 7];
            tail = record(value.payload, flag); code = flag === 129 ? 12 : 13; break;
        }
        case 'oversize': tail = record(Buffer.alloc(0), 0, [513, 65536, 0x7fffffff, 0xffffffff][value.selector % 4]); code = 8; break;
        case 'truncated-header': tail = record(value.payload).subarray(0, 1 + value.selector % 4); break;
        case 'truncated-payload': tail = record(value.payload, 0, value.payload.length + 1 + value.selector % 17); break;
        case 'missing-trailer': tail = Buffer.alloc(0); code = 2; break;
        case 'duplicate-trailer': tail = Buffer.concat([ok(), ok()]); break;
        case 'after-trailer': tail = Buffer.concat([ok(), record(value.payload)]); break;
        case 'invalid-binary': tail = trailer(`grpc-status: 0\r\ntrace-bin: ${['A', 'AB==', 'AAB=', '!!', 'AA=A'][value.selector % 5]}\r\n`); break;
        case 'duplicate-status': tail = trailer('grpc-status: 0\r\ngrpc-status: 7\r\n'); break;
        case 'invalid-status': tail = trailer(`grpc-status: ${['00', '17', '-1', '1, 2', 'NaN'][value.selector % 5]}\r\n`); break;
        case 'invalid-trailer': tail = trailer('grpc-status: 0\r\nno-colon\r\n'); break;
        case 'nonascii-trailer': tail = record(Buffer.from([255, 13, 10]), 128); break;
        case 'compressed-trailer': tail = record(text('grpc-status: 0\r\n'), 129); code = 12; break;
        case 'unsupported-encoding': tail = record(zlib.gzipSync(value.payload), 1); headers['grpc-encoding'] = 'fixture-unknown'; code = 12; break;
        case 'compressed-identity': tail = record(value.payload, 1); break;
        case 'corrupt-gzip': tail = record(Buffer.from([31, 139, 0, value.selector % 256]), 1); headers['grpc-encoding'] = 'gzip'; break;
        case 'decoded-limit': tail = record(zlib.gzipSync(Buffer.alloc(513 + value.selector % 512, 65)), 1); headers['grpc-encoding'] = 'gzip'; code = 8; break;
        case 'invalid-header-metadata': tail = ok(); headers['trace-bin'] = 'AB=='; received = []; break;
        case 'body-after-header-status': tail = record(value.payload); headers['grpc-status'] = '0'; received = []; break;
        case 'trailer-without-status': tail = trailer('x-trace: present\r\n'); code = 2; break;
        default: throw new Error('Unknown malformed case');
    }
    return sample(Buffer.concat([...prefix.map(data => record(data)), tail]), value.input, value.streaming, value.plan, headers,
        { ...expected(received, value.streaming, code), details: undefined });
}

function streamBoundary(value) {
    // Derive the oracle from whole-record boundaries, independently of a stream
    // decoder. A cut inside even the last trailer byte is a protocol failure;
    // a cut at a data boundary is clean EOF with a missing gRPC status.
    const records = value.payloads.map(data => record(data));
    records.push(trailer(`grpc-status: ${value.code}\r\n`));
    const complete = Buffer.concat(records);
    let wire, received = [], code;
    if (value.mutation === 'append') {
        wire = Buffer.concat([complete, value.suffix]);
        received = value.payloads;
        code = value.suffix.length ? 13 : value.code;
    } else {
        const cut = value.selector % (complete.length + 1);
        wire = complete.subarray(0, cut);
        let position = 0;
        code = 2;
        for (let index = 0; index < records.length; index++) {
            const end = position + records[index].length;
            if (cut === position) break;
            if (cut < end) { code = 13; break; }
            if (index < value.payloads.length) received.push(value.payloads[index]);
            else code = value.code;
            position = end;
        }
    }
    return sample(wire, value.input, true, value.plan, {}, { ...expected(received, true, code), details: undefined });
}

function checkResult(actual, wanted) {
    assert.equal(actual.statuses.length, 1);
    assert.equal(actual.statuses[0].code, wanted.code, 'terminal code');
    if (wanted.details !== undefined) assert.equal(actual.statuses[0].details, wanted.details, 'status details');
    assert.deepEqual(actual.statuses[0].trace, wanted.trace, 'binary trailer metadata');
    if (wanted.payloads) assert.deepEqual(actual.payloads, wanted.payloads, 'stream prefix including error cases');
    else { assert.equal(actual.callbackCode, wanted.callbackCode, 'unary callback code'); assert.equal(actual.value, wanted.value, 'unary response bytes'); }
    assert.equal(actual.activeCalls, 0);
    assert.deepEqual(actual.diagnostics, { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
}
async function exercise(value) {
    let timer;
    const invocation = ++report.caseExecutions;
    const response = await Promise.race([runtime.dispatchFetch('https://fuzz-driver.test/case', {
        method: 'POST', body: JSON.stringify({ sample: value, recovery }), headers: { 'content-type': 'application/json' },
    }), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('WORKER_CASE_TIMEOUT')), 12000); })])
        .finally(() => clearTimeout(timer));
    const data = await response.json();
    report.runtimeExecuted = true;
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.status, 'passed');
    assert.equal(data.invocation, invocation, 'same Worker isolate reused across generated cases');
    assert.deepEqual(data.results.map(result => result.mode), ['cloudflare', 'grpc-web']);
    for (const result of data.results) {
        checkResult(result.actual, value.expected); checkResult(result.reused, recovery.expected);
        for (const cleanup of result.cleanup) {
            assert.equal(cleanup.bodyLocked, false); assert.equal(cleanup.sourceLocked, false);
            assert.equal(cleanup.cancellations, cleanup.ended ? 0 : 1);
            report.responseCancellations += cleanup.cancellations;
            report.responseReadersReleased++;
            report.emptyChunksDelivered += cleanup.emptyChunks;
            report.offsetChunksDelivered += cleanup.offsetChunks;
        }
        report.rpcCount += 2;
        report.rpcCalls += 2;
    }
    assert.equal(report.outboundAttempts, 0, 'no network outside local service bindings');
    report.successfulCaseExecutions++;
}

async function main() {
    assert.deepEqual(process.argv.slice(2), [], 'This gate tests only the installed package; no source-build fallback');
    const seed = integer('WGA_WORKER_FUZZ_SEED', 1470698469, -2147483648, 2147483647);
    const numRuns = integer('WGA_WORKER_FUZZ_RUNS', 150, 1, 10000);
    const replayPath = process.env.WGA_WORKER_FUZZ_PATH, selected = process.env.WGA_WORKER_FUZZ_PROPERTY;
    const names = ['valid-unary', 'valid-stream', 'malformed-response', 'stream-boundaries'];
    if (selected !== undefined && !names.includes(selected)) throw new Error(`WGA_WORKER_FUZZ_PROPERTY must be one of ${names.join(', ')}`);
    if (replayPath !== undefined && (!/^\d+(?::\d+)*$/.test(replayPath) || !selected || process.env.WGA_WORKER_FUZZ_SEED === undefined))
        throw new Error('Exact replay requires WGA_WORKER_FUZZ_PROPERTY, WGA_WORKER_FUZZ_SEED and a valid WGA_WORKER_FUZZ_PATH');
    report.parameters = { seed, numRuns, ...(selected ? { property: selected } : {}), ...(replayPath === undefined ? {} : { path: replayPath }),
        propertyTimeoutMs: 180000, caseTimeoutMs: 12000, maxPayloadBytes: 192, maxStreamMessages: 5,
        maxReceiveBytes: 512, maxWireBytes: 2048, memoryBound: 'finite generators, one serial case, bounded payloads; no load benchmark' };
    report.miniflare = req('miniflare/package.json').version;
    report.workerd = req('workerd/package.json').version;
    report.fastCheck = require('fast-check/package.json').version;
    report.evidence = Object.fromEntries(['scripts/test-workerd-fuzz.cjs', 'fixtures/worker/fuzz-client.mjs',
        'fixtures/worker/fuzz-peer.mjs', 'fixtures/worker/package-lock.json', 'package-lock.json']
        .map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    const installed = path.dirname(req.resolve('@grpc/grpc-js/package.json'));
    report.installedRuntimeHashes = Object.fromEntries(['dist/index.mjs', 'dist/adapter.mjs'].map(file => [file, digest(fs.readFileSync(path.join(installed, file)))]));
    report.packageSha256 = digest(fs.readFileSync(path.join(root, 'artifacts/workers-grpc-adapter-0.0.0-prototype.1.tgz')));
    const banner = `import * as b from 'node:buffer';import * as e from 'node:events';import * as s from 'node:stream';import * as z from 'node:zlib';const builtins={'node:buffer':b,'node:events':e,'node:stream':s,'node:zlib':z};const require=name=>{if(Object.hasOwn(builtins,name))return builtins[name];throw new Error('Unsupported runtime require');};`;
    const bundle = await req('esbuild').build({ entryPoints: [path.join(root, 'fixtures/worker/fuzz-client.mjs')], bundle: true,
        write: false, metafile: true, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:*'], banner: { js: banner } });
    report.bundleInputs = Object.keys(bundle.metafile.inputs).sort();
    assert.ok(report.bundleInputs.some(file => file.includes('fixtures/worker/node_modules/@grpc/grpc-js/dist/index.mjs')));
    assert.ok(report.bundleInputs.every(file => !file.startsWith('src/') && !file.startsWith('dist/')), 'installed package only');
    report.bundleSha256 = digest(bundle.outputFiles[0].contents);
    const outboundService = async () => { report.outboundAttempts++; throw new Error('FUZZ_EXTERNAL_NETWORK_BLOCKED'); };
    runtime = new Miniflare(convertV4MiniflareOptions({ log: new Log(LogLevel.NONE), workers: [
        { name: 'fuzz-client', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: report.compatibilityDate,
            compatibilityFlags: ['nodejs_compat'], serviceBindings: { PEER: 'fuzz-peer' }, outboundService },
        { name: 'fuzz-peer', modules: true, script: fs.readFileSync(path.join(root, 'fixtures/worker/fuzz-peer.mjs'), 'utf8'),
            compatibilityDate: report.compatibilityDate, outboundService },
    ] }));
    save();
    try {
        // Every fault family executes even when the selected random seed omits it.
        // Skip the corpus for replay so the seed/path selects exactly one property.
        if (replayPath === undefined && selected === undefined) {
            for (const kind of malformedKinds) for (const streaming of [false, true]) {
                await exercise(malformed({ kind, streaming, prefix: true, selector: 3, payload: Uint8Array.from([0, 255, 1]),
                    input: Uint8Array.from([7, 0, 128]), plan: defaultPlan }));
                report.boundaries.push({ kind, streaming, modes: 2, passed: true });
            }
            // Explicit empty/offset payloads and compressed empty records.
            for (const streaming of [false, true]) for (const encoding of ['identity', 'gzip', 'deflate']) {
                await exercise(valid({ payload: new Uint8Array(), payloads: [new Uint8Array(), Uint8Array.from([0, 255])], input: new Uint8Array(),
                    encoding, mixed: true, code: 0, message: 'empty', trace: new Uint8Array(), plan: defaultPlan }, streaming));
                report.boundaries.push({ kind: 'empty-payload', streaming, encoding, modes: 2, passed: true });
            }
        }
        const common = { input: payload, plan: fragmentation, encoding: fc.constantFrom('identity', 'gzip', 'deflate'), mixed: fc.boolean(),
            code: fc.integer({ min: 0, max: 16 }), message: fc.string({ maxLength: 20 }), trace: fc.uint8Array({ maxLength: 16 }) };
        const properties = [
            ['valid-unary', fc.record({ ...common, payload }).map(value => valid(value, false))],
            ['valid-stream', fc.record({ ...common, payloads: fc.array(payload, { maxLength: 5 }) }).map(value => valid(value, true))],
            ['malformed-response', fc.record({ kind: fc.constantFrom(...malformedKinds), streaming: fc.boolean(), prefix: fc.boolean(),
                selector: fc.nat({ max: 100000 }), payload, input: payload, plan: fragmentation }).map(malformed)],
            ['stream-boundaries', fc.record({ payloads: fc.array(payload, { maxLength: 5 }), code: fc.integer({ min: 0, max: 16 }),
                mutation: fc.constantFrom('truncate', 'append'), suffix: fc.uint8Array({ maxLength: 32 }), selector: fc.nat({ max: 100000 }),
                input: payload, plan: fragmentation }).map(streamBoundary)],
        ];
        for (const [name, arbitrary] of properties) {
            if (selected && selected !== name) continue;
            const entry = { name, status: 'running', requestedRuns: numRuns, seed };
            report.properties.push(entry); save();
            const started = Date.now(), before = report.caseExecutions;
            const details = await fc.check(fc.asyncProperty(arbitrary, exercise), { seed, numRuns,
                interruptAfterTimeLimit: 180000, markInterruptAsFailure: true,
                ...(replayPath === undefined ? {} : { path: replayPath, endOnFailure: true }) });
            Object.assign(entry, { status: details.failed || details.interrupted ? 'failed' : 'passed',
                numRuns: details.numRuns, runs: details.numRuns, completedRuns: details.numRuns - (details.failed ? 1 : 0),
                numSkips: details.numSkips, numShrinks: details.numShrinks,
                failed: details.failed, interrupted: details.interrupted, completedCaseExecutions: report.caseExecutions - before,
                elapsedMs: Date.now() - started });
            if (details.failed || details.interrupted) {
                entry.counterexample = details.counterexample;
                entry.counterexamplePath = details.counterexamplePath;
                entry.diagnostic = details.errorInstance?.stack ?? details.error ?? 'Property interrupted';
                entry.replay = `WGA_WORKER_FUZZ_SEED=${seed} WGA_WORKER_FUZZ_RUNS=${numRuns} WGA_WORKER_FUZZ_PROPERTY=${name} WGA_WORKER_FUZZ_PATH=${details.counterexamplePath} node scripts/test-workerd-fuzz.cjs`;
                save(); throw new Error(`WORKER_FUZZ_FAILED: ${name}: ${entry.diagnostic}`);
            }
            assert.equal(details.numRuns, numRuns, 'an incomplete property must fail closed');
            save();
        }
        report.completedProperties = report.properties.length;
        report.totalGeneratedCases = report.properties.reduce((sum, entry) => sum + entry.numRuns, 0);
        report.coldInvocations = report.caseExecutions ? 1 : 0;
        report.warmInvocations = Math.max(0, report.caseExecutions - 1);
        assert.equal(report.outboundAttempts, 0);
        assert.equal(report.responseReadersReleased, report.rpcCount);
        report.status = 'passed';
    } finally { await runtime.dispose(); report.runtimeDisposed = true; }
}
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(signal, () => {
    report.status = 'interrupted'; report.interruptedBy = signal; report.finishedAt = new Date().toISOString(); save();
    process.exitCode = exitCode;
    const force = setTimeout(() => process.exit(exitCode), 1000);
    Promise.resolve(runtime?.dispose()).finally(() => { clearTimeout(force); process.exit(exitCode); });
});
main().catch(error => { report.status = 'failed'; report.diagnostic = error.stack ?? error.message; process.exitCode = 1; }).finally(() => {
    report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ status: report.status, properties: report.properties.length, generatedCases: report.totalGeneratedCases,
        boundaryCases: report.boundaries.length, rpcCount: report.rpcCount, runtimeDisposed: report.runtimeDisposed,
        ...(report.diagnostic ? { diagnostic: report.diagnostic } : {}), report: path.relative(root, reportPath) }));
});
