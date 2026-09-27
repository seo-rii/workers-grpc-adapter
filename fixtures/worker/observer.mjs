import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, Metadata, credentials } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const method = '/fixture.PrivateObserver/Unary';
const payload = 'synthetic-private-payload';
const reply = 'synthetic-private-response';
const secret = 'synthetic-private-token';
const serialize = value => Buffer.from(value);
const deserialize = value => value.toString();
const fields = {
    'call-start': [], 'call-admitted': ['queueMs'], 'attempt-start': ['attempt'],
    'auth-end': ['attempt', 'durationMs', 'statusCode'], 'fetch-start': ['attempt'],
    'response-headers': ['attempt'], 'first-message': ['attempt'],
    'attempt-end': ['attempt', 'durationMs', 'authDurationMs', 'fetchStarted', 'statusCode', 'sentBytes',
        'receivedBytes', 'responseMessages', 'responseMessageBytes'],
    'retry-scheduled': ['attempt', 'delayMs', 'statusCode'],
    'call-end': ['attemptCount', 'fetchCount', 'queueMs', 'statusCode', 'sentBytes', 'receivedBytes',
        'responseMessages', 'responseMessageBytes'],
};
function frame(value, flag = 0) {
    const bytes = Buffer.from(value), header = Buffer.alloc(5); header[0] = flag;
    header.writeUInt32BE(bytes.length, 1); return Buffer.concat([header, bytes]);
}
function metadata() {
    const value = new Metadata(); value.set('x-private-header', secret);
    value.set('private-bin', Buffer.from(secret)); return value;
}
function trace(events, codes, attempts, fetches) {
    assert.ok(!JSON.stringify(events).includes('synthetic-private'));
    const starts = events.filter(event => event.type === 'call-start');
    assert.equal(starts.length, codes.length);
    assert.equal(new Set(starts.map(event => event.logicalCallId)).size, starts.length);
    return starts.map((start, index) => {
        const selected = events.filter(event => event.logicalCallId === start.logicalCallId);
        let elapsed = 0;
        for (const event of selected) {
            assert.ok(Object.hasOwn(fields, event.type));
            assert.deepEqual(Object.keys(event).sort(), ['type', 'logicalCallId', 'elapsedMs', ...fields[event.type]].sort());
            assert.ok(Object.isFrozen(event));
            assert.ok(Number.isFinite(event.elapsedMs) && event.elapsedMs >= elapsed); elapsed = event.elapsedMs;
            for (const key of fields[event.type]) {
                if (key === 'fetchStarted') assert.equal(typeof event[key], 'boolean');
                else assert.ok(Number.isFinite(event[key]) && event[key] >= 0, `${event.type}/${key}`);
            }
        }
        const ends = selected.filter(event => event.type === 'call-end'); assert.equal(ends.length, 1);
        const end = ends[0]; assert.equal(selected.at(-1), end);
        assert.equal(end.statusCode, codes[index]); assert.equal(end.attemptCount, attempts[index]);
        assert.equal(end.fetchCount, fetches[index]);
        assert.equal(selected.filter(event => event.type === 'attempt-start').length, end.attemptCount);
        assert.equal(selected.filter(event => event.type === 'fetch-start').length, end.fetchCount);
        assert.equal(selected.filter(event => event.type === 'auth-end').length, end.attemptCount);
        const attemptEnds = selected.filter(event => event.type === 'attempt-end');
        assert.deepEqual(attemptEnds.map(event => event.attempt), Array.from({ length: end.attemptCount }, (_, i) => i + 1));
        for (const attempt of attemptEnds) {
            const of = type => selected.filter(event => event.type === type && event.attempt === attempt.attempt);
            const begin = of('attempt-start'), auth = of('auth-end'), fetch = of('fetch-start'), headers = of('response-headers');
            assert.equal(begin.length, 1); assert.equal(auth.length, 1);
            assert.ok(selected.indexOf(begin[0]) < selected.indexOf(auth[0]));
            assert.ok(selected.indexOf(auth[0]) < selected.indexOf(attempt));
            assert.equal(fetch.length, attempt.fetchStarted ? 1 : 0);
            assert.equal(headers.length, fetch.length);
            if (attempt.fetchStarted) {
                assert.ok(selected.indexOf(auth[0]) < selected.indexOf(fetch[0]));
                assert.ok(selected.indexOf(fetch[0]) < selected.indexOf(headers[0]));
                assert.ok(selected.indexOf(headers[0]) < selected.indexOf(attempt));
            }
        }
        for (const key of ['sentBytes', 'receivedBytes', 'responseMessages', 'responseMessageBytes']) {
            assert.equal(end[key], attemptEnds.reduce((sum, event) => sum + event[key], 0));
        }
        return { logicalCallId: start.logicalCallId, events: selected, terminalCode: end.statusCode,
            attemptCount: end.attemptCount, fetchCount: end.fetchCount, statuses: 1 };
    });
}
async function run() {
    const clients = [], transports = [], bodies = [], results = [], peerReceipts = [];
    const allIds = new Set(); let rpcCount = 0;
    async function until(predicate) {
        const deadline = Date.now() + 5000;
        while (!predicate()) { assert.ok(Date.now() < deadline, 'observer transition timed out'); await sleep(0); }
    }
    function peerResponse(code = 0, streaming = false) {
        const chunks = code === 0 ? [frame(reply)] : [];
        if (!streaming) chunks.push(frame(`grpc-status: ${code}\r\n${code === 14 ? 'grpc-retry-pushback-ms: 0\r\n' : ''}`, 128));
        let index = 0, ended = false, cancellations = 0, deliveredBytes = 0;
        const body = new ReadableStream({
            pull(controller) {
                if (index < chunks.length) {
                    const bytes = chunks[index++]; deliveredBytes += bytes.length; controller.enqueue(bytes);
                } else if (!streaming) { ended = true; controller.close(); }
            },
            cancel() { cancellations++; },
        }, { highWaterMark: 0 });
        bodies.push({ body, state: () => ({ bodyLocked: body.locked, ended, cancellations, deliveredBytes }) });
        return new Response(body, { headers: { 'content-type': 'application/grpc-web+proto', 'x-private-response': secret } });
    }
    function create(mode, events, config = {}, observerFailure) {
        let fetchCount = 0;
        const fetcher = { async fetch(url, init) {
            fetchCount++;
            assert.equal(new URL(url).origin, mode === 'cloudflare' ? 'https://private-observer.test' : 'https://private-gateway.test');
            assert.equal(init.cf?.grpcWeb, mode === 'cloudflare' ? 'convert' : 'passthrough');
            assert.equal(init.headers.get('x-private-header'), secret);
            assert.deepEqual(Buffer.from(init.body), frame(payload));
            const streaming = new URL(url).pathname.endsWith('/Stream');
            const code = config.retryPolicy && fetchCount === 1 ? 14 : 0;
            peerReceipts.push({ mode, sentBytes: init.body.byteLength, code, streaming });
            return peerResponse(code, streaming);
        } };
        const transport = createWorkersGrpcTransport({ mode, fetcher,
            ...(mode === 'grpc-web' ? { endpoints: { 'private-observer.test': 'https://private-gateway.test' } } : {}),
            ...config, observer(event) {
                events.push(event);
                if (observerFailure === 'throw') throw new Error(secret);
                if (observerFailure === 'reject') return Promise.reject(new Error(secret));
            },
        });
        transports.push(transport);
        const client = new Client('private-observer.test', transport.channelCredentials, transport.grpcOptions());
        clients.push(client); return { client, transport };
    }
    function unary(client, options = {}) {
        rpcCount++; const callbacks = [], statuses = [];
        const surface = client.makeUnaryRequest(method, serialize, deserialize, payload, metadata(),
            { deadline: Date.now() + 5000, ...options }, (error, value) => callbacks.push({ code: error?.code ?? 0, value }));
        const done = new Promise(resolve => surface.on('status', value => { statuses.push(value.code); resolve(value.code); }));
        return { surface, callbacks, statuses, done };
    }
    async function completed(call, code) {
        assert.equal(await call.done, code); await sleep(0);
        assert.deepEqual(call.statuses, [code]);
        assert.equal(call.callbacks.length, 1); assert.equal(call.callbacks[0].code, code);
        if (code === 0) assert.equal(call.callbacks[0].value, reply);
    }
    function record(mode, kind, events, codes, attempts, fetches, extra = {}) {
        const calls = trace(events, codes, attempts, fetches);
        for (const call of calls) { assert.equal(allIds.has(call.logicalCallId), false); allIds.add(call.logicalCallId); }
        results.push({ mode, kind, calls, privacyVerified: true, frozenEvents: true, ...extra });
    }
    try {
        for (const mode of ['cloudflare', 'grpc-web']) {
            {
                const events = []; let authCalls = 0;
                const auth = credentials.createFromMetadataGenerator((_options, callback) => {
                    authCalls++; const value = new Metadata(); value.set('authorization', `Bearer ${secret}`); callback(null, value);
                });
                const { client } = create(mode, events, { retryPolicy: { methods: [method], maxAttempts: 2,
                    initialBackoffMs: 1, maxBackoffMs: 1, retryableStatusCodes: [14] } });
                await completed(unary(client, { credentials: auth }), 0);
                assert.equal(authCalls, 2);
                assert.equal(events.filter(event => event.type === 'retry-scheduled').length, 1);
                const attemptEnds = events.filter(event => event.type === 'attempt-end');
                assert.deepEqual(attemptEnds.map(event => event.statusCode), [14, 0]);
                assert.deepEqual(attemptEnds.map(event => event.responseMessages), [0, 1]);
                assert.ok(attemptEnds.every(event => event.sentBytes === frame(payload).length && event.receivedBytes > 0));
                record(mode, 'retry', events, [0], [2], [2], { authCalls, retryCount: 1 }); client.close();
            }
            {
                const events = []; let release;
                const auth = credentials.createFromMetadataGenerator((_options, callback) => { release = callback; });
                const { client, transport } = create(mode, events, { resourceLimits: { maxConcurrentCalls: 1, maxQueuedCalls: 1 } });
                const active = unary(client, { credentials: auth }); await until(() => typeof release === 'function');
                const cancelled = unary(client); await until(() => transport.resourceUsage().queuedCalls === 1);
                cancelled.surface.cancel(); await completed(cancelled, 1);
                const expired = unary(client, { deadline: Date.now() + 40 }); await completed(expired, 4);
                assert.equal(events.filter(event => event.type === 'fetch-start').length, 0);
                release(null, new Metadata()); await completed(active, 0);
                record(mode, 'queue-terminal', events, [0, 1, 4], [1, 0, 0], [1, 0, 0], { queuedFetches: 0 }); client.close();
            }
            {
                const events = []; let release;
                const auth = credentials.createFromMetadataGenerator((_options, callback) => { release = callback; });
                const { client } = create(mode, events);
                const call = unary(client, { credentials: auth }); await until(() => typeof release === 'function');
                call.surface.cancel(); await completed(call, 1);
                const before = events.length;
                release(null, new Metadata()); await sleep(0); assert.equal(events.length, before);
                record(mode, 'auth-cancel', events, [1], [1], [0], { lateEvents: 0 }); client.close();
            }
            {
                const events = [], { client } = create(mode, events, { resourceLimits: { readableHighWaterMark: 1 } });
                rpcCount++;
                const stream = client.makeServerStreamRequest('/fixture.PrivateObserver/Stream', serialize, deserialize,
                    payload, metadata(), { deadline: Date.now() + 5000 });
                const statuses = [], errors = [], messages = [];
                stream.on('error', error => errors.push(error.code));
                const done = new Promise(resolve => stream.on('status', value => { statuses.push(value.code); resolve(); }));
                await new Promise(resolve => stream.once('data', value => { messages.push(value); resolve(); }));
                stream.destroy(); await done; await sleep(0);
                assert.deepEqual(statuses, [1]); assert.deepEqual(errors, []); assert.deepEqual(messages, [reply]);
                const end = events.find(event => event.type === 'call-end');
                assert.equal(end.sentBytes, frame(payload).length); assert.equal(end.receivedBytes, frame(reply).length);
                assert.equal(end.responseMessages, 1); assert.equal(end.responseMessageBytes, Buffer.byteLength(reply));
                record(mode, 'stream-destroy', events, [1], [1], [1], { messages: 1, bytesVerified: true }); client.close();
            }
            for (const failure of ['throw', 'reject']) {
                const events = [], { client } = create(mode, events, {}, failure);
                await completed(unary(client), 0);
                record(mode, `observer-${failure}`, events, [0], [1], [1], { rpcUnaffected: true }); client.close();
            }
            {
                const events = [], { client } = create(mode, events);
                await completed(unary(client), 0);
                record(mode, 'recovery', events, [0], [1], [1]); client.close();
            }
        }
        await until(() => transports.every(value => value.resourceUsage().bufferedBytes === 0));
        const usage = transports.map(value => value.resourceUsage());
        assert.ok(usage.every(value => value.activeCalls === 0 && value.queuedCalls === 0 && value.bufferedBytes === 0));
        const cleanup = bodies.map(value => value.state());
        assert.equal(cleanup.length, peerReceipts.length);
        assert.ok(cleanup.every(value => !value.bodyLocked && value.cancellations === (value.ended ? 0 : 1)));
        const calls = results.flatMap(value => value.calls);
        assert.equal(calls.length, rpcCount);
        assert.equal(calls.reduce((sum, call) => sum + call.fetchCount, 0), peerReceipts.length);
        return { status: 'passed', results, caseCount: results.length, rpcCount,
            attemptCount: calls.reduce((sum, call) => sum + call.attemptCount, 0), fetchCount: peerReceipts.length,
            eventCount: calls.reduce((sum, call) => sum + call.events.length, 0), cleanup, peerReceipts,
            resourcesIdle: true, activeClientCalls: clients.reduce((sum, value) => sum + value.getChannel().activeCallCount(), 0) };
    } finally { clients.forEach(value => value.close()); }
}
export default {
    async fetch() {
        try { return Response.json(await run()); }
        catch (error) { return Response.json({ status: 'failed', diagnostic: error.message, stack: error.stack }, { status: 500 }); }
    },
};
