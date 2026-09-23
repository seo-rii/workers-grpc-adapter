import { datastoreCrud, datastoreTransaction } from './datastore.mjs';
import { firestoreCrud, firestoreTransaction } from './firestore.mjs';
import { secretManagerRead } from './secret-manager.mjs';
import { datastoreStreams, firestoreBatchGet, firestoreListenUnsupported } from './local-streams.mjs';
import { secretManagerMissing, secretManagerDenied } from './local-errors.mjs';
import { datastoreAborted, datastoreCommitResponseLost, firestoreAbortedRetry } from './local-transactions.mjs';
// Runtime setup supplies only client options; every operation and assertion is shared.
export const controlledSuites = [
    { sdk: '@google-cloud/datastore', suite: 'datastore-crud', run: datastoreCrud },
    { sdk: '@google-cloud/datastore', suite: 'datastore-transaction', run: datastoreTransaction },
    { sdk: '@google-cloud/firestore', suite: 'firestore-crud', run: firestoreCrud },
    { sdk: '@google-cloud/firestore', suite: 'firestore-transaction', run: firestoreTransaction },
    { sdk: '@google-cloud/secret-manager', suite: 'secret-manager-read', run: secretManagerRead },
    { sdk: '@google-cloud/datastore', suite: 'datastore-streams', run: datastoreStreams },
    { sdk: '@google-cloud/firestore', suite: 'firestore-batch-get', run: firestoreBatchGet },
    { sdk: '@google-cloud/firestore', suite: 'firestore-listen-unsupported', run: firestoreListenUnsupported, workerdOnly: true },
    { sdk: '@google-cloud/secret-manager', suite: 'secret-manager-missing', run: secretManagerMissing },
    { sdk: '@google-cloud/secret-manager', suite: 'secret-manager-denied', run: secretManagerDenied },
    { sdk: '@google-cloud/datastore', suite: 'datastore-aborted', run: datastoreAborted },
    { sdk: '@google-cloud/datastore', suite: 'datastore-commit-response-lost', run: datastoreCommitResponseLost },
    { sdk: '@google-cloud/firestore', suite: 'firestore-aborted-retry', run: firestoreAbortedRetry },
];
