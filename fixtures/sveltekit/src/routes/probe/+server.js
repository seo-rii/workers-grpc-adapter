import { env } from '$env/dynamic/private';
import { Datastore, OAuth2Client, createWorkersGrpcTransport, cancellableCall } from '$lib/server/google-workers.js';

function check(condition, diagnostic) {
  if (!condition) throw new Error(diagnostic);
}

export async function GET({ request, url }) {
  // The harness supplies a synthetic token only at runtime. This fixture never
  // consults ADC or service-account credentials and never contacts Google.
  if (!env.WGA_FIXTURE_GATEWAY || !env.WGA_FIXTURE_TOKEN) return new Response('Disabled', { status: 503 });
  const invocation = url.searchParams.get('run') || 'default';
  if (!/^[a-z0-9-]{1,30}$/.test(invocation)) return new Response('Invalid run', { status: 400 });
  const events = [];
  const loopback = env.WGA_FIXTURE_GATEWAY.startsWith('http://127.0.0.1:');
  const transport = createWorkersGrpcTransport({
    mode: 'grpc-web',
    endpoints: { 'datastore.googleapis.com': loopback ? 'https://datastore.fixture.invalid' : env.WGA_FIXTURE_GATEWAY },
    // The development peer is local HTTP. Keep the logical TLS route and SDK
    // credentials intact, and use a trusted fixture-only Fetch implementation.
    ...(loopback ? { fetcher: { fetch: (input, init) => fetch(env.WGA_FIXTURE_GATEWAY + new URL(input).pathname, init) } } : {}),
    defaultTimeoutMs: 5000,
    observer: event => events.push(event),
  });
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: env.WGA_FIXTURE_TOKEN });
  const datastore = new Datastore(transport.gaxOptions({
    projectId: 'wga-sveltekit-fixture', namespace: invocation, authClient,
  }));
  const key = datastore.key(['FixtureRoot', 'parent', 'FixtureValue', datastore.int('9007199254740993')]);
  try {
    const result = await cancellableCall(async gaxOptions => {
      const options = { gaxOptions };
      await datastore.save({ key, data: { count: 1, label: invocation } }, gaxOptions);
      const [entity] = await datastore.get(key, options);
      check(entity?.count === 1 && entity.label === invocation, 'SK_LOOKUP');
      const entityKey = entity[Datastore.KEY];
      check(entityKey?.id === '9007199254740993' && entityKey.namespace === invocation
        && entityKey.parent?.name === 'parent', 'SK_KEY_SYMBOL');
      const query = datastore.createQuery('FixtureValue').limit(2);
      const [rows] = await datastore.runQuery(query, options);
      check(rows.length === 1 && rows[0][Datastore.KEY].id === entityKey.id, 'SK_QUERY_KEY');
      const transaction = datastore.transaction();
      await transaction.run(options);
      const [before] = await transaction.get(key, options);
      check(before.count === 1, 'SK_TRANSACTION_READ');
      transaction.save({ key, data: { count: 2, label: invocation } });
      const [commit] = await transaction.commit(gaxOptions);
      check(commit.mutationResults?.length === 1, 'SK_TRANSACTION_RECEIPT');
      const [after] = await datastore.get(key, options);
      check(after.count === 2 && after[Datastore.KEY].id === entityKey.id, 'SK_TRANSACTION_RESULT');
      const usage = transport.resourceUsage();
      check(usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0, 'SK_RESOURCES_IDLE');
      return { invocation, key: { id: entityKey.id, parent: entityKey.parent.name, namespace: entityKey.namespace },
        queryRows: rows.length, count: after.count, commitMutations: commit.mutationResults.length,
        terminalStatuses: events.filter(event => event.type === 'call-end').map(event => event.statusCode), resources: usage };
    }, { signal: request.signal, gaxOptions: { timeout: 5000, retry: null } }).promise;
    return Response.json({ status: 'passed', ...result });
  } catch (error) {
    return Response.json({ status: 'failed', code: Number.isInteger(error.code) ? error.code : null,
      trailingStatus: error.metadata?.get('x-fixture-status') || [],
      terminalStatuses: events.filter(event => event.type === 'call-end').map(event => event.statusCode),
      resources: transport.resourceUsage() }, { status: 502 });
  } finally {
    // Explicitly close all lazily initialized SDK clients owned by this request.
    // The SDK has no aggregate close() in this pinned version.
    for (const client of datastore.clients_.values()) {
      if (typeof client.close === 'function') await client.close();
    }
  }
}
