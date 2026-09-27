import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Metadata } from '@grpc/grpc-js';
import { createGrpcWebHandler } from '@grpc/grpc-js/server';

const receipts = [];
const codec = { requestStream: false, requestDeserialize: bytes => JSON.parse(bytes.toString()),
    responseSerialize: value => Buffer.from(JSON.stringify(value)) };
const definition = {
    unary: { ...codec, path: '/fixture.Lifecycle/Unary', responseStream: false },
    stream: { ...codec, path: '/fixture.Lifecycle/Stream', responseStream: true },
};
const handlers = {
    unary(value, context) {
        const receipt = receipts.find(item => item.id === context.metadata.get('x-case-id')[0]);
        receipt.input = value;
        try {
            if (value.kind === 'large-trailer' || value.kind === 'large-initial') {
                const metadata = new Metadata(); metadata.set('x', 'a'.repeat(65470));
                if (value.kind === 'large-trailer') context.setTrailer(metadata); else context.sendMetadata(metadata);
            }
            return value.kind === 'resource-large-response' ? { padding: 'x'.repeat(4096) } : value;
        } finally { receipt.active = false; receipt.finalized = true; receipt.complete(); }
    },
    async *stream(value, context) {
        const receipt = receipts.find(item => item.id === context.metadata.get('x-case-id')[0]);
        receipt.input = value;
        try {
            if (value.kind === 'resource-finite') {
                for (let index = 0; index < 8; index++) yield { index, padding: 'x'.repeat(128) };
                return;
            }
            yield { first: true };
            if (!context.signal.aborted) await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }));
            receipt.aborted = context.signal.aborted;
        } finally { receipt.active = false; receipt.finalized = true; receipt.complete(); }
    },
};
const handler = createGrpcWebHandler(definition, handlers);
const compressedHandler = createGrpcWebHandler(definition, handlers, { compression: 2 });
function frame(value, trailer = false) {
    const bytes = Buffer.from(value), header = Buffer.alloc(5);
    header[0] = trailer ? 0x80 : 0; header.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([header, bytes]);
}
// Independent test peer for the opt-in upload protocol. The production server
// API still rejects request-streaming registration; this is not that feature.
async function upload(request, receipt) {
    const reader = request.body.getReader();
    const values = [];
    let pending = Buffer.alloc(0);
    try {
        for (;;) {
            const item = await reader.read();
            if (item.done) break;
            pending = Buffer.concat([pending, Buffer.from(item.value)]);
            assert.ok(pending.length <= 8192);
            while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
                assert.equal(pending[0], 0);
                const length = pending.readUInt32BE(1);
                values.push(JSON.parse(pending.subarray(5, 5 + length).toString()));
                pending = pending.subarray(5 + length);
            }
        }
        assert.equal(pending.length, 0);
        assert.deepEqual(values, [0, 1, 2].map(id => ({ id, tenant: 'rewritten' })));
        receipt.input = values; receipt.uploadEOF = true;
        return new Response(Buffer.concat([frame(JSON.stringify({ accepted: 3 })), frame('grpc-status: 0\r\n', true)]),
            { headers: { 'content-type': 'application/grpc-web+proto' } });
    } finally {
        reader.releaseLock(); receipt.readerReleased = !request.body.locked;
        receipt.active = false; receipt.finalized = true; receipt.complete();
    }
}
export default {
    async fetch(request, _env, context) {
        if (new URL(request.url).pathname === '/control') return Response.json({ receipts,
            active: receipts.filter(item => item.active).length });
        const id = request.headers.get('x-case-id');
        assert.ok(id && !receipts.some(item => item.id === id) && receipts.length < 128);
        const receipt = { id, active: true, finalized: false };
        context.waitUntil(new Promise(resolve => Object.defineProperty(receipt, 'complete', { value: resolve })));
        receipts.push(receipt);
        try {
            const path = new URL(request.url).pathname;
            return path.endsWith('/ClientStream') || path.endsWith('/Bidi') ? await upload(request, receipt) : await (request.headers.get('x-compression') === 'gzip' ? compressedHandler : handler)(request);
        } catch (error) {
            receipt.active = false; receipt.finalized = true; receipt.complete();
            return Response.json({ status: 'failed', diagnostic: error.message }, { status: 500 });
        }
    },
};
