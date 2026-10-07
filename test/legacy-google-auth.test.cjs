'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const grpc = require('../dist/index.js');
const nativeRequire = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const native = nativeRequire('@grpc/grpc-js');
const options = { service_url: 'https://logical.test/fixture.Legacy', method_name: '/fixture.Legacy/Echo' };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

async function outcome(engine, setup) {
    const calls = [];
    const provider = setup(calls);
    try {
        const metadata = await engine.credentials.createFromGoogleCredential(provider).generateMetadata(options);
        return { headers: metadata.getMap(), calls };
    } catch (error) {
        return { error: { name: error.name, message: error.message, code: error.code }, calls };
    }
}

test('AUTH legacy callback contract matches pinned native grpc-js for supported records', async () => {
    assert.equal(nativeRequire('@grpc/grpc-js/package.json').version, '1.14.5');
    for (const kind of ['sync', 'async', 'empty', 'inherited', 'inherited-forEach', 'null-prototype', 'both']) {
        const setup = calls => {
            const provider = {
                getRequestMetadata(url, callback) {
                    calls.push({ api: 'legacy', url, receiver: this === provider });
                    let headers = { Authorization: 'Bearer fixture', 'x-goog-user-project': 'fixture-project' };
                    if (kind === 'empty') headers = {};
                    if (kind === 'inherited') headers = Object.assign(Object.create({ ignored: 'prototype' }), headers);
                    if (kind === 'inherited-forEach') headers = Object.assign(Object.create({ forEach() { throw new Error('Inherited helper must not run'); } }), headers);
                    if (kind === 'null-prototype') headers = Object.assign(Object.create(null), headers);
                    if (kind === 'async') setImmediate(() => callback(null, headers));
                    else callback(null, headers);
                },
            };
            if (kind === 'both') provider.getRequestHeaders = function (url) {
                calls.push({ api: 'modern', url, receiver: this === provider });
                return Promise.resolve({ authorization: 'Bearer modern' });
            };
            return provider;
        };
        const expected = await outcome(native, setup);
        const actual = await outcome(grpc, setup);
        assert.deepEqual(actual, expected, kind);
        assert.equal(actual.calls.length, 1, kind);
        assert.equal(actual.calls[0].url, options.service_url, kind);
        assert.equal(actual.calls[0].receiver, true, kind);
        if (kind === 'empty') assert.deepEqual(actual.headers, {});
        else assert.ok(actual.headers.authorization, kind);
        assert.equal(actual.headers.ignored, undefined, kind);
    }
});

test('AUTH legacy callback errors and first settlement match pinned native grpc-js', async () => {
    for (const kind of ['error', 'error-with-headers', 'undefined', 'null', 'throw', 'success-error', 'success-success', 'success-throw', 'error-success', 'missing-success']) {
        const setup = calls => ({
            getRequestMetadata(url, callback) {
                calls.push(url);
                const error = Object.assign(new Error('Controlled legacy failure'), { code: 16 });
                if (kind === 'throw') throw error;
                if (kind.startsWith('success')) {
                    callback(null, { authorization: 'Bearer first' });
                    if (kind === 'success-throw') throw error;
                    if (kind === 'success-error') callback(error);
                    else callback(null, { authorization: 'Bearer second' });
                } else if (kind === 'undefined' || kind === 'missing-success') {
                    callback(null);
                    if (kind === 'missing-success') callback(null, { authorization: 'Bearer late' });
                } else if (kind === 'null') callback(null, null);
                else {
                    callback(error, kind === 'error-with-headers' ? { authorization: 'Bearer ignored' } : undefined);
                    if (kind === 'error-success') callback(null, { authorization: 'Bearer late' });
                }
            },
        });
        assert.deepEqual(await outcome(grpc, setup), await outcome(native, setup), kind);
    }
});

test('AUTH modern Google provider retains precedence and never falls back after rejection', async () => {
    let legacyCalls = 0;
    const error = new Error('Controlled modern failure');
    const auth = {
        getRequestHeaders() { return Promise.reject(error); },
        getRequestMetadata(_url, callback) { legacyCalls++; callback(null, { authorization: 'Bearer fallback' }); },
    };
    await assert.rejects(grpc.credentials.createFromGoogleCredential(auth).generateMetadata(options), candidate => candidate === error);
    assert.equal(legacyCalls, 0);
    for (const headers of [new Headers({ authorization: 'Bearer modern' }), { authorization: 'Bearer modern', 'x-list': ['a', 'b'], ignored: undefined }]) {
        auth.getRequestHeaders = () => headers;
        const result = await grpc.credentials.createFromGoogleCredential(auth).generateMetadata(options);
        assert.equal(result.get('authorization')[0], 'Bearer modern');
        if (!(headers instanceof Headers)) assert.deepEqual(result.get('x-list'), ['a', 'b']);
    }
    assert.equal(legacyCalls, 0);
});

test('AUTH malformed legacy callback headers fail closed instead of becoming anonymous metadata', async () => {
    for (const headers of [[], ['token'], 1, true, 'token', new Headers(), { authorization: ['token'] }, { authorization: undefined }, { authorization: 1 }, { 'illegal key': 'token' }, { authorization: 'Bearer fixture\r\ninjected: x' }]) {
        const auth = { getRequestMetadata(_url, callback) { callback(null, headers); } };
        await assert.rejects(grpc.credentials.createFromGoogleCredential(auth).generateMetadata(options), Error);
    }
    for (const auth of [null, undefined, {}, { getRequestMetadata: true }, { getRequestHeaders: 'bad' }]) {
        assert.throws(() => grpc.credentials.createFromGoogleCredential(auth), TypeError);
    }
});

test('AUTH legacy async rejection is contained and cannot replace a settled callback', async () => {
    const failure = new Error('Controlled async legacy failure');
    for (const first of ['none', 'success', 'error']) {
        const auth = {
            async getRequestMetadata(_url, callback) {
                if (first === 'success') callback(null, { authorization: 'Bearer first' });
                if (first === 'error') callback(failure);
                throw new Error('Controlled rejected provider return');
            },
        };
        const pending = grpc.credentials.createFromGoogleCredential(auth).generateMetadata(options);
        if (first === 'success') assert.equal((await pending).get('authorization')[0], 'Bearer first');
        else await assert.rejects(pending, first === 'error' ? candidate => candidate === failure : { message: 'Controlled rejected provider return' });
        await nextTurn();
    }
});

test('AUTH legacy returned values never substitute for the required callback', async () => {
    let complete;
    const auth = { getRequestMetadata(_url, callback) { complete = callback; return Promise.resolve({ authorization: 'Bearer returned' }); } };
    let settled = false;
    const pending = grpc.credentials.createFromGoogleCredential(auth).generateMetadata(options).then(value => { settled = true; return value; });
    await nextTurn();
    assert.equal(settled, false);
    complete(null, { authorization: 'Bearer callback' });
    assert.equal((await pending).get('authorization')[0], 'Bearer callback');
});
