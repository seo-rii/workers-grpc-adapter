// Identical business operations for the native, Node adapter, and workerd consumers.
// The harness supplies only connection/auth settings for its local official emulator.
import { AggregateField, DocumentReference, FieldPath, FieldValue, Firestore, GeoPoint, Timestamp } from '@google-cloud/firestore';
import { Buffer } from 'node:buffer';
import { check, requireWrites, withCleanup } from './assert.mjs';

async function fixture(context, suffix, ids, work) {
    requireWrites(context);
    const firestore = new Firestore({ ...context.options, preferRest: false });
    const collection = firestore.collection(`wga_emu_${suffix}_${context.runId}`);
    const refs = ids.map(id => collection.doc(id));
    return withCleanup(() => work({ firestore, collection, refs }), () => withCleanup(async () => {
        const batch = firestore.batch();
        for (const ref of refs) batch.delete(ref);
        await batch.commit();
        const removed = await firestore.getAll(...refs);
        check(removed.every(snapshot => !snapshot.exists), `firestore-emulator-${suffix}-cleanup`);
    }, () => firestore.terminate()));
}

export async function emulatorFirestoreDataModel(context) {
    return fixture(context, 'types', ['value', 'target'], async ({ firestore, refs: [ref, target] }) => {
        // Firestore stores microsecond precision; choose an exactly representable timestamp.
        const timestamp = new Timestamp(1700000000, 123456000);
        const geopoint = new GeoPoint(37.5665, 126.9780);
        const bytes = Buffer.from([0, 1, 127, 128, 255]);
        const batch = firestore.batch();
        batch.set(target, { target: true });
        batch.set(ref, {
            timestamp, geopoint, bytes, reference: target,
            maximumSafeInteger: Number.MAX_SAFE_INTEGER,
            minimumSafeInteger: Number.MIN_SAFE_INTEGER,
            text: '한글과 unicode 🌏', decimal: 1.25, boolean: true, empty: null,
            nested: { label: 'nested', values: [1, 'two', null, false] },
        });
        await batch.commit();
        const snapshot = await ref.get();
        const value = snapshot.data();
        check(snapshot.exists && value.timestamp instanceof Timestamp && value.timestamp.isEqual(timestamp), 'firestore-emulator-timestamp');
        check(value.geopoint instanceof GeoPoint && value.geopoint.isEqual(geopoint), 'firestore-emulator-geopoint');
        check(Buffer.isBuffer(value.bytes) && value.bytes.equals(bytes), 'firestore-emulator-bytes');
        check(value.reference instanceof DocumentReference && value.reference.isEqual(target), 'firestore-emulator-reference');
        check(value.maximumSafeInteger === Number.MAX_SAFE_INTEGER && value.minimumSafeInteger === Number.MIN_SAFE_INTEGER, 'firestore-emulator-safe-integer-boundaries');
        check(value.text === '한글과 unicode 🌏' && value.decimal === 1.25 && value.boolean === true && value.empty === null, 'firestore-emulator-scalar-values');
        check(value.nested.label === 'nested' && JSON.stringify(value.nested.values) === '[1,"two",null,false]', 'firestore-emulator-nested-values');
        return ['Timestamp-microseconds', 'GeoPoint', 'Buffer', 'DocumentReference', 'safe-int64-boundaries', 'unicode-scalars-nested-values', 'verified-delete-cleanup'];
    });
}

