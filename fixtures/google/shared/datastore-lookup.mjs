import { Datastore } from '@google-cloud/datastore';
import { OAuth2Client } from 'google-auth-library';
import { check, withCleanup } from './assert.mjs';

export const lookupScenarios = [
  'mixed-promise', 'mixed-callback', 'mixed-stream', 'single-deferred',
  'single-missing', 'all-missing', 'denied-promise', 'denied-callback',
  'unavailable-no-retry', 'unavailable-retry', 'partial-stream-error',
  'partial-get-error', 'deferred-deadline', 'end-first', 'end-held', 'invalid-options', 'partition-variants',
];

export function createLookupAuth(onAuthRequest = () => {}) {
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'lookup-local-fixture' });
  // This fixture deliberately uses a cached token. Observe the auth library's
  // network boundary separately from adapter credential-plugin invocations.
  authClient.transporter.request = async () => {
    onAuthRequest();
    throw new Error('lookup-unexpected-auth-network');
  };
  return authClient;
}

// Positive control for the guarded authentication-network counter. Expiry is
// forced on a separate client and the request is stopped before any I/O.
export async function calibrateLookupAuth() {
  let requests = 0;
  const auth = createLookupAuth(() => { requests++; });
  const headers = await auth.getRequestHeaders('https://datastore.googleapis.com');
  check(headers.get('authorization') === 'Bearer lookup-local-fixture' && requests === 0, 'lookup-cached-auth-no-network');
  auth.setCredentials({ access_token: 'expired-fixture', refresh_token: 'fixture-not-a-secret', expiry_date: Date.now() - 1 });
  let caught;
  try { await auth.getRequestHeaders('https://datastore.googleapis.com'); } catch (error) { caught = error; }
  check(caught?.message === 'lookup-unexpected-auth-network' && requests === 1, 'lookup-auth-network-positive-control');
  return { cachedNetworkRequests: 0, expiredNetworkRequests: requests, blockedBeforeNetwork: true };
}

function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('lookup-scenario-timeout')), 10000);
  })]).finally(() => clearTimeout(timer));
}

function normalized(entity, namespace, ancestor = 'ancestor') {
  const key = entity[Datastore.KEY];
  check(key.namespace === namespace, 'lookup-key-namespace');
  check(key.parent?.kind === 'LookupRoot' && key.parent.name === ancestor, 'lookup-key-ancestor');
  check(key.kind === 'LookupValue', 'lookup-key-kind');
  const rank = entity.rank;
  const numeric = rank === 0;
  check(numeric ? key.id === '9007199254740993' && key.name === undefined
    : key.name === `name-${rank}` && key.id === undefined, 'lookup-key-id-or-name-fidelity');
  check(entity.large.value === '9223372036854775806', 'lookup-wrapped-int64');
  check(entity.when instanceof Date && entity.when.toISOString() === '2026-01-02T03:04:05.000Z', 'lookup-date');
  check(Buffer.isBuffer(entity.blob) && entity.blob.toString('hex') === '00017fff', 'lookup-binary');
  check(entity.enabled === true && entity.nothing === null && entity.label === `value-${rank}`, 'lookup-scalar-values');
  return { rank, key: { kind: key.kind, ...(numeric ? { id: key.id } : { name: key.name }),
    parent: { kind: key.parent.kind, name: key.parent.name } }, large: entity.large.value,
  when: entity.when.toISOString(), blob: entity.blob.toString('hex'), enabled: entity.enabled,
  nothing: entity.nothing, label: entity.label };
}

function observe(stream, namespace, endFirst = false, finishAtEnd = false) {
  const result = { rows: [], events: [], errors: [], end: 0, close: 0 };
  const finished = new Promise(resolve => {
    stream.on('data', entity => {
      const row = normalized(entity, namespace);
      result.rows.push(row);
      result.events.push(`data:${row.rank}`);
      if (endFirst) stream.end();
    });
    stream.on('error', error => { result.errors.push(error.code); result.events.push(`error:${error.code}`); });
    stream.on('end', () => { result.end++; result.events.push('end'); if (finishAtEnd) resolve(); });
    stream.on('close', () => { result.close++; result.events.push('close'); resolve(); });
  });
  return { result, finished };
}

