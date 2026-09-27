import { Firestore } from '@google-cloud/firestore';
import { PassThroughClient } from 'google-auth-library';

function check(value, diagnostic) {
    if (!value) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic });
}

// These exact business bytes run against both SDK profiles and all transports.
// The raw SDK has an explicitly different expected permission-error outcome.
export async function runFirestoreWatchErrors({ options, scenario, patched, control }) {
    check(options.projectId === 'demo-wga-local', 'WATCH_LOCAL_CONTEXT');
    const firestore = new Firestore({ ...options, authClient: new PassThroughClient(), preferRest: false });
    const events = [], pending = [], snapshots = [], errors = [];
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
    function listen() {
        return firestore.collection(`wga_errors_${scenario}`).orderBy('value').onSnapshot(snapshot => {
            callbacks++;
            const rows = snapshot.docs.map(doc => ({ id: doc.id, value: doc.data().value }));
            snapshots.push(rows); emit({ rows });
        }, error => {
            callbacks++;
            const observed = { code: error.code ?? null, message: error.message };
            errors.push(observed); emit({ error: observed });
        });
    }
    const expectRows = (event, value) => check(JSON.stringify(event.rows) === JSON.stringify([{ id: 'a', value }]), 'WATCH_EXPECTED_SNAPSHOT');
    try {
        unsubscribe = listen();
        expectRows(await next(), 1);
        await control('advance');
        const terminal = await next();
        if (scenario === 'permission') {
            if (patched) {
                check(terminal.error?.code === 7, 'WATCH_PERMISSION_CODE_PRESERVED');
                check(terminal.error.message.includes('controlled permission denied'), 'WATCH_PERMISSION_MESSAGE_PRESERVED');
            } else {
                check(terminal.error?.message === 'Error 7: baseline reconnect sentinel', 'WATCH_RAW_SDK_RECONNECT_OBSERVED');
            }
            // The first retry backoff has a maximum of 1.5 s in the pinned SDK.
            // Keep the listener alive beyond that bound to detect a hidden retry.
            await new Promise(resolve => setTimeout(resolve, 1700));
            check(errors.length === 1 && events.length === 0, 'WATCH_ONE_ERROR_CALLBACK');
        } else expectRows(terminal, 2);
        unsubscribe();
        await control('settle');
        const beforeReuse = callbacks;
        await new Promise(resolve => setTimeout(resolve, 120));
        check(callbacks === beforeReuse && events.length === 0, 'WATCH_UNSUBSCRIBE_STOPS_CALLBACKS');

        await control('reuse');
        unsubscribe = listen();
        expectRows(await next(), 3);
        unsubscribe();
        await control('settle');
        const stopped = callbacks;
        await new Promise(resolve => setTimeout(resolve, 120));
        check(callbacks === stopped && events.length === 0, 'WATCH_REUSE_UNSUBSCRIBE_STOPS_CALLBACKS');
        return { scenario, patched, snapshots, errors, callbacks, unsubscribeVerified: true, reuseVerified: true,
            originalErrorPreserved: scenario === 'permission' ? patched : null,
            rawSdkPermissionReconnectObserved: scenario === 'permission' ? !patched : null };
    } finally { unsubscribe?.(); await firestore.terminate(); }
}
