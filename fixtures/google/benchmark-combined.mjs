import { benchmarkBootstrap } from './benchmark-bootstrap.mjs';
export default benchmarkBootstrap(['datastore', 'firestore', 'secret-manager'], async () => {
  const [{ Datastore }, { Firestore }, { SecretManagerServiceClient }, { benchmarkWorker }] = await Promise.all([
    import('@google-cloud/datastore'), import('@google-cloud/firestore'),
    import('@google-cloud/secret-manager'), import('./benchmark-runtime.mjs'),
  ]);
  return benchmarkWorker({ Datastore, Firestore, SecretManagerServiceClient });
});
