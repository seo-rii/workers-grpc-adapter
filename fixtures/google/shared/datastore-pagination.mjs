import { Datastore } from '@google-cloud/datastore';
import { check, withCleanup } from './assert.mjs';

export const paginationScenarios = ['complete', 'destroy-first', 'destroy-inflight', 'end-first', 'end-inflight',
  'promise-complete', 'callback-complete', 'promise-error', 'callback-error', 'stream-error'];

function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('pagination-scenario-timeout')), 10000);
  })]).finally(() => clearTimeout(timer));
}

function infoSummary(info) {
  return { moreResults: info.moreResults, endCursor: info.endCursor };
}

function errorSummary(error) {
  return { code: error.code, details: error.details,
    metadata: { index: error.metadata?.get('x-wga-index') ?? [],
      binary: (error.metadata?.get('x-wga-detail-bin') ?? []).map(value => value.toString('hex')) } };
}

function observe(stream, stopFirst) {
  const result = { ranks: [], names: [], infos: [], end: 0, close: 0, errors: [], events: [] };
  let gotInfo;
  const terminalInfo = new Promise(resolve => { gotInfo = resolve; });
  const finished = new Promise((resolve, reject) => {
    stream.on('info', info => {
      result.events.push('info');
      result.infos.push({ moreResults: info.moreResults, endCursor: info.endCursor });
      gotInfo();
    });
    stream.on('end', () => { result.events.push('end'); result.end++; resolve(); });
    stream.on('close', () => { result.close++; resolve(); });
    stream.on('error', error => { result.events.push('error'); result.errors.push(errorSummary(error)); resolve(); });
    stream.on('data', entity => {
      result.events.push('data');
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
export async function runDatastorePagination({ options, scenario, namespace, control, beforeClose }) {
  check(paginationScenarios.includes(scenario), 'pagination-known-scenario');
  const datastore = new Datastore({ ...options, namespace });
  const streams = [];
  const queryOptions = { gaxOptions: { timeout: 5000, retry: null } };
  const query = kind => datastore.createQuery(kind).order('rank').offset(3).limit(6);
  return withCleanup(async () => {
    let overload;
    if (scenario.startsWith('promise-') || scenario.startsWith('callback-')) {
      const isError = scenario.endsWith('-error');
      if (scenario.startsWith('promise-')) {
        try {
          const tuple = await datastore.runQuery(query('Pagination'), queryOptions);
          check(!isError, 'pagination-promise-must-reject');
          overload = { kind: 'promise', tupleLength: tuple.length, errorPosition: null,
            entities: tuple[0].map(entity => ({ rank: entity.rank, name: entity[Datastore.KEY].name })),
            info: infoSummary(tuple[1]) };
        } catch (error) {
          if (!isError) throw error;
          overload = { kind: 'promise', rejected: true, error: errorSummary(error) };
        }
      } else {
        overload = await new Promise(resolve => {
          datastore.runQuery(query('Pagination'), queryOptions, (...args) => {
            const [error, entities, info] = args;
            resolve({ kind: 'callback', tupleLength: args.length, errorPosition: error ? 0 : null,
              error: error ? errorSummary(error) : null,
              entities: entities?.map(entity => ({ rank: entity.rank, name: entity[Datastore.KEY].name })) ?? null,
              info: info ? infoSummary(info) : null });
          });
        });
        check(!!overload.error === isError, 'pagination-callback-error-position');
      }
      if (isError) check(overload.error.code === 3 && overload.error.details === 'controlled-invalid-query',
        'pagination-overload-original-error');
      else check(overload.entities.map(entity => entity.rank).join(',') === '0,1,2,3,4,5'
        && overload.info.moreResults === 'NO_MORE_RESULTS' && overload.info.endCursor === 'Y3Vyc29yLTY=',
      'pagination-overload-entities-and-info');
    }
    const stream = overload ? null : datastore.runQueryStream(query('Pagination'), queryOptions);
    if (stream) streams.push(stream);
    const observed = stream ? observe(stream, scenario.endsWith('-first') ? scenario.split('-')[0] : undefined) : null;
    if (scenario.endsWith('-inflight')) {
      // The server acknowledges receipt of page two before destruction. No
      // timer or number of delivered rows is used to infer a pending RPC.
      await bounded(control('await-held'));
      check(observed.result.ranks.join(',') === '0,1', 'pagination-first-page-delivered');
      stream[scenario.split('-')[0]]();
    }
    if (observed) await bounded(observed.finished);
    if (scenario === 'complete') assertComplete(observed.result);
    else if (scenario === 'stream-error') {
      check(observed.result.ranks.join(',') === '0,1' && observed.result.end === 0
        && observed.result.infos.length === 0 && observed.result.errors.length === 1
        && observed.result.errors[0].code === 9
        && observed.result.errors[0].details === 'controlled-index-required', 'pagination-partial-page-error');
    }
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
    if (scenario.includes('-first') || scenario.includes('-inflight')) {
      const expected = scenario.endsWith('-first') ? '0' : '0,1';
      check(observed.result.ranks.join(',') === expected && observed.result.end === (scenario.startsWith('end') ? 1 : 0)
        && observed.result.close === 1 && observed.result.errors.length === 0,
      'pagination-destroy-no-late-delivery');
    }
    const result = { scenario, original: observed?.result ?? null, reused: after.result,
      ...(overload ? { overload } : {}), ...(pending ? { outstandingUnaryAfterDestroy: pending.pending } : {}) };
    if (beforeClose) result.accounting = await beforeClose();
    return result;
  }, async () => {
    for (const stream of streams) if (!stream.destroyed) stream.destroy();
    // The pinned high-level Datastore has no close(); close its GAPIC clients.
    const outcomes = await Promise.allSettled([...datastore.clients_.values()].map(client => client.close()));
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (failures.length) throw new AggregateError(failures, 'pagination-client-cleanup-failed');
  });
}
