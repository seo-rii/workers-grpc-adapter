import { Buffer } from 'node:buffer';
import { Datastore, v1 } from '@google-cloud/datastore';
import { check, requireWrites, withCleanup } from './assert.mjs';

// The same source runs with native grpc-js, the Node replacement and workerd.
// Each case owns a namespace; cleanup only deletes keys created by that case.
function createDatastore(context, suffix) {
    requireWrites(context);
    return new Datastore({ ...context.options, namespace: `wga-emu-${context.runId}-${suffix}` });
}

export async function emulatorDatastoreTypes(context) {
    const datastore = createDatastore(context, 'types');
    const namespace = `wga-emu-${context.runId}-types`;
    const largeId = '9007199254741009';
    const parent = datastore.key(['WgaEmulatorParent', context.runId]);
    const key = datastore.key(['WgaEmulatorParent', context.runId, 'WgaEmulatorTyped', datastore.int(largeId)]);
    const otherKey = datastore.key({ namespace: `${namespace}-other`, path: ['WgaEmulatorParent', context.runId, 'WgaEmulatorTyped', datastore.int(largeId)] });
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const date = new Date('2024-02-29T12:34:56.789Z');
    return withCleanup(async () => {
        await datastore.save([
            { key, data: {
                marker: 'primary', positive: datastore.int('9007199254740993'), negative: datastore.int('-9007199254740995'),
                bytes, date, location: datastore.geoPoint({ latitude: 37.5, longitude: 127.25 }), reference: parent,
                nested: { label: '한글', enabled: true, values: ['first', null, 'last'] }, nil: null, emptyText: '', emptyList: [],
            } },
            { key: otherKey, data: { marker: 'other-namespace' } },
        ]);
        const [entity] = await datastore.get(key, { wrapNumbers: true });
        check(entity?.marker === 'primary', 'emulator-datastore-types-primary');
        check(datastore.isInt(entity.positive) && entity.positive.value === '9007199254740993', 'emulator-datastore-positive-int64');
        check(datastore.isInt(entity.negative) && entity.negative.value === '-9007199254740995', 'emulator-datastore-negative-int64');
        check(Buffer.isBuffer(entity.bytes) && entity.bytes.equals(bytes), 'emulator-datastore-buffer-bytes');
        check(entity.date instanceof Date && entity.date.getTime() === date.getTime(), 'emulator-datastore-date-milliseconds');
        // The SDK returns a plain coordinates object, not its input GeoPoint wrapper.
        check(entity.location?.latitude === 37.5 && entity.location?.longitude === 127.25, 'emulator-datastore-geopoint');
        check(datastore.isKey(entity.reference) && entity.reference.kind === parent.kind && entity.reference.name === context.runId && entity.reference.namespace === namespace, 'emulator-datastore-key-property');
        check(entity.nested?.label === '한글' && entity.nested.enabled === true && JSON.stringify(entity.nested.values) === '["first",null,"last"]', 'emulator-datastore-nested-values');
        check(entity.nil === null && entity.emptyText === '' && Array.isArray(entity.emptyList) && entity.emptyList.length === 0, 'emulator-datastore-empty-values');
        check(!Object.hasOwn(entity, 'missingProperty'), 'emulator-datastore-missing-property');
        const actualKey = entity[datastore.KEY];
        check(datastore.isKey(actualKey) && actualKey.namespace === namespace && actualKey.id === largeId && actualKey.kind === 'WgaEmulatorTyped', 'emulator-datastore-key-symbol-and-int64-id');
        check(actualKey.parent?.kind === parent.kind && actualKey.parent?.name === context.runId, 'emulator-datastore-ancestor-path');
        const [other] = await datastore.get(otherKey);
        check(other?.marker === 'other-namespace' && other[datastore.KEY].namespace === `${namespace}-other`, 'emulator-datastore-namespace-isolation');
        return ['positive-negative-int64-wrappers', 'buffer-bytes', 'date-milliseconds', 'geopoint', 'key-property', 'nested-null-empty-values', 'key-symbol-and-int64-id', 'ancestor-path', 'namespace-isolation'];
    }, () => datastore.delete([key, otherKey]));
}