// This exact business module runs with native grpc-js, the packed replacement,
// and both local workerd routing modes. The control channel only observes or
// releases a real pending server RPC; it never implements an SDK operation.
export async function runDatastoreLookup({ options, scenario, namespace, control, beforeClose }) {
  check(lookupScenarios.includes(scenario), 'lookup-known-scenario');
  const datastore = new Datastore({ ...options, namespace, databaseId: 'lookup-db' });
  const streams = [];
  const clients = [datastore];
  const key = value => datastore.key(['LookupRoot', 'ancestor', 'LookupValue', value]);
  const keys = [key(datastore.int('9007199254740993')), key('missing'), key('name-1'), key('name-2')];
  const readOptions = { consistency: 'strong', wrapNumbers: true,
    gaxOptions: { timeout: 2000, retry: null, otherArgs: { headers: { 'x-wga-lookup': scenario } } } };
  let callbacks = 0;
  const getCallback = (input, extra = readOptions) => new Promise((resolve, reject) => {
    datastore.get(input, extra, (error, rows) => { callbacks++; if (error) reject(error); else resolve(rows); });
  });
  const expectedError = async (promise, code) => {
    let error;
    try { await bounded(promise); } catch (value) { error = value; }
    check(error?.code === code, `lookup-expected-error-${code}`);
    return code;
  };
  return withCleanup(async () => {
    const result = { scenario, rows: [], callbacks: 0 };
    if (scenario === 'partition-variants') {
      const alternate = new Datastore({ ...options, projectId: 'wga-lookup-alt', namespace: `${namespace}-alt`, databaseId: 'lookup-alt-db' });
      clients.push(alternate);
      result.variants = [];
      for (const [client, projectId, keyNamespace, ancestor, databaseId] of [
        [datastore, 'wga-lookup', namespace, 'ancestor', 'lookup-db'],
        [alternate, 'wga-lookup-alt', `${namespace}-alt`, 'other-ancestor', 'lookup-alt-db'],
      ]) {
        const [value] = await bounded(client.get(client.key(['LookupRoot', ancestor, 'LookupValue', 'name-2']), readOptions));
        result.variants.push({ projectId, databaseId, namespaceSuffix: keyNamespace === namespace ? '' : '-alt',
          row: normalized(value, keyNamespace, ancestor) });
      }
    } else if (scenario === 'invalid-options') {
      let emptyError, optionsError;
      try { await datastore.get([]); } catch (error) { emptyError = error; }
      try { await datastore.get(keys, { ...readOptions, readTime: new Date() }); } catch (error) { optionsError = error; }
      check(emptyError?.message.includes('At least one Key') && optionsError?.message.includes('Read time'), 'lookup-local-input-errors');
      result.localInputErrors = 2;
    } else if (['mixed-stream', 'partial-stream-error', 'deferred-deadline', 'end-first', 'end-held'].includes(scenario)) {
      const timeout = scenario === 'deferred-deadline' ? 250 : 2000;
      const stream = datastore.createReadStream(keys, { ...readOptions,
        gaxOptions: { ...readOptions.gaxOptions, timeout } });
      streams.push(stream);
      const observed = observe(stream, namespace, scenario === 'end-first', scenario === 'mixed-stream');
      if (scenario === 'end-held') {
        await bounded(control('await-held'));
        check(observed.result.rows.length === 1, 'lookup-first-round-consumed');
        stream.end();
      }
      await bounded(observed.finished);
      const expectedCode = scenario === 'partial-stream-error' ? 7 : scenario === 'deferred-deadline' ? 4 : undefined;
      const expectedRanks = scenario === 'mixed-stream' ? '1,0,2' : '1';
      check(observed.result.rows.map(row => row.rank).join(',') === expectedRanks, 'lookup-stream-delivery-order');
      check(observed.result.end === (expectedCode ? 0 : 1)
        && observed.result.close === (scenario === 'mixed-stream' ? 0 : 1), 'lookup-stream-terminal-count');
      check(observed.result.errors.join(',') === (expectedCode ? String(expectedCode) : ''), 'lookup-stream-error-code');
      check(observed.result.events.join(',') === (expectedCode ? `data:1,error:${expectedCode},close`
        : scenario === 'mixed-stream' ? 'data:1,data:0,data:2,end' : 'data:1,end,close'), 'lookup-stream-event-order');
      if (scenario === 'end-held') {
        const held = await control('held-state');
        check(held.pending && !held.cancelledBeforeReply, 'lookup-end-does-not-cancel-current-unary');
        result.currentUnaryCancelledByEnd = held.cancelledBeforeReply;
        await control('release');
      }
      if (scenario === 'deferred-deadline') await bounded(control('await-cancelled'));
      result.stream = observed.result;
    } else if (scenario.startsWith('denied-') || scenario === 'unavailable-no-retry' || scenario === 'partial-get-error') {
      const code = scenario === 'unavailable-no-retry' ? 14 : 7;
      result.errorCode = await expectedError(scenario === 'denied-callback' ? getCallback(keys) : datastore.get(keys, readOptions), code);
      // A failed get does not return a partial array; createReadStream is the
      // separate API that can deliver rows before its terminal error.
      result.partialArrayReturned = false;
    } else {
      let values;
      if (scenario === 'mixed-callback') values = await bounded(getCallback(keys));
      else {
        const input = scenario.startsWith('single-') ? keys[scenario === 'single-missing' ? 1 : 0]
          : scenario === 'all-missing' ? [keys[1], key('also-missing')] : keys;
        const settings = scenario === 'unavailable-retry' ? { ...readOptions,
          gaxOptions: { ...readOptions.gaxOptions, retry: { retryCodes: [14], backoffSettings: {
            initialRetryDelayMillis: 1, retryDelayMultiplier: 1, maxRetryDelayMillis: 1,
            initialRpcTimeoutMillis: 2000, rpcTimeoutMultiplier: 1, maxRpcTimeoutMillis: 2000,
            totalTimeoutMillis: 3000,
          } } } } : readOptions;
        [values] = await bounded(datastore.get(input, settings));
        if (scenario === 'single-missing') {
          check(values === undefined, 'lookup-single-missing-is-undefined');
          result.singleMissing = true;
          values = [];
        } else if (scenario === 'single-deferred') values = [values];
      }
      result.rows = values.map(entity => normalized(entity, namespace));
      const expected = scenario === 'single-deferred' ? '0' : scenario.includes('missing') ? ''
        : scenario === 'unavailable-retry' ? '0,1,2' : '1,0,2';
      check(result.rows.map(row => row.rank).join(',') === expected, 'lookup-found-order-and-missing-omission');
    }

    const [marker] = await bounded(datastore.get(datastore.key(['LookupMarker', 'alive']), {
      ...readOptions, wrapNumbers: false,
    }));
    check(marker?.rank === 99, 'lookup-same-client-reuse');
    result.reused = true;
    check(callbacks === (scenario.endsWith('-callback') ? 1 : 0), 'lookup-callback-exactly-once');
    result.callbacks = callbacks;
    if (result.stream && scenario === 'end-held') check(result.stream.rows.length === 1, 'lookup-no-late-rows-after-end');
    // Cleanup below may emit close on a successfully ended SDK Transform.
    // Snapshot public operation events before intentional fixture destruction.
    const output = structuredClone(result);
    if (beforeClose) await beforeClose();
    return output;
  }, async () => {
    for (const stream of streams) if (!stream.destroyed) stream.destroy();
    const outcomes = await Promise.allSettled(clients.flatMap(owner => [...owner.clients_.values()]).map(client => client.close()));
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (failures.length) throw new AggregateError(failures, 'lookup-client-cleanup-failed');
  });
}
