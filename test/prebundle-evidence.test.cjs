'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { reportFiles, validatePrebundleEvidence } = require('../scripts/prebundle-evidence.cjs');
const keys = ['googlePrebundleSdks', 'sveltekitPrebundle', 'honoPrebundle'];
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), value);
    return digest(value);
  };
  const identity = () => ({ runtime: { ownership: 'prebundle', physicalInstallations: 1 },
    transformCoverage: { passed: true, required: 2, applied: 2 } });
  const tarballHash = digest('tested tarball');
  const common = () => ({ status: 'passed', stage: 'complete', liveGoogle: false, deployment: false,
    cloudflareAutomaticConversion: false, sourceAliases: false, controlledGrpcWebPeer: true,
    tarball: { sha256: tarballHash } });
  const sdk = { ...common(), installedAdapterTarball: true, runtimeDisposed: true, restFallback: false,
    adapterTarballSha256: tarballHash, profiles: [], cases: [], rpcCount: 48, generatedArtifacts: {},
    evidence: { 'fixtures/prebundle-sdk/wrapper.mjs': put('fixtures/prebundle-sdk/wrapper.mjs', 'export const value = 1;\n') } };
  for (const id of ['google-static-v1', 'google-modern-v1']) {
    const directory = `verification/google-prebundle-sdks/${id}`;
    const profile = { id, profileSha256: digest(id), ...identity() };
    const manifest = { profile: id, profileSha256: profile.profileSha256, ...identity(), artifacts: {} };
    for (const name of ['index.cjs', 'index.mjs', 'index.d.ts', 'index.d.mts', 'index.d.cts', 'server-only.cjs', 'package.json']) {
      const file = `${directory}/prebundle/${name}`;
      const sha256 = put(file, `fixture artifact: ${id}/${name}\n`);
      sdk.generatedArtifacts[file] = sha256;
      manifest.artifacts[name] = { sha256 };
    }
    const manifestFile = `${directory}/prebundle/manifest.json`;
    sdk.generatedArtifacts[manifestFile] = put(manifestFile, JSON.stringify(manifest));
    const worker = `${directory}/worker.mjs`, metafile = `${directory}/consumer-metafile.json`;
    profile.workerSha256 = sdk.generatedArtifacts[worker] = put(worker, 'export default {};\n');
    sdk.generatedArtifacts[metafile] = put(metafile, '{}\n');
    sdk.profiles.push(profile);
    for (const mode of ['grpc-web', 'cloudflare']) {
      for (const [scenario, rpcCount] of [['firestore-values', 3], ['firestore-stream-error', 2], ['secret-cancel', 2],
        ['secret-access', 1], ['secret-list', 2], ['secret-denied', 1], ['secret-unavailable', 1]]) {
        sdk.cases.push({ profile: id, mode, scenario, rpcCount, status: 'passed' });
      }
    }
  }
  const report = { packaging: { sha256: tarballHash }, googlePrebundleSdks: sdk,
    sveltekitPrebundle: { ...common(), cleanupVerified: true, sameArtifactForDevAndProduction: true,
      prebundle: identity(), cases: [['vite-dev', 'dev'], ['workerd', 'cold'], ['workerd', 'denied'], ['workerd', 'warm']]
        .map(([runtime, invocation]) => ({ runtime, invocation, status: 'passed' })) },
    honoPrebundle: { ...common(), runtimeDisposed: true, backendIdleBeforeDispose: true, prebundle: identity(),
      cases: ['cold', 'denied', 'cancel', 'following'].map(id => ({ id, status: 'passed' })) },
    commands: reportFiles.map(file => ({ id: path.basename(file, '.json'), status: 'passed', exitCode: 0 })) };
  const save = () => keys.forEach((key, i) => put(reportFiles[i], JSON.stringify(report[key])));
  save();
  return { root, report, save, put };
}