export async function emulatorFirestoreGetAll(context) {
    return fixture(context, 'getall', ['first', 'second', 'third', 'missing'], async ({ firestore, refs }) => {
        const batch = firestore.batch();
        refs.slice(0, 3).forEach((ref, index) => batch.set(ref, { marker: index, retained: 'yes' }));
        await batch.commit();
        const requested = [refs[2], refs[3], refs[0], refs[1]];
        const snapshots = await firestore.getAll(...requested);
        check(snapshots.length === requested.length && snapshots.every((snapshot, index) => snapshot.ref.isEqual(requested[index])), 'firestore-emulator-getall-order');
        check(snapshots[0].data()?.marker === 2 && !snapshots[1].exists && snapshots[2].data()?.marker === 0 && snapshots[3].data()?.marker === 1, 'firestore-emulator-getall-found-missing');
        const masked = await firestore.getAll(refs[1], { fieldMask: ['marker'] });
        check(masked.length === 1 && masked[0].data()?.marker === 1 && !('retained' in masked[0].data()), 'firestore-emulator-getall-field-mask');
        return ['getAll-request-order', 'mixed-found-and-missing', 'field-mask', 'verified-delete-cleanup'];
    });
}

export async function emulatorFirestoreQueryPages(context) {
    return fixture(context, 'query', ['a', 'b', 'c', 'd', 'e', 'f'], async ({ firestore, collection, refs }) => {
        const scores = [10, 20, 20, 30, 40, 50];
        const batch = firestore.batch();
        refs.forEach((ref, index) => batch.set(ref, { group: index === 4 ? 'other' : 'selected', score: scores[index] }));
        await batch.commit();
        const query = collection.where('group', '==', 'selected').where('score', '>=', 20).orderBy('score').orderBy(FieldPath.documentId());
        const first = await query.limit(2).get();
        check(first.docs.map(doc => doc.id).join(',') === 'b,c', 'firestore-emulator-query-first-page');
        const second = await query.startAfter(first.docs.at(-1)).limit(2).get();
        check(second.docs.map(doc => doc.id).join(',') === 'd,f', 'firestore-emulator-query-next-page');
        const last = await query.startAfter(second.docs.at(-1)).limit(2).get();
        check(last.empty && last.size === 0, 'firestore-emulator-query-empty-page');
        const bounded = await query.startAt(20, 'b').endBefore(30, 'd').get();
        check(bounded.docs.map(doc => doc.id).join(',') === 'b,c', 'firestore-emulator-query-value-cursors');
        const descending = await collection.where('group', '==', 'selected').orderBy('score', 'desc').limit(2).get();
        check(descending.docs.map(doc => doc.id).join(',') === 'f,d', 'firestore-emulator-query-descending');
        return ['equality-and-inequality-filter', 'ordered-ties', 'snapshot-startAfter-pages', 'empty-final-page', 'value-startAt-endBefore', 'descending-order', 'verified-delete-cleanup'];
    });
}

export async function emulatorFirestoreAggregates(context) {
    return fixture(context, 'aggregate', ['first', 'second', 'third', 'excluded'], async ({ firestore, collection, refs }) => {
        const batch = firestore.batch();
        [10, 20, 30, 1000].forEach((score, index) => batch.set(refs[index], { included: index < 3, score }));
        await batch.commit();
        const query = collection.where('included', '==', true);
        const counted = await query.count().get();
        check(counted.data().count === 3, 'firestore-emulator-count');
        const aggregated = await query.aggregate({ count: AggregateField.count(), total: AggregateField.sum('score'), average: AggregateField.average('score') }).get();
        const values = aggregated.data();
        check(values.count === 3 && values.total === 60 && values.average === 20, 'firestore-emulator-count-sum-average');
        const empty = await collection.where('score', '<', 0).aggregate({ count: AggregateField.count(), total: AggregateField.sum('score'), average: AggregateField.average('score') }).get();
        const none = empty.data();
        check(none.count === 0 && none.total === 0 && none.average === null, 'firestore-emulator-empty-aggregates');
        return ['count-filtered', 'combined-count-sum-average', 'empty-count-zero-sum-zero-average-null', 'verified-delete-cleanup'];
    });
}

