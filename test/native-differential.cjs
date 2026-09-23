'use strict';
// Independent native grpc-js server/client oracle. The loopback bridge only
// translates HTTP framing; it never decodes messages or invents RPC outcomes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const h2 = require('node:http2');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const replacement = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { serialize, deserialize } = require('./helpers.cjs');
const methods = Object.fromEntries(['Unary', 'Stream'].map(name => [name.toLowerCase(), {
    path: `/oracle.Echo/${name}`, requestStream: false, responseStream: name === 'Stream',
    requestSerialize: serialize, requestDeserialize: deserialize,
    responseSerialize: serialize, responseDeserialize: deserialize,
}]));
const results = [];
function frameTrailer(headers) {
    const body = Buffer.from(Object.entries(headers).filter(([k]) => !k.startsWith(':'))
        .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map(item => `${k}: ${item}\r\n`)).join(''));
    const prefix = Buffer.alloc(5);
    prefix[0] = 128;
    prefix.writeUInt32BE(body.length, 1);
    return Buffer.concat([prefix, body]);
}
function metadata(grpc) {
    const m = new grpc.Metadata();
    m.set('x-oracle', 'native');
    m.add('trace-bin', Buffer.from([0, 255]));
    m.add('trace-bin', Buffer.from([1, 128]));
    return m;
}
function selectedMetadata(m) {
    return { marker: m.get('x-oracle'), trace: m.get('trace-bin').map(b => b.toString('hex')) };
}
function unaryTrace(client, text, options) {
    return new Promise(resolve => {
        const trace = [];
        const call = client.unary({ text }, options || {}, (error, value) => {
            trace.push(['callback', error?.code ?? 0, value?.text ?? null]);
        });
        call.on('metadata', m => trace.push(['metadata', selectedMetadata(m)]));
        call.on('status', s => { trace.push(['status', s.code, s.details, selectedMetadata(s.metadata)]); resolve(trace); });
    });
}
function streamTrace(client, text) {
    return new Promise(resolve => {
        const trace = [];
        const call = client.stream({ text });
        call.on('metadata', m => trace.push(['metadata', selectedMetadata(m)]));
        call.on('data', value => trace.push(['data', value.text]));
        call.on('error', e => trace.push(['error', e.code, e.details]));
        call.on('status', s => trace.push(['status', s.code, s.details, selectedMetadata(s.metadata)]));
        call.on('end', () => { trace.push(['end']); resolve(trace); });
    });
}
async function main() {
    const reached = { native: 0, adapter: 0 };
    let route = 'native';
    const server = new native.Server();
    server.addService(methods, {
        unary(call, callback) {
            reached[route]++;
            call.sendMetadata(metadata(native));
            if (call.request.text === 'denied') {
                callback({ code: 7, details: 'permission denied', metadata: metadata(native) });
            } else {
                callback(null, { text: `echo:${call.request.text}` }, metadata(native));
            }
        },
        stream(call) {
            reached[route]++;
            call.sendMetadata(metadata(native));
            if (call.request.text !== 'empty') {
                call.write({ text: 'first' });
                call.write({ text: 'last' });
            }
            if (call.request.text === 'denied') {
                call.emit('error', { code: 7, details: 'permission denied', metadata: metadata(native) });
            } else {
                call.end(metadata(native));
            }
        },
    });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', native.ServerCredentials.createInsecure(), (e, p) => e ? reject(e) : resolve(p)));
    const sessions = new Set();
    let requests = 0;
    const bridge = http.createServer((request, response) => {
        assert.equal(request.headers['content-type'], 'application/grpc-web+proto');
        requests++;
        const session = h2.connect(`http://127.0.0.1:${port}`);
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
        session.on('error', () => response.destroy());
        const upstream = session.request({ ':method': 'POST', ':path': request.url,
            'content-type': 'application/grpc', te: 'trailers',
            ...(request.headers['grpc-timeout'] ? { 'grpc-timeout': request.headers['grpc-timeout'] } : {}),
        });
        let hasStatus = false;
        upstream.on('response', headers => {
            const out = Object.fromEntries(Object.entries(headers).filter(([k]) => !k.startsWith(':') && !['content-type', 'content-length'].includes(k)));
            response.writeHead(200, { ...out, 'content-type': 'application/grpc-web+proto' });
            hasStatus = headers['grpc-status'] !== undefined;
        });
        upstream.on('data', chunk => response.write(chunk));
        upstream.on('trailers', headers => { hasStatus = true; response.write(frameTrailer(headers)); });
        upstream.on('end', () => {
            assert.ok(hasStatus, 'native server must send its own terminal status');
            response.end();
            session.close();
        });
        upstream.on('error', () => { response.destroy(); session.destroy(); });
        response.on('close', () => { if (!upstream.closed) upstream.close(h2.constants.NGHTTP2_CANCEL); session.close(); });
        request.pipe(upstream);
    });
    bridge.listen(0, '127.0.0.1');
    await once(bridge, 'listening');
    const NativeClient = native.makeGenericClientConstructor(methods, 'oracle.Echo');
    const AdapterClient = replacement.makeGenericClientConstructor(methods, 'oracle.Echo');
    const nativeClient = new NativeClient(`127.0.0.1:${port}`, native.credentials.createInsecure(), { 'grpc.enable_retries': 0 });
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', allowInsecureLocalhost: true,
        endpoints: { 'oracle.test': `http://127.0.0.1:${bridge.address().port}` } });
    const adapterClient = new AdapterClient('oracle.test', replacement.credentials.createInsecure(), transport.grpcOptions());
    try {
        for (const [kind, text] of [['unary', 'ok'], ['unary', 'denied'], ['stream', 'ok'], ['stream', 'empty'], ['stream', 'denied']]) {
            const run = kind === 'unary' ? unaryTrace : streamTrace;
            route = 'native';
            const expected = await run(nativeClient, text);
            route = 'adapter';
            const actual = await run(adapterClient, text);
            assert.deepEqual(actual, expected, `${kind}/${text}: native event contract`);
            results.push({ id: `${kind}/${text}`, status: 'passed', trace: actual });
        }
        for (const grpc of [native, replacement]) {
            const original = metadata(grpc), clone = original.clone();
            original.get('trace-bin')[0][0] = 42;
            const observed = { mapPrototype: Object.getPrototypeOf(original.getMap()) === Object.prototype,
                clonedBinary: clone.get('trace-bin')[0].toString('hex'), values: original.get('x-oracle') };
            if (grpc === native) results.push({ id: 'metadata-contract', status: 'passed', expected: observed });
            else assert.deepEqual(observed, results.at(-1).expected);
        }
        assert.equal(requests, 5);
        assert.deepEqual(reached, { native: 5, adapter: 5 });
        assert.equal(adapterClient.getChannel().activeCallCount(), 0);
        const report = { status: 'passed', upstreamVersion: nativeRequire('@grpc/grpc-js/package.json').version,
            scope: 'native-grpc-js-loopback-differential', envoy: false, liveCloud: false,
            contentType: 'application/grpc-web+proto', requests, serverReached: reached, results };
        fs.writeFileSync(path.join(root, 'verification/native-differential.json'), JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ status: report.status, cases: results.length, serverReached: reached }));
    } finally {
        nativeClient.close();
        adapterClient.close();
        bridge.closeAllConnections();
        for (const session of sessions) session.destroy();
        await new Promise(resolve => bridge.close(resolve));
        server.forceShutdown();
    }
}
const timeout = setTimeout(() => { console.error('Native differential test timed out'); process.exit(1); }, 20000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
