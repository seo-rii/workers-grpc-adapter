import { benchmarkBootstrap } from './benchmark-bootstrap.mjs';
export default benchmarkBootstrap(['datastore'], async () => {
  const [{ Datastore }, { benchmarkWorker }] = await Promise.all([
    import('@google-cloud/datastore'), import('./benchmark-runtime.mjs'),
  ]);
  return benchmarkWorker({ Datastore });
});
