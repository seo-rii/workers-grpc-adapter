// Controlled-server cases; this same file is copied byte-for-byte into both SDK consumers.
import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { check, requireWrites, withCleanup } from './assert.mjs';
function collect(stream) {
    return new Promise((resolve, reject) => {
        const values = [], events = [];
        stream.on('data', value => { values.push(value); events.push('data'); });
        stream.on('info', () => events.push('info'));
        stream.on('error', reject);
        stream.on('end', () => { events.push('end'); resolve({ values, events }); });
    });
}
export async function datastoreStreams(context) {
    requireWrites(context);
    const datastore = new Datastore({ ...context.options, namespace: `wga-${context.runId}` });
    const keys = [0, 1, 2].map(id => datastore.key(['WgaStreams', String(id)]));
    return withCleanup(async () => {
        await datastore.save(keys.map((key, marker) => ({ key, data: { marker } })));
        const query = await collect(datastore.runQueryStream(datastore.createQuery('WgaStreams')));
        check(query.values.length === 3, 'datastore-run-query-stream-count');
        const read = await collect(datastore.createReadStream([keys[2], datastore.key(['WgaStreams', 'missing']), keys[0]]));
        check(read.values.length === 2 && read.values.map(entity => entity.marker).sort().join(',') === '0,2', 'datastore-create-read-stream-found-missing');
        const early = datastore.runQueryStream(datastore.createQuery('WgaStreams'));
        let seen = 0;
        await new Promise((resolve, reject) => {
            early.on('error', reject);
            early.on('close', resolve);
            early.on('data', () => { seen++; early.destroy(); });
        });
        check(seen === 1 && early.destroyed, 'datastore-stream-early-destroy');
        return ['runQueryStream', query.events.join(','), 'createReadStream-found-missing', read.events.join(','), 'early-destroy'];
    }, () => datastore.delete(keys));
}
export async function firestoreBatchGet(context) {
    requireWrites(context);
    const firestore = new Firestore({ ...context.options, preferRest: false });
    const refs = [0, 1, 2].map(id => firestore.collection(`wga_${context.runId}_batch`).doc(String(id)));
    return withCleanup(async () => {
        const batch = firestore.batch();
        for (let index = 0; index < refs.length; index++) batch.set(refs[index], { marker: index });
        await batch.commit();
        const missing = firestore.collection(`wga_${context.runId}_batch`).doc('missing');
        const snapshots = await firestore.getAll(refs[2], missing, refs[0]);
        check(snapshots.length === 3 && snapshots[0].data()?.marker === 2 && !snapshots[1].exists && snapshots[2].data()?.marker === 0, 'firestore-get-all-order-and-missing');
        return ['getAll', 'multiple-documents', 'missing-document', 'request-order'];
    }, async () => {
        try {
            const batch = firestore.batch();
            for (const ref of refs) batch.delete(ref);
            await batch.commit();
        } finally { await firestore.terminate(); }
    });
}
export async function firestoreListenUnsupported(context) {
    const firestore = new Firestore({ ...context.options, preferRest: false });
    let unsubscribe;
    try {
        const code = await new Promise((resolve, reject) => {
            unsubscribe = firestore.collection(`wga_${context.runId}`).onSnapshot(() => reject(new Error('unexpected-listen-data')), error => resolve(error.code));
        });
        check(code === 12, 'firestore-listen-unimplemented');
        return ['onSnapshot', 'UNIMPLEMENTED', 'zero-network'];
    } finally {
        unsubscribe?.();
        await firestore.terminate();
    }
}
