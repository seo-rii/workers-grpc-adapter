// Every SDK import and constructor runs inside fetch, including the cold request.
export default {
  async fetch(request) {
    const stages = [];
    let datastore, firestore, secretManager;
    const close = () => Promise.all([
      ...[...(datastore?.clients_?.values() || [])].map(client => client.close()),
      firestore?.terminate(), secretManager?.close(),
    ]);
    try {
      const { Datastore } = await import('@google-cloud/datastore');
      stages.push('datastore-import');
      const { Firestore } = await import('@google-cloud/firestore');
      stages.push('firestore-import');
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      stages.push('secret-manager-import');
      const { OAuth2Client } = await import('google-auth-library');
      const authClient = new OAuth2Client();
      authClient.setCredentials({ access_token: new URL(request.url).pathname.slice(1), expiry_date: Date.now() + 3600000 });
      datastore = new Datastore({ projectId: 'wga-lazy', authClient, fallback: false });
      firestore = new Firestore({ projectId: 'wga-lazy', authClient, preferRest: false });
      secretManager = new SecretManagerServiceClient({ projectId: 'wga-lazy', authClient, fallback: false });
      const key = datastore.key({ namespace: 'lazy-namespace', path: ['Ancestor', '한글', 'LazyBootstrap', 7] });
      const encodedKey = await new Promise((resolve, reject) => datastore.keyToLegacyUrlSafe(key,
        (error, value) => error ? reject(error) : resolve(value)));
      const decodedKey = datastore.keyFromLegacyUrlsafe(encodedKey);
      const legacyKey = { encoded: encodedKey, decoded: { namespace: decodedKey.namespace, path: decodedKey.path } };
      stages.push('sdk-constructors');
      const [entities, info] = await datastore.runQuery(datastore.createQuery('LazyBootstrap'), {
        explainOptions: { analyze: true }, gaxOptions: { retry: null, timeout: 5000 },
      });
      if (entities.length !== 0) throw new Error('Unexpected Datastore entities');
      stages.push('datastore-run-query');
      const documents = await firestore.getAll(firestore.doc('lazy/missing'));
      if (documents.length !== 1 || documents[0].exists) throw new Error('Unexpected Firestore document');
      stages.push('firestore-batch-get');
      const [secret] = await secretManager.getSecret({ name: 'projects/wga-lazy/secrets/bootstrap' }, { retry: null, timeout: 5000 });
      stages.push('secret-manager-get');
      await close();
      return Response.json({ status: 'passed', stages, legacyKey, explainMetrics: info.explainMetrics, secretName: secret.name });
    } catch (error) {
      await close().catch(() => {});
      return Response.json({ status: 'failed', stages, code: error.code ?? error.name, message: error.message, stack: error.stack }, { status: 500 });
    }
  },
};
