import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import typescript from 'typescript';
import { buildGoogleWorkerPrebundle } from '@grpc/grpc-js/build';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
await buildGoogleWorkerPrebundle({
  projectRoot,
  outdir: `${projectRoot}/generated/google-workers`,
  entryPoint: `${projectRoot}/build/google-workers.mjs`,
  declarationFile: `${projectRoot}/build/google-workers.d.ts`,
  exports: ['Datastore', 'OAuth2Client', 'createWorkersGrpcTransport', 'cancellableCall'],
  packageName: '@wga-hono-fixture/google-workers',
  profile: 'google-static-v1',
  esbuild,
  typescript,
});
