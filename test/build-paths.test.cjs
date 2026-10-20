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

test('BUILD an absent symbolic role cannot stand in for an actual onLoad or metafile input', t => {
  const f = fixture(t), preset = f.prepare();
  const symbolic = path.join(f.project, f.sourcePath);
  assert.equal(fs.existsSync(symbolic), false);
  let load; preset.plugin.setup({ onLoad(_options, callback) { load = callback; } });
  assert.throws(() => load({ path: symbolic }), { code: 'WGA_SOURCE_IDENTITY' });
  assert.throws(() => preset.verifyBuild({ inputs: { [symbolic]: {} }, outputs: {} }), { code: 'WGA_SOURCE_IDENTITY' });
  assert.equal(f.api.inspectGoogleWorkerProfile({ projectRoot: f.project, typescript: ts }).passed, true,
    'doctor resolves the symbolic role to its real source before testing AST guards');
});

for (const bypass of [false, true]) {
  test(`BUILD logical role collision rejects a different installation at ${bypass ? 'metafile' : 'onLoad'} verification`, async t => {
    const f = fixture(t, 'hoisted');
    // The declared role names the application root slot, while its importer
    // selects a private SDK dependency, as the shipped Gaxios role does.
    const privateCodec = path.join(f.sdk, 'node_modules/codec');
    fs.cpSync(f.codec, privateCodec, { recursive: true });
    f.profile.packages[1].path = 'node_modules/codec';
    f.profile.files[0].path = 'node_modules/codec/index.js';
    f.write(path.join(f.project, 'build/profiles/google-static-v1.json'), JSON.stringify(f.profile));
    f.write(path.join(f.project, 'entry.cjs'), 'module.exports = [require("sdk"), require("codec")];');
    const preset = f.prepare();
    const override = { name: 'unverified-root', setup(build) {
      build.onLoad({ filter: /codec[/\\]index\.js$/ }, args => args.path === path.join(f.codec, 'index.js')
        ? { contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' } : undefined);
    } };
    await assert.rejects(f.bundle(preset, bypass ? [override] : []), /WGA_SOURCE_IDENTITY/);
    assert.equal(preset.manifest().transformCoverage.passed, false);
    // The exact logical slot is valid when it reaches the inspected source.
    fs.rmSync(f.codec, { recursive: true });
    f.link(privateCodec, f.codec);
    await f.bundle(preset);
    assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
  });
}

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

test('BUILD a custom namespace cannot conceal an untransformed physical target', async t => {
  const f = fixture(t), preset = f.prepare();
  const bypass = { name: 'namespaced-bypass', setup(build) {
    build.onResolve({ filter: /^codec$/ }, () => ({ path: path.join(f.codec, 'index.js'), namespace: 'bypass' }));
    build.onLoad({ filter: /.*/, namespace: 'bypass' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' }));
  } };
  await assert.rejects(f.bundle(preset, [bypass]), /WGA_TRANSFORM_COVERAGE/);
});

test('BUILD one transformed namespace cannot cover an untransformed module of the same source', async t => {
  const f = fixture(t, 'hoisted'), preset = f.prepare();
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports = [require("sdk"), require("codec-bypass")];');
  const bypass = { name: 'mixed-namespace', setup(build) {
    build.onResolve({ filter: /^codec-bypass$/ }, () => ({ path: path.join(f.codec, 'index.js'), namespace: 'bypass' }));
    build.onLoad({ filter: /.*/, namespace: 'bypass' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' }));
  } };
  await assert.rejects(f.bundle(preset, [bypass]), /WGA_TRANSFORM_COVERAGE/);
  assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 0, unused: 0, passed: false });
});

test('BUILD one transformed path cannot cover an untransformed preserved symlink alias', async t => {
  const f = fixture(t, 'hoisted'), preset = f.prepare();
  f.link(f.codec, path.join(f.project, 'node_modules/codec-alias'));
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports = [require("sdk"), require("codec-alias")];');
  const bypass = { name: 'mixed-file-alias', setup(build) {
    build.onLoad({ filter: /codec-alias[/\\]index\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' }));
  } };
  await assert.rejects(f.bundle(preset, [bypass], { preserveSymlinks: true }), /WGA_TRANSFORM_COVERAGE/);
  assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 0, unused: 0, passed: false });
});

for (const suffix of ['?raw', '#fragment', '?raw#fragment']) {
  test(`BUILD an untransformed namespaced input with suffix ${suffix} remains required`, async t => {
    const f = fixture(t, 'hoisted'), preset = f.prepare();
    f.write(path.join(f.project, 'entry.cjs'), 'module.exports = require("codec-suffixed");');
    const bypass = { name: 'suffixed-namespace', setup(build) {
      build.onResolve({ filter: /^codec-suffixed$/ }, () => ({ path: path.join(f.codec, 'index.js'), namespace: 'bypass', suffix }));
      build.onLoad({ filter: /.*/, namespace: 'bypass' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' }));
    } };
    await assert.rejects(f.bundle(preset, [bypass]), /WGA_TRANSFORM_COVERAGE/);
    assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 0, unused: 0, passed: false });
  });
}

test('BUILD one transformed suffix cannot cover another suffix in the same namespace', async t => {
  const f = fixture(t, 'hoisted'), preset = f.prepare();
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports = [require("codec-good"), require("codec-bad")];');
  const mixed = { name: 'mixed-suffixes', setup(build) {
    build.onResolve({ filter: /^codec-(good|bad)$/ }, args => ({ path: path.join(f.codec, 'index.js'), namespace: 'virtual',
      suffix: args.path === 'codec-good' ? '?good' : '?bad' }));
    build.onLoad({ filter: /.*/, namespace: 'virtual' }, args => args.suffix === '?bad'
      ? { contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' } : undefined);
  } };
  await assert.rejects(f.bundle(preset, [mixed]), /WGA_TRANSFORM_COVERAGE/);
  assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 0, unused: 0, passed: false });
});

test('BUILD namespace separators cannot hide a suffixed transform target', async t => {
  const f = fixture(t, 'hoisted'), preset = f.prepare();
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports = require("codec-nested-namespace");');
  const bypass = { name: 'namespace-separators', setup(build) {
    build.onResolve({ filter: /^codec-nested-namespace$/ }, () => ({ path: path.join(f.codec, 'index.js'), namespace: 'loader:original', suffix: '?raw' }));
    build.onLoad({ filter: /.*/, namespace: 'loader:original' }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' }));
  } };
  await assert.rejects(f.bundle(preset, [bypass]), /WGA_TRANSFORM_COVERAGE/);
  assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 0, unused: 0, passed: false });
});

test('BUILD all transformed aliases and namespaces share one aggregate profile target', async t => {
  const f = fixture(t, 'hoisted'), preset = f.prepare();
  f.link(f.codec, path.join(f.project, 'node_modules/codec-alias'));
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports = [require("sdk"), require("codec-alias"), require("codec-suffixed")];');
  const namespaced = { name: 'transformed-namespace', setup(build) {
    build.onResolve({ filter: /^codec-suffixed$/ }, () => ({ path: path.join(f.codec, 'index.js'), namespace: 'verified', suffix: '?checked#v1' }));
  } };
  const result = await f.bundle(preset, [namespaced], { preserveSymlinks: true });
  assert.ok(Object.keys(result.metafile.inputs).some(file => file.includes('codec-alias/index.js')));
  assert.ok(Object.keys(result.metafile.inputs).some(file => file.startsWith('verified:') && file.endsWith('?checked#v1')));
  assert.doesNotMatch(result.outputFiles[0].text, /Proto\.Root\.fromJSON\(/);
  assert.equal(preset.manifest().transformed.length, 1);
  assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
});

test('BUILD literal question marks and hashes in source directories are not module suffixes', async t => {
  const f = fixture(t, 'hoisted');
  const physical = path.join(f.project, 'store?literal#directory/codec');
  fs.mkdirSync(path.dirname(physical), { recursive: true });
  fs.renameSync(f.codec, physical); f.link(physical, f.codec);
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports = [require("sdk"), require("codec-suffixed")];');
  const namespaced = { name: 'literal-path-and-suffix', setup(build) {
    build.onResolve({ filter: /^codec-suffixed$/ }, () => ({ path: path.join(physical, 'index.js'), namespace: 'verified', suffix: '?checked#v1' }));
  } };
  const preset = f.prepare(), result = await f.bundle(preset, [namespaced]);
  assert.doesNotMatch(result.outputFiles[0].text, /Proto\.Root\.fromJSON\(/);
  assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
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
    await context.rebuild();
    assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
    f.write(path.join(f.project, 'entry.cjs'), 'module.exports = 1;');
    await context.rebuild();
    assert.deepEqual(preset.manifest().transformed, []);
    assert.deepEqual(preset.manifest().transformCoverage, { required: 0, applied: 0, unused: 1, passed: true });
  } finally { await context.dispose(); }
});

test('BUILD unchanged rebuilds cannot reuse a previous module instance receipt after bypass', async t => {
  const f = fixture(t, 'hoisted'), preset = f.prepare(); let bypass = false;
  f.write(path.join(f.project, 'entry.cjs'), 'module.exports = [require("sdk"), require("codec-rebuild")];');
  const namespaced = { name: 'rebuild-namespace', setup(build) {
    build.onResolve({ filter: /^codec-rebuild$/ }, () => ({ path: path.join(f.codec, 'index.js'), namespace: 'rebuild' }));
    build.onLoad({ filter: /.*/, namespace: 'rebuild' }, args => bypass
      ? { contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' } : undefined);
  } };
  const context = await esbuild.context({ absWorkingDir: f.project, entryPoints: ['entry.cjs'], bundle: true,
    platform: 'node', write: false, logLevel: 'silent', plugins: [namespaced, preset.plugin] });
  try {
    await context.rebuild();
    await context.rebuild();
    assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
    bypass = true;
    await assert.rejects(context.rebuild(), /WGA_TRANSFORM_COVERAGE/);
    assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 0, unused: 0, passed: false });
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

test('BUILD shipped Gaxios role never substitutes SDK-owned bytes for an application installation', async t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-gaxios-identity-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const original = fs.realpathSync(path.join(root, 'fixtures/google/node_modules'));
  const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  const link = (target, file) => fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir');
  write(path.join(project, 'package.json'), '{"private":true}');
  fs.mkdirSync(path.join(project, 'node_modules'));
  for (const entry of fs.readdirSync(original)) {
    if (entry === 'gaxios' || entry.startsWith('.')) continue;
    link(path.join(original, entry), path.join(project, 'node_modules', entry));
  }
  const shadow = path.join(project, 'node_modules/gaxios'), verified = path.join(original, 'gaxios');
  write(path.join(shadow, 'package.json'), fs.readFileSync(path.join(verified, 'package.json')));
  write(path.join(shadow, 'build/cjs/src/index.js'), 'module.exports = require("./gaxios.js");');
  write(path.join(shadow, 'build/cjs/src/gaxios.js'), 'exports.sourceIdentity = "application-owned";');
  write(path.join(project, 'entry.cjs'), 'module.exports = require("gaxios");');
  const api = require('../src/build/index.cjs');
  const report = api.inspectGoogleWorkerProfile({ projectRoot: project, typescript: ts });
  assert.equal(report.passed, true, JSON.stringify(report.diagnostics));
  const preset = api.createGoogleWorkerBuild({ projectRoot: project, outdir: path.join(project, 'generated'), typescript: ts });
  const bundle = () => esbuild.build({ absWorkingDir: project, entryPoints: ['entry.cjs'], bundle: true, platform: 'node',
    write: false, logLevel: 'silent', plugins: [preset.plugin] });
  await assert.rejects(bundle(), /WGA_SOURCE_IDENTITY/);
  assert.equal(preset.manifest().transformCoverage.passed, false);
  assert.equal(preset.manifest().transformed.length, 0);
  fs.rmSync(shadow, { recursive: true }); link(verified, shadow);
  await bundle();
  assert.equal(preset.manifest().transformCoverage.passed, true);
  assert.equal(preset.manifest().transformCoverage.required, 1);
  assert.equal(preset.manifest().transformCoverage.applied, 1);
});
