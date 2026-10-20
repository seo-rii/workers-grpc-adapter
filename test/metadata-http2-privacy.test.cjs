'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Metadata } = require('../dist/index.js');

test('METADATA HTTP/2 conversion discards invalid credentials without logging their contents', () => {
    const token = 'Bearer synthetic-private-value\tinvalid';
    const original = console.error, logged = [];
    let result;
    try {
        console.error = (...args) => logged.push(args);
        result = Metadata.fromHttp2Headers({ authorization: token, 'x-private': 'private\0value', 'x-proof': 'retained' });
    } finally { console.error = original; }
    assert.deepEqual(logged, [], 'library conversion must not write rejected metadata to the console');
    assert.deepEqual(result.get('authorization'), []);
    assert.deepEqual(result.get('x-private'), []);
    assert.deepEqual(result.get('x-proof'), ['retained']);
});

test('METADATA HTTP/2 conversion preserves valid credentials without logging', () => {
    const original = console.error, logged = [];
    let result;
    try {
        console.error = (...args) => logged.push(args);
        result = Metadata.fromHttp2Headers({ authorization: 'Bearer synthetic-token', 'x-proof': ['one', 'two'] });
    } finally { console.error = original; }
    assert.deepEqual(logged, []);
    assert.deepEqual(result.get('authorization'), ['Bearer synthetic-token']);
    assert.deepEqual(result.get('x-proof'), ['one', 'two']);
});
