import { Datastore, v1 } from '@google-cloud/datastore';
import { PassThroughClient } from 'google-auth-library';

export const transactionScenarios = ['commit-success', 'query-commit', 'rollback-queued', 'readonly-read',
  'readonly-write-rejected', 'commit-aborted', 'disconnect-before-apply', 'disconnect-after-apply',
  'v1-deadline-commit', 'crossed-transactions'];
export function transactionCheck(condition, diagnostic) {
  if (!condition) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic });
}
export function safeTransactionError(error) {
  return /^TX_[A-Z_]+$/.test(error?.fixtureDiagnostic) ? error.fixtureDiagnostic : 'TX_HARNESS_FAILURE';
}
export async function observeTransactionCalls(events, transport) {
  for (let turn = 0; turn < 200; turn++) {
    const usage = transport.resourceUsage();
    if (usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const usage = transport.resourceUsage();
  transactionCheck(usage.activeCalls === 0 && usage.queuedCalls === 0 && usage.bufferedBytes === 0, 'TX_RESOURCE_IDLE');
  const calls = [...new Set(events.map(event => event.logicalCallId))].map(logicalCallId => {
    const call = events.filter(event => event.logicalCallId === logicalCallId);
    const starts = call.filter(event => event.type === 'call-start'), ends = call.filter(event => event.type === 'call-end');
    const attempts = call.filter(event => event.type === 'attempt-start'), fetches = call.filter(event => event.type === 'fetch-start');
    transactionCheck(starts.length === 1 && ends.length === 1 && attempts.length === 1 && fetches.length === 1
      && ends[0].attemptCount === 1 && ends[0].fetchCount === 1, 'TX_OBSERVER_LIFETIME');
    return { logicalCallId, startCount: 1, terminalCount: 1, attemptCount: 1, fetchCount: 1,
      statusCode: ends[0].statusCode, responseMessages: ends[0].responseMessages };
  });
  return { calls, resources: { activeCalls: usage.activeCalls, queuedCalls: usage.queuedCalls, bufferedBytes: usage.bufferedBytes } };
}

// Exact business source for both pinned SDKs, native grpc-js and Fetch runtimes.
// The peer owns synthetic transaction state; this does not assert Google IAM or
// production conflict semantics. Both public commit Promise surfaces omit a
// cancel handle; the generated-v1 case bounds its accepted write by deadline.
export async function runDatastoreTransactions({ options, scenario, caseId, control, beforeClose }) {
  transactionCheck(transactionScenarios.includes(scenario), 'TX_KNOWN_SCENARIO');
  const config = { ...options, authClient: new PassThroughClient(), databaseId: 'tx-db',
    clientConfig: { interfaces: { 'google.datastore.v1.Datastore': { methods: Object.fromEntries(
      ['BeginTransaction', 'Lookup', 'RunQuery', 'Commit', 'Rollback'].map(name => [name, { timeout_millis: 2000, retry_codes: [] }])) } } } };
  const datastore = new Datastore({ ...config, namespace: 'tx-fixture' });
  let generated;
  const key = id => datastore.key(['TransactionValue', id]);
  const gax = identity => ({ timeout: 2000, retry: null, otherArgs: { headers: {
    'x-wga-case': caseId, 'x-wga-invocation': caseId, 'x-wga-identity': identity } } });
  const read = identity => ({ gaxOptions: gax(identity) });
  const result = { scenario, surface: scenario === 'v1-deadline-commit' ? 'generated-v1' : 'high-level',
    transactionIds: [], readCounts: [], commitResponses: [], errorCode: null, persistedCounts: [], cancelHandleAvailable: null,
    resolved: 0, rejected: 0, sameClientRecovery: false, noLateEvents: false };
  const remember = transaction => { const id = transaction.id.toString('hex'); result.transactionIds.push(id); return id; };
  const commitSummary = response => ({ mutationCount: response.mutationResults.length,
    versions: response.mutationResults.map(item => String(item.version)), indexUpdates: response.indexUpdates });
  async function commit(transaction, identity) {
    try {
      const pending = transaction.commit(gax(identity));
      result.cancelHandleAvailable = typeof pending.cancel === 'function';
      transactionCheck(result.cancelHandleAvailable === false, 'TX_COMMIT_CANCEL_SURFACE');
      const tuple = await pending; transactionCheck(tuple.length === 1, 'TX_COMMIT_TUPLE');
      result.commitResponses.push(commitSummary(tuple[0])); result.resolved++;
    } catch (error) { result.errorCode = error.code; result.rejected++; }
  }
  try {
    if (scenario === 'v1-deadline-commit') {
      // The high-level client parses host:port; generated v1 accepts them as
      // separate public options. Both still target the same local native peer.
      const endpoint = options.apiEndpoint ? new URL(`http://${options.apiEndpoint}`) : null;
      generated = new v1.DatastoreClient({ ...config, ...(endpoint ? { apiEndpoint: endpoint.hostname, port: Number(endpoint.port) } : {}) });
      const [begin] = await generated.beginTransaction({ projectId: 'demo-wga-transactions', databaseId: 'tx-db', transactionOptions: { readWrite: {} } }, gax('a'));
      result.transactionIds.push(Buffer.from(begin.transaction).toString('hex'));
      const pending = generated.commit({ projectId: 'demo-wga-transactions', databaseId: 'tx-db', transaction: begin.transaction, mode: 'TRANSACTIONAL',
        mutations: [{ upsert: { key: { partitionId: { projectId: 'demo-wga-transactions', databaseId: 'tx-db', namespaceId: 'tx-fixture' }, path: [{ kind: 'TransactionValue', name: 'a' }] }, properties: { count: { integerValue: '2' } } } }] }, gax('a'));
      // Observe rejection immediately, before the received-commit barrier.
      const settled = pending.then(() => { result.resolved++; }, error => { result.rejected++; result.errorCode = error.code; });
      result.cancelHandleAvailable = typeof pending.cancel === 'function';
      transactionCheck(result.cancelHandleAvailable === false, 'TX_COMMIT_CANCEL_SURFACE');
      await control('await-commit'); await settled;
      // Deadline is local completion, never proof that an accepted mutation was undone.
      const [recovery] = await generated.lookup({ projectId: 'demo-wga-transactions', databaseId: 'tx-db',
        keys: [{ partitionId: { projectId: 'demo-wga-transactions', databaseId: 'tx-db', namespaceId: 'tx-fixture' }, path: [{ kind: 'TransactionValue', name: 'a' }] }] }, gax('recovery'));
      result.persistedCounts.push(Number(recovery.found[0].entity.properties.count.integerValue));
      result.sameClientRecovery = true;
    } else if (scenario === 'crossed-transactions') {
      const first = datastore.transaction(), second = datastore.transaction();
      await first.run({ gaxOptions: gax('a') }); remember(first);
      await second.run({ gaxOptions: gax('b') }); remember(second);
      result.readCounts.push((await second.get(key('b'), read('b')))[0].count);
      result.readCounts.push((await first.get(key('a'), read('a')))[0].count);
      first.save({ key: key('a'), data: { count: 2 } }); second.save({ key: key('b'), data: { count: 3 } });
      await commit(second, 'b'); await commit(first, 'a');
      for (const id of ['a', 'b']) result.persistedCounts.push((await datastore.get(key(id), read('recovery')))[0].count);
      result.sameClientRecovery = true;
    } else {
      const readonly = scenario.startsWith('readonly');
      const transaction = datastore.transaction({ readOnly: readonly });
      const begun = await transaction.run({ gaxOptions: gax('a') });
      transactionCheck(begun.length === 2 && begun[0] === transaction && Buffer.from(begun[1].transaction).equals(transaction.id), 'TX_BEGIN_TUPLE');
      remember(transaction);
      if (scenario === 'query-commit') {
        const query = transaction.createQuery('TransactionValue').filter('count', '=', 1).limit(2);
        const [rows, info] = await transaction.runQuery(query, read('a'));
        transactionCheck(rows.length === 1 && rows[0][Datastore.KEY].name === 'a' && info.moreResults === Datastore.NO_MORE_RESULTS, 'TX_QUERY_RESULT');
        result.readCounts.push(rows[0].count);
      } else result.readCounts.push((await transaction.get(key('a'), read('a')))[0].count);
      if (scenario !== 'readonly-read') transaction.save({ key: key('a'), data: { count: 2 } });
      if (scenario === 'rollback-queued') { const tuple = await transaction.rollback(gax('a')); transactionCheck(tuple.length === 1, 'TX_ROLLBACK_TUPLE'); result.resolved++; }
      else await commit(transaction, 'a');
      result.persistedCounts.push((await datastore.get(key('a'), read('recovery')))[0].count);
      result.sameClientRecovery = true;
    }
    const code = scenario === 'readonly-write-rejected' ? 3 : scenario === 'commit-aborted' ? 10
      : scenario.startsWith('disconnect-') ? 14 : scenario === 'v1-deadline-commit' ? 4 : null;
    transactionCheck(result.errorCode === code && result.rejected === (code === null ? 0 : 1)
      && result.resolved === (code === null ? scenario === 'crossed-transactions' ? 2 : 1 : 0), 'TX_APPLICATION_TERMINAL');
    const expected = scenario === 'crossed-transactions' ? [2, 3]
      : ['commit-success', 'query-commit', 'disconnect-after-apply', 'v1-deadline-commit'].includes(scenario) ? [2] : [1];
    transactionCheck(JSON.stringify(result.persistedCounts) === JSON.stringify(expected), 'TX_PERSISTED_STATE');
    const before = JSON.stringify(result);
    await new Promise(resolve => setTimeout(resolve, 0));
    transactionCheck(JSON.stringify(result) === before, 'TX_NO_LATE_EVENTS'); result.noLateEvents = true;
    return result;
  } finally {
    try { await beforeClose?.(); }
    finally {
      await generated?.close();
      // Datastore exposes no public close; only close already-created generated
      // clients after resource accounting, never mutate their request behavior.
      await Promise.all([...datastore.clients_.values()].map(client => client.close()));
    }
  }
}
