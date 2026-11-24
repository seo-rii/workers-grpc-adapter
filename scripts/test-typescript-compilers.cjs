'use strict';
// Build both pinned SDK profiles through the esbuild preset with TypeScript 5.8
// and TypeScript 6, then require identical outputs apart from the compiler-bound
// cache identity. Uses the installed fixtures; no network or credentials.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { parityCompilers, compareBuilds } = require('./typescript-parity.cjs');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const esbuild = workerRequire('esbuild');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const profiles = [
  { id: 'google-static-v1', fixture: 'google' },
  { id: 'google-modern-v1', fixture: 'modern' },
];
// Import every SDK in the profile so all declared transforms must apply.
const entrySource = [
  "export { Datastore } from '@google-cloud/datastore';",
  "export { Firestore } from '@google-cloud/firestore';",
  "export { SecretManagerServiceClient } from '@google-cloud/secret-manager';",
  "export { OAuth2Client } from 'google-auth-library';",
  "export { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';",
  "export { cancellableCall } from '@grpc/grpc-js/sdk';",
  '',
].join('\n');
const report = { schemaVersion: 1, status: 'running', node: process.version, esbuild: esbuild.version,
  scope: 'esbuild preset output for both pinned SDK profiles; no Worker execution', profiles: [] };

async function build(profile, projectRoot, entry, typescript, temporary) {
  const build = createRequire(path.join(projectRoot, 'package.json'))('@grpc/grpc-js/build');
  // Both compilers use the same output path, so bundle path comments match.
  const outdir = path.join(temporary, profile.id);
  fs.rmSync(outdir, { recursive: true, force: true });
  const preset = build.createGoogleWorkerBuild({ projectRoot, outdir: path.join(outdir, 'preset'), profile: profile.id, typescript });
  await esbuild.build({ absWorkingDir: projectRoot, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node',
    target: 'es2022', outfile: path.join(outdir, 'bundle.cjs'), plugins: [preset.plugin], logLevel: 'silent' });
  const manifest = preset.manifest();
  if (!manifest.transformCoverage.passed || manifest.transformCoverage.applied !== manifest.transformCoverage.required
    || manifest.transformCoverage.required === 0) throw new Error(`WGA_TYPESCRIPT_PARITY: incomplete transforms with ${typescript.version}`);
  const bundle = fs.readFileSync(path.join(outdir, 'bundle.cjs'), 'utf8');
  return { version: typescript.version, manifest, texts: { 'bundle.cjs': bundle }, sha256: hash(bundle),
    transforms: manifest.transformCoverage.applied };
}

async function main() {
  const { current, next } = parityCompilers();
  report.typescript = [current.version, next.version];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-typescript-compilers-'));
  try {
    for (const profile of profiles) {
      const projectRoot = path.join(root, 'fixtures', profile.fixture);
      const entryDirectory = fs.mkdtempSync(path.join(projectRoot, '.wga-compilers-'));
      try {
        const entry = path.join(entryDirectory, 'entry.mjs');
        fs.writeFileSync(entry, entrySource);
        const left = await build(profile, projectRoot, entry, current, temporary);
        const right = await build(profile, projectRoot, entry, next, temporary);
        const parity = compareBuilds(left, right);
        report.profiles.push({ profile: profile.id, ...parity, transforms: left.transforms,
          bundleSha256: { [left.version]: left.sha256, [right.version]: right.sha256 } });
      } finally { fs.rmSync(entryDirectory, { recursive: true, force: true }); }
    }
    report.status = 'passed';
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

main().catch(error => {
  report.status = 'failed'; report.error = String(error?.message || error).slice(0, 2000); process.exitCode = 1;
}).finally(() => {
  fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
  fs.writeFileSync(path.join(root, 'verification/typescript-compilers.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, typescript: report.typescript,
    profiles: report.profiles.map(item => ({ profile: item.profile, transforms: item.transforms })), error: report.error }));
});
