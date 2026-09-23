/** Small fixed registry, intentionally not a general-purpose plugin framework. */
export const suites = {
    'datastore-crud': { sdk: '@google-cloud/datastore', project: 'WGA_DATASTORE_PROJECT', writes: true,
        load: async () => (await import('./shared/datastore.mjs')).datastoreCrud },
    'datastore-transaction': { sdk: '@google-cloud/datastore', project: 'WGA_DATASTORE_PROJECT', writes: true,
        load: async () => (await import('./shared/datastore.mjs')).datastoreTransaction },
    'firestore-crud': { sdk: '@google-cloud/firestore', project: 'WGA_FIRESTORE_PROJECT', writes: true,
        load: async () => (await import('./shared/firestore.mjs')).firestoreCrud },
    'firestore-transaction': { sdk: '@google-cloud/firestore', project: 'WGA_FIRESTORE_PROJECT', writes: true,
        load: async () => (await import('./shared/firestore.mjs')).firestoreTransaction },
    'secret-manager-read': { sdk: '@google-cloud/secret-manager', project: 'WGA_SECRET_MANAGER_PROJECT', writes: false,
        load: async () => (await import('./shared/secret-manager.mjs')).secretManagerRead },
};
