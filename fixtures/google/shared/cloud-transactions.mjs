import { Buffer } from 'node:buffer';
import { v1 as datastoreV1 } from '@google-cloud/datastore';
import Firestore from '@google-cloud/firestore';
import { check, requireWrites, withCleanup } from './assert.mjs';

const callOptions = { timeout: 10000, retry: null };
const firestoreV1 = Firestore.v1;
const services = { datastore: 'google.datastore.v1.Datastore', firestore: 'google.firestore.v1.Firestore' };

function transactionTarget(context) {
  requireWrites(context);
  check(typeof context.options.databaseId === 'string' && /^wga-probe-[a-z0-9-]{4,52}$/.test(context.options.databaseId), 'cloud-transaction-named-database-required');
  return { projectId: context.allowedProjectId, databaseId: context.options.databaseId };
}

// Consume a small successful unary gRPC-Web response before deliberately hiding
// it from the adapter. This is an injected client-boundary failure, not a claim
// that Google lost the response or that a real network failure was reproduced.
async function successfulCommitResponse(response) {
  check(response.status === 200 && !!response.body, 'cloud-lost-response-http-success');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      check(length <= 65536, 'cloud-lost-response-bounded');
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the primary error. */ }
    throw error;
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks, length);
  let offset = 0, trailers = 0, messages = 0, status;
  while (offset < body.length) {
    check(offset + 5 <= body.length, 'cloud-lost-response-frame-header');
    const flag = body[offset], size = body.readUInt32BE(offset + 1); offset += 5;
    check(offset + size <= body.length && (flag === 0 || flag === 1 || flag === 128), 'cloud-lost-response-frame-payload');
    check(trailers === 0, 'cloud-lost-response-trailer-final');
    if (flag === 128) {
      trailers++;
      const lines = body.subarray(offset, offset + size).toString('utf8').split('\r\n');
      const statuses = lines.filter(line => /^grpc-status:/i.test(line));
      check(statuses.length === 1, 'cloud-lost-response-single-status');
      status = statuses[0].slice(statuses[0].indexOf(':') + 1).trim();
    } else messages++;
    offset += size;
  }
  check(trailers === 1 && messages === 1 && status === '0', 'cloud-lost-response-grpc-success');
}

export function createCommitResponseLoss({ service, fetchImpl = globalThis.fetch }) {
  check(Object.hasOwn(services, service) && typeof fetchImpl === 'function', 'cloud-lost-response-controller-config');
  const expectedPath = `/${services[service]}/Commit`;
  let armed = false, everArmed = false;
  const counters = { layer: 'adapter-fetch', commitAttempts: 0, completedResponses: 0, successfulResponses: 0, discardedResponses: 0 };
  return {
    arm() {
      check(!everArmed, 'cloud-lost-response-arm-once');
      armed = true; everArmed = true;
    },
    snapshot() { return { ...counters, armed }; },
    fetcher: {
      async fetch(input, init) {
        const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
        if (!everArmed || path !== expectedPath) return fetchImpl(input, init);
        counters.commitAttempts++;
        if (!armed) return fetchImpl(input, init);
        armed = false;
        const response = await fetchImpl(input, init);
        await successfulCommitResponse(response);
        counters.completedResponses++; counters.successfulResponses++; counters.discardedResponses++;
        throw new TypeError('WGA_INJECTED_COMMIT_RESPONSE_DISCARD');
      },
    },
  };
}

function nativeCommitResponseLoss(client) {
  const original = client.commit.bind(client);
  let armed = false;
  const counters = { layer: 'native-sdk-result', commitAttempts: 0, completedResponses: 0, successfulResponses: 0, discardedResponses: 0 };
  client.commit = async (...args) => {
    counters.commitAttempts++;
    const result = await original(...args);
    if (!armed) return result;
    armed = false;
    check(Array.isArray(result) && result[0] && typeof result[0] === 'object', 'cloud-lost-response-native-success');
    counters.completedResponses++; counters.successfulResponses++; counters.discardedResponses++;
    throw Object.assign(new Error('WGA_INJECTED_COMMIT_RESPONSE_DISCARD'), { code: 14 });
  };
  return {
    arm() { check(!armed && counters.commitAttempts === 0, 'cloud-lost-response-arm-once'); armed = true; },
    snapshot() { return { ...counters, armed }; },
  };
}

