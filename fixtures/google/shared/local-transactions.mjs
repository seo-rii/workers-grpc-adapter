import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { check, requireWrites, withCleanup } from './assert.mjs';

// These cases require the controlled local server's documented fault triggers.
// The same business operations execute with native grpc-js and in workerd.
async function datastoreFailedCommit(context, kind, code, persistedCount) {
    requireWrites(context);
    const datastore = new Datastore({ ...context.options, namespace: `wga-${context.runId}` });
    const key = datastore.key([kind, context.runId]);
    return withCleanup(async () => {
        await datastore.save({ key, data: { count: 1 } });
        const transaction = datastore.transaction();
        let failure, commitStarted = false;
        try {
            await transaction.run();
            const [before] = await transaction.get(key);
            check(before?.count === 1, 'datastore-fault-initial-read');
            transaction.save({ key, data: { count: 2 } });
            commitStarted = true;
            await transaction.commit({ timeout: 1000, retry: null });
        } catch (error) {
            if (!commitStarted) {
                try { await transaction.rollback(); }
                catch (cleanupError) { throw new AggregateError([error, cleanupError], 'WGA_ROLLBACK_FAILED'); }
                throw error;
            }
            failure = error;
        }
        check(failure?.code === code, 'datastore-fault-status');
        // Datastore itself sends Rollback after Commit failure. It cannot undo
        // an already applied Commit, so verify persisted state independently.
        const [after] = await datastore.get(key);
        check(after?.count === persistedCount, 'datastore-fault-persisted-state');
        return [`commit-error-${code}`, `persisted-count-${persistedCount}`, 'no-application-retry', 'delete-cleanup'];
    }, () => datastore.delete(key));
}

export async function datastoreAborted(context) {
    return datastoreFailedCommit(context, 'WgaAdapterAbort', 10, 1);
}

export async function datastoreCommitResponseLost(context) {
    return datastoreFailedCommit(context, 'WgaAdapterLostResponse', 4, 2);
}

export async function firestoreAbortedRetry(context) {
    requireWrites(context);
    const firestore = new Firestore({ ...context.options, preferRest: false });
    const ref = firestore.collection(`wga_abort_${context.runId}`).doc('transaction');
    return withCleanup(async () => {
        await ref.set({ count: 1 });
        let attempts = 0;
        await firestore.runTransaction(async transaction => {
            attempts++;
            const snapshot = await transaction.get(ref);
            check(snapshot.exists && snapshot.data()?.count === 1, 'firestore-aborted-unchanged-before-retry');
            transaction.update(ref, { count: snapshot.data().count + 1 });
        }, { maxAttempts: 2 });
        check(attempts === 2, 'firestore-aborted-exactly-one-sdk-retry');
        check((await ref.get()).data()?.count === 2, 'firestore-aborted-single-applied-update');
        return ['aborted-before-apply', 'sdk-retried-transaction-once', 'single-applied-update', 'delete-cleanup'];
    }, async () => {
        try { await ref.delete(); }
        finally { await firestore.terminate(); }
    });
}
