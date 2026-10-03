'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, methods, client, serialize, deserialize, response, withFetch, unary, immediate, trailers, byteStream, transportCall } = require('./helpers.cjs');
const { encodeFrame } = require('../dist/wire.js');
test('CLIENT unary makes one framed request and reports metadata/callback/status', async () => withFetch(async (url, init) => {
    assert.equal(url, 'https://echo.test/demo.Echo/Unary');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.get('content-type'), 'application/grpc-web');
    assert.deepEqual(init.cf, { grpcWeb: 'convert' });
    assert.deepEqual(deserialize(Buffer.from(init.body).subarray(5)), { text: 'request' });
    return response([{ text: 'reply' }], { headers: { 'x-initial': 'yes' }, extra: 'x-trailing: done\r\n', chunkSize: 1 });
}, async () => {
    const c = client();
    const events = [];
    const { call, promise } = unary(c);
    call.on('metadata', m => events.push(['metadata', m.get('x-initial')[0]]));
    call.on('status', s => events.push(['status', s.code, s.metadata.get('x-trailing')[0]]));
    assert.deepEqual(await promise, { text: 'reply' });
    assert.deepEqual(events, [['metadata', 'yes'], ['status', 0, 'done']]);
    assert.equal(c.getChannel().activeCallCount(), 0);
    assert.equal(transportCall(call).diagnostics().fetchCount, 1);
    c.close();
}));
for (const variant of ['callback', 'metadata', 'options', 'both']) {
    test(`CLIENT unary overload ${variant}`, async () => withFetch(async () => response(), async () => {
        const c = client(), m = new grpc.Metadata();
        m.set('x', 'v');
        const opts = { deadline: Date.now() + 5000 };
        const args = variant === 'callback' ? [] : variant === 'metadata' ? [m] : variant === 'options' ? [opts] : [m, opts];
        assert.deepEqual(await unary(c, { text: 'x' }, ...args).promise, { text: 'ok' });
        c.close();
    }));
}
test('CLIENT generated aliases/service metadata and package definitions', async () => {
    const descriptor = { format: 'Protocol Buffer 3 DescriptorProto', type: { name: 'Echo' } };
    const tree = grpc.loadPackageDefinition({ 'demo.Echo': methods, 'demo.Message': descriptor });
    assert.strictEqual(tree.demo.Message, descriptor);
    assert.strictEqual(tree.demo.Echo.service, methods);
    assert.equal(tree.demo.Echo.serviceName, 'Echo');
    assert.strictEqual(tree.demo.Echo.prototype.unary, tree.demo.Echo.prototype.Unary);
    await withFetch(async () => response(), async () => {
        const c = new tree.demo.Echo('echo.test', grpc.credentials.createSsl());
        assert.deepEqual(await new Promise((resolve, reject) => c.Unary({ text: 'x' }, (e, v) => e ? reject(e) : resolve(v))), { text: 'ok' });
        c.close();
    });
});
test('CLIENT unsafe package definitions are ignored as in upstream', () => {
    assert.deepEqual(grpc.loadPackageDefinition(JSON.parse('{"__proto__.bad":{}}')), {});
    assert.equal({}.bad, undefined);
});
test('CLIENT extends Client path uses the same transport', async () => withFetch(async () => response(), async () => {
    class Direct extends grpc.Client {
        run(value, cb) {
            return this.makeUnaryRequest('/demo.Echo/Unary', serialize, deserialize, value, cb);
        }
    }
    const c = new Direct('echo.test', grpc.credentials.createSsl());
    assert.deepEqual(await new Promise((resolve, reject) => c.run({ text: 'x' }, (e, v) => e ? reject(e) : resolve(v))), { text: 'ok' });
    c.close();
}));
test('CLIENT invocation transformer changes actual request and metadata', async () => withFetch(async (_u, init) => {
    assert.deepEqual(deserialize(Buffer.from(init.body).subarray(5)), { text: 'changed' });
    assert.equal(init.headers.get('x-transform'), 'yes');
    return response();
}, async () => {
    const c = client({ callInvocationTransformer: p => {
            p.argument = { text: 'changed' };
            p.metadata.set('x-transform', 'yes');
            return p;
        } });
    await unary(c).promise;
    c.close();
}));
test('CLIENT callback error and status differ for zero-message OK', async () => withFetch(async () => response([]), async () => {
    const c = client();
    const { call, promise } = unary(c);
    let code;
    call.on('status', s => code = s.code);
    await assert.rejects(promise, { code: 12 });
    assert.equal(code, 0);
    c.close();
}));
test('CLIENT duplicate unary responses reject', async () => withFetch(async () => response([{ text: '1' }, { text: '2' }]), async () => {
    const c = client();
    await assert.rejects(unary(c).promise, { code: 12 });
    assert.equal(c.getChannel().activeCallCount(), 0);
    c.close();
}));
test('CLIENT status error is not hidden by HTTP 200', async () => withFetch(async () => response([], { code: 7, details: 'permission denied', extra: 'grpc-status-details-bin: AQI=\r\n' }), async () => {
    const c = client();
    await assert.rejects(unary(c).promise, e => {
        assert.equal(e.code, 7);
        assert.equal(e.details, 'permission denied');
        assert.deepEqual(e.metadata.get('grpc-status-details-bin'), [Buffer.from([1, 2])]);
        return true;
    });
    c.close();
}));
test('CLIENT trailers-only response via headers', async () => withFetch(async () => new Response(null, { headers: { 'content-type': 'application/grpc-web+proto', 'grpc-status': '16', 'grpc-message': 'no%20auth' } }), async () => {
    const c = client();
    await assert.rejects(unary(c).promise, { code: 16, details: 'no auth' });
    c.close();
}));
test('CLIENT header status with body is malformed', async () => withFetch(async () => response([], { headers: { 'grpc-status': '0' } }), async () => {
    const c = client();
    await assert.rejects(unary(c).promise, { code: 13 });
    c.close();
}));
test('CLIENT no gRPC status never becomes success', async () => withFetch(async () => new Response(encodeFrame(serialize({ text: 'x' })), { headers: { 'content-type': 'application/grpc-web+proto' } }), async () => {
    const c = client();
    await assert.rejects(unary(c).promise, { code: 2 });
    c.close();
}));
for (const [http, code] of [[400, 13], [401, 16], [403, 7], [404, 12], [429, 14], [502, 14], [503, 14], [504, 14], [200, 2]]) {
    test(`CLIENT HTTP fallback ${http}`, async () => withFetch(async () => new Response('not grpc', { status: http }), async () => {
        const c = client();
        await assert.rejects(unary(c).promise, { code });
        c.close();
    }));
}
test('CLIENT redirect rejected, no second fetch', async () => {
    let count = 0;
    await withFetch(async () => {
        count++;
        return new Response(null, { status: 307, headers: { location: 'https://untrusted.test' } });
    }, async () => {
        const c = client();
        await assert.rejects(unary(c).promise, e => e.details === 'WGA_REDIRECT_BLOCKED');
        c.close();
    });
    assert.equal(count, 1);
});
test('CLIENT network failure has safe details and no automatic retry', async () => {
    let count = 0;
    await withFetch(async () => {
        count++;
        throw new Error('TOKEN_DO_NOT_LEAK');
    }, async () => {
        const c = client();
        await assert.rejects(unary(c).promise, e => e.code === 14 && !e.message.includes('TOKEN'));
        c.close();
    });
    assert.equal(count, 1);
});
test('CLIENT serialize and deserialize failures use call error surface', async () => withFetch(async () => response(), async () => {
    const c = new grpc.Client('echo.test', grpc.credentials.createSsl());
    for (const [ser, de] of [[() => {
                throw new Error('private input');
            }, deserialize], [serialize, () => {
                throw new Error('private output');
            }]]) {
        await assert.rejects(new Promise((resolve, reject) => c.makeUnaryRequest('/demo.Echo/Unary', ser, de, { text: 'x' }, (e, v) => e ? reject(e) : resolve(v))), { code: 13 });
    }
    c.close();
}));
test('CLIENT unsupported channel features fail explicitly', () => {
    for (const opts of [{ 'grpc.enable_retries': 1 }, { 'grpc.keepalive_time_ms': 100 }, { 'unrecognized': true }]) {
        assert.throws(() => client(opts), { code: 'WGA_UNSUPPORTED_OPTION' });
    }
    assert.throws(() => new grpc.Server(), { code: 'WGA_SERVER_UNSUPPORTED' });
});
test('CLIENT READY unsupported; no health request', async () => withFetch(async () => {
    throw new Error('unexpected fetch');
}, async () => {
    const c = client();
    assert.equal(c.getChannel().getConnectivityState(), grpc.connectivityState.IDLE);
    await new Promise(resolve => c.waitForReady(Date.now() + 100, e => {
        assert.equal(e.code, 12);
        resolve();
    }));
    c.close();
    assert.equal(c.getChannel().getConnectivityState(), grpc.connectivityState.SHUTDOWN);
}));
test('CLIENT CJS, ESM and deep Client have identical class identities', async () => {
    const esm = await import('../dist/index.mjs'), deep = await import('../dist/client.mjs');
    assert.strictEqual(esm.Metadata, grpc.Metadata);
    assert.strictEqual(deep.Client, grpc.Client);
    assert.strictEqual(esm.credentials, grpc.credentials);
});
