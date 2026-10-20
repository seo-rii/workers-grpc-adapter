'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { once } = require('node:events');
const { Metadata } = require('../dist/index.js');
const { requestHeaders, metadataFromHeaders } = require('../dist/wire.js');

for (const conversion of ['getMap', 'toJSON', 'toHttp2Headers']) {
    for (const key of ['__proto__', 'constructor', 'x-fixture']) {
        test(`METADATA object conversion ${conversion} preserves own ${key} entries`, () => {
            const metadata = new Metadata();
            metadata.add(key, 'first');
            metadata.add(key, 'second');
            const result = metadata[conversion]();
            const expected = conversion === 'getMap' ? 'first' : ['first', 'second'];
            assert.equal(Object.hasOwn(result, key), true);
            assert.strictEqual(Object.getPrototypeOf(result), Object.prototype);
            assert.deepEqual(Object.keys(result), [key]);
            assert.deepEqual(result[key], expected);
            assert.deepEqual(Object.getOwnPropertyDescriptor(result, key), {
                value: expected, enumerable: true, configurable: true, writable: true,
            });
            const json = JSON.parse(JSON.stringify(result));
            assert.equal(Object.hasOwn(json, key), true);
            assert.deepEqual(json[key], expected);
            assert.deepEqual(metadata.get(key), ['first', 'second']);
        });
    }
}

test('METADATA prototype-named keys survive Metadata JSON serialization with ordinary and binary values', () => {
    const metadata = new Metadata();
    metadata.add('__proto__', 'one'); metadata.add('__proto__', 'two');
    metadata.set('x-fixture', 'ordinary'); metadata.set('proof-bin', Buffer.from([1, 2]));
    const json = JSON.parse(JSON.stringify(metadata));
    assert.equal(Object.hasOwn(json, '__proto__'), true);
    assert.deepEqual(json.__proto__, ['one', 'two']);
    assert.deepEqual(json['x-fixture'], ['ordinary']);
    assert.deepEqual(json['proof-bin'], [{ type: 'Buffer', data: [1, 2] }]);
    const map = metadata.getMap();
    assert.deepEqual(map['proof-bin'], Buffer.from([1, 2]));
    map['proof-bin'][0] = 9;
    assert.deepEqual(metadata.get('proof-bin'), [Buffer.from([1, 2])]);
    assert.deepEqual(metadata.toHttp2Headers()['proof-bin'], ['AQI=']);
});

test('METADATA prototype-named keys round-trip through Fetch headers and map conversion', () => {
    const metadata = new Metadata();
    metadata.set('__proto__', 'retained'); metadata.set('x-fixture', 'ordinary');
    const headers = requestHeaders(metadata);
    assert.equal(headers.get('__proto__'), 'retained');
    const received = metadataFromHeaders(headers, 'request');
    assert.deepEqual(received.get('__proto__'), ['retained']);
    const map = received.getMap();
    assert.equal(Object.hasOwn(map, '__proto__'), true);
    assert.equal(map.__proto__, 'retained');
    assert.equal(map['x-fixture'], 'ordinary');
    assert.strictEqual(Object.getPrototypeOf(map), Object.prototype);
});

test('METADATA HTTP/2 conversion delivers prototype-named headers to a real local peer', { timeout: 5000 }, async () => {
    const server = http2.createServer();
    server.on('stream', (stream, headers) => {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ hasOwn: Object.hasOwn(headers, '__proto__'),
            value: headers.__proto__, ordinary: headers['x-fixture'], binary: headers['proof-bin'] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = http2.connect('http://127.0.0.1:' + server.address().port);
    try {
        const metadata = new Metadata();
        metadata.set('__proto__', 'retained'); metadata.set('x-fixture', 'ordinary');
        metadata.set('proof-bin', Buffer.from([1, 2]));
        const observed = await new Promise((resolve, reject) => {
            const request = client.request(metadata.toHttp2Headers()), chunks = [];
            request.on('error', reject);
            request.on('data', chunk => chunks.push(chunk));
            request.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
                catch (error) { reject(error); }
            });
            request.end();
        });
        assert.deepEqual(observed, { hasOwn: true, value: 'retained', ordinary: 'ordinary', binary: 'AQI=' });
    } finally {
        client.destroy();
        await new Promise(resolve => server.close(resolve));
    }
});
