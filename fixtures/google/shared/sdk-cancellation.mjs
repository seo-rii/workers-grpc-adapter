import * as grpc from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import { cancellableCall, cancellableQueryStream } from '@grpc/grpc-js/sdk';
import { Datastore, v1 } from '@google-cloud/datastore';
import { OAuth2Client } from 'google-auth-library';

export const cancellationScenarios = [
  'query-complete', 'query-destroy-first', 'query-break-first', 'query-destroy-inflight',
  'query-abort-inflight', 'query-precancel', 'query-lazy-cancel', 'query-shared-concurrent',
  'commit-complete', 'commit-cancel-inflight', 'commit-abort-inflight', 'commit-precancel',
  'commit-lazy-cancel', 'commit-completion-first', 'commit-shared-concurrent',
  'transaction-cancel-inflight', 'transaction-completion-first',
];
const zeroExecution = { activePumps: 0, pendingMessages: 0, pendingMessageBytes: 0,
  pendingWriteCallbacks: 0, parserAssemblies: 0, parserAssemblyBytes: 0, runtimeChunkBytes: 0 };
function check(value, label) { if (!value) throw new Error(`SDK_CANCEL_${label}`); }
function defer() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('SDK_CANCEL_TIMEOUT')), 10000);
  })]); } finally { clearTimeout(timer); }
}

