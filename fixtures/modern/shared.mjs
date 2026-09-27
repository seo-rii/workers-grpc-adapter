import { Datastore } from '@google-cloud/datastore';
import { Firestore } from '@google-cloud/firestore';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { createHash } from 'node:crypto';

function check(value, diagnostic) {
  if (!value) { const error = new Error(); error.fixtureDiagnostic = diagnostic; throw error; }
}
// The runner copies these exact bytes beside each locked dependency graph.
// Only controlled loopback services and synthetic data are used.
export async function runModernSDK({ sdk, options, runId }) {
  if (sdk === 'datastore') {
    const client = new Datastore({ ...options, namespace: `modern-${runId}` });
    const key = client.key(['ModernFixture', runId]);
    try {
      let encoded;
      try {
        encoded = await new Promise((resolve, reject) => client.keyToLegacyUrlSafe(key,
          (error, value) => error ? reject(error) : resolve(value)));
        const decoded = client.keyFromLegacyUrlsafe(encoded);
        check(decoded.name === key.name && decoded.kind === key.kind, 'DATASTORE_KEY_CODEC');
      } catch (error) { error.fixtureDiagnostic ||= 'DATASTORE_KEY_CODEC_RUNTIME'; throw error; }
      await client.save({ key, data: { marker: runId, count: 7, text: '한글' } });
      const [entity] = await client.get(key);
      check(entity?.marker === runId && entity.count === 7 && entity.text === '한글', 'DATASTORE_ENTITY');
      const [rows] = await client.runQuery(client.createQuery('ModernFixture').limit(2));
      check(rows.length === 1 && rows[0].marker === runId, 'DATASTORE_QUERY');
      return [`legacy-key-codec:${createHash('sha256').update(encoded).digest('hex')}`, 'save', 'get', 'query', 'delete'];
    } finally {
      try { await client.delete(key); }
      finally { await Promise.all([...client.clients_.values()].map(value => value.close())); }
    }
  }
  if (sdk === 'firestore') {
    const client = new Firestore({ ...options, preferRest: false });
    const ref = client.collection(`modern_${runId}`).doc('fixture');
    try {
      await ref.set({ marker: runId, count: 7, text: '한글' });
      const value = await ref.get();
      check(value.exists && value.data().marker === runId && value.data().text === '한글', 'FIRESTORE_DOCUMENT');
      const rows = await client.collection(`modern_${runId}`).limit(2).get();
      check(rows.size === 1 && rows.docs[0].id === 'fixture', 'FIRESTORE_QUERY');
      return ['set', 'get', 'query', 'delete'];
    } finally {
      try { await ref.delete(); }
      finally { await client.terminate(); }
    }
  }
  check(sdk === 'secret-manager', 'SDK_NAME');
  const client = new SecretManagerServiceClient({ ...options, fallback: false });
  try {
    const name = 'projects/wga-local-test/secrets/metadata';
    const [secret] = await client.getSecret({ name }, { retry: null, timeout: 5000 });
    check(secret.name === name && !!secret.replication.automatic, 'SECRET_METADATA');
    for (const [suffix, code] of [['missing', 5], ['denied', 7]]) {
      let error;
      try { await client.getSecret({ name: `projects/wga-local-test/secrets/${suffix}` }, { retry: null, timeout: 5000 }); }
      catch (failure) { error = failure; }
      check(error?.code === code && error.details === `controlled ${suffix}`, 'SECRET_STATUS');
    }
    return ['getSecret', 'missing-status', 'denied-status'];
  } finally { await client.close(); }
}
