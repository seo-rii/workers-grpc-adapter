// Resolve the generated public entry and its declarations exactly as an ESM
// consumer does. No source-path mapping or repository types are available.
import { Datastore, OAuth2Client, createWorkersGrpcTransport, cancellableCall } from '@wga-fixture/google-workers';

const transport = createWorkersGrpcTransport({ mode: 'cloudflare', defaultTimeoutMs: 1000 });
const authClient = new OAuth2Client();
const datastore = new Datastore(transport.gaxOptions({ projectId: 'typecheck-only', authClient }));
const key = datastore.key(['FixtureValue', datastore.int('9007199254740993')]);
datastore.transaction().save({ key, data: { count: 1 } });
const pending = cancellableCall(gaxOptions => datastore.get(key, { gaxOptions }), {
  signal: new AbortController().signal,
  gaxOptions: { timeout: 1000, retry: null },
});
void pending.promise;
pending.cancel();
