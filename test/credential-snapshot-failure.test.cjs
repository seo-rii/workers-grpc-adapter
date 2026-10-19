'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { credentials, Metadata } = require('../dist/index.js');

const options = { service_url: 'https://auth.test/fixture.Service', method_name: '/fixture.Service/Call' };
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const delivery of ['synchronous', 'async-return', 'later-callback']) {
    test(`AUTH rejects a metadata snapshot failure from ${delivery} delivery`, async () => {
        const failure = new Error('controlled snapshot failure');
        class BrokenMetadata extends Metadata { clone() { throw failure; } }
        const deliver = done => {
            // Even an asynchronously delivered callback must not throw into
            // provider code, nor allow a later callback to replace its outcome.
            assert.doesNotThrow(() => done(null, new BrokenMetadata()));
            done(null, new Metadata());
            done(new Error('later callback'));
        };
        const provider = credentials.createFromMetadataGenerator(delivery === 'async-return'
            ? async (_options, done) => { await turn(); deliver(done); }
            : (_options, done) => {
                if (delivery === 'later-callback') setImmediate(() => deliver(done));
                else deliver(done);
            });
        let outcome;
        provider.generateMetadata(options).then(value => { outcome = { value }; }, error => { outcome = { error }; });
        await turn();
        await turn();
        assert.equal(outcome?.error, failure, 'The first callback rejects promptly with the snapshot failure');
    });
}

test('AUTH keeps the first successful metadata snapshot when the provider later fails', async () => {
    const metadata = new Metadata();
    metadata.set('x-subject', 'first');
    const provider = credentials.createFromMetadataGenerator(async (_options, done) => {
        done(null, metadata);
        metadata.set('x-subject', 'changed');
        done(new Error('later callback'));
        throw new Error('late rejected return');
    });
    const result = await provider.generateMetadata(options);
    assert.deepEqual(result.get('x-subject'), ['first']);
    await turn();
});
