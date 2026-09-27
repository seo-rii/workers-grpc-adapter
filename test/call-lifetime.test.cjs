'use strict';
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { assert, grpc, client, response, withFetch, immediate, transportCall } = require('./helpers.cjs');

for (const action of ['deadline', 'default-timeout', 'cancel', 'close', 'parent']) {
    test(`LIFETIME stalled interceptor start terminates on ${action} and ignores late next`, async t => {
        t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
        let resume, fetches = 0, callbacks = 0;
        const statuses = [], results = [];
        const parent = Object.assign(new EventEmitter(), { cancelled: false, getDeadline: () => Infinity });
        await withFetch(async () => { fetches++; return response(); }, async () => {
            const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
                start(md, listener, next) { resume = () => next(md, listener); },
                cancel(_next) { /* A stalled cancellation interceptor cannot veto local cleanup. */ },
            })] }, { defaultTimeoutMs: 10 });
            try {
                const options = action === 'default-timeout' ? {} : { deadline: action === 'deadline' ? 1010 : Infinity,
                    ...(action === 'parent' ? { parent } : {}) };
                const call = c.unary({ text: 'held' }, options, error => { callbacks++; results.push(error?.code ?? 0); });
                call.on('status', value => statuses.push(value.code));
                if (action === 'cancel') call.cancel();
                else if (action === 'close') c.close();
                else if (action === 'parent') { parent.cancelled = true; parent.emit('cancelled'); }
                else t.mock.timers.tick(10);
                await immediate();
                const expected = ['deadline', 'default-timeout'].includes(action) ? grpc.status.DEADLINE_EXCEEDED
                    : action === 'close' ? grpc.status.UNAVAILABLE : grpc.status.CANCELLED;
                assert.deepEqual(results, [expected]);
                assert.deepEqual(statuses, [expected]);
                assert.equal(c.getChannel().activeCallCount(), 0);
                assert.equal(parent.listenerCount('cancelled'), 0);
                resume(); await immediate();
                assert.equal(fetches, 0);
                assert.equal(callbacks, 1);
                assert.deepEqual(statuses, [expected]);
                assert.equal(transportCall(call).diagnostics().timerActive, false);
            } finally { c.close(); }
        });
    });
}

test('LIFETIME holds the deadline through asynchronous inbound status delivery', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
    let resume, callbacks = 0;
    const codes = [];
    await withFetch(async () => response(), async () => {
        const c = client({ interceptors: [(options, nextCall) => new grpc.InterceptingCall(nextCall(options), {
            start(md, listener, next) { next(md, { onReceiveStatus(result, next) { resume = () => next(result); } }); },
        })] }, { defaultTimeoutMs: 10 });
        try {
            const call = c.unary({ text: 'request' }, error => { callbacks++; codes.push(error?.code ?? 0); });
            const statuses = []; call.on('status', result => statuses.push(result.code));
            await immediate(); assert.equal(typeof resume, 'function');
            assert.equal(c.getChannel().activeCallCount(), 1);
            t.mock.timers.tick(10); await immediate();
            assert.deepEqual(codes, [grpc.status.DEADLINE_EXCEEDED]);
            assert.equal(c.getChannel().activeCallCount(), 0);
            resume(); await immediate();
            assert.equal(callbacks, 1);
            assert.deepEqual(statuses, [grpc.status.DEADLINE_EXCEEDED]);
        } finally { c.close(); }
    });
});

