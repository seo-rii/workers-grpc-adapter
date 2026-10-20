'use strict';
const test = require('node:test');
const { assert, grpc, client, response, unary, immediate, transportCall } = require('./helpers.cjs');

const observe = promise => promise.then(value => ({ value }), error => ({ error }));
for (const requestStream of [false, true]) for (const delay of ['none', 'metadata', 'message']) for (const count of [1, 2, 3]) {
    test(`UNARY cardinality counts ${count} wire messages with ${delay} delay and requestStream=${requestStream}`, async () => {
        const continuations = [];
        const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
            start(metadata, _listener, next) {
                next(metadata, {
                    onReceiveMetadata(value, resume) {
                        if (delay === 'metadata') continuations.push(() => resume(value)); else resume(value);
                    },
                    onReceiveMessage(value, resume) {
                        if (delay === 'message') continuations.push(() => resume(value)); else resume(value);
                    },
                });
            },
        })] }, {
            mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' }, experimentalRequestStreaming: true,
            fetcher: { async fetch(_url, init) {
                if (requestStream) for await (const _chunk of init.body) { /* Drain the owned request. */ }
                return response(Array.from({ length: count }, (_, i) => ({ text: String(i + 1) })));
            } },
        });
        let call, callbacks = 0, statuses = 0;
        try {
            const result = observe(new Promise((resolve, reject) => {
                const done = (error, value) => { callbacks++; error ? reject(error) : resolve(value); };
                call = requestStream ? c.clientStream(done) : c.unary({ text: 'request' }, done);
            }));
            call.on('error', () => {});
            call.on('status', () => { statuses++; });
            if (requestStream) call.end({ text: 'request' });
            await immediate();
            for (const resume of continuations) { resume(); resume(); }
            const outcome = await result;
            if (count === 1) assert.deepEqual(outcome.value, { text: '1' });
            else {
                assert.equal(outcome.error?.code, grpc.status.UNIMPLEMENTED);
                assert.equal(outcome.error.details, 'Too many responses received');
            }
            await immediate();
            assert.equal(callbacks, 1); assert.equal(statuses, 1);
            assert.equal(c.getChannel().activeCallCount(), 0);
            assert.equal(transportCall(call).executionDiagnostics().pendingMessages, 0);
            assert.equal(transportCall(call).diagnostics().timerActive, false);
        } finally { c.close(); }
    });
}

test('UNARY a dropped response interceptor cannot conceal extra wire messages', async () => {
    let wireStatus;
    const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
        start(metadata, _listener, next) { next(metadata, {
            onReceiveMessage() { /* Intentionally drop every message. */ },
            onReceiveStatus(value, resume) { wireStatus = value; resume(value); },
        }); },
    })] }, { fetcher: { async fetch() { return response([{ text: '1' }, { text: '2' }]); } } });
    try {
        const pending = unary(c);
        const result = observe(pending.promise);
        await immediate();
        // The wire reader must reject the response even while user delivery is withheld.
        assert.equal(transportCall(pending.call).diagnostics().terminal, true);
        assert.equal(wireStatus.code, 12);
        pending.call.cancel();
        assert.equal((await result).error?.code, 1);
    } finally { c.close(); }
});
