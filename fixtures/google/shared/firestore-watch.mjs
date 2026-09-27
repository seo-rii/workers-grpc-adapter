// The harness copies these exact business assertions into both dependency graphs.
import { Firestore } from '@google-cloud/firestore';
import { PassThroughClient } from 'google-auth-library';

function check(condition, diagnostic) {
    if (!condition) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic });
}
function observe(target, normalize) {
    const queue = [], waiters = [];
    let failure, callbacks = 0, stopped = false;
    const drain = () => {
        while (waiters.length && (failure || queue.length)) {
            const waiter = waiters.shift();
            if (failure) waiter.reject(failure); else waiter.resolve(queue.shift());
        }
    };
    const unsubscribe = target.onSnapshot(snapshot => {
        callbacks++;
        try { queue.push(normalize(snapshot)); } catch (error) { failure = error; }
        drain();
    }, error => { failure = Object.assign(new Error('WATCH_CALLBACK_ERROR'), { code: error.code }); drain(); });
    return {
        get callbacks() { return callbacks; },
        async next(diagnostic) {
            let timer, waiter;
            try {
                return await new Promise((resolve, reject) => {
                    waiter = { resolve, reject }; waiters.push(waiter); drain();
                    timer = setTimeout(() => reject(Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic })), 7000);
                });
            } finally {
                clearTimeout(timer);
                const index = waiters.indexOf(waiter);
                if (index >= 0) waiters.splice(index, 1);
            }
        },
        stop() { if (!stopped) { stopped = true; unsubscribe(); } },
    };
}
async function unchanged(observer, before) {
    // A bounded quiescence assertion after an acknowledged write. Snapshots are
    // always received from onSnapshot, never replaced with repeated reads.
    await new Promise(resolve => setTimeout(resolve, 100));
    check(observer.callbacks === before, 'WATCH_NO_CALLBACK_AFTER_UNSUBSCRIBE');
}

export async function runFirestoreWatch({ options, runId, scenario }) {
    check(options.projectId === 'demo-wga-local' && /^[a-z0-9-]+$/.test(runId), 'WATCH_LOCAL_CONTEXT');
    check(scenario === 'document' || scenario === 'query', 'WATCH_SCENARIO');
    // Ordinary anonymous emulator credentials also satisfy GAX's universe-domain
    // lookup, so it never falls through to ambient ADC or metadata discovery.
    const firestore = new Firestore({ ...options, authClient: new PassThroughClient(), preferRest: false });
    const collection = firestore.collection(`wga_watch_${scenario}_${runId}`);
    const refs = ['a', 'b', 'c'].map(id => collection.doc(id));
    const observers = [], selected = [], changeTypes = new Set();
    let primary;
    try {
        if (scenario === 'document') {
            const ref = refs[0];
            const normalize = snapshot => ({ exists: snapshot.exists, value: snapshot.data()?.value ?? null });
            const observer = observe(ref, normalize); observers.push(observer);
            const expect = async (exists, value, diagnostic) => {
                const snapshot = await observer.next(diagnostic);
                check(snapshot.exists === exists && snapshot.value === value, diagnostic);
                selected.push(snapshot);
            };
            await expect(false, null, 'WATCH_DOCUMENT_INITIAL_ABSENT');
            await ref.set({ value: 1 }); await expect(true, 1, 'WATCH_DOCUMENT_CREATE');
            await ref.update({ value: 2 }); await expect(true, 2, 'WATCH_DOCUMENT_UPDATE');
            await ref.delete(); await expect(false, null, 'WATCH_DOCUMENT_DELETE');
            observer.stop(); const callbacks = observer.callbacks;
            await ref.set({ value: 3 });
            check((await ref.get()).data()?.value === 3, 'WATCH_DOCUMENT_WRITE_AFTER_UNSUBSCRIBE');
            await unchanged(observer, callbacks);
            const reused = observe(ref, normalize); observers.push(reused);
            const existing = await reused.next('WATCH_DOCUMENT_REUSE_INITIAL');
            check(existing.exists && existing.value === 3, 'WATCH_DOCUMENT_REUSE_INITIAL'); selected.push(existing);
            await ref.update({ value: 4 });
            const changed = await reused.next('WATCH_DOCUMENT_REUSE_UPDATE');
            check(changed.exists && changed.value === 4, 'WATCH_DOCUMENT_REUSE_UPDATE'); selected.push(changed);
            reused.stop();
        } else {
            const query = collection.where('included', '==', true).orderBy('score');
            const normalize = snapshot => {
                for (const change of snapshot.docChanges()) changeTypes.add(change.type);
                return snapshot.docs.map(doc => ({ id: doc.id, score: doc.data().score }));
            };
            const observer = observe(query, normalize); observers.push(observer);
            const expect = async (expected, diagnostic) => {
                const rows = await observer.next(diagnostic);
                check(JSON.stringify(rows) === JSON.stringify(expected), diagnostic); selected.push(rows);
            };
            await expect([], 'WATCH_QUERY_INITIAL_EMPTY');
            const batch = firestore.batch();
            batch.set(refs[0], { included: true, score: 1 });
            batch.set(refs[1], { included: true, score: 2 });
            await batch.commit(); await expect([{ id: 'a', score: 1 }, { id: 'b', score: 2 }], 'WATCH_QUERY_ADDED_ORDER');
            await refs[0].update({ score: 3 }); await expect([{ id: 'b', score: 2 }, { id: 'a', score: 3 }], 'WATCH_QUERY_MODIFIED_ORDER');
            await refs[1].delete(); await expect([{ id: 'a', score: 3 }], 'WATCH_QUERY_DELETED');
            await refs[0].update({ included: false }); await expect([], 'WATCH_QUERY_FILTER_REMOVED');
            check([...changeTypes].sort().join(',') === 'added,modified,removed', 'WATCH_QUERY_CHANGE_TYPES');
            observer.stop(); const callbacks = observer.callbacks;
            await refs[2].set({ included: true, score: 5 });
            check((await refs[2].get()).data()?.score === 5, 'WATCH_QUERY_WRITE_AFTER_UNSUBSCRIBE');
            await unchanged(observer, callbacks);
            const reused = observe(query, normalize); observers.push(reused);
            const existing = await reused.next('WATCH_QUERY_REUSE_INITIAL');
            check(JSON.stringify(existing) === JSON.stringify([{ id: 'c', score: 5 }]), 'WATCH_QUERY_REUSE_INITIAL'); selected.push(existing);
            await refs[2].delete();
            const empty = await reused.next('WATCH_QUERY_REUSE_DELETE');
            check(empty.length === 0, 'WATCH_QUERY_REUSE_DELETE'); selected.push(empty);
            reused.stop();
        }
        return { scenario, selected, changeTypes: [...changeTypes].sort(), listeners: observers.length,
            callbacks: observers.reduce((sum, item) => sum + item.callbacks, 0), unsubscribeVerified: true, reuseVerified: true };
    } catch (error) { primary = error; throw error; }
    finally {
        for (const observer of observers) observer.stop();
        const errors = [];
        try {
            const batch = firestore.batch(); for (const ref of refs) batch.delete(ref); await batch.commit();
            check((await firestore.getAll(...refs)).every(snapshot => !snapshot.exists), 'WATCH_DATA_CLEANUP');
        } catch (error) { errors.push(error); }
        try { await firestore.terminate(); } catch (error) { errors.push(error); }
        if (errors.length) throw Object.assign(new Error('WATCH_CLEANUP_FAILED'), { fixtureDiagnostic: 'WATCH_CLEANUP_FAILED', cause: primary ?? errors[0] });
    }
}
