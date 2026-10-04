import { benchmarkBootstrap } from './benchmark-bootstrap.mjs';
export default benchmarkBootstrap(['firestore'], async () => {
  const [{ Firestore }, { benchmarkWorker }] = await Promise.all([
    import('@google-cloud/firestore'), import('./benchmark-runtime.mjs'),
  ]);
  return benchmarkWorker({ Firestore });
});
