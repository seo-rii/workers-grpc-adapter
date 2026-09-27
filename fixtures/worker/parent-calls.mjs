import { Buffer } from 'node:buffer';
import { Client, propagate } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { createGrpcWebHandler, GrpcWebServerError } from '@grpc/grpc-js/server';
const serialize = value => Buffer.from(value.text);
const deserialize = value => ({ text: value.toString() });
const definition = { forward: { path: '/fixture.Parent/Forward', requestStream: false, responseStream: false,
    requestDeserialize: deserialize, responseSerialize: serialize } };
function check(condition, diagnostic) { if (!condition) throw new Error(diagnostic); }
function frame(value) {
    const payload = serialize(value), head = Buffer.alloc(5); head.writeUInt32BE(payload.length, 1);
    return Buffer.concat([head, payload]);
}
async function read(response) {
    const bytes = Buffer.from(await response.arrayBuffer()); const values = []; let code, offset = 0;
    while (offset < bytes.length) {
        check(bytes.length - offset >= 5, 'incomplete header');
        const flag = bytes[offset], size = bytes.readUInt32BE(offset + 1); offset += 5;
        check(bytes.length - offset >= size && code === undefined, 'bad frame size/order');
        const body = bytes.subarray(offset, offset + size); offset += size;
        if (flag === 128) { const match = body.toString().match(/(?:^|\r\n)grpc-status: (\d+)\r\n/); check(match, 'missing status'); code = Number(match[1]); }
        else { check(flag === 0, 'bad message flag'); values.push(body.toString()); }
    }
    check(code !== undefined, 'missing trailers'); return { code, values };
}
export default { async fetch() {
    const results = [];
    for (const mode of ['grpc-web', 'cloudflare']) for (const scenario of ['success', 'abort', 'deadline', 'no-propagation']) {
        const config = mode === 'grpc-web' ? { mode, endpoints: { 'child.test': 'https://child.test' } } : { mode };
        const transport = createWorkersGrpcTransport(config); const c = new Client('child.test', transport.channelCredentials, transport.grpcOptions());
        let childCode, parent; const caller = new AbortController();
        const handler = createGrpcWebHandler(definition, { forward(input, context) {
            parent = context;
            check(context.cancelled === false && context.getDeadline() === context.deadline, 'parent shape');
            return new Promise((resolve, reject) => {
                const options = { parent: context, ...(scenario === 'no-propagation' ? { propagate_flags: 0 } : {}) };
                c.makeUnaryRequest('/fixture.Child/Echo', serialize, deserialize, input, options, (error, value) => {
                    childCode = error?.code ?? 0;
                    if (error) reject(new GrpcWebServerError(error.code, 'Forwarded child failure'));
                    else resolve(value);
                });
                if (scenario === 'abort' || scenario === 'no-propagation') setTimeout(() => caller.abort(), 60);
            });
        } });
        try {
            const headers = { 'content-type': 'application/grpc-web', 'grpc-timeout': scenario === 'deadline' ? '120m' : '4000m' };
            const result = await read(await handler(new Request('https://parent.test/fixture.Parent/Forward', {
                method: 'POST', headers, body: frame({ text: scenario }), signal: caller.signal,
            })));
            if (scenario === 'success') { check(result.code === 0 && result.values.join() === 'success', 'success forwarding'); check(childCode === 0, 'child success'); }
            else if (scenario === 'deadline') { check(result.code === 4, 'server deadline'); }
            else check(result.code === 1, 'server abort');
            if (scenario !== 'success') {
                const until = Date.now() + 2500;
                while (childCode === undefined && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
                check(childCode !== undefined, 'child did not terminate');
                if (scenario === 'no-propagation') check(childCode === 0, 'disabled cancellation must preserve child');
                else check(childCode === 1 || (scenario === 'deadline' && childCode === 4), 'child cancellation/deadline');
            }
            check(c.getChannel().activeCallCount() === 0, 'active child leak');
            results.push({ mode, scenario, outerCode: result.code, childCode, parentCancelled: parent.cancelled, activeCalls: 0 });
        } finally { c.close(); }
    }
    return Response.json({ status: 'passed', results });
} };
