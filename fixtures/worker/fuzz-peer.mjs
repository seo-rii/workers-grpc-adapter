// Deliberately has no adapter imports: Node supplies independently encoded wire
// bytes; this peer checks requests and only controls Fetch chunk boundaries.
function check(value, message) { if (!value) throw new Error(message); }
function bytes(value) { return Uint8Array.from(atob(value), character => character.charCodeAt(0)); }

export default {
    async fetch(request) {
        try {
            const sample = JSON.parse(atob(request.headers.get('x-fuzz-fixture')));
            const url = new URL(request.url);
            const mime = sample.mode === 'cloudflare' ? 'application/grpc-web' : 'application/grpc-web+proto';
            check(request.method === 'POST', 'METHOD');
            check(url.origin === (sample.mode === 'cloudflare' ? 'https://fuzz.test' : 'https://fuzz-gateway.test'), 'ORIGIN');
            check(url.pathname === `/fixture.Fuzz/${sample.streaming ? 'Stream' : 'Unary'}`, 'PATH');
            check(request.headers.get('content-type') === mime && request.headers.get('accept') === mime, 'MIME');
            const input = new Uint8Array(await request.arrayBuffer());
            const expected = bytes(sample.request);
            check(input.length === expected.length + 5 && input[0] === 0, 'REQUEST_FLAGS');
            check(new DataView(input.buffer, input.byteOffset).getUint32(1) === expected.length, 'REQUEST_LENGTH');
            check(expected.every((byte, index) => input[index + 5] === byte), 'REQUEST_PAYLOAD');
            const wire = bytes(sample.wire), plan = sample.plan;
            let offset = 0, part = 0, empty = false;
            const body = new ReadableStream({
                pull(controller) {
                    if (!empty && plan.empties[part % plan.empties.length]) {
                        empty = true;
                        controller.enqueue(new Uint8Array(plan.padding + 1).subarray(plan.padding, plan.padding));
                        return;
                    }
                    empty = false;
                    if (offset === wire.length) { controller.close(); return; }
                    const length = Math.min(wire.length - offset, plan.sizes[part % plan.sizes.length]);
                    // Poison surrounding bytes to detect accidental backing-buffer use.
                    const storage = new Uint8Array(plan.padding + length + 3).fill(253);
                    storage.set(wire.subarray(offset, offset + length), plan.padding);
                    controller.enqueue(storage.subarray(plan.padding, plan.padding + length));
                    offset += length; part++;
                },
            }, { highWaterMark: 0 });
            return new Response(body, { headers: { 'content-type': mime, 'x-fuzz-peer': 'validated', ...sample.headers } });
        } catch (error) {
            return Response.json({ peerFailure: error.message }, { status: 500 });
        }
    },
};