export async function emulatorFirestoreTransforms(context) {
    return fixture(context, 'transforms', ['value'], async ({ refs: [ref] }) => {
        const initialWrite = await ref.set({ counter: 1, members: ['a', 'b'], discard: 'remove', nested: { preserved: true, changed: 1 } });
        const write = await ref.update({
            counter: FieldValue.increment(4),
            members: FieldValue.arrayUnion('b', 'c'),
            updatedAt: FieldValue.serverTimestamp(),
            alsoUpdatedAt: FieldValue.serverTimestamp(),
            discard: FieldValue.delete(),
            'nested.changed': 2,
        });
        let value = (await ref.get()).data();
        check(value.counter === 5 && value.members.join(',') === 'a,b,c', 'firestore-emulator-increment-and-union');
        // REQUEST_TIME has millisecond precision and is identical within one write;
        // a WriteResult's update time can carry finer precision.
        check(value.updatedAt instanceof Timestamp && value.alsoUpdatedAt instanceof Timestamp && value.updatedAt.isEqual(value.alsoUpdatedAt), 'firestore-emulator-server-timestamp');
        check(value.updatedAt.nanoseconds % 1000000 === 0 && value.updatedAt.toMillis() >= Math.floor(initialWrite.writeTime.toMillis()) && value.updatedAt.toMillis() <= write.writeTime.toMillis(), 'firestore-emulator-server-timestamp-precision');
        check(!('discard' in value) && value.nested.preserved === true && value.nested.changed === 2, 'firestore-emulator-delete-and-nested-update');
        await ref.update({ counter: FieldValue.increment(-2), members: FieldValue.arrayRemove('a', 'absent') });
        await ref.set({ merged: true }, { merge: true });
        value = (await ref.get()).data();
        check(value.counter === 3 && value.members.join(',') === 'b,c' && value.merged === true, 'firestore-emulator-remove-and-merge');
        await ref.delete();
        check(!(await ref.get()).exists, 'firestore-emulator-document-delete');
        return ['increment-positive-negative', 'arrayUnion-deduplicates', 'arrayRemove', 'serverTimestamp-precision-and-consistency', 'delete-field', 'nested-update', 'merge-preserves-fields', 'delete-document', 'verified-delete-cleanup'];
    });
}

export async function emulatorFirestoreTransactionRollback(context) {
    return fixture(context, 'rollback', ['value', 'created'], async ({ firestore, refs: [ref, created] }) => {
        await ref.set({ counter: 1 });
        const intentional = new Error('WGA_EMULATOR_TRANSACTION_ROLLBACK');
        let attempts = 0, failure;
        try {
            await firestore.runTransaction(async transaction => {
                attempts++;
                const snapshot = await transaction.get(ref);
                check(snapshot.data()?.counter === 1, 'firestore-emulator-rollback-initial-read');
                transaction.update(ref, { counter: 2 });
                transaction.create(created, { shouldNotExist: true });
                throw intentional;
            }, { maxAttempts: 1 });
        } catch (error) {
            failure = error;
        }
        check(failure === intentional && attempts === 1, 'firestore-emulator-rollback-error-preserved');
        const [unchanged, absent] = await firestore.getAll(ref, created);
        check(unchanged.data()?.counter === 1 && !absent.exists, 'firestore-emulator-rollback-no-mutations');
        return ['transaction-read', 'callback-error-identity', 'one-attempt', 'rollback-existing-document-unchanged', 'rollback-created-document-absent', 'verified-delete-cleanup'];
    });
}

