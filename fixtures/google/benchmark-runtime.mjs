import { OAuth2Client } from 'google-auth-library';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

// All values are synthetic fixture data. This Worker never contacts Google.
const projectId = 'wga-sdk-benchmark';
const turn = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(condition, label) { if (!condition) throw new Error(label); }

export function benchmarkWorker(constructors) {
  let clients = [], auth, anonymous = false, transport, authCalls = 0;
  const terminalCodes = [];
  const sdks = [constructors.Datastore && 'datastore', constructors.Firestore && 'firestore',
    constructors.SecretManagerServiceClient && 'secret-manager'].filter(Boolean);
  async function close() {
    await Promise.all(clients.map(client => client.close()));
    clients = [];
    if (transport) {
      // Buffer cleanup can follow the SDK callback by a microtask.
      for (let attempt = 0; attempt < 10 && transport.resourceUsage().bufferedBytes; attempt++) await turn(0);
      const usage = transport.resourceUsage();
      check(usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0, 'RESOURCE_LEAK');
    }
  }
  function open(noAuthorization) {
    anonymous = noAuthorization;
    auth = new OAuth2Client({ clientId: 'benchmark', clientSecret: 'synthetic',
      endpoints: { oauth2TokenUrl: 'https://benchmark-oauth.invalid/token' } });
    auth.setCredentials({ access_token: 'benchmark-initial', refresh_token: 'synthetic-refresh', expiry_date: Date.now() + 3600000 });
    const headers = auth.getRequestHeaders.bind(auth);
    auth.getRequestHeaders = async url => { authCalls++; return anonymous ? new Headers() : headers(url); };
    transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: Object.fromEntries(
      ['datastore', 'firestore', 'secretmanager'].map(service => [`${service}.googleapis.com`, 'https://benchmark-peer.invalid'])),
      resourceLimits: { maxConcurrentCalls: 8, maxQueuedCalls: 16, maxBufferedBytes: 16 * 1024 * 1024, readableHighWaterMark: 1 },
      observer(event) { if (event.type === 'call-end') terminalCodes.push(event.statusCode); },
    });
    const options = () => transport.gaxOptions({ projectId, authClient: auth, preferRest: false });
    if (constructors.Datastore) {
      const sdk = new constructors.Datastore(options());
      clients.push({ name: 'datastore', async rpc() {
        const [entity] = await sdk.get(sdk.key(['Benchmark', 'missing']), { gaxOptions: { retry: null, timeout: 10000 } });
        check(entity === undefined, 'DATASTORE_RESULT'); return 1;
      }, close: () => Promise.all([...(sdk.clients_?.values() || [])].map(client => client.close())) });
    }
    if (constructors.Firestore) {
      const sdk = new constructors.Firestore(options());
      clients.push({ name: 'firestore', async rpc() {
        const result = await sdk.doc('benchmark/missing').get();
        check(!result.exists, 'FIRESTORE_RESULT'); return 1;
      }, async stream(input, ready) {
        const stream = sdk.collection('benchmark').stream();
        let messages = 0;
        try {
          for await (const item of stream) {
            const value = item.data();
            check(value.index === messages && value.payload.length === input.payloadBytes, 'STREAM_RESULT');
            messages++;
            if (messages === 1) await ready();
            await turn(input.consumerDelayMs);
          }
        } finally { if (!stream.readableEnded) stream.destroy(); }
        check(messages === input.messages, 'STREAM_MESSAGES');
        return messages;
      }, close: () => sdk.terminate() });
    }
    if (constructors.SecretManagerServiceClient) {
      const sdk = new constructors.SecretManagerServiceClient(options());
      clients.push({ name: 'secret-manager', async rpc() {
        const name = `projects/${projectId}/secrets/benchmark`;
        const [secret] = await sdk.getSecret({ name }, { retry: null, timeout: 10000 });
        check(secret.name === name, 'SECRET_MANAGER_RESULT'); return 1;
      }, close: () => sdk.close() });
    }
  }
  return { async fetch(request) {
    const phase = new URL(request.url).pathname.slice(1);
    try {
      if (phase === 'ready') return Response.json({ status: 'passed', sdks });
      const beforeCalls = terminalCodes.length, beforeAuth = authCalls;
      if (phase === 'close') {
        await close();
        return Response.json({ status: 'passed', resources: transport.resourceUsage(), clientsClosed: true });
      }
      if (phase === 'unauthenticated' || phase === 'authenticated') {
        await close(); open(phase === 'unauthenticated');
      }
      let messages = 0, concurrency = 1, heldResources;
      if (phase === 'refresh' || phase === 'concurrent') auth.setCredentials({
        access_token: 'benchmark-expired', refresh_token: 'synthetic-refresh', expiry_date: Date.now() - 1000,
      });
      if (phase === 'concurrent') {
        const input = await request.json();
        concurrency = input.concurrency;
        const streaming = clients.find(client => client.stream);
        let arrived = 0, release;
        const gate = new Promise(resolve => { release = resolve; });
        const ready = async () => {
          if (++arrived === concurrency) {
            heldResources = transport.resourceUsage();
            const response = await fetch('https://benchmark-control.invalid/held');
            check(response.ok, 'MEMORY_CHECKPOINT'); await response.text(); release();
          }
          await gate;
        };
        messages = (await Promise.all(Array.from({ length: concurrency }, async () => {
          if (streaming) return streaming.stream(input, ready);
          // Non-streaming SDK graphs still exercise shared admission and OAuth
          // refresh concurrently; only Firestore graphs claim slow consumers.
          return (await Promise.all(clients.map(client => client.rpc()))).reduce((a, b) => a + b, 0);
        }))).reduce((a, b) => a + b, 0);
      } else {
        check(['unauthenticated', 'authenticated', 'warm', 'compressed', 'refresh'].includes(phase), 'UNKNOWN_PHASE');
        messages = (await Promise.all(clients.map(client => client.rpc()))).reduce((a, b) => a + b, 0);
      }
      await turn(0);
      const resources = transport.resourceUsage();
      check(resources.activeCalls === 0 && resources.queuedCalls === 0 && resources.bufferedBytes === 0, 'RPC_RESOURCE_LEAK');
      return Response.json({ status: 'passed', sdks, messages, concurrency, resources,
        ...(heldResources ? { heldResources } : {}), logicalCalls: terminalCodes.length - beforeCalls,
        terminalCodes: terminalCodes.slice(beforeCalls),
        authMetadataCalls: authCalls - beforeAuth, accessTokenRefreshed: auth.credentials.access_token.startsWith('benchmark-refreshed-'),
        slowConsumer: phase === 'concurrent' && sdks.includes('firestore') });
    } catch (error) {
      await close().catch(() => {});
      return Response.json({ status: 'failed', phase, diagnostic: String(error.message).slice(0, 300), code: error.code }, { status: 500 });
    }
  } };
}
