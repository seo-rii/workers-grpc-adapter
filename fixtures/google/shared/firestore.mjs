import { Firestore } from '@google-cloud/firestore';
import { check, requireWrites, withCleanup } from './assert.mjs';
export async function firestoreCrud(context) {
    requireWrites(context);
    // Explicitly forbid preferRest so success cannot silently exercise a different transport.
    const firestore = new Firestore({ ...context.options, preferRest: false });
    const ref = firestore.collection(`wga_${context.runId}`).doc('smoke');
    return withCleanup(async () => {
        await ref.set({ marker: context.runId, count: 1 });
        const snapshot = await ref.get();
        check(snapshot.exists && snapshot.data()?.marker === context.runId, 'firestore-set-get');
        const query = await firestore.collection(`wga_${context.runId}`).where('marker', '==', context.runId).limit(2).get();
        check(query.size === 1 && query.docs[0].id === 'smoke', 'firestore-run-query');
        return ['commit-set', 'batchGetDocuments', 'runQuery', 'delete-cleanup'];
    }, async () => {
        try {
            await ref.delete();
        }
        finally {
            await firestore.terminate();
        }
    });
}
export async function firestoreTransaction(context) {
    requireWrites(context);
    const firestore = new Firestore({ ...context.options, preferRest: false });
    const ref = firestore.collection(`wga_${context.runId}`).doc('transaction');
    return withCleanup(async () => {
        await ref.set({ count: 1 });
        await firestore.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(ref);
            check(snapshot.exists, 'firestore-transaction-read');
            transaction.update(ref, { count: snapshot.data().count + 1 });
        });
        check((await ref.get()).data()?.count === 2, 'firestore-transaction-commit');
        return ['beginTransaction', 'transaction-get', 'commit', 'get', 'delete-cleanup'];
    }, async () => {
        try {
            await ref.delete();
        }
        finally {
            await firestore.terminate();
        }
    });
}
