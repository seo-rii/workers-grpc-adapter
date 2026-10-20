'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGrpcWebHandler, GrpcWebServerError } = require('../dist/server.js');
const { Metadata } = require('../dist/metadata.js');
const { status, TransportError } = require('../dist/status.js');
const { decodeFrames, parseTrailers } = require('../dist/wire.js');

const method = { path: '/fixture.ErrorInspection/Call', requestStream: true,
    requestDeserialize: bytes => bytes, responseSerialize: bytes => bytes };
const variants = [
    { name: 'plain Error', create: () => Object.assign(new Error('private handler failure'), {
        code: status.PERMISSION_DENIED, details: 'private details',
    }) },
    { name: 'revoked Proxy', create() {
        const resource = Proxy.revocable({}, {});
        resource.revoke();
        return resource.proxy;
    } },
    ...['code', 'details', 'metadata'].map(field => ({ name: `server error with throwing ${field}`, create() {
        const error = new GrpcWebServerError(status.PERMISSION_DENIED, 'private partial details');
        Object.defineProperty(error, field, { get() { throw new Error('private inspection failure'); } });
        return error;
    } })),
    ...['code', 'diagnostic'].map(field => ({ name: `transport error with throwing ${field}`, create() {
        const error = new TransportError(status.UNAVAILABLE, 'private partial diagnostic');
        Object.defineProperty(error, field, { get() { throw new Error('private inspection failure'); } });
        return error;
    } })),
    { name: 'explicit server error', code: status.PERMISSION_DENIED, details: 'public explanation', metadata: ['published'], create() {
        const metadata = new Metadata(); metadata.set('x-status', 'published');
        return new GrpcWebServerError(status.PERMISSION_DENIED, 'public explanation', metadata);
    } },
    { name: 'normal transport error', code: status.UNAVAILABLE, details: 'WGA_SERVER_TEST', create() {
        return new TransportError(status.UNAVAILABLE, 'WGA_SERVER_TEST');
    } },
];

for (const streaming of [false, true]) {
    for (const variant of variants) {
        test(`SERVER contains ${variant.name} and cleans resources with responseStream=${streaming}`, async () => {
            let cancelled = 0, returned = 0, context;
            const caller = new AbortController();
            const upload = new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 });
            const error = variant.create();
            const handler = createGrpcWebHandler({ call: { ...method, responseStream: streaming } }, { call(_input, ctx) {
                context = ctx;
                const trailing = new Metadata(); trailing.set('x-receipt', 'known'); ctx.setTrailer(trailing);
                if (!streaming) throw error;
                let reads = 0;
                return { [Symbol.asyncIterator]() { return this; }, async next() {
                    if (reads++ === 0) return { done: false, value: Buffer.from('ready') };
                    throw error;
                }, async return() { returned++; return { done: true }; } };
            } });
            try {
                const response = await handler(new Request('https://fixture.test' + method.path, {
                    method: 'POST', headers: { 'content-type': 'application/grpc-web+proto' },
                    body: upload, duplex: 'half', signal: caller.signal,
                }));
                const messages = [], trailers = [];
                for await (const frame of decodeFrames(response.body, 1024)) {
                    if (frame.trailer) trailers.push(parseTrailers(frame.payload));
                    else messages.push(frame.payload.toString());
                }
                assert.deepEqual(messages, streaming ? ['ready'] : []);
                assert.equal(trailers.length, 1);
                assert.equal(trailers[0].code, variant.code ?? status.INTERNAL);
                assert.equal(trailers[0].details, variant.details ?? 'WGA_SERVER_HANDLER');
                assert.deepEqual(trailers[0].metadata.get('x-receipt'), ['known']);
                assert.deepEqual(trailers[0].metadata.get('x-status'), variant.metadata ?? []);
                assert.equal(cancelled, 1, 'cancel the unread request upload once');
                assert.equal(returned, streaming ? 1 : 0, 'return an owned output iterator once');
                assert.equal(context.signal.aborted, true, 'abort the request context on terminal failure');
            } finally {
                // Release resources even when a regression makes the assertions fail.
                caller.abort();
            }
        });
    }
}
