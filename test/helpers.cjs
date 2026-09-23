'use strict';
const assert = require('node:assert/strict');
const { encodeFrame } = require('../dist/wire.js');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
function varint(n) {
    const bytes = [];
    do {
        const value = n % 128;
        n = Math.floor(n / 128);
        bytes.push(value | (n ? 128 : 0));
    } while (n);
    return Buffer.from(bytes);
}
// A real, deliberately small protobuf codec: message Echo { string text = 1; }.
function serialize(value) {
    const text = Buffer.from(value.text, 'utf8');
    return Buffer.concat([Buffer.from([10]), varint(text.length), text]);
}
function deserialize(bytes) {
    if (bytes.length === 0) {
        return { text: '' };
    }
    assert.equal(bytes[0], 10);
    let length = 0, scale = 1, i = 1;
    for (; i < bytes.length; i++) {
        length += (bytes[i] & 127) * scale;
        if (!(bytes[i] & 128)) {
            i++;
            break;
        }
        scale *= 128;
    }
    assert.equal(bytes.length - i, length);
    return { text: bytes.subarray(i).toString('utf8') };
}
const methods = {
    unary: { path: '/demo.Echo/Unary', requestStream: false, responseStream: false, requestSerialize: serialize, responseDeserialize: deserialize, originalName: 'Unary' },
    stream: { path: '/demo.Echo/Stream', requestStream: false, responseStream: true, requestSerialize: serialize, responseDeserialize: deserialize },
    clientStream: { path: '/demo.Echo/ClientStream', requestStream: true, responseStream: false, requestSerialize: serialize, responseDeserialize: deserialize },
    bidi: { path: '/demo.Echo/Bidi', requestStream: true, responseStream: true, requestSerialize: serialize, responseDeserialize: deserialize },
};
const Echo = grpc.makeGenericClientConstructor(methods, 'demo.Echo');
function client(options = {}, config = {}) {
    const factory = createWorkersGrpcTransport(config);
    return new Echo('echo.test:443', factory.channelCredentials, factory.grpcOptions(options));
}
function byteStream(bytes, chunkSize = bytes.length || 1, onCancel = () => {
}) {
    let offset = 0;
    return new ReadableStream({ pull(c) {
            if (offset === bytes.length) {
                c.close();
                return;
            }
            const end = Math.min(offset + chunkSize, bytes.length);
            c.enqueue(bytes.subarray(offset, end));
            offset = end;
        }, cancel: onCancel });
}
function trailers(code = 0, details = '', extra = '') {
    return encodeFrame(Buffer.from(`grpc-status: ${code}\r\ngrpc-message: ${encodeURIComponent(details)}\r\n${extra}`), true);
}
function response(messages = [{ text: 'ok' }], options = {}) {
    const bytes = Buffer.concat([...messages.map(x => encodeFrame(serialize(x))), trailers(options.code ?? 0, options.details ?? '', options.extra ?? '')]);
    return new Response(byteStream(bytes, options.chunkSize ?? bytes.length, options.onCancel), { status: options.httpStatus ?? 200, headers: { 'content-type': 'application/grpc-web+proto', ...(options.headers ?? {}) } });
}
async function withFetch(fake, fn) {
    const saved = globalThis.fetch;
    globalThis.fetch = fake;
    try {
        return await fn();
    }
    finally {
        globalThis.fetch = saved;
    }
}
function unary(c, arg = { text: 'request' }, ...options) {
    let call;
    const promise = new Promise((resolve, reject) => {
        call = c.unary(arg, ...options, (e, v) => e ? reject(e) : resolve(v));
    });
    return { call, promise };
}
function immediate() {
    return new Promise(resolve => setImmediate(resolve));
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
// Diagnostics belong to the adapter beneath upstream's interceptor wrappers.
function transportCall(surface) {
    const seen = new Set();
    let current = surface;
    while (current && !seen.has(current)) {
        if (typeof current.diagnostics === 'function') return current;
        seen.add(current);
        current = current.call ?? current.nextCall;
    }
    throw new Error('No WorkersCall below client surface');
}
module.exports = { assert, grpc, serialize, deserialize, methods, Echo, client, byteStream, trailers, response, withFetch, unary, immediate, deferred, transportCall };
