import { Buffer } from 'node:buffer';
import { Datastore, v1 } from '@google-cloud/datastore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { check, requireWrites, withCleanup } from './assert.mjs';

const callOptions = { timeout: 10000, retry: null };
const readOptions = { gaxOptions: callOptions };

function datastoreFor(context, suffix) {
  requireWrites(context);
  check(typeof context.options.databaseId === 'string' && /^wga-probe-[a-z0-9-]{4,52}$/.test(context.options.databaseId), 'cloud-named-datastore-required');
  const namespace = `wga-${context.runId}-${suffix}`;
  const datastore = new Datastore({ ...context.options, namespace, fallback: false });
  context.registerDatastoreClient?.(datastore);
  return { datastore, namespace };
}
async function cleanDatastore(datastore, keys) {
  return withCleanup(async () => {
    if (keys.length) {
      await datastore.delete(keys, callOptions);
      const [remaining] = await datastore.get(keys, readOptions);
      check(remaining.length === 0, 'cloud-datastore-cleanup-verified');
    }
  }, async () => {
    // The pinned high-level Datastore has no close(); its generated clients do.
    await Promise.all([...datastore.clients_.values()].map(client => client.close()));
  });
}
function remoteError(error, code, prefix) {
  check(error?.code === code, `${prefix}-code`);
  check(typeof error.details === 'string' && error.details.trim().length > 0, `${prefix}-details`);
  check(typeof error.metadata?.get === 'function' && typeof error.metadata?.getMap === 'function', `${prefix}-metadata`);
  const entries = error.metadata.getMap();
  check(entries !== null && typeof entries === 'object' && !Array.isArray(entries), `${prefix}-metadata-map`);
  for (const key of Object.keys(entries)) {
    const values = error.metadata.get(key);
    check(Array.isArray(values) && values.every(value => key.endsWith('-bin') ? value instanceof Uint8Array : typeof value === 'string'), `${prefix}-metadata-values`);
  }
}

export async function cloudDatastoreTyped(context) {
  const { datastore, namespace } = datastoreFor(context, 'typed');
  const kind = 'WgaCloudTyped';
  const parent = datastore.key(['WgaCloudTypedParent', context.runId]);
  const largeId = '9007199254741009';
  const keys = [datastore.key(['WgaCloudTypedParent', context.runId, kind, datastore.int(largeId)]),
    ...[1, 2].map(rank => datastore.key(['WgaCloudTypedParent', context.runId, kind, `row-${rank}`]))];
  const bytes = Buffer.from([0, 1, 127, 128, 255]), date = new Date('2024-02-29T12:34:56.789Z');
  return withCleanup(async () => {
    await datastore.save(keys.map((key, rank) => ({ key, data: { rank, bytes, date, reference: parent,
      positive: datastore.int('9007199254740993'), negative: datastore.int('-9007199254740995') } })), callOptions);
    const [typed] = await datastore.get(keys[0], { ...readOptions, wrapNumbers: true });
    check(datastore.isInt(typed?.positive) && typed.positive.value === '9007199254740993'
      && datastore.isInt(typed.negative) && typed.negative.value === '-9007199254740995', 'cloud-datastore-wrapped-int64');
    check(Buffer.isBuffer(typed.bytes) && typed.bytes.equals(bytes), 'cloud-datastore-bytes');
    check(typed.date instanceof Date && typed.date.getTime() === date.getTime(), 'cloud-datastore-date');
    const actualKey = typed[datastore.KEY];
    check(datastore.isKey(actualKey) && actualKey.id === largeId && actualKey.kind === kind && actualKey.namespace === namespace
      && actualKey.parent?.name === context.runId, 'cloud-datastore-int64-key');
    check(datastore.isKey(typed.reference) && typed.reference.kind === parent.kind && typed.reference.name === context.runId
      && typed.reference.namespace === namespace, 'cloud-datastore-key-property');
    const ranks = [], names = new Set(), cursors = new Set(); let cursor, finished = false;
    for (let page = 0; page < 4; page++) {
      // One ordered property avoids requiring a composite index for this case.
      const query = datastore.createQuery(kind).order('rank').limit(1);
      if (cursor) query.start(cursor);
      const [entities, info] = await datastore.runQuery(query, { ...readOptions, wrapNumbers: true });
      check(entities.length <= 1, 'cloud-datastore-cursor-page-size');
      for (const entity of entities) {
        const key = entity[datastore.KEY], identity = key.id || key.name;
        check(!names.has(identity) && key.namespace === namespace && key.parent?.name === context.runId, 'cloud-datastore-cursor-isolation');
        check(datastore.isInt(entity.rank) && entity.rank.value === String(ranks.length), 'cloud-datastore-cursor-order');
        ranks.push(Number(entity.rank.value)); names.add(identity);
      }
      if (info.moreResults === datastore.NO_MORE_RESULTS) { finished = true; break; }
      check(typeof info.endCursor === 'string' && info.endCursor.length > 0 && !cursors.has(info.endCursor), 'cloud-datastore-cursor-progress');
      cursors.add(info.endCursor); cursor = info.endCursor;
    }
    check(finished && ranks.join(',') === '0,1,2' && names.size === 3 && cursors.size >= 2, 'cloud-datastore-cursor-complete');
    return ['typed-key-int64', 'key-property', 'bytes-roundtrip', 'date-roundtrip', 'wrapped-positive-negative-int64',
      'ordered-single-property-cursor-pages', 'cursor-no-duplicates-or-omissions', 'verified-delete-cleanup'];
  }, () => cleanDatastore(datastore, keys));
}

