import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { Client, credentials, Metadata } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

export default {
  async fetch(request, env) {
    const clients = [];
    try {
      const invocation = new URL(request.url).pathname.slice(1);
      assert.ok(['cold', 'warm'].includes(invocation));
      const results = [];
      for (const mode of ['cloudflare', 'grpc-web']) {
        const route = mode === 'cloudflare' ? { mode } : {
          mode, endpoints: { 'echo.fixture.invalid': 'https://gateway.fixture.invalid' },
        };
        const a = createWorkersGrpcTransport({ ...route, fetcher: env.GATEWAY_A });
        const b = createWorkersGrpcTransport({ ...route, fetcher: env.GATEWAY_B });
        const plain = createWorkersGrpcTransport(route);
        const gax = a.gaxOptions({});
        const configurations = [
          ['default-before', 'default', plain.grpcOptions()],
          ['binding-a', 'a', a.grpcOptions()],
          ['binding-b', 'b', b.grpcOptions()],
          ['gax-a', 'a', Object.fromEntries(Object.entries(gax).filter(([key]) => key.startsWith('grpc.')))],
          ['default-after', 'default', plain.grpcOptions()],
        ];
        const values = await Promise.all(configurations.map(async ([label, expected, options]) => {
          const id = `${invocation}-${mode}-${label}`;
          let audience;
          const auth = credentials.combineChannelCredentials(credentials.createSsl(), credentials.createFromGoogleCredential({
            getRequestHeaders(url) { audience = url; return { authorization: `Bearer ${id}` }; },
          }));
          const client = new Client('echo.fixture.invalid', auth, options);
          clients.push(client);
          const metadata = new Metadata();
          metadata.set('x-fixture-id', id);
          metadata.set('x-fixture-mode', mode);
          metadata.set('x-fixture-owner', expected);
          const reply = await new Promise((resolve, reject) => {
            client.makeUnaryRequest('/fixture.Binding/Echo', value => Buffer.from(value), value => value.toString(), id,
              metadata, { deadline: Date.now() + 5000 }, (error, value) => error ? reject(error) : resolve(value));
          });
          assert.equal(reply, `${expected}:${id}`);
          assert.equal(audience, 'https://echo.fixture.invalid/fixture.Binding');
          assert.equal(client.getChannel().activeCallCount(), 0);
          return { id, invocation, mode, label, expected, status: 'passed' };
        }));
        results.push(...values);
      }
      return Response.json({ status: 'passed', results });
    } catch {
      return Response.json({ status: 'failed', diagnostic: 'FETCHER_WORKER_FIXTURE' }, { status: 500 });
    } finally { clients.forEach(client => client.close()); }
  },
};