function lossFor(context, client) {
  if (context.commitResponseLoss) {
    check(typeof context.commitResponseLoss.arm === 'function' && typeof context.commitResponseLoss.snapshot === 'function'
      && context.commitResponseLoss.snapshot().layer === 'adapter-fetch', 'cloud-lost-response-controller-required');
    return context.commitResponseLoss;
  }
  check(context.nativeCommitResponseLoss === true, 'cloud-lost-response-native-opt-in-required');
  return nativeCommitResponseLoss(client);
}

function datastoreClient(context, suffix) {
  const target = transactionTarget(context);
  const client = new datastoreV1.DatastoreClient({ ...context.options, fallback: false });
  const key = { partitionId: { ...target, namespaceId: `wga-${context.runId}-${suffix}` }, path: [{ kind: 'WgaCloudTransaction', name: 'value' }] };
  const entity = count => ({ key, properties: { count: { integerValue: String(count) }, marker: { stringValue: context.runId } } });
  return {
    client,
    async write(count, transaction) {
      return client.commit({ ...target, mode: transaction ? 'TRANSACTIONAL' : 'NON_TRANSACTIONAL',
        ...(transaction ? { transaction } : {}), mutations: [{ upsert: entity(count) }] }, callOptions);
    },
    async begin() { const [result] = await client.beginTransaction({ ...target, transactionOptions: { readWrite: {} } }, callOptions); return result.transaction; },
    async read(transaction) {
      const [result] = await client.lookup({ ...target, keys: [key], ...(transaction ? { readOptions: { transaction } } : {}) }, callOptions);
      check(result.deferred?.length === 0 && result.found?.length === 1 && result.missing?.length === 0, 'cloud-transaction-datastore-found');
      const stored = result.found[0].entity;
      check(stored.properties?.marker?.stringValue === context.runId, 'cloud-transaction-datastore-marker');
      return Number(stored.properties.count.integerValue);
    },
    async rollback(transaction) { await client.rollback({ ...target, transaction }, callOptions); },
    async cleanup() {
      await client.commit({ ...target, mode: 'NON_TRANSACTIONAL', mutations: [{ delete: key }] }, callOptions);
      const [result] = await client.lookup({ ...target, keys: [key] }, callOptions);
      check(result.found?.length === 0 && result.missing?.length === 1 && result.deferred?.length === 0, 'cloud-transaction-datastore-cleanup');
    },
  };
}

function firestoreClient(context, suffix) {
  const target = transactionTarget(context);
  const client = new firestoreV1.FirestoreClient({ ...context.options, fallback: false });
  const database = `projects/${target.projectId}/databases/${target.databaseId}`;
  const name = `${database}/documents/wga_${context.runId}_${suffix}/value`;
  return {
    client,
    async write(count, transaction) {
      return client.commit({ database, ...(transaction ? { transaction } : {}),
        writes: [{ update: { name, fields: { count: { integerValue: String(count) }, marker: { stringValue: context.runId } } } }] }, callOptions);
    },
    async begin() { const [result] = await client.beginTransaction({ database, options: { readWrite: {} } }, callOptions); return result.transaction; },
    async read(transaction) {
      const [stored] = await client.getDocument({ name, ...(transaction ? { transaction } : {}) }, callOptions);
      check(stored.name === name && stored.fields?.marker?.stringValue === context.runId, 'cloud-transaction-firestore-marker');
      return Number(stored.fields.count.integerValue);
    },
    async rollback(transaction) { await client.rollback({ database, transaction }, callOptions); },
    async cleanup() {
      await client.commit({ database, writes: [{ delete: name }] }, callOptions);
      let missing;
      try { await client.getDocument({ name }, callOptions); } catch (error) { missing = error; }
      check(missing?.code === 5, 'cloud-transaction-firestore-cleanup');
    },
  };
}