export async function cloudDatastoreAggregation(context) {
  const { datastore } = datastoreFor(context, 'aggregation');
  const keys = [2, 4, 6].map(amount => datastore.key(['WgaCloudAggregation', `row-${amount}`]));
  return withCleanup(async () => {
    await datastore.save(keys.map((key, index) => ({ key, data: { amount: (index + 1) * 2 } })), callOptions);
    const query = datastore.createAggregationQuery(datastore.createQuery('WgaCloudAggregation'))
      .count('total').sum('amount', 'sum').average('amount', 'average');
    const [rows] = await datastore.runAggregationQuery(query, readOptions);
    check(rows.length === 1 && rows[0].total === 3 && rows[0].sum === 12 && rows[0].average === 4
      && Object.keys(rows[0]).sort().join(',') === 'average,sum,total', 'cloud-datastore-aggregation-exact');
    return ['aggregation-count-3', 'aggregation-sum-12', 'aggregation-average-4', 'aggregation-explicit-aliases', 'verified-delete-cleanup'];
  }, () => cleanDatastore(datastore, keys));
}

export async function cloudDatastoreRollback(context) {
  const { datastore } = datastoreFor(context, 'rollback');
  const keys = ['existing', 'not-created'].map(name => datastore.key(['WgaCloudRollback', name]));
  let transaction, active = false;
  return withCleanup(async () => {
    await datastore.save({ key: keys[0], data: { count: 1 } }, callOptions);
    transaction = datastore.transaction(); await transaction.run({ gaxOptions: callOptions }); active = true;
    const [before] = await transaction.get(keys[0], readOptions);
    check(before?.count === 1, 'cloud-datastore-rollback-read');
    transaction.save([{ key: keys[0], data: { count: 99 } }, { key: keys[1], data: { count: 2 } }]);
    await transaction.rollback(callOptions); active = false;
    const [existing] = await datastore.get(keys[0], readOptions);
    const [absent] = await datastore.get(keys[1], readOptions);
    check(existing?.count === 1 && absent === undefined, 'cloud-datastore-rollback-state');
    return ['begin-transaction', 'transaction-read', 'queue-update-and-insert', 'explicit-rollback', 'original-entity-unchanged', 'new-entity-absent', 'verified-delete-cleanup'];
  }, () => withCleanup(async () => { if (active) await transaction.rollback(callOptions); }, () => cleanDatastore(datastore, keys)));
}

export async function cloudDatastoreErrors(context) {
  const { datastore, namespace } = datastoreFor(context, 'errors');
  const generated = new v1.DatastoreClient({ ...context.options, fallback: false });
  const kind = `WgaCloudMissingIndex_${context.runId.replace(/-/g, '_')}`;
  return withCleanup(async () => {
    let missingIndex, invalid;
    try { await datastore.runQuery(datastore.createQuery(kind).order('first').order('second').limit(1), readOptions); }
    catch (error) { missingIndex = error; }
    remoteError(missingIndex, 9, 'cloud-datastore-missing-index');
    // Generated request carries the invalid limit to Google. A high-level
    // validation exception would not prove transport status/metadata behavior.
    try {
      await generated.runQuery({ projectId: context.allowedProjectId, databaseId: context.options.databaseId,
        partitionId: { projectId: context.allowedProjectId, databaseId: context.options.databaseId, namespaceId: namespace },
        query: { kind: [{ name: kind }], limit: { value: -1 } } }, callOptions);
    } catch (error) { invalid = error; }
    remoteError(invalid, 3, 'cloud-datastore-invalid-query');
    return ['missing-composite-index-code-9', 'malformed-query-code-3', 'remote-details-nonempty', 'remote-metadata-shape', 'named-database-only'];
  }, () => withCleanup(() => generated.close(), () => cleanDatastore(datastore, [])));
}

