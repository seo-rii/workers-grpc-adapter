'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('BIDI early OK settles pending writes without an error or losing a buffered response', { timeout: 15000 }, async t => {
    const { client, response, immediate } = require('./helpers.cjs');
    const errors = [], statuses = [], writes = [];
    const c = client({}, {
        mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' },
        experimentalRequestStreaming: true,
        fetcher: { async fetch() {
            // Complete without consuming the upload, leaving one active and one queued write.
            return response([{ text: 'retained response' }], { extra: 'x-receipt: retained\r\n' });
        } },
    });
    t.after(() => c.close());
    const call = c.bidi();
    call.on('error', error => errors.push(error));
    call.on('status', result => statuses.push(result));
    const terminal = new Promise(resolve => call.once('status', resolve));
    call.write({ text: 'pending' }, error => writes.push(error));
    call.write({ text: 'queued' }, error => writes.push(error));
    // Start reading into the Node buffer without consuming the response.
    call.read(0);
    const result = await terminal;
    await immediate(); await immediate();
    assert.equal(result.code, 0);
    assert.deepEqual(result.metadata.get('x-receipt'), ['retained']);
    assert.equal(statuses.length, 1);
    assert.deepEqual(errors, []);
    assert.equal(writes.length, 2);
    assert.ok(writes.every(error => error instanceof Error));
    assert.equal(c.getChannel().activeCallCount(), 0);
    assert.equal(call.destroyed, true);
    assert.equal(call.readableLength, 1);
    assert.deepEqual(call.read(), { text: 'retained response' });
    assert.equal(call.read(), null);
});

for (const action of ['cancel', 'deadline', 'close', 'remote', 'oversize', 'serialize']) {
    test(`BIDI delivers one RPC error while settling pending writes: ${action}`, () => {
        const source = `
            const assert = require('node:assert/strict');
            const { client, response } = require('./test/helpers.cjs');
            const action = ${JSON.stringify(action)};
            const errors = [], statuses = [], writes = [];
            const expected = { cancel: 1, deadline: 4, close: 14, remote: 7, oversize: 8, serialize: 13 }[action];
            const c = client(action === 'oversize' ? { 'grpc.max_send_message_length': 1 } : {}, {
                mode: 'grpc-web', endpoints: { 'echo.test': 'https://gateway.test' },
                experimentalRequestStreaming: true,
                fetcher: { async fetch() {
                    if (action === 'remote') return response([], { code: 7, details: 'remote denied', extra: 'x-receipt: retained\\r\\n' });
                    return new Promise(() => {});
                } },
            });
            const call = c.bidi(action === 'deadline' ? { deadline: Date.now() + 40 } : {});
            // A duplicate error must fail this process, not be hidden by a persistent listener.
            call.once('error', error => errors.push(error));
            const guard = setTimeout(() => { throw new Error('terminal delivery stalled'); }, 10000);
            call.on('status', result => {
                statuses.push(result);
                setImmediate(() => setImmediate(() => {
                    assert.equal(errors.length, 1);
                    assert.equal(errors[0].code, expected);
                    assert.equal(statuses.length, 1);
                    assert.equal(result.code, expected);
                    assert.equal(writes.length, 2);
                    assert.ok(writes.every(error => error instanceof Error));
                    assert.equal(c.getChannel().activeCallCount(), 0);
                    assert.equal(call.destroyed, true);
                    if (action === 'remote') {
                        assert.equal(errors[0].details, 'remote denied');
                        assert.deepEqual(errors[0].metadata.get('x-receipt'), ['retained']);
                    }
                    clearTimeout(guard); c.close();
                    console.log(JSON.stringify({ code: result.code, errors: errors.length, writes: writes.length }));
                }));
            });
            call.write(action === 'serialize' ? {} : { text: 'first' }, error => writes.push(error));
            call.write({ text: 'queued' }, error => writes.push(error));
            if (action === 'cancel') call.cancel();
            if (action === 'close') c.close();
        `;
        const result = cp.spawnSync(process.execPath, ['-e', source], {
            cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: '' },
        });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        assert.equal(JSON.parse(result.stdout).errors, 1);
    });
}
