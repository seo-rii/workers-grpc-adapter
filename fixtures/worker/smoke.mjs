import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { Buffer } from 'node:buffer';
async function exerciseMode(mode) {
    const transport = createWorkersGrpcTransport(mode === 'cloudflare'
        ? { mode }
        : { mode, endpoints: { 'echo.test:443': 'https://gateway.test' } });
    const client = new Client('echo.test:443', credentials.createSsl(), transport.grpcOptions());
    try {
        // Echo protobuf field 1, length 2, contents "ok".
        const encode = () => Buffer.from([10, 2, 111, 107]);
        const decode = bytes => bytes.toString('hex');
        const metadata = new Metadata();
        metadata.set('x-fixture', 'worker-runtime');
        metadata.set('x-fixture-mode', mode);
        const value = await new Promise((resolve, reject) => {
            client.makeUnaryRequest('/demo.Echo/Unary', encode, decode, {}, metadata, { deadline: Date.now() + 5000 }, (error, result) => error ? reject(error) : resolve(result));
        });
        const streamed = await new Promise((resolve, reject) => {
            const values = [];
            const call = client.makeServerStreamRequest('/demo.Echo/Stream', encode, decode, {}, metadata, { deadline: Date.now() + 5000 });
            call.on('data', result => values.push(result));
            call.on('error', reject);
            call.on('end', () => resolve(values));
        });
        return { mode, value, streamed, status: 'passed' };
    }
    finally {
        client.close();
    }
}
export default {
    async fetch() {
        // Both configurations coexist in one isolate without changing global routing.
        return Response.json({ cases: await Promise.all(['cloudflare', 'grpc-web'].map(exerciseMode)) });
    },
};
