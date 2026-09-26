import { Datastore } from '@google-cloud/datastore';
import { check, withCleanup } from './assert.mjs';

export const paginationScenarios = ['complete', 'destroy-first', 'destroy-inflight', 'end-first', 'end-inflight'];

function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('pagination-scenario-timeout')), 10000);
  })]).finally(() => clearTimeout(timer));
}

function observe(stream, stopFirst) {
  const result = { ranks: [], names: [], infos: [], end: 0, close: 0, errors: [] };
  let gotInfo;
  const terminalInfo = new Promise(resolve => { gotInfo = resolve; });
  const finished = new Promise((resolve, reject) => {
    stream.on('info', info => {
      result.infos.push({ moreResults: info.moreResults, endCursor: info.endCursor });
      gotInfo();
    });
    stream.on('end', () => { result.end++; resolve(); });
    stream.on('close', () => { result.close++; resolve(); });
    stream.on('error', error => { result.errors.push(error.code ?? error.message); reject(error); });
    stream.on('data', entity => {
      result.ranks.push(entity.rank);
      result.names.push(entity[Datastore.KEY].name);
      if (stopFirst && result.ranks.length === 1) stream[stopFirst]();
    });
  });
  // An in-flight case waits for a server observation before awaiting this promise.
  // Keep a rejection handler installed during that interval.
  finished.catch(() => {});
  return { result, finished, terminalInfo };
}

function assertComplete(result) {
  check(result.ranks.join(',') === '0,1,2,3,4,5', 'pagination-six-ordered-rows');
  check(result.names.join(',') === 'row-0,row-1,row-2,row-3,row-4,row-5', 'pagination-entity-keys');
  check(result.end === 1 && result.errors.length === 0, 'pagination-single-end-without-error');
  check(result.infos.length === 1 && result.infos[0].moreResults === 'NO_MORE_RESULTS'
    && result.infos[0].endCursor === 'Y3Vyc29yLTY=', 'pagination-terminal-info-cursor');
}

// Identical business code executes with upstream grpc-js and the installed
// adapter, including the bundled Worker. The control channel observes the
// server's pending page; it never replaces or calls a Datastore SDK method.
export async function runDatastorePagination({ options, scenario, namespace, control }) {
  check(paginationScenarios.includes(scenario), 'pagination-known-scenario');
  const datastore = new Datastore({ ...options, namespace });
  const streams = [];
  const queryOptions = { gaxOptions: { timeout: 5000, retry: null } };
  const query = kind => datastore.createQuery(kind).order('rank').offset(3).limit(6);
  return withCleanup(async () => {
    const stream = datastore.runQueryStream(query('Pagination'), queryOptions);
    streams.push(stream);
    const observed = observe(stream, scenario.endsWith('-first') ? scenario.split('-')[0] : undefined);
    if (scenario.endsWith('-inflight')) {
      // The server acknowledges receipt of page two before destruction. No
      // timer or number of delivered rows is used to infer a pending RPC.
      await bounded(control('await-held'));
      check(observed.result.ranks.join(',') === '0,1', 'pagination-first-page-delivered');
      stream[scenario.split('-')[0]]();
    }
    await bounded(observed.finished);
    if (scenario === 'complete') assertComplete(observed.result);
    else if (scenario.startsWith('destroy')) check(stream.destroyed, 'pagination-stream-destroyed');

    // A separate RPC proves the same generated client remains usable, even
    // while the destroyed stream's second RunQuery response is withheld.
    const [marker] = await datastore.get(datastore.key(['PaginationMarker', 'alive']), queryOptions);
    check(marker?.rank === 99, 'pagination-lookup-after-destroy');
    let pending;
    if (scenario.endsWith('-inflight')) {
      pending = await control('held-state');
      check(pending.pending && !pending.cancelledBeforeReply, 'pagination-sdk-does-not-cancel-pending-unary');
      await control('release');
    }
    // Pinned is-stream-ended checks ended, not destroyed. Bare destroy stops
    // consumer delivery but still walks subsequent pages. Wait for the public
    // terminal info event so those RPCs are observed deterministically.
    if (scenario.startsWith('destroy')) await bounded(observed.terminalInfo);

    const reused = datastore.runQueryStream(query('ReusePagination'), queryOptions);
    streams.push(reused);
    const after = observe(reused);
    await bounded(after.finished);
    assertComplete(after.result);

    // Retain listeners through response release and an entire new three-page
    // query. The runner separately asserts exact server-side cursor traces.
    if (scenario !== 'complete') {
      const expected = scenario.endsWith('-first') ? '0' : '0,1';
      check(observed.result.ranks.join(',') === expected && observed.result.end === (scenario.startsWith('end') ? 1 : 0)
        && observed.result.close === 1 && observed.result.errors.length === 0,
      'pagination-destroy-no-late-delivery');
    }
    return { scenario, original: observed.result, reused: after.result,
      ...(pending ? { outstandingUnaryAfterDestroy: pending.pending } : {}) };
  }, async () => {
    for (const stream of streams) if (!stream.destroyed) stream.destroy();
    // The pinned high-level Datastore has no close(); close its GAPIC clients.
    const outcomes = await Promise.allSettled([...datastore.clients_.values()].map(client => client.close()));
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (failures.length) throw new AggregateError(failures, 'pagination-client-cleanup-failed');
  });
}