test('LIFETIME discards nested interceptor queues even when cancel forwarding stalls', async () => {
    const layers = [], continuations = [];
    let serialized = 0, fetches = 0;
    const { methods } = require('./helpers.cjs');
    const Original = grpc.makeGenericClientConstructor({ unary: { ...methods.unary,
        requestSerialize(value) { serialized++; return methods.unary.requestSerialize(value); },
    } }, 'demo.Echo');
    const { createWorkersGrpcTransport } = require('../dist/adapter.js');
    const transport = createWorkersGrpcTransport({ fetcher: { async fetch() { fetches++; return response(); } } });
    const interceptor = (options, nextCall) => {
        const call = new grpc.InterceptingCall(nextCall(options), {
            start(metadata, listener, next) { continuations.push(() => next(metadata, listener)); },
            sendMessage(value, next) { next({ text: value.text + 'rewritten' }); },
            cancel() { /* Cleanup must not depend on next(). */ },
        });
        layers.push(call);
        return call;
    };
    const c = new Original('echo.test:443', transport.channelCredentials,
        transport.grpcOptions({ interceptors: [interceptor, interceptor] }));
    try {
        const codes = [];
        const call = c.unary({ text: 'retained'.repeat(1000) }, error => codes.push(error?.code ?? 0));
        assert.equal(layers.reduce((sum, layer) => sum + layer.pendingMessages.length, 0), 1);
        call.cancel(); await immediate();
        assert.deepEqual(codes, [grpc.status.CANCELLED]);
        assert.deepEqual(layers.map(layer => layer.pendingMessages.length), [0, 0]);
        for (const next of continuations) next();
        await immediate();
        assert.equal(serialized, 0); assert.equal(fetches, 0);
        assert.equal(c.getChannel().activeCallCount(), 0);
    } finally { c.close(); }
});

for (const stalled of ['metadata', 'message', 'status']) {
    for (const action of ['cancel', 'deadline']) {
        test(`LIFETIME ${action} disposes held inbound ${stalled} and ignores late continuations`, async t => {
            t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
            const resumed = {}, downstream = [], results = [], statuses = [], layers = [], incoming = [];
            const payload = 'x'.repeat(100000);
            await withFetch(async () => response([{ text: payload }]), async () => {
                const c = client({ interceptors: [(options, nextCall) => {
                    const nextCallInstance = nextCall(options), start = nextCallInstance.start.bind(nextCallInstance);
                    nextCallInstance.start = (metadata, listener) => { incoming.push(listener); start(metadata, listener); };
                    const layer = new grpc.InterceptingCall(nextCallInstance, {
                        start(metadata, listener, next) {
                            for (const name of ['Metadata', 'Message', 'Status']) {
                                const original = listener[`onReceive${name}`].bind(listener);
                                listener[`onReceive${name}`] = value => { downstream.push(name); original(value); };
                            }
                            next(metadata, {
                                onReceiveMetadata(value, next) { resumed.metadata = next; if (stalled !== 'metadata') next(value); },
                                onReceiveMessage(value, next) { resumed.message = next; if (stalled !== 'message') next(value); },
                                onReceiveStatus(value, next) { resumed.status = next; if (stalled !== 'status') next(value); },
                            });
                        },
                        cancel() { /* Cleanup cannot rely on cancellation forwarding. */ },
                    });
                    layers.push(layer); return layer;
                }] }, { defaultTimeoutMs: 10 });
                try {
                    const call = c.unary({ text: 'request' }, error => results.push(error?.code ?? 0));
                    call.on('status', value => statuses.push(value.code));
                    const inbound = incoming[0];
                    assert.ok(inbound, 'The downstream call receives an inbound listener');
                    await immediate();
                    assert.equal(typeof resumed[stalled], 'function');
                    if (stalled === 'metadata') assert.equal(inbound.pendingMessage.text.length, 100000);
                    if (stalled !== 'status') assert.ok(inbound.pendingStatus);
                    const before = [...downstream];
                    if (action === 'cancel') call.cancel(); else t.mock.timers.tick(10);
                    await immediate();
                    const code = action === 'cancel' ? grpc.status.CANCELLED : grpc.status.DEADLINE_EXCEEDED;
                    assert.deepEqual(results, [code]); assert.deepEqual(statuses, [code]);
                    assert.equal(layers[0].responseListener, undefined);
                    assert.equal(inbound.pendingMessage, undefined); assert.equal(inbound.pendingStatus, null);
                    assert.equal(inbound.hasPendingMessage, false); assert.equal(inbound.processingMetadata, false); assert.equal(inbound.processingMessage, false);
                    assert.equal(inbound.listener, undefined); assert.equal(inbound.nextListener, undefined);
                    resumed.metadata?.(new grpc.Metadata()); resumed.message?.({ text: payload });
                    resumed.status?.({ code: 0, details: '', metadata: new grpc.Metadata() });
                    inbound.onReceiveMetadata(new grpc.Metadata()); inbound.onReceiveMessage({ text: payload });
                    inbound.onReceiveStatus({ code: 0, details: '', metadata: new grpc.Metadata() });
                    await immediate(); assert.deepEqual(downstream, before); assert.deepEqual(statuses, [code]);
                    assert.equal(c.getChannel().activeCallCount(), 0); assert.equal(transportCall(call).diagnostics().timerActive, false);
                } finally { c.close(); }
            });
        });
    }
}

