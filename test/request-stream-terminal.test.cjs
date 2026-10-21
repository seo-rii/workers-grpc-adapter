'use strict';
const test = require('node:test');
const { assert, grpc, methods, response, immediate, transportCall } = require('./helpers.cjs');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');

function fixture(stalled, remote, options = {}) {
    let resume, fetches = 0;
    const statuses = [], writes = [], order = [], observations = [], layers = [];
    const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: { 'stream.test': 'https://gateway.test' },
        experimentalRequestStreaming: true, observer: event => observations.push(event), fetcher: {
            async fetch(_url, init) {
                fetches++;
                if (options.consumeUpload) {
                    const reader = init.body.getReader();
                    try { assert.equal((await reader.read()).done, false); }
                    finally { reader.releaseLock(); }
                }
                if (options.completion === 'cancel') await init.body.cancel();
                // A bodyless header status finishes transport validation before
                // the upload rejection continuation; trailers exercise the
                // opposite ordering while the response reader validates EOF.
                if (options.completion === 'headers') return new Response(null, { headers: {
                    'content-type': 'application/grpc-web+proto', 'grpc-status': String(remote),
                    'grpc-message': 'remote-terminal', 'x-receipt': 'stable',
                } });
                return response([], { code: remote, details: 'remote-terminal', extra: 'x-receipt: stable\r\n' });
            },
        } });
    const C = grpc.makeGenericClientConstructor(methods, 'demo.Echo');
    const c = new C('stream.test', transport.channelCredentials, transport.grpcOptions({
        ...(options.maxSend === undefined ? {} : { 'grpc.max_send_message_length': options.maxSend }),
        interceptors: [(options, nextCall) => {
            const layer = new grpc.InterceptingCall(nextCall(options), {
                start(metadata, listener, next) {
                    next(metadata, {
                        onReceiveMetadata(value, next) {
                            if (stalled === 'metadata') resume = () => next(value);
                            else next(value);
                        },
                        onReceiveStatus(value, next) {
                            // A real inbound transform must survive the pending upload.
                            value.metadata.set('x-interceptor', 'forwarded');
                            if (stalled === 'status') resume = () => next(value);
                            else next(value);
                        },
                    });
                },
                cancel() { /* Local completion must not depend on interceptor forwarding. */ },
            });
            layers.push(layer); return layer;
        }],
    }));
    const call = c.bidi({ deadline: options.deadline ?? Infinity });
    call.on('error', () => {});
    call.on('status', result => { statuses.push(result); order.push('status'); });
    call.resume();
    call.write({ text: 'pending upload' }, error => { writes.push(error); order.push('write'); });
    return { c, call, transport, statuses, writes, order, observations, layers,
        resume() { assert.equal(typeof resume, 'function'); resume(); },
        fetches: () => fetches,
        async held() {
            await immediate(); await immediate();
            assert.equal(typeof resume, 'function', 'an inbound interceptor is holding the result');
            assert.deepEqual(statuses, [], 'upload cleanup must not cancel the logical call');
            assert.equal(writes.length, options.consumeUpload ? 1 : 0, 'only failed upload callbacks wait for the logical result');
            if (options.consumeUpload) assert.ifError(writes[0]);
            assert.equal(c.getChannel().activeCallCount(), 1);
            assert.equal(transportCall(call).diagnostics().requestBytes, 0);
        },
        async cleaned(expected, expectedFetches = 1, expectedOrder = options.consumeUpload ? ['write', 'status'] : ['status', 'write']) {
            await immediate(); await immediate();
            assert.equal(statuses.length, 1);
            assert.equal(statuses[0].code, expected);
            assert.equal(writes.length, 1);
            if (options.consumeUpload) assert.ifError(writes[0]);
            else assert.ok(writes[0] instanceof Error);
            assert.deepEqual(order, expectedOrder);
            assert.equal(fetches, expectedFetches);
            assert.equal(c.getChannel().activeCallCount(), 0);
            const usage = transport.resourceUsage();
            assert.equal(usage.activeCalls, 0); assert.equal(usage.queuedCalls, 0); assert.equal(usage.bufferedBytes, 0);
            assert.equal(transportCall(call).diagnostics().timerActive, false);
            assert.ok(Object.values(transportCall(call).executionDiagnostics()).every(value => value === 0));
            assert.deepEqual(observations.filter(event => event.type === 'call-end').map(event => event.statusCode), [expected]);
            assert.ok(layers.every(layer => layer.responseListener === undefined));
        },
    };
}

