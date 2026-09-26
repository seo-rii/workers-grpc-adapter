'use strict';
// Local build only. Wrangler invokes this from fixtures/google; no credentials are read.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const googleRoot = path.join(root, 'fixtures/google');
const googleRequire = createRequire(path.join(googleRoot, 'package.json'));
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const digest = value => createHash('sha256').update(value).digest('hex');

async function buildGoogleWorker({ entry = path.join(googleRoot, 'worker.mjs'), outdir = path.join(root, '.wga-build/google-live') } = {}) {
  entry = path.resolve(entry);
  outdir = path.resolve(outdir);
  const artifacts = ['sdk.cjs', 'worker.mjs', 'build-manifest.json'];
  if ([...artifacts, 'preset/static-protobuf.cjs'].some(file => entry === path.join(outdir, file))) {
    throw new Error('The build entry must not be overwritten by a generated artifact');
  }
  fs.mkdirSync(outdir, { recursive: true });
  // Remove only this builder's outputs; a caller may use an existing build directory.
  for (const file of artifacts) fs.rmSync(path.join(outdir, file), { force: true });
  try {
    const { createGoogleWorkerBuild } = googleRequire('@grpc/grpc-js/build');
    const esbuild = workerRequire('esbuild');
    const typescript = require('typescript');
    const preset = createGoogleWorkerBuild({ projectRoot: googleRoot, outdir: path.join(outdir, 'preset'), typescript });
    const result = await esbuild.build({
      absWorkingDir: root,
      entryPoints: [entry],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      outfile: path.join(outdir, 'sdk.cjs'),
      plugins: [preset.plugin],
      metafile: true,
    });
    // Wrangler supplies its Node compatibility transforms after the pinned SDK preset.
    fs.writeFileSync(path.join(outdir, 'worker.mjs'), 'import bundle from "./sdk.cjs";\nexport default bundle.default;\n');
    const inputs = Object.keys(result.metafile.inputs).sort();
    const sourceHashes = Object.fromEntries(inputs
      .filter(file => file.startsWith('fixtures/google/') && !file.includes('/node_modules/'))
      .map(file => [file, digest(fs.readFileSync(path.join(root, file)))]));
    const manifest = {
      ...preset.manifest(),
      entry: path.relative(root, entry).split(path.sep).join('/'),
      entrySha256: digest(fs.readFileSync(entry)),
      sourceHashes,
      inputs,
      tools: { esbuild: esbuild.version, typescript: typescript.version },
      outputs: Object.fromEntries(['sdk.cjs', 'worker.mjs'].map(file => [file, digest(fs.readFileSync(path.join(outdir, file)))])),
    };
    fs.writeFileSync(path.join(outdir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { main: path.join(outdir, 'worker.mjs'), manifestFile: path.join(outdir, 'build-manifest.json'), manifest };
  } catch (error) {
    // A failed build must not leave an old entry point available for a later deployment.
    for (const file of artifacts) fs.rmSync(path.join(outdir, file), { force: true });
    throw error;
  }
}

module.exports = { buildGoogleWorker };
if (require.main === module) {
  buildGoogleWorker().then(({ main, manifest }) => {
    console.log(JSON.stringify({ status: 'built', entry: manifest.entry, main: path.relative(root, main), profile: manifest.profile }));
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
