'use strict';
const { test } = require('node:test');
const { assert, grpc, client, response, deferred, serialize, transportCall, immediate } = require('./helpers.cjs');

for (const kind of ['direct', 'managed']) {
    for (const scenario of ['initial-expiry', 'compression-expiry', 'positive-header-snapshot']) {
        test(`DEADLINE ${kind} ${scenario} keeps status and timeout encoding consistent`, async t => {
            // Hold timer callbacks so only the explicitly supplied clock reads
            // can advance this boundary. Authentication gates the attempt.
            t.mock.timers.enable({ apis: ['setTimeout'] });
            let sequence, reads = 0;
            t.mock.method(Date, 'now', () => sequence ? sequence[Math.min(reads++, sequence.length - 1)] : 1000);
            const entered = deferred();
            let release;
            const auth = grpc.credentials.createFromMetadataGenerator((_options, callback) => {
                release = () => callback(null, new grpc.Metadata()); entered.resolve();
            });
            let fetches = 0, timeout;
            const reply = response();
            const c = client({}, { fetcher: { async fetch(_url, init) {
                fetches++; timeout = init.headers.get('grpc-timeout'); return reply;
            } } });
            let call, callbacks = 0;
            const statuses = [];
            try {
                const done = new Promise(resolve => {
                    if (kind === 'direct') {
                        call = c.getChannel().createCallForMethod('/demo.Echo/Unary', false, false, { deadline: 2000, credentials: auth });
                        call.start(new grpc.Metadata(), { onReceiveMetadata() {}, onReceiveMessage() {},
                            onReceiveStatus(result) { callbacks++; statuses.push(result.code); resolve(result.code); },
                        });
                        call.startRead();
                        call.sendMessageWithContext({}, serialize({ text: 'request' }));
                        call.halfClose();
                    } else {
                        call = c.unary({ text: 'request' }, { deadline: 2000, credentials: auth }, error => {
                            callbacks++; resolve(error?.code ?? grpc.status.OK);
                        });
                        call.on('status', result => statuses.push(result.code));
                    }
                });
                await entered.promise;
                sequence = scenario === 'initial-expiry' ? [2000]
                    : scenario === 'compression-expiry' ? [1999, 2000] : [1999, 1999, 2001];
                release();
                const expected = scenario === 'positive-header-snapshot' ? grpc.status.OK : grpc.status.DEADLINE_EXCEEDED;
                assert.equal(await done, expected);
                await immediate();
                assert.equal(callbacks, 1);
                assert.deepEqual(statuses, [expected]);
                assert.equal(fetches, expected === grpc.status.OK ? 1 : 0);
                if (expected === grpc.status.OK) {
                    assert.equal(timeout, '1m', 'the positive checked duration is the duration encoded in the header');
                    assert.equal(reads, 2, 'no extra clock read may turn the checked duration negative');
                }
                assert.equal(c.getChannel().activeCallCount(), 0);
                const diagnostics = (kind === 'direct' ? call : transportCall(call)).diagnostics();
                assert.deepEqual(diagnostics, { terminal: true, fetchCount: fetches, requestBytes: 0, responseBytes: 0, timerActive: false });
            } finally {
                c.close();
                await reply.body?.cancel().catch(() => {});
            }
        });
    }
}
