'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const esbuild = createRequire(path.join(root, 'fixtures/worker/package.json'))('esbuild');
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, layout = 'isolated') {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-paths-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const isolated = layout !== 'hoisted';
  const sdk = path.join(project, layout === 'workspace' ? 'packages/sdk' : isolated ? 'node_modules/.pnpm/sdk@1/node_modules/sdk' : 'node_modules/sdk');
  const codec = path.join(project, isolated ? 'node_modules/.pnpm/codec@1/node_modules/codec' : 'node_modules/codec');
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const link = (target, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(path.relative(path.dirname(file), target), file, 'dir'); };
  const sdkJson = JSON.stringify({ name: 'sdk', version: '1.0.0', main: 'index.js', dependencies: { codec: '1.0.0' } });
  const codecJson = JSON.stringify({ name: 'codec', version: '1.0.0', main: 'index.js' });
  write(path.join(project, 'package.json'), JSON.stringify({ private: true, dependencies: { sdk: '1.0.0' } }));
  write(path.join(sdk, 'package.json'), sdkJson); write(path.join(sdk, 'index.js'), 'module.exports = require("codec");');
  write(path.join(codec, 'package.json'), codecJson);
  const source = 'module.exports = Proto.Root.fromJSON({});';
  write(path.join(codec, 'index.js'), source);
  if (isolated) {
    link(sdk, path.join(project, 'node_modules/sdk'));
    link(codec, path.join(layout === 'workspace' ? sdk : path.dirname(sdk), 'node_modules/codec').replace('/node_modules/node_modules/', '/node_modules/'));
  }
  // The manifest's nested role remains valid in both npm and pnpm layouts.
  const slot = 'node_modules/sdk/node_modules/codec';
  const sourcePath = slot + '/index.js';
  const profile = { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, revision: 1,
    packages: [
      { path: 'node_modules/sdk', name: 'sdk', version: '1.0.0', packageJsonSha256: hash(sdkJson) },
      { path: slot, name: 'codec', version: '1.0.0', packageJsonSha256: hash(codecJson), resolveFrom: 'node_modules/sdk' },
    ], files: [{ path: sourcePath, sha256: hash(source), transforms: [{ rule: 'static-root-from-json', expectedMatches: 1 }] }],
    schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] };
  const moduleFile = path.join(project, 'build/index.cjs');
  write(moduleFile, fs.readFileSync(path.join(root, 'src/build/index.cjs')));
  write(path.join(project, 'build/profiles/google-static-v1.json'), JSON.stringify(profile));
  write(path.join(project, 'entry.cjs'), 'module.exports = require("sdk");');
  const api = require(moduleFile);
  const prepare = () => api.createGoogleWorkerBuild({ projectRoot: project, outdir: path.join(project, 'generated'), typescript: ts });
  const bundle = (preset, plugins = [], extra = {}) => esbuild.build({ absWorkingDir: project, entryPoints: ['entry.cjs'], bundle: true,
    platform: 'node', write: false, logLevel: 'silent', plugins: [...plugins, preset.plugin], ...extra });
  return { project, sdk, codec, source, sourcePath, profile, prepare, bundle, api, write, link };
}

for (const layout of ['hoisted', 'isolated', 'workspace']) {
    test(`BUILD actual ${layout} bundle transforms importer-resolved source`, async t => {
      const f = fixture(t, layout), preset = f.prepare();
      const inspected = f.api.inspectGoogleWorkerProfile({ projectRoot: f.project, typescript: ts });
      assert.equal(inspected.passed, true, JSON.stringify(inspected.diagnostics));
      const resolved = inspected.resolvedPaths.find(item => item.path === f.sourcePath);
      assert.equal(resolved.physicalPath, path.join(f.codec, 'index.js'));
      assert.equal(resolved.logicalPath, path.join(f.project, f.sourcePath));
      await f.bundle(preset);
      assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
      assert.equal(preset.manifest().transformed[0].upstreamSha256, hash(f.source));
    });
}

test('BUILD logical and physical onLoad paths reach exactly the same inspected source', t => {
  const f = fixture(t, 'workspace'), preset = f.prepare();
  let load; preset.plugin.setup({ onLoad(_options, callback) { load = callback; } });
  const logical = load({ path: path.join(f.project, f.sourcePath) });
  // The importer-resolved role need not exist as a literal filesystem path.
  const rootLink = load({ path: path.join(f.project, 'node_modules/sdk/node_modules/codec/index.js') });
  const physical = load({ path: path.join(f.codec, 'index.js') });
  assert.ok(logical);
  assert.equal(logical.contents, rootLink.contents);
  assert.equal(logical.contents, physical.contents);
});

