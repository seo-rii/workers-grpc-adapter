import { Firestore } from '@google-cloud/firestore';
import { PassThroughClient } from 'google-auth-library';

function check(value, diagnostic) {
    if (!value) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic });
}
export async function runFirestoreRecovery({ options, scenario, advance }) {
    check(options.projectId === 'demo-wga-local', 'WATCH_LOCAL_CONTEXT');
    const firestore = new Firestore({ ...options, authClient: new PassThroughClient(), preferRest: false });
    const events = [], pending = [], snapshots = [], changes = [];
    let callbacks = 0, unsubscribe;
    const emit = event => pending.length ? pending.shift()(event) : events.push(event);
    async function next() {
        let timer, waiter;
        try {
            return await new Promise((resolve, reject) => {
                waiter = resolve;
                if (events.length) resolve(events.shift()); else pending.push(resolve);
                timer = setTimeout(() => reject(Object.assign(new Error('WATCH_EVENT_TIMEOUT'), { fixtureDiagnostic: 'WATCH_EVENT_TIMEOUT' })), 10000);
            });
        } finally {
            clearTimeout(timer);
            const index = pending.indexOf(waiter); if (index >= 0) pending.splice(index, 1);
        }
    }
    try {
        unsubscribe = firestore.collection(`wga_recovery_${scenario}`).orderBy('value').onSnapshot(snapshot => {
            callbacks++;
            const rows = snapshot.docs.map(doc => ({ id: doc.id, value: doc.data().value }));
            snapshots.push(rows); changes.push(snapshot.docChanges().map(change => change.type)); emit({ rows });
        }, error => { callbacks++; emit({ error: { code: error.code ?? null, message: error.message } }); });
        check(JSON.stringify((await next()).rows) === JSON.stringify([{ id: 'a', value: 1 }]), 'WATCH_INITIAL_SNAPSHOT');
        await advance();
        const event = await next();
        if (scenario === 'target-error') check(event.error?.message === 'Error 7: controlled target denial', 'WATCH_TARGET_ERROR');
        else {
            const expected = ['resume', 'disconnect'].includes(scenario) ? [{ id: 'a', value: 2 }]
                : scenario === 'remove' ? [] : [{ id: 'b', value: 2 }];
            check(JSON.stringify(event.rows) === JSON.stringify(expected), 'WATCH_RECOVERED_SNAPSHOT');
            check(!snapshots.some(rows => rows.some(row => row.id === 'pending')), 'WATCH_UNCOMMITTED_CHANGE_DISCARDED');
        }
        unsubscribe();
        const stopped = callbacks;
        await new Promise(resolve => setTimeout(resolve, 120));
        check(callbacks === stopped && events.length === 0, 'WATCH_TERMINAL_CALLBACKS_STOPPED');
        return { scenario, snapshots, changes, callbacks, errorCode: event.error?.code ?? null,
            errorMessage: scenario === 'target-error' ? event.error.message : null, unsubscribeVerified: true };
    } finally { unsubscribe?.(); await firestore.terminate(); }
}
