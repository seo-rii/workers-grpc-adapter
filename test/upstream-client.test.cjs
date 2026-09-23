'use strict';
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { assert, grpc, client, response, withFetch, unary, serialize, deserialize, immediate } = require('./helpers.cjs');

test('UPSTREAM vendored files and patches reproduce the compiled client sources', () => {
    execFileSync(process.execPath, ['vendor/verify.cjs'], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
});

test('UPSTREAM interceptor builders preserve outgoing and incoming order', async () => {
    const trace = [];
    const intercept = name => (options, nextCall) => {
        trace.push(`${name}:construct`);
        const requester = new grpc.RequesterBuilder()
            .withStart((metadata, listener, next) => {
                trace.push(`${name}:start`);
                metadata.add('x-intercept', name);
                next(metadata, new grpc.ListenerBuilder()
                    .withOnReceiveMetadata((value, next) => { trace.push(`${name}:metadata`); next(value); })
                    .withOnReceiveMessage((value, next) => { trace.push(`${name}:response`); next(value); })
                    .withOnReceiveStatus((value, next) => { trace.push(`${name}:status`); next(value); })
                    .build());
            })
            .withSendMessage((value, next) => { trace.push(`${name}:request`); next({ text: value.text + name }); })
            .withHalfClose(next => { trace.push(`${name}:halfClose`); next(); })
            .build();
        return new grpc.InterceptingCall(nextCall(options), requester);
    };
    await withFetch(async (_url, init) => {
        assert.equal(init.headers.get('x-intercept'), 'a, b');
        assert.deepEqual(deserialize(Buffer.from(init.body).subarray(5)), { text: 'xab' });
        return response();
    }, async () => {
        const c = client({ interceptors: [intercept('a'), intercept('b')] });
        const result = unary(c, { text: 'x' });
        assert.equal(result.call.getAuthContext(), null);
        await result.promise;
        c.close();
    });
    assert.deepEqual(trace, ['a:construct', 'b:construct', 'a:start', 'b:start', 'a:request', 'b:request', 'a:halfClose', 'b:halfClose', 'b:metadata', 'a:metadata', 'b:response', 'a:response', 'b:status', 'a:status']);
});

test('UPSTREAM call interceptors override client interceptors and providers see transformed definition', async () => {
    const observed = [];
    await withFetch(async url => { assert.ok(url.endsWith('/demo.Echo/Transformed')); return response(); }, async () => {
        const c = client({
            interceptors: [() => { throw new Error('client interceptor should be overridden'); }],
            callInvocationTransformer(properties) {
                observed.push('transform');
                properties.methodDefinition = { ...properties.methodDefinition, path: '/demo.Echo/Transformed' };
                return properties;
            },
        });
        await unary(c, { text: 'x' }, { interceptor_providers: [definition => {
            observed.push(definition.path);
            return (options, nextCall) => new grpc.InterceptingCall(nextCall(options));
        }] }).promise;
        c.close();
    });
    assert.deepEqual(observed, ['transform', '/demo.Echo/Transformed']);
});

test('UPSTREAM bottom bridge uses final method, serializers, credentials and explicit deadline provenance', async () => {
    let authCount = 0;
    const seenTimeouts = [];
    const credentials = grpc.credentials.createFromMetadataGenerator((_options, done) => {
        authCount++;
        const metadata = new grpc.Metadata();
        metadata.set('x-auth-test', 'present');
        done(null, metadata);
    });
    await withFetch(async (url, init) => {
        assert.ok(url.endsWith('/demo.Echo/Final'));
        assert.equal(init.headers.get('x-auth-test'), 'present');
        assert.deepEqual(deserialize(Buffer.from(init.body).subarray(5)), { text: 'serialized transformed' });
        seenTimeouts.push(init.headers.get('grpc-timeout'));
        return response();
    }, async () => {
        const c = client({
            callInvocationTransformer(properties) { properties.argument = { text: 'transformed' }; return properties; },
            interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall({
                ...options,
                credentials,
                method_definition: { ...options.method_definition, path: '/demo.Echo/Final', requestSerialize: value => serialize({ text: 'serialized ' + value.text }), responseDeserialize: bytes => ({ final: deserialize(bytes).text }) },
            }))],
        }, { defaultTimeoutMs: 5000 });
        assert.deepEqual(await unary(c).promise, { final: 'ok' });
        assert.deepEqual(await unary(c, { text: 'original' }, { deadline: Infinity }).promise, { final: 'ok' });
        c.close();
    });
    assert.equal(authCount, 2);
    assert.match(seenTimeouts[0], /^[0-9]+[HMSmun]$/);
    assert.equal(seenTimeouts[1], null);
});