async function cleanupTransactions(target, active) {
  // A failed Rollback must not skip deletion of the scenario's own record or
  // closing the SDK client. Keep every cleanup failure visible to the caller.
  return withCleanup(() => Promise.all([...active].map(transaction => target.rollback(transaction))),
    () => withCleanup(() => target.cleanup(), () => target.client.close()));
}

async function conflictingTransactions(context, makeClient) {
  const target = makeClient(context, 'conflict');
  const active = new Set();
  return withCleanup(async () => {
    await target.write(1);
    const first = await target.begin(); active.add(first);
    const second = await target.begin(); active.add(second);
    check(first instanceof Uint8Array && first.length > 0 && second instanceof Uint8Array && second.length > 0
      && !Buffer.from(first).equals(Buffer.from(second)), 'cloud-transaction-distinct-ids');
    check(await target.read(first) === 1 && await target.read(second) === 1, 'cloud-transaction-conflict-shared-snapshot');
    await target.write(2, first); active.delete(first);
    let failure;
    try { await target.write(3, second); } catch (error) { failure = error; }
    check(failure?.code === 10 && typeof failure.details === 'string' && failure.details.trim().length > 0,
      'cloud-transaction-real-aborted');
    // Explicitly release the failed transaction; Commit error is not success.
    await target.rollback(second); active.delete(second);
    check(await target.read() === 2, 'cloud-transaction-winner-persists');
    // The same client still performs a fresh transaction after the conflict.
    const recovery = await target.begin(); active.add(recovery);
    check(await target.read(recovery) === 2, 'cloud-transaction-recovery-read');
    await target.write(4, recovery); active.delete(recovery);
    check(await target.read() === 4, 'cloud-transaction-recovery-commit');
    return ['two-explicit-read-write-transactions', 'same-record-shared-snapshot', 'first-commit-accepted',
      'second-commit-real-aborted-10', 'no-sdk-or-application-retry', 'winner-value-preserved',
      'same-client-fresh-transaction-recovery', 'verified-delete-cleanup'];
  }, () => cleanupTransactions(target, active));
}

async function commitResponseLost(context, makeClient) {
  const target = makeClient(context, 'lost');
  const active = new Set();
  return withCleanup(async () => {
    await target.write(1);
    const transaction = await target.begin(); active.add(transaction);
    check(transaction instanceof Uint8Array && transaction.length > 0, 'cloud-transaction-id-required');
    check(await target.read(transaction) === 1, 'cloud-transaction-lost-initial-read');
    const loss = lossFor(context, target.client); loss.arm();
    let failure;
    try { await target.write(2, transaction); } catch (error) { failure = error; }
    const receipt = loss.snapshot();
    check(failure?.code === 14, 'cloud-transaction-lost-unavailable');
    check(receipt.armed === false && receipt.commitAttempts === 1 && receipt.completedResponses === 1
      && receipt.successfulResponses === 1 && receipt.discardedResponses === 1, 'cloud-transaction-lost-single-success-discard');
    active.delete(transaction);
    // Do not retry Commit or infer its outcome from UNAVAILABLE. Independently
    // read a stable record identity and its marker to reconcile the result.
    check(await target.read() === 2, 'cloud-transaction-lost-applied-state');
    return ['explicit-transaction-commit', 'commit-success-observed-before-discard', `response-discard-at-${receipt.layer}`,
      'caller-unavailable-14', 'one-commit-attempt-no-retry', 'independent-read-reconciles-applied-value',
      'same-client-recovery', 'verified-delete-cleanup'];
  }, () => cleanupTransactions(target, active));
}

export const cloudDatastoreConflict = context => conflictingTransactions(context, datastoreClient);
export const cloudFirestoreConflict = context => conflictingTransactions(context, firestoreClient);
export const cloudDatastoreCommitResponseLost = context => commitResponseLost(context, datastoreClient);
export const cloudFirestoreCommitResponseLost = context => commitResponseLost(context, firestoreClient);
