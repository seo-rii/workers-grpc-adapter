import { Datastore, v1 } from '@google-cloud/datastore';
import { OAuth2Client } from 'google-auth-library';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { cancellableCall, cancellableQueryStream } from '@grpc/grpc-js/sdk';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(value, reason) { if (!value) throw new Error(`SDK_DEADLINE_${reason}`); }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function consume(stream) {
  const rows = [];
  try { for await (const row of stream) rows.push(row.rank); return { rows }; }
  catch (error) { return { rows, error }; }
}

/** Identical real-SDK consumer in Node and workerd, with controlled response loss. */
export async function runSdkDeadline({ scenario, mode, send }) {
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'sdk-deadline-local-fixture' });
  let authNetworkRequests = 0, fetches = 0, aborts = 0, held = 0;
  authClient.transporter.request = async () => { authNetworkRequests++; throw new Error('SDK_DEADLINE_AUTH_NETWORK'); };
  const transport = createWorkersGrpcTransport({ mode,
    ...(mode === 'grpc-web' ? { endpoints: { 'datastore.googleapis.com': 'https://sdk-deadline-gateway.invalid' } } : {}),
    fetcher: { async fetch(input, init) {
      fetches++;
      const response = await send(input, init);
      const primary = new Headers(init.headers).get('x-wga-deadline-operation') === 'primary';
      const method = new URL(input).pathname.split('/').pop();
      if (scenario === 'query-budget' && primary && fetches === 1) await pause(100);
      if (primary && (scenario === 'commit-response-lost' && method === 'Commit' || scenario === 'query-budget' && fetches === 2)) {
        held++;
        // The peer has accepted the request. Withhold its response locally;
        // an AbortSignal receipt proves local cleanup, not backend rollback.
        return new Promise((_resolve, reject) => {
          const abort = () => {
            aborts++; init.signal.removeEventListener('abort', abort);
            response.body?.cancel().catch(() => {});
            reject(new DOMException('Controlled response lost', 'AbortError'));
          };
          init.signal.addEventListener('abort', abort, { once: true });
          if (init.signal.aborted) abort();
        });
      }
      return response;
    } } });
  const options = transport.gaxOptions({ projectId: 'wga-sdk-deadline', authClient });
  const datastore = new Datastore(options), generated = new v1.DatastoreClient(options);
  const primaryOptions = { timeout: 10_000, retry: null, otherArgs: { headers: { 'x-wga-deadline-operation': 'primary' } } };
  const recoveryOptions = { timeout: 5000, retry: null };
  const key = { partitionId: { projectId: options.projectId }, path: [{ kind: 'Write', name: 'accepted' }] };
  let stream, parent, release, restore = () => {};
  try {
    const deadline = Date.now() + 1000;
    let result, persisted = false;
    if (scenario === 'commit-response-lost') {
      const operation = cancellableCall(gax => {
        parent = gax.otherArgs.options.parent;
        return generated.commit({ projectId: options.projectId, mode: 'NON_TRANSACTIONAL', mutations: [{
          upsert: { key, properties: { rank: { integerValue: '41' } } },
        }] }, gax);
      }, { deadline, gaxOptions: primaryOptions });
      result = await operation.promise.then(() => ({}), error => ({ error, rows: [] }));
      check(result.error?.code === 4 && held === 1, 'COMMIT_DEADLINE');
      const [lookup] = await generated.lookup({ projectId: options.projectId, keys: [key] }, recoveryOptions);
      persisted = Number(lookup.found[0]?.entity?.properties?.rank?.integerValue) === 41;
      check(persisted, 'COMMIT_ACCEPTANCE_SURVIVES_LOCAL_TIMEOUT');
    } else {
      let entered;
      if (scenario === 'query-lazy') {
        entered = deferred(); const gate = deferred(); release = gate.resolve;
        const original = datastore.auth.getProjectId;
        datastore.auth.getProjectId = function(...args) { entered.resolve(); gate.promise.then(() => original.apply(this, args)); };
        restore = () => { datastore.auth.getProjectId = original; };
      }
      stream = cancellableQueryStream(gax => {
        parent = gax.otherArgs.options.parent;
        return datastore.runQueryStream(datastore.createQuery('Primary').order('rank').limit(6), { gaxOptions: gax });
      }, { deadline, gaxOptions: primaryOptions });
      const consumed = consume(stream);
      if (entered) await entered.promise;
      result = await consumed;
      check(result.error?.code === 4, 'QUERY_DEADLINE');
      check(result.rows.join(',') === (scenario === 'query-budget' ? '0,1' : ''), 'QUERY_PARTIAL_ROWS');
      if (scenario === 'query-lazy') { restore(); release(); await pause(10); check(fetches === 0, 'LAZY_NO_FETCH'); }
      else check(fetches === 2 && held === 1, 'PAGINATION_STOPS');
    }
    check(parent.getDeadline() === deadline && parent.cancelled, 'SAME_ABSOLUTE_PARENT');
    // At a shared deadline the adapter timer can win the scheduling race. Its
    // original code-4 error must pass through; only the no-RPC lazy case is
    // guaranteed to have been settled by the helper's local timer.
    const deadlineOrigin = result.error.details === 'Deadline exceeded by SDK helper' ? 'helper' : 'adapter';
    if (scenario === 'query-lazy') check(deadlineOrigin === 'helper', 'LOCAL_ERROR_SURFACE');
    check(Object.keys(result.error.metadata.getMap()).length === 0, 'EMPTY_CONTROLLED_TRAILERS');
    const primaryFetches = fetches;
    const recovery = await consume(datastore.runQueryStream(datastore.createQuery('Recovery').order('rank').limit(6), { gaxOptions: recoveryOptions }));
    check(!recovery.error && recovery.rows.join(',') === '0,1,2,3,4,5', 'SHARED_CLIENT_RECOVERY');
    for (let turn = 0; turn < 100 && transport.resourceUsage().activeCalls; turn++) await pause(1);
    const { activeCalls, queuedCalls, bufferedBytes } = transport.resourceUsage();
    check(activeCalls === 0 && queuedCalls === 0 && bufferedBytes === 0, 'RESOURCES_RELEASED_BEFORE_CLOSE');
    check(authNetworkRequests === 0, 'NO_EXTERNAL_AUTH');
    return { scenario, errorCode: result.error.code, deadlineOrigin, partialRows: result.rows, persisted, primaryFetches,
      fetches, aborts, held, recoveryRows: recovery.rows, resources: { activeCalls, queuedCalls, bufferedBytes }, authNetworkRequests };
  } finally {
    restore(); release?.(); stream?.destroy();
    await generated.close();
    await Promise.all([...datastore.clients_.values()].map(client => client.close()));
  }
}
