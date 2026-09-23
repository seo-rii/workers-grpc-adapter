import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { Buffer } from 'node:buffer';
export default {
    async fetch() {
        const client = new Client('echo.test:443', credentials.createSsl());
        try {
            // Echo protobuf field 1, length 2, contents "ok".
            const encode = () => Buffer.from([10, 2, 111, 107]);
            const decode = bytes => bytes.toString('hex');
            const metadata = new Metadata();
            metadata.set('x-fixture', 'worker-runtime');
            const value = await new Promise((resolve, reject) => {
                client.makeUnaryRequest('/demo.Echo/Unary', encode, decode, {}, metadata, { deadline: Date.now() + 5000 }, (error, result) => error ? reject(error) : resolve(result));
            });
            return Response.json({ value, status: 'passed' });
        }
        finally {
            client.close();
        }
    },
};
