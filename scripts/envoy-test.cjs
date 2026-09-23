'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const pin = require('../fixtures/envoy/binary.json');
const binary = process.env.WGA_ENVOY_BINARY || path.join(root, 'fixtures/envoy/.cache', `envoy-${pin.version}`);
const reportPath = path.join(root, 'verification/envoy.json');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const { serialize, deserialize } = require('../test/helpers.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function writeReport(value) { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(value, null, 2) + '\n'); }
async function unusedPort() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}
async function until(check, label, milliseconds = 5000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) { if (await check()) return; await delay(20); }
    throw new Error(`Timed out waiting for ${label}`);
}
const methods = Object.fromEntries(['Unary', 'Stream'].map(name => [name.toLowerCase(), {
    path: `/interop.Echo/${name}`, requestStream: false, responseStream: name === 'Stream',
    requestSerialize: serialize, requestDeserialize: deserialize,
    responseSerialize: serialize, responseDeserialize: deserialize,
}]));
function meta(marker) { const result = new native.Metadata(); result.set('x-envoy-fixture', marker); result.set('trace-bin', Buffer.from([1, 128, 255])); return result; }
function selected(metadata) { return { marker: metadata.get('x-envoy-fixture'), binary: metadata.get('trace-bin').map(value => value.toString('hex')) }; }
function trailerSummary(bytes) {
    let offset = 0, messages = 0;
    const trailer = [];
    while (offset < bytes.length) {
        assert.ok(offset + 5 <= bytes.length);
        const flag = bytes[offset], length = bytes.readUInt32BE(offset + 1);
        offset += 5;
        assert.ok(offset + length <= bytes.length);
        if (flag === 128) {
            const payload = bytes.subarray(offset, offset + length).toString('ascii');
            trailer.push({ flag, grpcStatus: /(?:^|\r\n)grpc-status: ?([0-9]+)(?:\r\n|$)/.exec(payload)?.[1] ?? null });
        } else { assert.equal(flag, 0); messages++; }
        offset += length;
    }
    return { messages, trailers: trailer };
}
async function main() {
    if (!fs.existsSync(binary)) {
        writeReport({ status: 'blocked', runtimeExecuted: false, reason: 'Pinned Envoy binary missing; run node fixtures/envoy/download.cjs', pin });
        process.exitCode = 2;
        return;
    }
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), pin.sha256, 'Envoy binary must match pin');
    const versionOutput = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
    const logs = path.join(os.homedir(), 'logs');
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    fs.chmodSync(logs, 0o700);
    const processLog = path.join(logs, `wga-envoy-process-${Date.now()}-${process.pid}.log`);
    const fd = fs.openSync(processLog, 'wx', 0o600);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-envoy-'));
    const arrivals = {}, cancellations = {}, upstreamHeaders = [], captures = [], results = [];
    const server = new native.Server();
    function arrived(call) {
        const id = call.metadata.get('x-wga-case')[0];
        arrivals[id] = (arrivals[id] ?? 0) + 1;
        call.on('cancelled', () => { cancellations[id] = (cancellations[id] ?? 0) + 1; });
        call.sendMetadata(meta('initial'));
        return id;
    }
    server.addService(methods, {
        unary(call, callback) {
            const id = arrived(call);
            if (id === 'deadline' || id === 'cancel') return;
            if (id === 'unary-denied') callback({ code: 7, details: 'permission denied', metadata: meta('trailing') });
            else callback(null, { text: 'echo:' + call.request.text }, meta('trailing'));
        },
        stream(call) {
            const id = arrived(call);
            call.write({ text: 'first' });
            call.write({ text: 'last' });
            if (id === 'stream-denied') call.emit('error', { code: 7, details: 'permission denied', metadata: meta('trailing') });
            else call.end(meta('trailing'));
        },
    });
    let envoy, client;
    const savedFetch = globalThis.fetch;
    let exitResult;
    try {
        const nativePort = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
        // Read-only wire observation of the pinned native server's HTTP/2 socket.
        // No HTTP translation or synthesized trailers are implemented here.
        for (const h2server of server.http2Servers.keys()) h2server.on('stream', (_stream, headers) => {
            upstreamHeaders.push({ case: headers['x-wga-case'], method: headers[':path'], contentType: headers['content-type'], timeout: headers['grpc-timeout'] ?? null });
        });
        const [envoyPort, adminPort] = await Promise.all([unusedPort(), unusedPort()]);
        const yaml = fs.readFileSync(path.join(root, 'fixtures/envoy/envoy.yaml'), 'utf8')
            .replaceAll('__NATIVE_PORT__', String(nativePort)).replaceAll('__ENVOY_PORT__', String(envoyPort)).replaceAll('__ADMIN_PORT__', String(adminPort));
        const config = path.join(scratch, 'envoy.yaml');
        fs.writeFileSync(config, yaml, { mode: 0o600 });
        envoy = spawn(binary, ['-c', config, '--concurrency', '1', '--disable-hot-restart', '--log-level', 'warning'], { stdio: ['ignore', fd, fd] });
        const exited = new Promise(resolve => {
            envoy.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
            envoy.once('error', error => { exitResult = { code: null, error: error.message }; resolve(exitResult); });
        });
        await until(async () => {
            if (exitResult) throw new Error(`Envoy startup failed; inspect ${processLog}`);
            try { return (await savedFetch(`http://127.0.0.1:${adminPort}/ready`, { signal: AbortSignal.timeout(300) })).ok; } catch { return false; }
        }, 'Envoy readiness');
        const downstream = [];
        globalThis.fetch = async (url, init) => {
            const id = init.headers.get('x-wga-case');
            const entry = { case: id, requestContentType: init.headers.get('content-type'), responseContentType: null };
            downstream.push(entry);
            const response = await savedFetch(url, init);
            entry.responseContentType = response.headers.get('content-type');
            if (id !== 'deadline' && id !== 'cancel') captures.push(response.clone().arrayBuffer().then(bytes => { entry.wire = trailerSummary(Buffer.from(bytes)); }));
            return response;
        };
        const transport = createWorkersGrpcTransport({ mode: 'grpc-web', allowInsecureLocalhost: true, defaultTimeoutMs: 3000, endpoints: { 'envoy.test': `http://127.0.0.1:${envoyPort}` } });
        const Client = grpc.makeGenericClientConstructor(methods, 'interop.Echo');
        client = new Client('envoy.test', grpc.credentials.createInsecure(), transport.grpcOptions());
        async function run(id, stream = false) {
            const trace = [];
            const metadata = new grpc.Metadata(); metadata.set('x-wga-case', id);
            let call;
            const completed = new Promise(resolve => {
                if (stream) {
                    call = client.stream({ text: id }, metadata);
                    call.on('data', value => trace.push(['data', value.text]));
                    call.on('error', error => trace.push(['error', error.code, error.details]));
                    call.on('end', () => trace.push(['end']));
                } else {
                    call = client.unary({ text: id }, metadata, id === 'deadline' ? { deadline: Date.now() + 300 } : {}, (error, value) => trace.push(['callback', error?.code ?? 0, value?.text ?? null]));
                }
                call.on('metadata', value => trace.push(['metadata', selected(value)]));
                call.on('status', value => { trace.push(['status', value.code, value.details, selected(value.metadata)]); resolve(value); });
            });
            if (id === 'cancel') { await until(() => arrivals[id] === 1, 'server arrival before cancel'); call.cancel(); }
            const terminal = await completed;
            if (stream) await delay(0);
            const expected = id === 'deadline' ? 4 : id === 'cancel' ? 1 : id.endsWith('denied') ? 7 : 0;
            assert.equal(terminal.code, expected, id);
            assert.equal(arrivals[id], 1, 'one server arrival per call');
            if (stream) assert.deepEqual(trace.filter(event => event[0] === 'data'), [['data', 'first'], ['data', 'last']]);
            if (expected === 0 && !stream) assert.deepEqual(trace.find(event => event[0] === 'callback'), ['callback', 0, 'echo:' + id]);
            if (expected === 0 || expected === 7) assert.deepEqual(selected(terminal.metadata), { marker: ['trailing'], binary: ['0180ff'] });
            if (id === 'deadline' || id === 'cancel') await until(() => cancellations[id] >= 1, 'upstream cancellation');
            assert.equal(client.getChannel().activeCallCount(), 0);
            results.push({ id, status: 'passed', code: terminal.code, serverArrivals: arrivals[id], upstreamCancellationObserved: id === 'deadline' || id === 'cancel' ? cancellations[id] >= 1 : undefined, trace });
        }
        for (const [id, streaming] of [['unary-ok', false], ['stream-ok', true], ['unary-denied', false], ['stream-denied', true], ['deadline', false], ['cancel', false]]) await run(id, streaming);
        await Promise.all(captures);
        assert.equal(downstream.length, 6);
        assert.equal(upstreamHeaders.length, 6);
        for (const entry of downstream) {
            assert.equal(entry.requestContentType, 'application/grpc-web+proto');
            assert.match(entry.responseContentType, /^application\/grpc-web(?:\+proto)?$/);
            if (entry.wire) assert.deepEqual(entry.wire.trailers, [{ flag: 128, grpcStatus: entry.case.endsWith('denied') ? '7' : '0' }]);
        }
        for (const entry of upstreamHeaders) assert.match(entry.contentType, /^application\/grpc(?:\+proto)?$/);
        client.close(); client = null;
        globalThis.fetch = savedFetch;
        envoy.kill('SIGTERM');
        await Promise.race([exited, delay(3000).then(() => { if (!exitResult) envoy.kill('SIGKILL'); })]);
        await exited;
        const report = { status: 'passed', runtimeExecuted: true, scope: 'local Envoy grpc_web -> native grpc-js HTTP/2 server', liveCloud: false, node: process.version, nativeGrpcVersion: nativeRequire('@grpc/grpc-js/package.json').version, envoy: { ...pin, versionOutput, pid: envoy.pid, exit: exitResult, log: processLog }, requests: downstream.length, upstreamHeaders, downstream, results };
        writeReport(report);
        console.log(JSON.stringify({ status: 'passed', cases: results.length, requests: downstream.length, envoyLog: processLog, envoyExit: exitResult }));
    } finally {
        globalThis.fetch = savedFetch;
        client?.close();
        if (envoy && !exitResult) { envoy.kill('SIGTERM'); await Promise.race([once(envoy, 'exit'), delay(3000)]); if (!exitResult) envoy.kill('SIGKILL'); }
        server.forceShutdown();
        fs.closeSync(fd);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}
main().catch(error => { writeReport({ status: 'failed', runtimeExecuted: true, reason: error.message, pin }); console.error(error); process.exitCode = 1; });