export async function emulatorDatastoreBatch(context) {
    const datastore = createDatastore(context, 'batch');
    const keys = ['first', 'second', 'missing'].map(name => datastore.key(['WgaEmulatorBatch', name]));
    return withCleanup(async () => {
        await datastore.save([{ key: keys[0], data: { value: 'one' } }, { key: keys[1], data: { value: 'two' } }]);
        // Lookup need not preserve the requested order or include missing keys.
        const response = await datastore.get([keys[1], keys[2], keys[0]]);
        check(Array.isArray(response) && response.length === 1 && Array.isArray(response[0]), 'emulator-datastore-batch-promise-tuple');
        const entities = response[0];
        const byName = new Map(entities.map(entity => [entity[datastore.KEY].name, entity.value]));
        check(entities.length === 2 && byName.size === 2 && byName.get('first') === 'one' && byName.get('second') === 'two' && !byName.has('missing'), 'emulator-datastore-batch-found-missing');
        const scalar = await datastore.get(keys[0]);
        check(scalar.length === 1 && !Array.isArray(scalar[0]) && scalar[0]?.value === 'one', 'emulator-datastore-scalar-promise-tuple');
        const [missing] = await datastore.get(keys[2]);
        check(missing === undefined, 'emulator-datastore-scalar-missing');
        let callbacks = 0;
        const callbackEntity = await new Promise((resolve, reject) => datastore.get(keys[0], (error, entity) => {
            callbacks++;
            if (error) reject(error); else resolve(entity);
        }));
        check(callbacks === 1 && callbackEntity?.value === scalar[0].value && callbackEntity[datastore.KEY].name === scalar[0][datastore.KEY].name, 'emulator-datastore-callback-promise-equivalence');
        const callbackMissing = await new Promise((resolve, reject) => datastore.get(keys[2], (error, entity) => error ? reject(error) : resolve(entity)));
        check(callbackMissing === undefined, 'emulator-datastore-callback-missing');
        await datastore.delete([keys[0], keys[1], keys[2]]);
        const [deleted] = await datastore.get([keys[0], keys[1]]);
        check(Array.isArray(deleted) && deleted.length === 0, 'emulator-datastore-batch-delete-including-missing');
        return ['batch-save', 'found-missing-key-map', 'scalar-array-shapes', 'promise-tuple', 'callback-promise-equivalence', 'missing-is-undefined', 'batch-delete-including-missing'];
    }, () => datastore.delete(keys));
}

export async function emulatorDatastoreQueries(context) {
    const datastore = createDatastore(context, 'queries');
    const parent = datastore.key(['WgaEmulatorQueryParent', 'selected']);
    const keys = Array.from({ length: 6 }, (_, rank) => datastore.key(['WgaEmulatorQueryParent', 'selected', 'WgaEmulatorQuery', `row-${rank}`]));
    const outside = datastore.key(['WgaEmulatorQueryParent', 'outside', 'WgaEmulatorQuery', 'not-selected']);
    return withCleanup(async () => {
        await datastore.save([...keys.map((key, rank) => ({ key, data: { rank, label: `row-${rank}` } })), { key: outside, data: { rank: 3, label: 'not-selected' } }]);
        const ranks = [], names = new Set(), cursors = new Set();
        let cursor;
        for (let page = 0; page < 5; page++) {
            const query = datastore.createQuery('WgaEmulatorQuery').hasAncestor(parent).filter('rank', '>=', 1).order('rank').order('__key__').limit(2);
            if (cursor) query.start(cursor);
            const [entities, info] = await datastore.runQuery(query);
            check(entities.length <= 2, 'emulator-datastore-page-size');
            for (const entity of entities) {
                const key = entity[datastore.KEY];
                check(key.parent?.name === 'selected' && entity.label === `row-${entity.rank}` && !names.has(key.name), 'emulator-datastore-page-membership-and-deduplication');
                ranks.push(entity.rank);
                names.add(key.name);
            }
            if (info.moreResults === datastore.NO_MORE_RESULTS) break;
            check(typeof info.endCursor === 'string' && info.endCursor.length > 0 && !cursors.has(info.endCursor), 'emulator-datastore-cursor-progress');
            cursors.add(info.endCursor);
            cursor = info.endCursor;
            check(page < 4, 'emulator-datastore-pagination-terminates');
        }
        check(JSON.stringify(ranks) === '[1,2,3,4,5]' && names.size === 5, 'emulator-datastore-filter-order-cursor-complete');
        const projection = datastore.createQuery('WgaEmulatorQuery').hasAncestor(parent).select('rank').order('rank');
        const [projected] = await datastore.runQuery(projection);
        check(projected.length === 6 && projected.every((entity, rank) => entity.rank === rank && !Object.hasOwn(entity, 'label') && datastore.isKey(entity[datastore.KEY])), 'emulator-datastore-projection');
        return ['ancestor-isolation', 'inequality-filter', 'explicit-rank-key-order', 'cursor-page-size-two', 'no-missing-or-duplicate-rows', 'projection-and-key-symbol'];
    }, () => datastore.delete([...keys, outside]));
}