test('UPSTREAM asynchronous interceptor startup retains request until metadata is ready', async () => withFetch(async (_url, init) => {
    assert.equal(init.headers.get('x-async'), 'ready');
    return response();
}, async () => {
    const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        start(metadata, listener, next) { setImmediate(() => { metadata.set('x-async', 'ready'); next(metadata, listener); }); },
    })] });
    await unary(c).promise;
    c.close();
}));

test('UPSTREAM async listener message processing precedes status and callback', async () => withFetch(async () => response(), async () => {
    const seen = [];
    const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        start(metadata, listener, next) {
            next(metadata, {
                onReceiveMessage(value, next) { setImmediate(() => { seen.push('message'); next({ text: value.text + ' async' }); }); },
                onReceiveStatus(value, next) { seen.push('interceptor-status'); next(value); },
            });
        },
    })] });
    const request = unary(c);
    request.call.on('status', () => seen.push('surface-status'));
    assert.deepEqual(await request.promise, { text: 'ok async' });
    assert.deepEqual(seen, ['interceptor-status', 'message', 'surface-status']);
    c.close();
}));

test('UPSTREAM interceptor configuration conflicts and foreign transformer channels are synchronous', () => {
    const pass = (options, next) => new grpc.InterceptingCall(next(options));
    assert.throws(() => client({ interceptors: [pass], interceptor_providers: [() => pass] }), /Both interceptors/);
    const c = client();
    assert.throws(() => c.unary({ text: '' }, { interceptors: [pass], interceptor_providers: [() => pass] }, () => {}), { name: 'InterceptorConfigurationError' });
    c.close();
    const foreign = client({ callInvocationTransformer(properties) { properties.channel = { createCallForMethod() { throw new Error('must not be called'); } }; return properties; } });
    assert.throws(() => foreign.unary({ text: '' }, () => {}), { code: 'WGA_UNSUPPORTED_OPTION' });
    foreign.close();
});

test('UPSTREAM metadata clone/map/options and protobuf package factories preserve native semantics', () => {
    const options = { idempotentRequest: true };
    const metadata = new grpc.Metadata(options);
    const value = Buffer.from([1, 2]);
    metadata.add('X-BIN', value);
    metadata.add('x-bin', Buffer.from([3]));
    assert.strictEqual(metadata.get('x-bin')[0], value);
    assert.strictEqual(metadata.getOptions(), options);
    assert.strictEqual(Object.getPrototypeOf(metadata.getMap()), Object.prototype);
    assert.notStrictEqual(metadata.getMap()['x-bin'], value);
    assert.notStrictEqual(metadata.clone().get('x-bin')[0], value);
    metadata.setOpaque('local', { enabled: true });
    assert.deepEqual(metadata.getOpaque('local'), { enabled: true });
    assert.equal(metadata.clone().getOpaque('local'), undefined);
    assert.deepEqual(metadata.toHttp2Headers()['x-bin'], ['AQI=', 'Aw==']);
    assert.deepEqual(grpc.Metadata.fromHttp2Headers({ 'custom-bin': 'AQI=,Aw==' }).get('custom-bin'), [Buffer.from([1, 2]), Buffer.from([3])]);
    assert.deepEqual(grpc.loadPackageDefinition(JSON.parse('{"__proto__.bad":{}}')), {});
    assert.throws(() => grpc.makeGenericClientConstructor({ $bad: {} }, 'Bad'), /cannot start with/);
});

test('UPSTREAM stream exposes upstream codec and buffer highWaterMark', async () => withFetch(async () => response([{ text: '1' }, { text: '2' }]), async () => {
    const c = client();
    const stream = c.stream({ text: '' });
    assert.equal(stream.deserialize, deserialize);
    const { Readable } = require('node:stream');
    assert.equal(stream.readableHighWaterMark, new Readable({ objectMode: true, read() {} }).readableHighWaterMark);
    const values = [];
    for await (const value of stream) values.push(value.text);
    assert.deepEqual(values, ['1', '2']);
    assert.equal(stream.getAuthContext(), null);
    c.close();
    await immediate();
}));

test('UPSTREAM StatusBuilder preserves supplied code, details and metadata identity', () => {
    const metadata = new grpc.Metadata();
    assert.deepEqual(new grpc.StatusBuilder().build(), {});
    assert.deepEqual(new grpc.StatusBuilder().withCode(7).withDetails('denied').withMetadata(metadata).build(), { code: 7, details: 'denied', metadata });
});
