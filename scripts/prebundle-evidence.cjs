'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const reports = [
  ['googlePrebundleSdks', 'google-prebundle-sdks'],
  ['sveltekitPrebundle', 'sveltekit-prebundle'],
  ['honoPrebundle', 'hono-prebundle'],
];
const reportFiles = reports.map(([, id]) => `verification/${id}.json`);
function need(condition, message) {
  if (!condition) throw new Error(`WGA_EVIDENCE_INVALID: ${message}`);
}
function location(root, file) {
  need(typeof file === 'string' && file.length > 0 && !path.isAbsolute(file)
    && !file.split(/[\\/]/).includes('..'), `invalid prebundle evidence path: ${file}`);
  return path.join(root, file);
}
function read(root, file) { return JSON.parse(fs.readFileSync(location(root, file), 'utf8')); }
function hash(root, file) { return createHash('sha256').update(fs.readFileSync(location(root, file))).digest('hex'); }
function ownedRuntime(manifest) {
  return manifest?.runtime?.ownership === 'prebundle' && manifest.runtime.physicalInstallations === 1
    && manifest.transformCoverage?.passed === true && manifest.transformCoverage.required > 0
    && manifest.transformCoverage.required === manifest.transformCoverage.applied;
}
function validatePrebundleEvidence(root, aggregate) {
  for (const [key, id] of reports) {
    const result = aggregate[key], file = `verification/${id}.json`;
    need(result && isDeepStrictEqual(result, read(root, file)), `${file}: aggregate report drift`);
    need(result.status === 'passed' && result.stage === 'complete', `${id}: incomplete report`);
    need(aggregate.commands?.some(command => command.id === id && command.status === 'passed' && command.exitCode === 0),
      `${id}: required command did not pass`);
    need(result.liveGoogle === false && result.deployment === false && result.cloudflareAutomaticConversion === false
      && result.sourceAliases === false && result.controlledGrpcWebPeer === true, `${id}: local evidence scope drift`);
    need(Array.isArray(result.cases) && result.cases.length > 0 && result.cases.every(item => item.status === 'passed'),
      `${id}: missing or failed cases`);
    need((result.adapterTarballSha256 || result.tarball?.sha256) === aggregate.packaging?.sha256,
      `${id}: tested adapter tarball drift`);
  }
  const sdk = aggregate.googlePrebundleSdks;
  need(sdk.runtimeDisposed === true && sdk.installedAdapterTarball === true && sdk.restFallback === false,
    'google-prebundle-sdks: installed runtime verification is incomplete');
  need(isDeepStrictEqual(sdk.profiles?.map(profile => profile.id).sort(), ['google-modern-v1', 'google-static-v1']),
    'google-prebundle-sdks: profile matrix drift');
  const scenarios = ['firestore-values', 'firestore-stream-error', 'secret-cancel', 'secret-access',
    'secret-list', 'secret-denied', 'secret-unavailable'];
  const expectedCases = sdk.profiles.flatMap(profile => ['grpc-web', 'cloudflare']
    .flatMap(mode => scenarios.map(scenario => `${profile.id}/${mode}/${scenario}`))).sort();
  need(isDeepStrictEqual(sdk.cases.map(item => `${item.profile}/${item.mode}/${item.scenario}`).sort(), expectedCases)
    && sdk.rpcCount === 48 && sdk.cases.reduce((sum, item) => sum + item.rpcCount, 0) === sdk.rpcCount,
    'google-prebundle-sdks: executed case matrix drift');
  const expectedArtifacts = [];
  for (const profile of sdk.profiles) {
    const directory = `verification/google-prebundle-sdks/${profile.id}`;
    const manifestFile = `${directory}/prebundle/manifest.json`, manifest = read(root, manifestFile);
    need(manifest.profile === profile.id && manifest.profileSha256 === profile.profileSha256
      && ownedRuntime(profile) && ownedRuntime(manifest), `${profile.id}: prebundle profile/runtime drift`);
    need(manifest.artifacts && Object.keys(manifest.artifacts).length > 0, `${profile.id}: missing artifact manifest`);
    expectedArtifacts.push(manifestFile, `${directory}/consumer-metafile.json`, `${directory}/worker.mjs`);
    for (const [name, artifact] of Object.entries(manifest.artifacts)) {
      const file = `${directory}/prebundle/${name}`;
      need(sdk.generatedArtifacts?.[file] === artifact.sha256, `${file}: artifact manifest drift`);
      expectedArtifacts.push(file);
    }
    need(sdk.generatedArtifacts?.[`${directory}/worker.mjs`] === profile.workerSha256, `${profile.id}: executed Worker drift`);
  }
  need(isDeepStrictEqual(Object.keys(sdk.generatedArtifacts || {}).sort(), expectedArtifacts.sort()),
    'google-prebundle-sdks: missing or unexpected generated artifacts');
  need(sdk.evidence && Object.keys(sdk.evidence).length > 0, 'google-prebundle-sdks: missing execution inputs');
  for (const [file, expected] of Object.entries({ ...sdk.evidence, ...sdk.generatedArtifacts })) {
    need(/^[a-f0-9]{64}$/.test(expected) && hash(root, file) === expected, `${file}: prebundle execution input or artifact drift`);
  }
  const sveltekit = aggregate.sveltekitPrebundle, hono = aggregate.honoPrebundle;
  need(isDeepStrictEqual(sveltekit.cases.map(item => `${item.runtime}/${item.invocation}`).sort(),
    ['vite-dev/dev', 'workerd/cold', 'workerd/denied', 'workerd/warm'])
    && sveltekit.cleanupVerified === true && sveltekit.sameArtifactForDevAndProduction === true && ownedRuntime(sveltekit.prebundle),
  'sveltekit-prebundle: installed consumer verification is incomplete');
  need(isDeepStrictEqual(hono.cases.map(item => item.id).sort(), ['cancel', 'cold', 'denied', 'following'])
    && hono.runtimeDisposed === true && hono.backendIdleBeforeDispose === true && ownedRuntime(hono.prebundle),
  'hono-prebundle: installed consumer verification is incomplete');
}
module.exports = { reportFiles, validatePrebundleEvidence };