export async function emulatorDatastoreAggregation(context) {
    const datastore = createDatastore(context, 'aggregation');
    const keys = [2, 4, 6].map(value => datastore.key(['WgaEmulatorAggregation', `row-${value}`]));
    return withCleanup(async () => {
        await datastore.save(keys.map((key, index) => ({ key, data: { amount: (index + 1) * 2 } })));
        const query = datastore.createAggregationQuery(datastore.createQuery('WgaEmulatorAggregation')).count('total').sum('amount', 'sum').average('amount', 'average');
        const [rows] = await datastore.runAggregationQuery(query);
        check(rows.length === 1 && rows[0].total === 3 && rows[0].sum === 12 && rows[0].average === 4, 'emulator-datastore-aggregation-count-sum-average');
        const emptyQuery = datastore.createAggregationQuery(datastore.createQuery('WgaEmulatorAggregation').filter('amount', '>', 100)).count('total').sum('amount', 'sum').average('amount', 'average');
        const [empty] = await datastore.runAggregationQuery(emptyQuery);
        check(empty.length === 1 && empty[0].total === 0 && empty[0].sum === 0 && empty[0].average === null, 'emulator-datastore-aggregation-empty');
        return ['count', 'sum', 'average', 'explicit-aliases', 'empty-count-zero-sum-zero-average-null'];
    }, () => datastore.delete(keys));
}

export async function emulatorDatastoreIds(context) {
    const datastore = createDatastore(context, 'ids');
    const namespace = `wga-emu-${context.runId}-ids`;
    // High-level apiEndpoint accepts host:port; generated clients take them separately.
    const endpoint = new URL(context.options.apiEndpoint.includes('://') ? context.options.apiEndpoint : `https://${context.options.apiEndpoint}`);
    const generated = new v1.DatastoreClient({ ...context.options, apiEndpoint: endpoint.hostname, port: Number(endpoint.port || 443), fallback: false });
    const keys = [];
    return withCleanup(async () => {
        const allocated = await datastore.allocateIds(datastore.key(['WgaEmulatorAllocated']), 3);
        check(Array.isArray(allocated) && allocated.length === 2 && Array.isArray(allocated[0]) && allocated[0].length === 3, 'emulator-datastore-allocated-response');
        keys.push(...allocated[0]);
        check(new Set(keys.map(key => key.id)).size === 3 && keys.every(key => /^\d+$/.test(key.id) && key.namespace === namespace && key.kind === 'WgaEmulatorAllocated'), 'emulator-datastore-allocated-ids');
        const reservedId = '9007199254741011';
        const reserved = datastore.key(['WgaEmulatorReserved', datastore.int(reservedId)]);
        keys.push(reserved);
        // reserveIds is public on the generated v1 client, not high-level Datastore.
        const reservedResponse = await generated.reserveIds({ projectId: context.options.projectId, keys: [{ partitionId: { projectId: context.options.projectId, namespaceId: namespace }, path: [{ kind: 'WgaEmulatorReserved', id: reservedId }] }] }, { timeout: 5000, retry: null });
        check(Array.isArray(reservedResponse) && reservedResponse[0] !== null && typeof reservedResponse[0] === 'object', 'emulator-datastore-reserve-ids-response');
        const [notCreated] = await datastore.get(keys);
        check(notCreated.length === 0, 'emulator-datastore-id-allocation-does-not-create-entities');
        await datastore.save(keys.map((key, index) => ({ key, data: { marker: `allocated-${index}` } })));
        const [found] = await datastore.get(keys);
        const byId = new Map(found.map(entity => [entity[datastore.KEY].id, entity.marker]));
        check(found.length === 4 && keys.every((key, index) => byId.get(key.id) === `allocated-${index}`), 'emulator-datastore-allocated-and-reserved-id-round-trip');
        return ['allocate-three-unique-ids', 'generated-v1-reserve-ids', 'reserved-int64-id-precision', 'allocation-creates-no-entity', 'allocated-reserved-key-round-trip'];
    }, () => withCleanup(async () => { if (keys.length) await datastore.delete(keys); }, () => generated.close()));
}

