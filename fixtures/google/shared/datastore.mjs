import { Datastore } from '@google-cloud/datastore';
import { check, requireWrites, withCleanup } from './assert.mjs';
// This exact module is imported by both Node and the Worker entrypoint.
// No gaxOptions, alternate SDK import, or REST fallback is used here.
export async function datastoreCrud(context) {
    requireWrites(context);
    const datastore = new Datastore({ ...context.options, namespace: `wga-${context.runId}` });
    const key = datastore.key(['WgaAdapterSmoke', context.runId]);
    return withCleanup(async () => {
        await datastore.save({ key, data: { marker: context.runId, count: 1 } });
        const [entity] = await datastore.get(key);
        check(entity?.marker === context.runId && entity.count === 1, 'datastore-save-get');
        const query = datastore.createQuery('WgaAdapterSmoke').filter('marker', '=', context.runId).limit(2);
        const [rows] = await datastore.runQuery(query);
        check(rows.length === 1 && rows[0].marker === context.runId, 'datastore-run-query');
        return ['save', 'get', 'runQuery', 'delete-cleanup'];
    }, () => datastore.delete(key));
}
export async function datastoreTransaction(context) {
    requireWrites(context);
    const datastore = new Datastore({ ...context.options, namespace: `wga-${context.runId}` });
    const key = datastore.key(['WgaAdapterTransaction', context.runId]);
    return withCleanup(async () => {
        await datastore.save({ key, data: { count: 1 } });
        const transaction = datastore.transaction();
        let commitStarted = false;
        try {
            await transaction.run();
            const [entity] = await transaction.get(key);
            check(entity?.count === 1, 'datastore-transaction-read');
            transaction.save({ key, data: { count: 2 } });
            commitStarted = true;
            await transaction.commit();
        }
        catch (error) {
            // Once Commit was sent, a failure does not prove the mutation was rolled back.
            if (!commitStarted) {
                try {
                    await transaction.rollback();
                }
                catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], 'WGA_ROLLBACK_FAILED');
                }
            }
            throw error;
        }
        const [entity] = await datastore.get(key);
        check(entity?.count === 2, 'datastore-transaction-commit');
        return ['beginTransaction', 'transaction-get', 'commit', 'get', 'delete-cleanup'];
    }, () => datastore.delete(key));
}
