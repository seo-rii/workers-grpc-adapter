'use strict';
const { test } = require('node:test');
const { assert, grpc, Echo, client, serialize, response, withFetch, unary, immediate, deferred, trailers, byteStream, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');
function credential(generator) {
    return grpc.credentials.combineChannelCredentials(grpc.credentials.createSsl(), grpc.credentials.createFromMetadataGenerator(generator));
}
function authed(generator, opts = {}) {
    return new Echo('echo.test', credential(generator), opts);
}
test('LIFE past deadline sends no auth and no request', async () => {
    let auth = 0, fetches = 0;
    const c = authed((_o, cb) => {
        auth++;
        cb(null, new grpc.Metadata());
    });
    await withFetch(async () => {
        fetches++;
        return response();
    }, async () => {
        const { call, promise } = unary(c, { text: 'x' }, { deadline: Date.now() - 1 });
        await assert.rejects(promise, { code: 4 });
        assert.equal(transportCall(call).diagnostics().timerActive, false);
    });
    assert.equal(auth, 0);
    assert.equal(fetches, 0);
    assert.equal(c.getChannel().activeCallCount(), 0);
    c.close();
});
test('LIFE immediate cancellation before auth microtask', async () => {
    let auth = 0, fetches = 0;
    const c = authed((_o, cb) => {
        auth++;
        cb(null, new grpc.Metadata());
    });
    await withFetch(async () => {
        fetches++;
        return response();
    }, async () => {
        const { call, promise } = unary(c);
        let statuses = 0;
        call.on('status', () => statuses++);
        call.cancel();
        call.cancel();
        await assert.rejects(promise, { code: 1 });
        assert.equal(statuses, 1);
    });
    assert.equal(auth, 0);
    assert.equal(fetches, 0);
    c.close();
});
test('LIFE deadline during auth; late completion cannot start fetch', { timeout: 2000 }, async () => {
    let complete, fetches = 0;
    const c = authed((_o, cb) => complete = cb);
    await withFetch(async () => {
        fetches++;
        return response();
    }, async () => {
        const { call, promise } = unary(c, { text: 'x' }, { deadline: Date.now() + 25 });
        await assert.rejects(promise, { code: 4 });
        complete(null, new grpc.Metadata());
        await immediate();
        assert.equal(fetches, 0);
        assert.equal(transportCall(call).diagnostics().timerActive, false);
    });
    c.close();
});
test('LIFE explicitly infinite deadline is not overridden by factory default', { timeout: 2000 }, async () => {
    const c = client({}, { defaultTimeoutMs: 1 });
    let header;
    await withFetch(async (_u, init) => {
        header = init.headers.get('grpc-timeout');
        await new Promise(r => setTimeout(r, 8));
        return response();
    }, async () => {
        assert.deepEqual(await unary(c, { text: 'x' }, { deadline: Infinity }).promise, { text: 'ok' });
    });
    assert.equal(header, null);
    c.close();
});
test('LIFE no implicit timeout without a configured default', async () => {
    const c = client();
    await withFetch(async (_u, init) => {
        assert.equal(init.headers.get('grpc-timeout'), null);
        return response();
    }, async () => {
        await unary(c).promise;
    });
    c.close();
});
test('LIFE cancel fetch that ignores AbortSignal; late response body is cancelled', async () => {
    const pending = deferred(), entered = deferred();
    let cancelled = false, signal;
    const c = client();
    await withFetch(async (_u, init) => {
        signal = init.signal;
        entered.resolve();
        return pending.promise;
    }, async () => {
        const { call, promise } = unary(c);
        await entered.promise;
        call.cancel();
        await assert.rejects(promise, { code: 1 });
        assert.ok(signal.aborted);
        pending.resolve(response([{ text: 'late' }], { onCancel: () => cancelled = true }));
        await immediate();
        assert.equal(cancelled, true);
        assert.equal(transportCall(call).diagnostics().requestBytes, 0);
    });
    c.close();
});
test('LIFE channel close terminates calls and prevents later network', async () => {
    let count = 0;
    const c = client();
    await withFetch(async (_u, init) => {
        count++;
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }, async () => {
        const first = unary(c);
        await immediate();
        c.close();
        await assert.rejects(first.promise, { code: 14 });
        await assert.rejects(unary(c).promise, { code: 14 });
        assert.equal(count, 1);
        assert.equal(c.getChannel().activeCallCount(), 0);
    });
});
test('LIFE cancelling one of two concurrent calls does not affect the other', async () => {
    const c = client();
    let firstSignal;
    await withFetch(async (_u, init) => {
        const request = Buffer.from(init.body).toString();
        if (request.includes('first')) {
            firstSignal = init.signal;
            return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error()), { once: true }));
        }
        return response([{ text: 'second' }]);
    }, async () => {
        const one = unary(c, { text: 'first' });
        const oneRejected = assert.rejects(one.promise, { code: 1 });
        const two = unary(c, { text: 'second' });
        await immediate();
        one.call.cancel();
        await oneRejected;
        assert.deepEqual(await two.promise, { text: 'second' });
        assert.ok(firstSignal.aborted);
        assert.equal(c.getChannel().activeCallCount(), 0);
    });
    c.close();
});
test('AUTH logical audience stays logical when route maps to a gateway', async () => {
    let seen;
    const factory = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' } });
    const creds = credential((options, cb) => {
        seen = options;
        const m = new grpc.Metadata();
        m.set('authorization', 'Bearer fixture');
        cb(null, m);
    });
    const c = new Echo('echo.test', creds, factory.grpcOptions());
    await withFetch(async (url, init) => {
        assert.equal(url, 'https://gateway.test/demo.Echo/Unary');
        assert.equal(init.headers.get('authorization'), 'Bearer fixture');
        return response();
    }, async () => await unary(c).promise);
    assert.deepEqual(seen, { service_url: 'https://echo.test/demo.Echo', method_name: '/demo.Echo/Unary' });
    c.close();
});
test('AUTH errors retain code, redact message, do not anonymously retry', async () => {
    let fetches = 0;
    const c = authed((_o, cb) => cb(Object.assign(new Error('PRIVATE_TOKEN'), { code: 16 })));
    await withFetch(async () => {
        fetches++;
        return response();
    }, async () => assert.rejects(unary(c).promise, e => e.code === 16 && !e.message.includes('PRIVATE_TOKEN')));
    assert.equal(fetches, 0);
    c.close();
});
test('AUTH per-call credentials combine and duplicate authorization fails', async () => {
    const c = authed((_o, cb) => {
        const m = new grpc.Metadata();
        m.set('authorization', 'Bearer channel');
        cb(null, m);
    });
    const extra = grpc.credentials.createFromMetadataGenerator((_o, cb) => {
        const m = new grpc.Metadata();
        m.set('authorization', 'Bearer call');
        cb(null, m);
    });
    let fetches = 0;
    await withFetch(async () => {
        fetches++;
        return response();
    }, async () => assert.rejects(unary(c, { text: 'x' }, { credentials: extra }).promise, { code: 13 }));
    assert.equal(fetches, 0);
    c.close();
});
test('STREAM incrementally returns messages and trailing metadata', { timeout: 2000 }, async () => withFetch(async () => response([{ text: '1' }, { text: '2' }, { text: '3' }], { chunkSize: 1, extra: 'x-final: yes\r\n' }), async () => {
    const c = client();
    const stream = c.stream({ text: 'x' });
    let final;
    stream.on('status', s => final = s);
    const values = [];
    for await (const v of stream) {
        values.push(v.text);
    }
    assert.deepEqual(values, ['1', '2', '3']);
    assert.equal(final.metadata.get('x-final')[0], 'yes');
    assert.equal(c.getChannel().activeCallCount(), 0);
    c.close();
}));
test('STREAM zero-message success is valid', { timeout: 2000 }, async () => withFetch(async () => response([]), async () => {
    const c = client();
    const out = [];
    for await (const v of c.stream({ text: 'x' })) {
        out.push(v);
    }
    assert.deepEqual(out, []);
    c.close();
}));
test('STREAM valid messages then remote failure does not restart', { timeout: 2000 }, async () => {
    let fetches = 0;
    await withFetch(async () => {
        fetches++;
        return response([{ text: 'partial' }], { code: 14, chunkSize: 1 });
    }, async () => {
        const c = client();
        const out = [];
        await assert.rejects((async () => {
            for await (const v of c.stream({ text: 'x' })) {
                out.push(v.text);
            }
        })(), { code: 14 });
        assert.deepEqual(out, ['partial']);
        c.close();
    });
    assert.equal(fetches, 1);
});
test('STREAM cancellation cleans pending reader and active call', { timeout: 2000 }, async () => {
    let cancelled = false;
    await withFetch(async () => new Response(new ReadableStream({ start(controller) {
            controller.enqueue(encodeFrame(serialize({ text: 'first' })));
        }, cancel() {
            cancelled = true;
        } }), { headers: { 'content-type': 'application/grpc-web+proto' } }), async () => {
        const c = client();
        const stream = c.stream({ text: 'x' });
        const failure = new Promise(resolve => stream.once('error', resolve));
        stream.once('data', () => stream.cancel());
        const error = await failure;
        assert.equal(error.code, 1);
        await immediate();
        assert.equal(cancelled, true);
        assert.equal(c.getChannel().activeCallCount(), 0);
        c.close();
    });
});
test('STREAM slow reader has bounded adapter lookahead', { timeout: 2000 }, async () => {
    let produced = 0;
    const one = encodeFrame(serialize({ text: 'small' }));
    await withFetch(async () => new Response(new ReadableStream({ pull(c) {
            produced++;
            if (produced <= 200) {
                c.enqueue(one);
            }
            else {
                c.enqueue(trailers());
                c.close();
            }
        } }), { headers: { 'content-type': 'application/grpc-web+proto' } }), async () => {
        const c = client();
        const stream = c.stream({ text: 'x' });
        stream.on('error', () => {
        });
        await immediate();
        await immediate();
        assert.ok(produced <= 4, `unconsumed stream produced ${produced} chunks`);
        stream.cancel();
        await immediate();
        c.close();
    });
});
test('STREAM many small messages exceed per-message limit in total', { timeout: 5000 }, async () => withFetch(async () => response(Array.from({ length: 500 }, () => ({ text: 'x'.repeat(32) }))), async () => {
    const c = client({ 'grpc.max_receive_message_length': 64 });
    let count = 0;
    for await (const _ of c.stream({ text: 'x' })) {
        count++;
    }
    assert.equal(count, 500);
    c.close();
}));
test('LIMIT send overflow stops before fetch', async () => {
    let count = 0;
    const c = client({ 'grpc.max_send_message_length': 1 });
    await withFetch(async () => {
        count++;
        return response();
    }, async () => assert.rejects(unary(c).promise, { code: 8 }));
    assert.equal(count, 0);
    c.close();
});
test('LIMIT receive -1 accepts >4 MiB under safety ceiling', { timeout: 5000 }, async () => withFetch(async () => response([{ text: 'x'.repeat(4 * 1024 * 1024 + 1) }]), async () => {
    const c = client({ 'grpc.max_receive_message_length': -1 });
    const value = await unary(c).promise;
    assert.equal(value.text.length, 4 * 1024 * 1024 + 1);
    c.close();
}));
test('LIMIT standalone default rejects >4 MiB', { timeout: 5000 }, async () => withFetch(async () => response([{ text: 'x'.repeat(4 * 1024 * 1024 + 1) }]), async () => {
    const c = client();
    await assert.rejects(unary(c).promise, { code: 8 });
    c.close();
}));
test('UNSUPPORTED client streaming/bidi send zero auth and zero requests', { timeout: 2000 }, async () => {
    let auth = 0, fetches = 0;
    const c = authed((_o, cb) => {
        auth++;
        cb(null, new grpc.Metadata());
    });
    await withFetch(async () => {
        fetches++;
        return response();
    }, async () => {
        await assert.rejects(new Promise((resolve, reject) => c.clientStream(e => e ? reject(e) : resolve())), { code: 12 });
        const bidi = c.bidi();
        await new Promise(resolve => bidi.on('error', error => {
            assert.equal(error.code, 12);
            resolve();
        }));
    });
    assert.equal(auth, 0);
    assert.equal(fetches, 0);
    c.close();
});
test('LIFE repeated success leaves no active calls or timers', { timeout: 3000 }, async () => withFetch(async () => response(), async () => {
    const c = client();
    for (let i = 0; i < 50; i++) {
        const { call, promise } = unary(c, { text: 'x' }, { deadline: Date.now() + 10000 });
        await promise;
        assert.deepEqual(transportCall(call).diagnostics(), { terminal: true, fetchCount: 1, requestBytes: 0, responseBytes: 0, timerActive: false });
    }
    assert.equal(c.getChannel().activeCallCount(), 0);
    c.close();
}));