export async function emulatorDatastoreRollback(context) {
    const datastore = createDatastore(context, 'rollback');
    const key = datastore.key(['WgaEmulatorRollback', 'existing']);
    const newKey = datastore.key(['WgaEmulatorRollback', 'not-created']);
    let transaction;
    let active = false;
    return withCleanup(async () => {
        await datastore.save({ key, data: { count: 1 } });
        transaction = datastore.transaction();
        await transaction.run();
        active = true;
        const [before] = await transaction.get(key);
        check(before?.count === 1, 'emulator-datastore-rollback-read');
        transaction.save([{ key, data: { count: 99 } }, { key: newKey, data: { count: 2 } }]);
        await transaction.rollback();
        active = false;
        const [after] = await datastore.get(key);
        const [absent] = await datastore.get(newKey);
        check(after?.count === 1 && absent === undefined, 'emulator-datastore-rollback-mutations-not-applied');
        return ['begin-transaction', 'transaction-read', 'queue-update-and-insert', 'rollback', 'original-entity-unchanged', 'new-entity-absent'];
    }, () => withCleanup(async () => { if (active) await transaction.rollback(); }, () => datastore.delete([key, newKey])));
}

export async function emulatorDatastoreErrors(context) {
    const datastore = createDatastore(context, 'errors');
    const [existing, missing, created] = ['existing', 'missing', 'atomic-created'].map(name => datastore.key(['WgaEmulatorErrors', name]));
    const gaxOptions = { timeout: 5000, retry: null };
    let transaction, active = false, commitAttempted = false;
    async function expectStatus(operation, code, label) {
        let failure;
        try { await operation(); }
        catch (error) { failure = error; }
        check(failure?.code === code, `emulator-datastore-${label}-status`);
        check(typeof failure.details === 'string' && failure.details.trim().length > 0, `emulator-datastore-${label}-details`);
    }
    return withCleanup(async () => {
        await datastore.save({ key: existing, data: { counter: 1 } }, gaxOptions);
        // Explicit save methods select the same insert/update mutations while
        // allowing a finite RPC timeout and disabling retries for the error cases.
        await expectStatus(() => datastore.save({ key: existing, method: 'insert', data: { counter: 999 } }, gaxOptions), 6, 'already-exists');
        const [preserved] = await datastore.get(existing, { gaxOptions });
        check(preserved?.counter === 1, 'emulator-datastore-failed-insert-unchanged');
        await expectStatus(() => datastore.save({ key: missing, method: 'update', data: { counter: 999 } }, gaxOptions), 5, 'not-found');
        const [absent] = await datastore.get(missing, { gaxOptions });
        check(absent === undefined, 'emulator-datastore-failed-update-still-missing');

        transaction = datastore.transaction();
        await transaction.run({ gaxOptions });
        active = true;
        const [before] = await transaction.get(existing, { gaxOptions });
        check(before?.counter === 1, 'emulator-datastore-atomic-failure-initial-read');
        transaction.update({ key: existing, data: { counter: 999 } });
        transaction.insert({ key: created, data: { counter: 3 } });
        transaction.update({ key: missing, data: { counter: 10 } });
        commitAttempted = true;
        // Datastore Transaction.commit performs its own rollback on failure.
        await expectStatus(() => transaction.commit(gaxOptions), 5, 'atomic-commit-not-found');
        active = false;
        const [after] = await datastore.get([existing, missing, created], { gaxOptions });
        check(after.length === 1 && after[0][datastore.KEY].name === 'existing' && after[0].counter === 1, 'emulator-datastore-failed-commit-is-atomic');
        return ['insert-ALREADY_EXISTS-6', 'update-NOT_FOUND-5', 'remote-error-details-nonempty', 'failed-writes-preserve-state', 'transaction-valid-update-and-insert-with-invalid-update', 'atomic-commit-failure-existing-unchanged-new-absent', 'verified-delete-cleanup'];
    }, () => withCleanup(async () => {
        if (active && !commitAttempted) await transaction.rollback(gaxOptions);
    }, async () => {
        await datastore.delete([existing, missing, created], gaxOptions);
        const [remaining] = await datastore.get([existing, missing, created], { gaxOptions });
        check(remaining.length === 0, 'emulator-datastore-errors-cleanup');
    }));
}

export const emulatorDatastoreSuites = [
    { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-types', run: emulatorDatastoreTypes },
    { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-batch', run: emulatorDatastoreBatch },
    { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-queries', run: emulatorDatastoreQueries },
    { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-aggregation', run: emulatorDatastoreAggregation },
    { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-ids', run: emulatorDatastoreIds },
    { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-rollback', run: emulatorDatastoreRollback },
    { sdk: '@google-cloud/datastore', suite: 'datastore-emulator-errors', run: emulatorDatastoreErrors },
];