export async function emulatorFirestoreBulkWriter(context) {
    return fixture(context, 'bulk', ['first', 'second', 'third'], async ({ firestore, refs }) => {
        // SDK 8.3 BulkWriter uses unary BatchWrite; it does not use the Write bidi RPC.
        const writer = firestore.bulkWriter({ throttling: false });
        let successfulWrites = 0, errors = 0, writeTimesValid = true;
        writer.onWriteResult((_ref, result) => { successfulWrites++; writeTimesValid &&= result.writeTime instanceof Timestamp; });
        writer.onWriteError(() => { errors++; return false; });
        return withCleanup(async () => {
            const first = [writer.create(refs[0], { counter: 1 }), writer.set(refs[1], { counter: 2 })];
            await Promise.all([...first, writer.flush()]);
            const second = [writer.update(refs[0], { counter: FieldValue.increment(2) }), writer.delete(refs[1]), writer.set(refs[2], { counter: 3 })];
            await Promise.all([...second, writer.flush()]);
            const duplicate = writer.create(refs[0], { counter: 999 });
            const [failed, flushed] = await Promise.allSettled([duplicate, writer.flush()]);
            check(failed.status === 'rejected' && failed.reason.code === 6 && flushed.status === 'fulfilled', 'firestore-emulator-bulkwriter-already-exists');
            const snapshots = await firestore.getAll(...refs);
            check(snapshots[0].data()?.counter === 3 && !snapshots[1].exists && snapshots[2].data()?.counter === 3, 'firestore-emulator-bulkwriter-state');
            check(successfulWrites === 5 && errors === 1 && writeTimesValid, 'firestore-emulator-bulkwriter-callbacks');
            return ['BulkWriter-unary-BatchWrite', 'create-set-update-delete', 'flush-awaits-writes', 'ALREADY_EXISTS-no-retry', 'five-write-results-one-error', 'verified-delete-cleanup'];
        }, () => writer.close());
    });
}

export async function emulatorFirestoreErrors(context) {
    return fixture(context, 'errors', ['existing', 'missing', 'atomic-created'], async ({ firestore, refs: [existing, missing, atomicCreated] }) => {
        async function expectStatus(operation, code, label) {
            let failure;
            try { await operation(); }
            catch (error) { failure = error; }
            check(failure?.code === code, `firestore-emulator-${label}-status`);
            check(typeof failure.details === 'string' && failure.details.trim().length > 0, `firestore-emulator-${label}-details`);
        }
        const initial = await existing.create({ counter: 1 });
        await expectStatus(() => existing.create({ counter: 999 }), 6, 'already-exists');
        check((await existing.get()).data()?.counter === 1, 'firestore-emulator-failed-create-unchanged');
        await expectStatus(() => missing.update({ counter: 10 }), 5, 'not-found');
        check(!(await missing.get()).exists, 'firestore-emulator-failed-update-still-missing');

        await existing.update({ counter: 2 });
        await expectStatus(() => existing.update({ counter: 999 }, { lastUpdateTime: initial.writeTime }), 9, 'stale-precondition');
        check((await existing.get()).data()?.counter === 2, 'firestore-emulator-stale-update-unchanged');

        const batch = firestore.batch();
        batch.create(atomicCreated, { counter: 3 });
        batch.update(existing, { counter: 999 });
        batch.update(missing, { counter: 10 });
        await expectStatus(() => batch.commit(), 5, 'atomic-batch-not-found');
        const [preserved, absent, uncreated] = await firestore.getAll(existing, missing, atomicCreated);
        check(preserved.data()?.counter === 2 && !absent.exists && !uncreated.exists, 'firestore-emulator-failed-batch-is-atomic');
        return ['create-ALREADY_EXISTS-6', 'update-NOT_FOUND-5', 'stale-update-FAILED_PRECONDITION-9', 'remote-error-details-nonempty', 'failed-writes-preserve-state', 'atomic-batch-failure-creates-nothing', 'verified-delete-cleanup'];
    });
}

export const emulatorFirestoreSuites = [
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-data-model', run: emulatorFirestoreDataModel },
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-get-all', run: emulatorFirestoreGetAll },
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-query-pages', run: emulatorFirestoreQueryPages },
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-aggregates', run: emulatorFirestoreAggregates },
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-transforms', run: emulatorFirestoreTransforms },
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-transaction-rollback', run: emulatorFirestoreTransactionRollback },
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-bulk-writer', run: emulatorFirestoreBulkWriter },
    { sdk: '@google-cloud/firestore', suite: 'firestore-emulator-errors', run: emulatorFirestoreErrors },
];