function secretTarget(context) {
  check(context.options.projectId === context.allowedProjectId && !!context.allowedProjectId, 'cloud-secret-project-mismatch');
  check(typeof context.secretName === 'string' && /^projects\/[^/]+\/secrets\/wga-probe-[a-z0-9-]{4,52}$/.test(context.secretName)
    && context.secretName.split('/')[1] === context.allowedProjectId, 'cloud-secret-name-required');
  return `projects/${context.allowedProjectId}`;
}
export async function cloudSecretManager(context) {
  const parent = secretTarget(context);
  check(typeof context.secretVersion === 'string' && context.secretVersion.startsWith(`${context.secretName}/versions/`)
    && /^[1-9][0-9]*$/.test(context.secretVersion.split('/').at(-1)), 'cloud-secret-version-required');
  check(typeof context.secretPayload === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(context.secretPayload), 'cloud-secret-payload-base64-required');
  const expected = Buffer.from(context.secretPayload, 'base64');
  check(expected.toString('base64') === context.secretPayload, 'cloud-secret-payload-canonical-base64');
  check(Array.isArray(context.secretNames) && context.secretNames.length === 2 && new Set(context.secretNames).size === 2
    && context.secretNames.includes(context.secretName) && context.secretNames.every(name => typeof name === 'string'
      && /^projects\/[^/]+\/secrets\/wga-probe-[a-z0-9-]{4,52}$/.test(name) && name.startsWith(`${parent}/secrets/`)), 'cloud-secret-two-owned-resources');
  check(typeof context.resourceLabel === 'string' && /^[a-z0-9_-]{1,63}$/.test(context.resourceLabel), 'cloud-secret-resource-label');
  const client = new SecretManagerServiceClient({ ...context.options, fallback: false });
  return withCleanup(async () => {
    const [secret] = await client.getSecret({ name: context.secretName }, callOptions);
    check(secret.name === context.secretName && secret.labels?.['wga-probe'] === context.resourceLabel, 'cloud-secret-get');
    const [version] = await client.accessSecretVersion({ name: context.secretVersion }, callOptions);
    check(version.name === context.secretVersion && version.payload?.data instanceof Uint8Array
      && Buffer.from(version.payload.data).equals(expected), 'cloud-secret-access-payload');
    let next = { parent, pageSize: 1, filter: `labels.wga-probe=${context.resourceLabel}` };
    const names = new Set(), tokens = new Set(); let pages = 0;
    while (next) {
      const [secrets, following, raw] = await client.listSecrets(next, { ...callOptions, autoPaginate: false });
      pages++; check(pages <= 3 && secrets.length <= 1 && Array.isArray(raw.secrets) && raw.secrets.length === secrets.length, 'cloud-secret-page-size');
      for (const item of secrets) {
        check(context.secretNames.includes(item.name) && !names.has(item.name)
          && item.labels?.['wga-probe'] === context.resourceLabel, 'cloud-secret-filtered-membership');
        names.add(item.name);
      }
      if (following) {
        check(following.parent === parent && following.pageSize === 1 && following.filter === `labels.wga-probe=${context.resourceLabel}`
          && typeof following.pageToken === 'string' && following.pageToken.length > 0 && following.pageToken === raw.nextPageToken
          && !tokens.has(following.pageToken), 'cloud-secret-pagination-progress');
        tokens.add(following.pageToken);
      } else check(!raw.nextPageToken, 'cloud-secret-terminal-page');
      next = following;
    }
    check(names.size === 2 && context.secretNames.every(name => names.has(name)) && pages >= 2 && tokens.size >= 1, 'cloud-secret-list-exact-two');
    // Payloads, checksums, remote messages and SDK response objects stay local.
    return ['secret-get', 'secret-access-payload-match', 'secret-filter-label', 'secret-list-page-size-one', 'secret-list-exact-two', 'secret-pagination-progress', 'payload-not-returned'];
  }, () => client.close());
}

export async function cloudPermissionDenied(context) {
  secretTarget(context);
  check(!!context.options.authClient, 'cloud-restricted-auth-client-required');
  const client = new SecretManagerServiceClient({ ...context.options, fallback: false });
  return withCleanup(async () => {
    let denied;
    try { await client.getSecret({ name: context.secretName }, callOptions); }
    catch (error) { denied = error; }
    remoteError(denied, 7, 'cloud-permission-denied');
    return ['restricted-auth-client', 'permission-denied-code-7', 'permission-denied-details-nonempty', 'permission-denied-metadata-shape'];
  }, () => client.close());
}
