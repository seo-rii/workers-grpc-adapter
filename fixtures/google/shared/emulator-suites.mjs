import { datastoreCrud, datastoreTransaction } from './datastore.mjs';
import { firestoreCrud, firestoreTransaction } from './firestore.mjs';
import { emulatorDatastoreSuites } from './emulator-datastore.mjs';
import { emulatorFirestoreSuites } from './emulator-firestore.mjs';
import { emulatorDatastoreStreamSuite } from './emulator-datastore-streams.mjs';

// Only official-emulator scenarios; controlled fake-server faults stay separate.
export const emulatorSuites = [
    { sdk: '@google-cloud/datastore', suite: 'datastore-crud', run: datastoreCrud },
    { sdk: '@google-cloud/datastore', suite: 'datastore-transaction', run: datastoreTransaction },
    { sdk: '@google-cloud/firestore', suite: 'firestore-crud', run: firestoreCrud },
    { sdk: '@google-cloud/firestore', suite: 'firestore-transaction', run: firestoreTransaction },
    ...emulatorDatastoreSuites,
    emulatorDatastoreStreamSuite,
    ...emulatorFirestoreSuites,
];