for (const stalled of ['metadata', 'status']) for (const completion of ['trailers', 'headers', 'cancel']) for (const remote of [0, 7, 14]) {
    test(`REQUEST STREAM bidi early status survives held ${stalled}: completion=${completion} remote=${remote}`, async () => {
        const f = fixture(stalled, remote, { completion });
        try {
            await f.held();
            f.resume();
            await f.cleaned(remote);
            assert.equal(f.statuses[0].details, 'remote-terminal');
            assert.deepEqual(f.statuses[0].metadata.get('x-receipt'), ['stable']);
            assert.deepEqual(f.statuses[0].metadata.get('x-interceptor'), ['forwarded']);
        } finally { f.c.close(); }
    });
}

for (const stalled of ['metadata', 'status']) for (const action of ['cancel', 'destroy', 'deadline', 'close']) {
    test(`REQUEST STREAM ${action} settles a bidi upload held by ${stalled} and ignores late forwarding`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
        const f = fixture(stalled, 7, { deadline: 1010 });
        try {
            await f.held();
            if (action === 'cancel') f.call.cancel();
            else if (action === 'destroy') f.call.destroy();
            else if (action === 'close') f.c.close();
            else t.mock.timers.tick(10);
            const expected = action === 'deadline' ? 4 : action === 'close' ? 14 : 1;
            // Explicit destroy settles Node's active write synchronously; the
            // logical cancellation is already committed before that callback.
            const order = action === 'destroy' ? ['write', 'status'] : ['status', 'write'];
            await f.cleaned(expected, 1, order);
            assert.deepEqual(f.statuses[0].metadata.get('x-receipt'), []);
            f.resume();
            await f.cleaned(expected, 1, order);
        } finally { f.c.close(); }
    });
}

test('REQUEST STREAM actual upload failure survives an asynchronous status interceptor', async () => {
    const f = fixture('status', 0, { maxSend: 1 });
    try {
        await f.held();
        f.resume();
        await f.cleaned(grpc.status.RESOURCE_EXHAUSTED, 0);
        assert.equal(f.statuses[0].details, 'WGA_REQUEST_SIZE');
    } finally { f.c.close(); }
});

for (const action of ['cancel', 'deadline', 'close']) {
    test(`REQUEST STREAM settles a write rejection arriving after immediate ${action} once`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
        const f = fixture('status', 7, { deadline: 1010 });
        try {
            if (action === 'cancel') f.call.cancel();
            else if (action === 'close') f.c.close();
            else t.mock.timers.tick(10);
            await f.cleaned(action === 'deadline' ? 4 : action === 'close' ? 14 : 1, 0);
        } finally { f.c.close(); }
    });
}

for (const stalled of ['metadata', 'status']) {
    test(`REQUEST STREAM accepts a pulled write before held ${stalled} without repeating its callback`, async () => {
        const f = fixture(stalled, 0, { consumeUpload: true });
        try {
            await f.held();
            f.resume();
            await f.cleaned(0);
            assert.deepEqual(f.statuses[0].metadata.get('x-receipt'), ['stable']);
        } finally { f.c.close(); }
    });

    test(`REQUEST STREAM rejects a later write after remote EOF without cancelling held ${stalled}`, async () => {
        const f = fixture(stalled, 7, { consumeUpload: true });
        const laterWrites = [];
        try {
            await f.held();
            f.call.write({ text: 'after remote EOF' }, error => laterWrites.push(error));
            await immediate(); await immediate();
            assert.deepEqual(f.statuses, []);
            assert.deepEqual(laterWrites, []);
            f.resume();
            await f.cleaned(7);
            assert.equal(laterWrites.length, 1);
            assert.ok(laterWrites[0] instanceof Error);
            assert.deepEqual(f.statuses[0].metadata.get('x-receipt'), ['stable']);
        } finally { f.c.close(); }
    });
}
