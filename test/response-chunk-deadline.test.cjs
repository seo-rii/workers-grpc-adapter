'use strict';
const test = require('node:test');
const { assert, grpc, client, serialize, trailers, immediate, transportCall } = require('./helpers.cjs');
const { encodeFrame } = require('../dist/wire.js');

for (const mode of ['cloudflare', 'grpc-web']) for (const kind of ['direct', 'unary', 'stream']) {
    for (const observed of [false, true]) for (const boundary of ['empty', 'header', 'payload']) {
        test(`DEADLINE stops expired ${boundary} chunks before another read, ${mode} ${kind}, observer=${observed}`, async t => {
            // Immediately fulfilled reads can keep an overdue timer queued.
            // Advance the wall clock independently of delivering its callback.
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let now = 1000, pulls = 0, cancelled = 0;
            t.mock.method(Date, 'now', () => now);
            const bytes = Buffer.concat([encodeFrame(serialize({ text: 'response' })), trailers()]);
            const chunks = boundary === 'empty' ? [Buffer.alloc(0), Buffer.alloc(0), bytes]
                : boundary === 'header' ? [bytes.subarray(0, 1), bytes.subarray(1)]
                    : [bytes.subarray(0, 5), bytes.subarray(5, 6), bytes.subarray(6)];
            const expireAt = boundary === 'payload' ? 2 : 1;
            const body = new ReadableStream({ pull(controller) {
                if (++pulls === expireAt) now = 1100;
                if (pulls <= chunks.length) controller.enqueue(chunks[pulls - 1]);
                else controller.close();
            }, cancel() { cancelled++; } }, { highWaterMark: 0 });
            const events = [];
            const c = client({}, { mode,
                ...(mode === 'grpc-web' ? { endpoints: { 'echo.test': 'https://gateway.test' } } : {}),
                ...(observed ? { observer: event => events.push(event) } : {}),
                fetcher: { async fetch() {
                    return new Response(body, { headers: { 'content-type': 'application/grpc-web' } });
                } },
            });
            let call, completions = 0;
            const messages = [], statuses = [], errors = [];
            try {
                const done = new Promise(resolve => {
                    if (kind === 'direct') {
                        call = c.getChannel().createCallForMethod('/demo.Echo/Stream', false, true, { deadline: 1100 });
                        call.start(new grpc.Metadata(), { onReceiveMetadata() {},
                            onReceiveMessage(value) { messages.push(value); call.startRead(); },
                            onReceiveStatus(value) { completions++; statuses.push(value.code); resolve(); },
                        });
                        call.startRead(); call.sendMessageWithContext({}, serialize({ text: 'request' })); call.halfClose();
                    } else {
                        if (kind === 'unary') call = c.unary({ text: 'request' }, { deadline: 1100 }, (error, value) => {
                            completions++; if (error) errors.push(error.code); else messages.push(value);
                        });
                        else {
                            call = c.stream({ text: 'request' }, { deadline: 1100 });
                            call.on('data', value => messages.push(value));
                            call.on('error', error => errors.push(error.code));
                        }
                        call.on('status', value => { if (kind === 'stream') completions++; statuses.push(value.code); resolve(); });
                    }
                });
                await done; await immediate();
                assert.deepEqual(statuses, [grpc.status.DEADLINE_EXCEEDED]);
                assert.deepEqual(messages, []);
                if (kind !== 'direct') assert.deepEqual(errors, [grpc.status.DEADLINE_EXCEEDED]);
                assert.equal(completions, 1);
                assert.equal(pulls, expireAt, 'an expired partial frame cannot request another Fetch chunk');
                assert.equal(cancelled, 1);
                assert.equal(body.locked, false);
                assert.equal(c.getChannel().activeCallCount(), 0);
                const diagnostics = (kind === 'direct' ? call : transportCall(call)).diagnostics();
                assert.equal(diagnostics.timerActive, false);
                if (observed) assert.equal(events.filter(event => event.type === 'call-end').length, 1);
            } finally { c.close(); }
        });
    }
}