// Fixture-only channel/observer instrumentation, including calls cancelled
// before their first Fetch. The lazy-query case additionally delays the real
// auth project-ID callback; installed source files remain unchanged.
function accounting() {
  const descriptor = Object.getOwnPropertyDescriptor(grpc.Channel.prototype, 'createCallForMethod');
  const captured = new Map(), events = [], aborts = [];
  const create = function(...args) {
    const call = descriptor.value.apply(this, args), logicalCallId = call.observation.id;
    check(!captured.has(logicalCallId), 'DISTINCT_CALL_ID');
    captured.set(logicalCallId, { call, channel: this, method: args[0], fetches: 0 });
    const start = call.start;
    call.start = function(metadata, listener) {
      const tagged = metadata.clone(); tagged.set('x-wga-sdk-call-id', logicalCallId);
      return start.call(this, tagged, listener);
    };
    return call;
  };
  Object.defineProperty(grpc.Channel.prototype, 'createCallForMethod', { ...descriptor, value: create });
  return {
    observer(event) { events.push(event); },
    async fetch(send, input, init) {
      const id = new Headers(init.headers).get('x-wga-sdk-call-id'), record = captured.get(id);
      check(record && record.method === new URL(input).pathname, 'FETCH_ID');
      record.fetches++;
      let abort;
      const stopped = new Promise((_, reject) => {
        abort = () => { aborts.push(id); reject(new DOMException('Fixture Fetch aborted', 'AbortError')); };
        init.signal.addEventListener('abort', abort, { once: true });
      });
      // This local Fetch implementation follows AbortSignal. The report does
      // not infer a deployed backend generator's cancellation from this hook.
      try { return await Promise.race([send(input, init), stopped]); }
      finally { init.signal.removeEventListener('abort', abort); }
    },
    async snapshot(transport) {
      for (let turn = 0; turn < 200; turn++) {
        const usage = transport.resourceUsage();
        if (usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0
          && [...captured.values()].every(({ call }) => Object.entries(zeroExecution)
            .every(([key, value]) => call.executionDiagnostics()[key] === value))) break;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
      await Promise.resolve();
      const usage = transport.resourceUsage();
      const resources = Object.fromEntries(['activeCalls', 'queuedCalls', 'bufferedBytes'].map(key => [key, usage[key]]));
      check(Object.values(resources).every(value => value === 0), 'RESOURCE_IDLE');
      const channels = new Set([...captured.values()].map(value => value.channel));
      check([...channels].every(channel => !channel.closed && channel.activeCallCount() === 0), 'CHANNEL_IDLE_BEFORE_CLOSE');
      const calls = [...captured].map(([logicalCallId, { call, method, fetches }]) => {
        const own = events.filter(event => event.logicalCallId === logicalCallId);
        const count = type => own.filter(event => event.type === type).length;
        const ends = own.filter(event => event.type === 'call-end');
        check(count('call-start') === 1 && ends.length === 1 && ends[0].fetchCount === fetches, 'ONE_TERMINAL');
        const diagnostics = call.diagnostics(), execution = call.executionDiagnostics();
        check(diagnostics.terminal && diagnostics.fetchCount === fetches && !diagnostics.timerActive
          && diagnostics.requestBytes === 0 && diagnostics.responseBytes === 0, 'CALL_RELEASED');
        check(Object.entries(zeroExecution).every(([key, value]) => execution[key] === value), 'EXECUTION_RELEASED');
        return { logicalCallId, method, startCount: count('call-start'), terminalCount: ends.length,
          fetchCount: fetches, fetchEventCount: count('fetch-start'), attemptCount: count('attempt-start'),
          authCount: count('auth-end'), statusCode: ends[0].statusCode, responseMessages: ends[0].responseMessages,
          diagnostics, execution };
      });
      check(events.every(event => captured.has(event.logicalCallId)), 'CAPTURED_EVENTS');
      return { beforeClose: true, resources, activeChannels: 0, channelCount: channels.size, calls, signalAborts: aborts };
    },
    restore() {
      check(grpc.Channel.prototype.createCallForMethod === create, 'HOOK_OWNERSHIP');
      Object.defineProperty(grpc.Channel.prototype, 'createCallForMethod', descriptor);
    },
  };
}

function observe(stream, onEntity) {
  const result = { ranks: [], names: [], errors: [], end: 0, close: 0 };
  const finished = new Promise(resolve => {
    stream.on('data', entity => {
      result.ranks.push(entity.rank); result.names.push(entity[Datastore.KEY].name);
      onEntity?.(entity, result.ranks.length);
    });
    stream.on('error', error => { result.errors.push(error.code ?? error.name); });
    stream.on('end', () => { result.end++; });
    stream.on('close', () => { result.close++; resolve(); });
  });
  return { result, finished };
}

export async function runSdkCancellation({ scenario, namespace, mode, send, control }) {
  check(cancellationScenarios.includes(scenario), 'KNOWN_SCENARIO');
  const tracker = accounting(), authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'sdk-cancellation-local-fixture' });
  let authNetworkRequests = 0;
  authClient.transporter.request = async () => { authNetworkRequests++; throw new Error('SDK_CANCEL_AUTH_NETWORK'); };
  const transport = createWorkersGrpcTransport({ mode,
    ...(mode === 'grpc-web' ? { endpoints: { 'datastore.googleapis.com': 'https://sdk-cancellation-gateway.invalid' } } : {}),
    observer: tracker.observer, fetcher: { fetch: (input, init) => tracker.fetch(send, input, init) } });
  const options = transport.gaxOptions({ projectId: 'wga-sdk-cancellation', authClient });
  const datastore = new Datastore({ ...options, namespace });
  const generated = new v1.DatastoreClient(options), streams = [];
  const gaxOptions = { timeout: 5000, retry: null, otherArgs: { headers: { 'x-wga-cancellation-case': namespace } } };
  const query = kind => datastore.createQuery(kind).order('rank').limit(6);
  const makeQuery = (kind, signal) => {
    const stream = cancellableQueryStream(gax => datastore.runQueryStream(query(kind), { gaxOptions: gax }),
      { gaxOptions, ...(signal ? { signal } : {}) });
    streams.push(stream); return stream;
  };
  const key = name => ({ partitionId: { projectId: options.projectId, namespaceId: namespace }, path: [{ kind: 'Write', name }] });
  const commitRequest = name => ({ projectId: options.projectId, mode: 'NON_TRANSACTIONAL', mutations: [{
    upsert: { key: key(name), properties: { rank: { integerValue: '41' } } },
  }] });
  const result = { scenario, started: 0, original: null, concurrent: null, reused: null, resolved: 0, rejected: 0,
    errorCodes: [], persisted: null, lazyBarrier: null, overlapAtCancel: null, authNetworkRequests: 0 };
  let delayedRelease;
  try {
    if (scenario.startsWith('query-')) {
      const controller = new AbortController();
      if (scenario === 'query-precancel') controller.abort();
      let arrival, originalGetProjectId;
      if (scenario === 'query-lazy-cancel') {
        arrival = defer(); const release = defer(); delayedRelease = release.resolve;
        originalGetProjectId = datastore.auth.getProjectId;
        datastore.auth.getProjectId = function(...args) {
          arrival.resolve(); release.promise.then(() => originalGetProjectId.apply(this, args));
        };
      }
      const stream = cancellableQueryStream(gax => {
        result.started++; return datastore.runQueryStream(query('Primary'), { gaxOptions: gax });
      }, { gaxOptions, signal: controller.signal });
      streams.push(stream);
      if (scenario === 'query-break-first') {
        const observed = { ranks: [], names: [], errors: [], end: 0, close: 0 };
        stream.on('error', error => { observed.errors.push(error.code ?? error.name); });
        stream.on('end', () => { observed.end++; });
        const closed = new Promise(resolve => stream.on('close', () => { observed.close++; resolve(); }));
        for await (const entity of stream) {
          observed.ranks.push(entity.rank); observed.names.push(entity[Datastore.KEY].name); break;
        }
        await bounded(closed); result.original = observed;
      } else {
        const observed = observe(stream, (_entity, count) => {
          if (scenario === 'query-destroy-first' && count === 1) stream.destroy();
        });
        if (scenario === 'query-lazy-cancel') {
          await bounded(arrival.promise); result.lazyBarrier = 'project-id-resolution'; stream.destroy();
          delayedRelease(); datastore.auth.getProjectId = originalGetProjectId;
        } else if (scenario.endsWith('-inflight') || scenario === 'query-shared-concurrent') {
          await bounded(control('await-held'));
          let parallel;
          if (scenario === 'query-shared-concurrent') {
            parallel = observe(makeQuery('Concurrent'));
            const sibling = await bounded(control('await-sibling'));
            result.overlapAtCancel = { activeCalls: transport.resourceUsage().activeCalls, pendingResponses: sibling.pendingResponses };
            check(result.overlapAtCancel.activeCalls === 2 && result.overlapAtCancel.pendingResponses === 2, 'QUERY_BOTH_ACTIVE');
          }
          if (scenario === 'query-abort-inflight') controller.abort(); else stream.destroy();
          if (parallel) {
            await bounded(observed.finished);
            await control('release-sibling');
            await bounded(parallel.finished); result.concurrent = parallel.result;
          }
        }
        await bounded(observed.finished); result.original = observed.result;
      }
    } else {
      const transactionCase = scenario.startsWith('transaction-');
      let transaction;
      if (transactionCase) {
        transaction = datastore.transaction(); await transaction.run({ gaxOptions });
        transaction.save({ key: datastore.key(['Write', 'primary']), data: { rank: 41 } });
      }
      const controller = new AbortController();
      if (scenario === 'commit-precancel') controller.abort();
      const operation = cancellableCall(gax => {
        result.started++; return transaction ? transaction.commit(gax) : generated.commit(commitRequest('primary'), gax);
      }, { gaxOptions, signal: controller.signal });
      const settled = operation.promise.then(tuple => {
        result.resolved++; check(tuple[0].mutationResults.length === 1, 'COMMIT_RESPONSE');
      }, error => { result.rejected++; result.errorCodes.push(error.code); });
      let sibling;
      if (scenario === 'commit-lazy-cancel') {
        check(!!generated.datastoreStub, 'GAPIC_LAZY_STUB_STARTED');
        result.lazyBarrier = 'gapic-initialize-promise'; operation.cancel();
      } else if (scenario.endsWith('-inflight') || scenario === 'commit-shared-concurrent') {
        await bounded(control('await-held'));
        if (scenario === 'commit-shared-concurrent') {
          sibling = generated.commit(commitRequest('concurrent'), gaxOptions);
          sibling.catch(() => {});
          const arrived = await bounded(control('await-sibling'));
          result.overlapAtCancel = { activeCalls: transport.resourceUsage().activeCalls, pendingResponses: arrived.pendingResponses };
          check(result.overlapAtCancel.activeCalls === 2 && result.overlapAtCancel.pendingResponses === 2, 'COMMIT_BOTH_ACTIVE');
        }
        if (scenario === 'commit-abort-inflight') controller.abort(); else operation.cancel();
        operation.cancel(); controller.abort();
      }
      await bounded(settled);
      if (sibling) {
        await control('release-sibling');
        const [other] = await bounded(sibling);
        check(other.mutationResults.length === 1, 'CONCURRENT_COMMIT_RESPONSE');
        result.concurrent = { committed: 'concurrent', mutations: 1 };
      }
      if (scenario === 'transaction-cancel-inflight') await bounded(control('await-rollback'));
      if (scenario.endsWith('-completion-first')) { operation.cancel(); controller.abort(); }
      if (!['commit-precancel', 'commit-lazy-cancel'].includes(scenario)) {
        const [lookup] = await generated.lookup({ projectId: options.projectId, keys: [key('primary')] }, gaxOptions);
        check(lookup.found.length === 1 && Number(lookup.found[0].entity.properties.rank.integerValue) === 41, 'ACCEPTED_WRITE_PERSISTS');
        result.persisted = { name: lookup.found[0].entity.key.path[0].name,
          rank: Number(lookup.found[0].entity.properties.rank.integerValue) };
      }
    }
    // Release the withheld successful reply after local cancellation, then run
    // a full query on this same high-level client. Late data must not revive it.
    await control('release');
    const reused = observe(makeQuery('Recovery'));
    await bounded(reused.finished); result.reused = reused.result;
    check(result.reused.ranks.join(',') === '0,1,2,3,4,5' && result.reused.errors.length === 0, 'SAME_CLIENT_RECOVERY');
    result.accounting = await tracker.snapshot(transport);
    result.authNetworkRequests = authNetworkRequests;
    return result;
  } finally {
    delayedRelease?.();
    for (const stream of streams) if (!stream.destroyed) stream.destroy();
    await generated.close();
    await Promise.all([...datastore.clients_.values()].map(client => client.close()));
    tracker.restore();
  }
}
