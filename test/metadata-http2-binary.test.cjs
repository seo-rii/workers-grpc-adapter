'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Metadata } = require('../dist/index.js');
const { decodeGrpcStatusDetails } = require('../dist/status-details.js');

const first = Buffer.from([8, 7, 18, 5, ...Buffer.from('first')]);
const second = Buffer.from([8, 7, 18, 6, ...Buffer.from('second')]);
for (const key of ['x-details-bin', 'grpc-status-details-bin', 'grpc-other-bin']) {
    for (const padded of [true, false]) {
        for (const representation of ['combined', 'array', 'combined array']) {
            test(`METADATA HTTP/2 splits ${key}, padded=${padded}, ${representation}`, () => {
                const encode = bytes => padded ? bytes.toString('base64') : bytes.toString('base64').replace(/=+$/, '');
                const values = [encode(first), encode(second)];
                const source = representation === 'combined' ? values.join(', ')
                    : representation === 'array' ? values : [values.join(', ')];
                const result = Metadata.fromHttp2Headers({ [key]: source });
                assert.deepEqual(result.get(key), [first, second]);
                if (key === 'grpc-status-details-bin') {
                    const status = { code: 7, details: 'original', metadata: result };
                    const decoded = decodeGrpcStatusDetails(status);
                    assert.equal(decoded.status, status);
                    assert.equal(decoded.diagnostic, 'multiple-values');
                    assert.equal(decoded.details, undefined);
                }
            });
        }
    }
}

test('METADATA HTTP/2 binary splitting preserves single rich status envelopes', () => {
    const metadata = Metadata.fromHttp2Headers({ 'grpc-status-details-bin': first.toString('base64') });
    const result = decodeGrpcStatusDetails({ code: 7, details: 'original', metadata });
    assert.equal(result.diagnostic, undefined);
    assert.equal(result.details.message, 'first');
});
