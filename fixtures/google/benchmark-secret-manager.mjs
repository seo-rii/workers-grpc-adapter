import { benchmarkBootstrap } from './benchmark-bootstrap.mjs';
export default benchmarkBootstrap(['secret-manager'], async () => {
  const [{ SecretManagerServiceClient }, { benchmarkWorker }] = await Promise.all([
    import('@google-cloud/secret-manager'), import('./benchmark-runtime.mjs'),
  ]);
  return benchmarkWorker({ SecretManagerServiceClient });
});