test('LIFETIME inbound metadata completion waits for an asynchronous message before one status', () => {
    const { InterceptingListenerImpl } = require('../dist/call-interface.js');
    for (const metadataFirst of [true, false]) {
        const continuations = {}, order = [];
        const listener = new InterceptingListenerImpl({
            onReceiveMetadata(_value, next) { continuations.metadata = next; },
            onReceiveMessage(_value, next) { continuations.message = next; },
            onReceiveStatus(value, next) { next(value); next(value); },
        }, {
            onReceiveMetadata() { order.push('metadata'); },
            onReceiveMessage(value) { order.push(value); },
            onReceiveStatus() { order.push('status'); },
        });
        listener.onReceiveMetadata(new grpc.Metadata()); listener.onReceiveMessage('original');
        listener.onReceiveStatus({ code: 0, details: '', metadata: new grpc.Metadata() });
        if (metadataFirst) {
            continuations.metadata(new grpc.Metadata()); continuations.metadata(new grpc.Metadata());
            assert.deepEqual(order, ['metadata']);
            continuations.message('rewritten'); continuations.message('duplicate');
        } else {
            continuations.message('rewritten'); continuations.message('duplicate'); assert.deepEqual(order, []);
            continuations.metadata(new grpc.Metadata()); continuations.metadata(new grpc.Metadata());
        }
        assert.deepEqual(order, ['metadata', 'rewritten', 'status']);
        assert.equal(listener.pendingMessage, undefined); assert.equal(listener.pendingStatus, null);
    }
});

test('LIFETIME inbound disposal during metadata delivery clears queued reply before reentry', () => {
    const { InterceptingListenerImpl } = require('../dist/call-interface.js');
    let resume; const events = [];
    const listener = new InterceptingListenerImpl({
        onReceiveMetadata(_value, next) { resume = next; },
        onReceiveMessage(value, next) { next(value); }, onReceiveStatus(value, next) { next(value); },
    }, {
        onReceiveMetadata() { events.push('metadata'); listener.disposePending(); },
        onReceiveMessage() { events.push('message'); }, onReceiveStatus() { events.push('status'); },
    });
    listener.onReceiveMetadata(new grpc.Metadata()); listener.onReceiveMessage(Buffer.alloc(100000));
    listener.onReceiveStatus({ code: 0, details: '', metadata: new grpc.Metadata() });
    resume(new grpc.Metadata()); assert.deepEqual(events, ['metadata']);
    assert.equal(listener.pendingMessage, undefined); assert.equal(listener.pendingStatus, null);
    assert.equal(listener.listener, undefined); assert.equal(listener.nextListener, undefined);
});

test('LIFETIME existing interceptor listeners are gated without disposing borrowed objects', () => {
    let incoming, borrowedDisposals = 0; const events = [];
    const next = { start(_metadata, listener) { incoming = listener; }, disposePending() {}, cancelWithStatus() {},
        getPeer() { return ''; }, getAuthContext() { return null; }, sendMessageWithContext() {}, sendMessage() {}, startRead() {}, halfClose() {} };
    const borrowed = { onReceiveMetadata(_metadata) { events.push('metadata'); }, onReceiveMessage(_message) { events.push('message'); },
        onReceiveStatus(_status) { events.push('status'); }, disposePending() { borrowedDisposals++; } };
    const call = new grpc.InterceptingCall(next, { start(metadata, _listener, next) { next(metadata, borrowed); } });
    call.start(new grpc.Metadata()); incoming.onReceiveMetadata(new grpc.Metadata()); assert.deepEqual(events, ['metadata']);
    call.disposePending(); incoming.onReceiveMetadata(new grpc.Metadata()); incoming.onReceiveMessage(Buffer.alloc(100000));
    incoming.onReceiveStatus({ code: 0, details: '', metadata: new grpc.Metadata() });
    assert.deepEqual(events, ['metadata']); assert.equal(borrowedDisposals, 0);
});
