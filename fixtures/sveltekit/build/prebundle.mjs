import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import typescript from 'typescript';
import { buildGoogleWorkerPrebundle } from '@grpc/grpc-js/build';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const outdir = path.join(projectRoot, 'packages/google-workers/generated');
const temporary = fs.mkdtempSync(path.join(projectRoot, '.prebundle-'));
const previous = path.join(temporary, 'previous');
let retainBackup = false;
try {
  const result = await buildGoogleWorkerPrebundle({
    projectRoot,
    outdir: path.join(temporary, 'package'),
    entryPoint: path.join(projectRoot, 'build/google-workers.mjs'),
    exports: ['Datastore', 'OAuth2Client', 'createWorkersGrpcTransport', 'cancellableCall'],
    declarationFile: path.join(projectRoot, 'build/google-workers.d.ts'),
    packageName: '@wga-fixture/google-workers',
    profile: 'google-static-v1',
    esbuild,
    typescript,
  });
  if (fs.existsSync(outdir)) {
    if (!fs.lstatSync(outdir).isDirectory()) throw new Error('Refusing to replace an output path that is not a directory');
    const manifest = JSON.parse(fs.readFileSync(path.join(outdir, 'manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(outdir, 'package.json'), 'utf8'));
    if (manifest.kind !== 'google-worker-prebundle' || pkg.name !== '@wga-fixture/google-workers'
      || fs.readdirSync(outdir).some(file => file !== 'manifest.json' && (
        !Object.hasOwn(manifest.artifacts, file) || !fs.lstatSync(path.join(outdir, file)).isFile()
        || createHash('sha256').update(fs.readFileSync(path.join(outdir, file))).digest('hex') !== manifest.artifacts[file].sha256))) {
      throw new Error('Refusing to replace an output directory containing changed or unrecognized files');
    }
    fs.renameSync(outdir, previous);
  }
  fs.mkdirSync(path.dirname(outdir), { recursive: true });
  try { fs.renameSync(result.outdir, outdir); }
  catch (error) {
    if (fs.existsSync(previous)) {
      try { fs.renameSync(previous, outdir); }
      catch (restoreError) {
        retainBackup = true;
        throw new Error(`Prebundle publication and restoration failed. Previous artifact preserved at ${previous}; current output preserved at ${outdir}.`,
          { cause: new AggregateError([error, restoreError], 'Prebundle publication and restoration errors') });
      }
    }
    throw error;
  }
  console.log(JSON.stringify({ status: 'prebundled', manifest: path.relative(projectRoot, path.join(outdir, 'manifest.json')) }));
} finally {
  if (!retainBackup) fs.rmSync(temporary, { recursive: true, force: true });
}
