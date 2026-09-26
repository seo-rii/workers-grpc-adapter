import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { OAuth2Client } from 'google-auth-library';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const projectId = 'wga-mode-fixture';
const services = ['datastore', 'firestore', 'secretmanager'];
const labels = ['default-before', 'cloudflare', 'gateway-a', 'gateway-b', 'default-after'];
const transports = Object.fromEntries(labels.filter(label => !label.startsWith('default')).map(label => [label,
  createWorkersGrpcTransport(label === 'cloudflare' ? { mode: 'cloudflare' } : {
    mode: 'grpc-web', endpoints: Object.fromEntries(services.map(service => [`${service}.googleapis.com`, `https://${label}.invalid`])),
  }),
]));

function clientFor(service, label, invocation) {
  const identity = `${invocation}-${service}-${label}`;
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: `fixture-${identity}` });
  const googleHeaders = authClient.getRequestHeaders.bind(authClient);
  authClient.getRequestHeaders = async url => {
    const headers = await googleHeaders(url);
    headers.set('x-fixture-client', identity);
    if (label.startsWith('gateway')) headers.set('x-serverless-authorization', `Bearer gateway-${identity}`);
    return headers;
  };
  const base = { projectId, authClient, preferRest: false, fallback: false };
  // Plain/default clients intentionally bypass gaxOptions to warm or reuse the
  // same GAX proto cache as explicitly configured transport instances.
  const options = transports[label]
    ? transports[label].gaxOptions({ projectId, authClient, preferRest: false }) : base;
  if (service === 'datastore') {
    const client = new Datastore(options);
    return { async run() {
      const [entity] = await client.get(client.key(['MixedMode', identity]));
      if (entity !== undefined) throw new Error('Expected missing Datastore entity');
      return identity;
    }, close: () => Promise.all([...(client.clients_?.values() || [])].map(client => client.close())) };
  }
  if (service === 'firestore') {
    const client = new Firestore(options);
    return { async run() {
      const snapshot = await client.doc(`mixed-mode/${identity}`).get();
      if (snapshot.exists) throw new Error('Expected missing Firestore document');
      return identity;
    }, close: () => client.terminate() };
  }
  const client = new SecretManagerServiceClient(options);
  return { async run() {
    const name = `projects/${projectId}/secrets/${identity}`;
    const [secret] = await client.getSecret({ name }, { timeout: 5000, retry: null });
    if (secret.name !== name) throw new Error('Unexpected Secret Manager name');
    return identity;
  }, close: () => client.close() };
}

export default {
  async fetch(request) {
    const [order, invocation] = new URL(request.url).pathname.slice(1).split('/');
    if (!['default-before', 'cloudflare', 'gateway-a'].includes(order) || !['first', 'second'].includes(invocation)) {
      return new Response('Not found', { status: 404 });
    }
    const clients = [];
    try {
      const results = [];
      // The first client for each SDK controls which constructor enters GAX's
      // shared proto cache. Other transports must remain independent of it.
      for (const service of services) {
        const client = clientFor(service, order, invocation);
        clients.push(client);
        results.push(await client.run());
      }
      const concurrent = [];
      for (const service of services) {
        for (const label of labels.filter(label => label !== order && label !== 'default-after')) {
          const client = clientFor(service, label, invocation);
          clients.push(client);
          concurrent.push(client.run());
        }
      }
      results.push(...await Promise.all(concurrent));
      // Warm explicit clients must not change later plain/default clients.
      for (const service of services) {
        const client = clientFor(service, 'default-after', invocation);
        clients.push(client);
        results.push(await client.run());
      }
      return Response.json({ status: 'passed', results });
    } catch (error) {
      return Response.json({ status: 'failed', message: String(error.message), code: error.code }, { status: 500 });
    } finally {
      await Promise.all(clients.map(client => client.close()));
    }
  },
};
