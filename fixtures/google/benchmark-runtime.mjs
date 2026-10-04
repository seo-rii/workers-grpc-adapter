import { OAuth2Client } from 'google-auth-library';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

// All values are synthetic fixture data. This Worker never contacts Google.
const projectId = 'wga-sdk-benchmark';
const turn = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(condition, label) { if (!condition) throw new Error(label); }

export function benchmarkWorker(constructors) {
  let clients = [], auth, anonymous = false, transport, authCalls = 0, contextId, initialized = false;
  const terminalCodes = [], observerEvents = [], probes = [];
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
    check(clients.length === 0, 'CLIENT_CONTEXT_MUST_BE_FRESH');
    anonymous = noAuthorization;
    contextId = noAuthorization ? 'unauthenticated' : 'authenticated';
    initialized = false;
    auth = new OAuth2Client({ clientId: 'benchmark', clientSecret: 'synthetic',
      endpoints: { oauth2TokenUrl: 'https://benchmark-oauth.invalid/token' } });
    auth.setCredentials({ access_token: 'benchmark-initial', refresh_token: 'synthetic-refresh', expiry_date: Date.now() + 3600000 });
    const headers = auth.getRequestHeaders.bind(auth);
    auth.getRequestHeaders = async url => { authCalls++; return anonymous ? new Headers() : headers(url); };
    transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: Object.fromEntries(
      ['datastore', 'firestore', 'secretmanager'].map(service => [`${service}.googleapis.com`, 'https://benchmark-peer.invalid'])),
      resourceLimits: { maxConcurrentCalls: 8, maxQueuedCalls: 16, maxBufferedBytes: 16 * 1024 * 1024, readableHighWaterMark: 1 },
      observer(event) {
        observerEvents.push(event);
        if (event.type === 'call-end') terminalCodes.push(event.statusCode);
        if (event.type === 'first-message') {
          // The host times receipt of this probe from phase dispatch. Workerd's
          // clock can stay frozen between I/O; never substitute its elapsedMs
          // for a host first-message latency. Probe overhead remains included.
          const probe = fetch('https://benchmark-control.invalid/first-message', {
            method: 'POST', body: JSON.stringify(event),
          }).then(async response => { check(response.ok, 'FIRST_MESSAGE_PROBE'); await response.text(); });
          // Observe rejection immediately, but preserve it for the phase await.
          probe.catch(() => {}); probes.push(probe);
        }
      },
    });
    const options = () => transport.gaxOptions({ projectId, authClient: auth, preferRest: false });
    if (constructors.Datastore) {
      const sdk = new constructors.Datastore(options());
      clients.push({ name: 'datastore', async initialize() {
        check(typeof sdk.initialize === 'undefined' && sdk.clients_.size === 0, 'DATASTORE_FRESH_HIGH_LEVEL_CLIENT');
        // Fixture-only pinned internal path: populate the same generated client
        // cache used by get(), without making a service RPC.
        await new Promise((resolve, reject) => sdk.prepareGaxRequest_({ client: 'DatastoreClient', method: 'lookup', reqOpts: {} },
          (error, requestFn) => error ? reject(error) : typeof requestFn === 'function' ? resolve() : reject(new Error('DATASTORE_PREPARE'))));
        const generated = sdk.clients_.get('DatastoreClient');
        check(generated && !generated.datastoreStub, 'DATASTORE_FRESH_GAPIC');
        await generated.initialize();
        check(!!generated.datastoreStub, 'DATASTORE_INITIALIZED');
        return { sdk: 'datastore', path: 'fixture-internal-prepareGaxRequest_-gapic.initialize', generatedClients: sdk.clients_.size, initialized: true };
      }, async rpc() {
        const [entity] = await sdk.get(sdk.key(['Benchmark', 'missing']), { gaxOptions: { retry: null, timeout: 10000 } });
        check(entity === undefined, 'DATASTORE_RESULT'); return 1;
      }, close: () => Promise.all([...(sdk.clients_?.values() || [])].map(client => client.close())) });
    }
    if (constructors.Firestore) {
      const sdk = new constructors.Firestore(options());
      clients.push({ name: 'firestore', async initialize() {
        check(sdk._clientPool.size === 0, 'FIRESTORE_FRESH_CLIENT_POOL');
        await sdk.initializeIfNeeded('benchmark-initialize');
        // initializeIfNeeded only freezes settings when projectId is supplied.
        // Explicitly initialize the pooled GAPIC used by doc().get().
        await sdk._clientPool.run('benchmark-initialize', true, async generated => {
          check(!generated.firestoreStub, 'FIRESTORE_FRESH_GAPIC');
          await generated.initialize(); check(!!generated.firestoreStub, 'FIRESTORE_INITIALIZED');
        });
        return { sdk: 'firestore', path: 'fixture-internal-initializeIfNeeded-clientPool-gapic.initialize',
          generatedClients: sdk._clientPool.size, initialized: true };
      }, async rpc() {
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
      clients.push({ name: 'secret-manager', async initialize() {
        check(!sdk.secretManagerServiceStub, 'SECRET_MANAGER_FRESH_GAPIC');
        await sdk.initialize(); check(!!sdk.secretManagerServiceStub, 'SECRET_MANAGER_INITIALIZED');
        return { sdk: 'secret-manager', path: 'public-initialize', generatedClients: 1, initialized: true };
      }, async rpc() {
        const name = `projects/${projectId}/secrets/benchmark`;
        const [secret] = await sdk.getSecret({ name }, { retry: null, timeout: 10000 });
        check(secret.name === name, 'SECRET_MANAGER_RESULT'); return 1;
      }, close: () => sdk.close() });
    }
  }
  return { async fetch(request) {
    const phase = new URL(request.url).pathname.slice(1);
    try {
      if (phase === 'ready') return Response.json({ status: 'passed', sdks, clientCount: clients.length, initialized });
      const beforeCalls = terminalCodes.length, beforeAuth = authCalls, beforeEvents = observerEvents.length, beforeProbes = probes.length;
      if (phase === 'close' || phase === 'close-unauthenticated') {
        await close();
        return Response.json({ status: 'passed', sdks, contextId, resources: transport.resourceUsage(), clientsClosed: true,
          logicalCalls: terminalCodes.length - beforeCalls, authMetadataCalls: authCalls - beforeAuth });
      }
      if (phase.startsWith('construct-')) {
        open(phase === 'construct-unauthenticated');
        return Response.json({ status: 'passed', sdks, contextId, clientCount: clients.length, initialized,
          logicalCalls: terminalCodes.length - beforeCalls, authMetadataCalls: authCalls - beforeAuth, resources: transport.resourceUsage() });
      }
      if (phase.startsWith('initialize-')) {
        check(contextId === phase.slice('initialize-'.length) && !initialized, 'INITIALIZATION_CONTEXT');
        const initialization = await Promise.all(clients.map(client => client.initialize())); initialized = true;
        return Response.json({ status: 'passed', sdks, contextId, clientCount: clients.length, initialized, initialization,
          logicalCalls: terminalCodes.length - beforeCalls, authMetadataCalls: authCalls - beforeAuth, resources: transport.resourceUsage() });
      }
      check(initialized && contextId === (phase === 'unauthenticated' ? 'unauthenticated' : 'authenticated'), 'RPC_INITIALIZED_CONTEXT');
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
      await Promise.all(probes.slice(beforeProbes));
      const resources = transport.resourceUsage();
      check(resources.activeCalls === 0 && resources.queuedCalls === 0 && resources.bufferedBytes === 0, 'RPC_RESOURCE_LEAK');
      return Response.json({ status: 'passed', sdks, contextId, messages, concurrency, resources,
        ...(heldResources ? { heldResources } : {}), logicalCalls: terminalCodes.length - beforeCalls,
        observerEvents: observerEvents.slice(beforeEvents), firstMessageProbes: probes.length - beforeProbes,
        terminalCodes: terminalCodes.slice(beforeCalls),
        authMetadataCalls: authCalls - beforeAuth, accessTokenRefreshed: auth.credentials.access_token.startsWith('benchmark-refreshed-'),
        slowConsumer: phase === 'concurrent' && sdks.includes('firestore') });
    } catch (error) {
      await close().catch(() => {});
      return Response.json({ status: 'failed', phase, diagnostic: String(error.message).slice(0, 300), code: error.code }, { status: 500 });
    }
  } };
}