test('BUILD an earlier plugin bypass cannot silently bundle an original transform target', async t => {
  const f = fixture(t), preset = f.prepare();
  const bypass = { name: 'bypass', setup(build) { build.onLoad({ filter: /codec[/\\]index\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' })); } };
  await assert.rejects(f.bundle(preset, [bypass]), /WGA_TRANSFORM_COVERAGE/);
  assert.equal(preset.manifest().transformCoverage.passed, false);
});

test('BUILD same-version duplicate source identity fails instead of trusting equal bytes', async t => {
  const f = fixture(t), preset = f.prepare();
  const duplicate = path.join(f.project, 'other/codec');
  fs.cpSync(f.codec, duplicate, { recursive: true });
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports=require("./other/codec");');
  await assert.rejects(f.bundle(preset), /WGA_SOURCE_IDENTITY/);
});

test('BUILD a second SDK version and source/hash drift remain rejected with physical resolution', async t => {
  const f = fixture(t);
  const file = path.join(f.codec, 'package.json');
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, JSON.stringify({ name: 'codec', version: '2.0.0', main: 'index.js' }));
  assert.throws(f.prepare, { code: 'WGA_UNSUPPORTED_DEPENDENCY' });
  fs.writeFileSync(file, original);
  const preset = f.prepare();
  fs.appendFileSync(path.join(f.codec, 'index.js'), '\n// changed after inspection');
  await assert.rejects(f.bundle(preset), /WGA_SCHEMA_MISMATCH/);
});

test('BUILD empty bundles report unused targets and rebuilds cannot reuse stale transform coverage', async t => {
  const f = fixture(t), preset = f.prepare();
  const context = await esbuild.context({ absWorkingDir: f.project, entryPoints: ['entry.cjs'], bundle: true,
    platform: 'node', write: false, logLevel: 'silent', plugins: [preset.plugin] });
  try {
    await context.rebuild();
    assert.equal(preset.manifest().transformCoverage.applied, 1);
    f.write(path.join(f.project, 'entry.cjs'), 'module.exports = 1;');
    await context.rebuild();
    assert.deepEqual(preset.manifest().transformed, []);
    assert.deepEqual(preset.manifest().transformCoverage, { required: 0, applied: 0, unused: 1, passed: true });
  } finally { await context.dispose(); }
});

test('BUILD verification rejects an installation link retargeted after inspection', t => {
  const f = fixture(t), preset = f.prepare();
  const duplicate = path.join(f.project, 'other/sdk'); fs.cpSync(f.sdk, duplicate, { recursive: true });
  fs.unlinkSync(path.join(f.project, 'node_modules/sdk')); f.link(duplicate, path.join(f.project, 'node_modules/sdk'));
  assert.throws(() => preset.verifyBuild({ inputs: {}, outputs: {} }), /WGA_SOURCE_IDENTITY|WGA_UNSUPPORTED_DEPENDENCY/);
});

test('BUILD compiler range stays explicit rather than silently accepting TS 6', t => {
  const f = fixture(t);
  assert.throws(() => f.api.createGoogleWorkerBuild({ projectRoot: f.project, outdir: path.join(f.project, 'out'),
    typescript: { ...ts, version: '6.0.0' } }), /TypeScript >=5.8 <6/);
  assert.equal(fs.existsSync(path.join(f.project, 'out')), false);
});

test('BUILD doctor checks physical AST anchors when the nested logical role does not exist', t => {
  const f = fixture(t);
  assert.equal(fs.existsSync(path.join(f.project, f.sourcePath)), false);
  const changed = f.source + '\nProto.Root.fromJSON({});';
  f.write(path.join(f.codec, 'index.js'), changed);
  f.profile.files[0].sha256 = hash(changed);
  f.write(path.join(f.project, 'build/profiles/google-static-v1.json'), JSON.stringify(f.profile));
  const report = f.api.inspectGoogleWorkerProfile({ projectRoot: f.project, typescript: ts });
  assert.equal(report.passed, false);
  assert.equal(report.transformationsChecked, true);
  assert.equal(report.diagnostics[0].reason, 'anchor-count');
  assert.equal(report.diagnostics[0].actual, 2);
});