test('EVIDENCE validates installed SDK and framework reports against their aggregate and commands', t => {
  const f = fixture(t);
  validatePrebundleEvidence(f.root, f.report);
  for (const key of keys) {
    const original = structuredClone(f.report[key]);
    f.report[key].status = 'failed';
    assert.throws(() => validatePrebundleEvidence(f.root, f.report), /aggregate report drift/);
    f.save();
    assert.throws(() => validatePrebundleEvidence(f.root, f.report), /incomplete report/);
    f.report[key] = original; f.save();
  }
  for (const command of f.report.commands) {
    command.exitCode = 1;
    assert.throws(() => validatePrebundleEvidence(f.root, f.report), /required command did not pass/);
    command.exitCode = 0;
  }
});

test('EVIDENCE rejects incomplete prebundle coverage, scope claims and runtime identity', t => {
  for (const change of [
    r => r.googlePrebundleSdks.cases.pop(),
    r => r.googlePrebundleSdks.cases[1] = r.googlePrebundleSdks.cases[0],
    r => r.googlePrebundleSdks.profiles.pop(),
    r => r.googlePrebundleSdks.profiles[0].runtime.physicalInstallations = 2,
    r => r.googlePrebundleSdks.adapterTarballSha256 = digest('another tarball'),
    r => r.googlePrebundleSdks.liveGoogle = true,
    r => r.googlePrebundleSdks.evidence = {},
    r => r.sveltekitPrebundle.cases.pop(),
    r => r.sveltekitPrebundle.cleanupVerified = false,
    r => r.honoPrebundle.runtimeDisposed = false,
    r => r.honoPrebundle.cases[0].status = 'failed',
  ]) {
    const f = fixture(t); change(f.report); f.save();
    assert.throws(() => validatePrebundleEvidence(f.root, f.report), /WGA_EVIDENCE_INVALID/);
  }
});

test('EVIDENCE rehashes every generated prebundle artifact and execution input', t => {
  const f = fixture(t), sdk = f.report.googlePrebundleSdks;
  for (const file of Object.keys({ ...sdk.generatedArtifacts, ...sdk.evidence })) {
    const original = fs.readFileSync(path.join(f.root, file));
    // Appended whitespace keeps JSON valid and still invalidates its receipt.
    fs.appendFileSync(path.join(f.root, file), ' ');
    assert.throws(() => validatePrebundleEvidence(f.root, f.report), /artifact drift/);
    fs.writeFileSync(path.join(f.root, file), original);
    validatePrebundleEvidence(f.root, f.report);
  }
  const file = Object.keys(sdk.generatedArtifacts)[0], sha256 = sdk.generatedArtifacts[file];
  delete sdk.generatedArtifacts[file]; f.save();
  assert.throws(() => validatePrebundleEvidence(f.root, f.report), /artifact manifest drift/);
  sdk.generatedArtifacts[file] = sha256;
  sdk.generatedArtifacts['../outside'] = sha256; f.save();
  assert.throws(() => validatePrebundleEvidence(f.root, f.report), /unexpected generated artifacts/);
});

test('CI receipts retain all hashed SDK prebundle outputs and framework reports', t => {
  const f = fixture(t), archive = path.join(f.root, 'receipts.tar.gz');
  f.put('verification/google-prebundle-sdks/private.txt', 'excluded');
  fs.mkdirSync(path.join(f.root, 'empty-logs'));
  execFileSync('python3', [path.resolve(__dirname, '../scripts/collect-ci-receipts.py'), '--root', f.root,
    '--output', archive, '--log-dir', path.join(f.root, 'empty-logs')], { timeout: 10000 });
  const actual = JSON.parse(execFileSync('python3', ['-c',
    'import hashlib,json,sys,tarfile\nwith tarfile.open(sys.argv[1]) as t:\n'
    + '    print(json.dumps({m.name:hashlib.sha256(t.extractfile(m).read()).hexdigest() for m in t.getmembers()}))\n', archive],
  { encoding: 'utf8', timeout: 10000 }));
  const expected = { ...f.report.googlePrebundleSdks.generatedArtifacts,
    ...Object.fromEntries(reportFiles.map(file => [file, digest(fs.readFileSync(path.join(f.root, file)))])) };
  assert.deepEqual(actual, expected);
});
