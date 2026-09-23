'use strict';
const { test } = require('node:test');
const { assert, grpc, client, response, withFetch, unary } = require('./helpers.cjs');

test('BRIDGE default propagation without a parent preserves unary behavior', async () => {
    const c = client();
    try {
        await withFetch(async () => response(), async () => {
            for (const propagate_flags of [undefined, 0, grpc.propagate.DEFAULTS]) {
                assert.deepEqual(await unary(c, { text: 'x' }, { parent: null, propagate_flags }).promise, { text: 'ok' });
            }
        });
    } finally { c.close(); }
});

test('BRIDGE identity write flags and unsupported WriteThrough terminate once', async () => {
    const c = client();
    let requests = 0;
    try {
        await withFetch(async (_url, init) => {
            requests++;
            assert.equal(Buffer.from(init.body)[0], 0);
            return response();
        }, async () => {
            for (const flags of [0, 1, 2, 3, 4, -1, 256, 0.5]) {
                const call = c.getChannel().createCallForMethod('/demo.Echo/Unary', false, false, {});
                let statuses = 0;
                const done = new Promise(resolve => call.start(new grpc.Metadata(), {
                    onReceiveMetadata() {}, onReceiveMessage() {},
                    onReceiveStatus(status) { statuses++; resolve(status); },
                }));
                call.startRead();
                call.sendMessageWithContext({ flags }, Buffer.from([10, 1, 120]));
                call.halfClose();
                const status = await done;
                assert.equal(status.code, flags >= 0 && flags <= 3 && Number.isInteger(flags) ? 0 : 12);
                assert.equal(statuses, 1);
                assert.equal(call.diagnostics().timerActive, false);
            }
        });
        assert.equal(requests, 4);
        assert.equal(c.getChannel().activeCallCount(), 0);
    } finally { c.close(); }
});

test('BRIDGE concurrent success/cancel stress retains final messages and frees calls', { timeout: 5000 }, async () => {
    const c = client();
    try {
        await withFetch(async () => response([{ text: 'first' }, { text: 'last' }], { chunkSize: 1 }), async () => {
            await Promise.all(Array.from({ length: 48 }, async (_, index) => {
                const stream = c.stream({ text: String(index) });
                if (index % 2 === 0) {
                    const failure = new Promise(resolve => stream.once('error', resolve));
                    stream.cancel();
                    assert.equal((await failure).code, 1);
                } else {
                    const values = [];
                    for await (const value of stream) values.push(value.text);
                    assert.deepEqual(values, ['first', 'last']);
                }
            }));
        });
        assert.equal(c.getChannel().activeCallCount(), 0);
    } finally { c.close(); }
});
