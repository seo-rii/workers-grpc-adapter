'use strict';
// A test-only, fixed-upstream gRPC-Web bridge. Not a production proxy or grpc-js oracle.
const { test } = require('node:test');
const http = require('node:http');
const h2 = require('node:http2');
const { once } = require('node:events');
const { assert, grpc, Echo, serialize, deserialize, unary } = require('./helpers.cjs');
const { encodeFrame } = require('../dist/wire.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}
async function stop(server) {
    await new Promise(resolve => server.close(resolve));
}
test('INTEROP real TCP HTTP/2 native gRPC server + fixed gRPC-Web bridge', { timeout: 10000 }, async () => {
    const seen = [], sessions = new Set();
    const upstream = h2.createServer();
    upstream.on('session', session => {
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
    });
    upstream.on('stream', (stream, headers) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', () => {
        });
        stream.on('end', () => {
            const data = Buffer.concat(chunks);
            assert.equal(data[0], 0);
            assert.equal(data.readUInt32BE(1), data.length - 5);
            const request = deserialize(data.subarray(5));
            seen.push({ method: headers[':path'], text: request.text });
            stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'x-server': 'native-h2' }, { waitForTrailers: true });
            stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'trace-bin': 'AQI=' }));
            const replies = headers[':path'].endsWith('/Stream') ? [{ text: 'one' }, { text: 'two' }, { text: 'three' }] : [{ text: 'echo:' + request.text }];
            for (const reply of replies) {
                const frame = encodeFrame(serialize(reply));
                stream.write(frame.subarray(0, 3));
                stream.write(frame.subarray(3));
            }
            stream.end();
        });
    });
    const upPort = await listen(upstream);
    const bridge = http.createServer((req, res) => {
        if (req.method !== 'POST' || !['/demo.Echo/Unary', '/demo.Echo/Stream'].includes(req.url) || req.headers['content-type'] !== 'application/grpc-web+proto') {
            res.writeHead(404);
            res.end();
            return;
        }
        const session = h2.connect(`http://127.0.0.1:${upPort}`);
        session.on('error', () => {
        });
        const call = session.request({ ':method': 'POST', ':path': req.url, 'content-type': 'application/grpc', te: 'trailers' });
        let ended = false, hadTrailers = false;
        call.on('response', headers => res.writeHead(200, { 'content-type': 'application/grpc-web+proto', 'x-server': headers['x-server'] }));
        call.on('data', data => res.write(data));
        call.on('trailers', headers => {
            hadTrailers = true;
            const text = Object.entries(headers).filter(([k]) => !k.startsWith(':')).map(([k, v]) => `${k}: ${v}\r\n`).join('');
            res.write(encodeFrame(Buffer.from(text), true));
        });
        call.on('end', () => {
            ended = true;
            if (!hadTrailers) {
                res.write(encodeFrame(Buffer.from('grpc-status: 2\r\n'), true));
            }
            res.end();
            session.close();
        });
        call.on('error', () => {
            ended = true;
            res.destroy();
            session.destroy();
        });
        res.on('close', () => {
            if (!ended) {
                call.close(h2.constants.NGHTTP2_CANCEL);
                session.close();
            }
        });
        req.pipe(call);
    });
    const bridgePort = await listen(bridge);
    let client;
    try {
        const transport = createWorkersGrpcTransport({ mode: 'grpc-web', allowInsecureLocalhost: true, endpoints: { 'echo.test': `http://127.0.0.1:${bridgePort}` } });
        client = new Echo('echo.test', grpc.credentials.createInsecure(), transport.grpcOptions());
        const { call, promise } = unary(client, { text: 'socket' });
        let initial, final;
        call.on('metadata', m => initial = m);
        call.on('status', s => final = s);
        assert.deepEqual(await promise, { text: 'echo:socket' });
        assert.equal(initial.get('x-server')[0], 'native-h2');
        assert.deepEqual(final.metadata.get('trace-bin'), [Buffer.from([1, 2])]);
        const items = [];
        for await (const item of client.stream({ text: 'stream' })) {
            items.push(item.text);
        }
        assert.deepEqual(items, ['one', 'two', 'three']);
        assert.deepEqual(seen, [{ method: '/demo.Echo/Unary', text: 'socket' }, { method: '/demo.Echo/Stream', text: 'stream' }]);
        assert.equal(client.getChannel().activeCallCount(), 0);
    }
    finally {
        client?.close();
        bridge.closeAllConnections();
        await stop(bridge);
        for (const s of sessions) {
            s.destroy();
        }
        await stop(upstream);
    }
});
