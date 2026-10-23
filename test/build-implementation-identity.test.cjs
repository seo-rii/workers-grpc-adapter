'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');
const googleRequire = createRequire(path.resolve(__dirname, '../fixtures/google/package.json'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-implementation-identity-'));
  t.after(() => {
    for (const file of ['index.cjs', 'prebundle.cjs']) delete require.cache[path.join(projectRoot, 'build', file)];
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
  const write = (name, value) => {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value));
    return file;
  };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file)));
  write('package.json', { private: true });
  const manifest = JSON.stringify({ name: 'example-sdk', version: '1.0.0', main: 'index.js' });
  const source = 'exports.directory = __dirname;';
  write('node_modules/example-sdk/package.json', manifest);
  write('node_modules/example-sdk/index.js', source);
  write('entry.cjs', 'module.exports = require("example-sdk").directory;');
  const profile = { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, revision: 1,
    packages: [{ path: 'node_modules/example-sdk', name: 'example-sdk', version: '1.0.0', packageJsonSha256: hash(manifest) }],
    files: [{ path: 'node_modules/example-sdk/index.js', sha256: hash(source), transforms: [{ rule: 'bundle-dirname', expectedMatches: 1 }] }],
    schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] };
  const save = () => write('build/profiles/google-static-v1.json', profile);
  save();
  const moduleFile = path.join(projectRoot, 'build/index.cjs');
  const fresh = file => { delete require.cache[file]; return require(file); };
  const prepare = api => api.createGoogleWorkerBuild({ projectRoot, outdir: path.join(projectRoot, 'generated'), typescript: ts });
  let bundles = 0;
  async function bundle(api, preset = prepare(api)) {
    const built = await esbuild.build({ absWorkingDir: projectRoot, entryPoints: ['entry.cjs'], bundle: true,
      platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins: [preset.plugin] });
    const output = write(`output-${++bundles}.cjs`, built.outputFiles[0].contents);
    return { manifest: preset.manifest(), value: require(output), sha256: hash(built.outputFiles[0].contents) };
  }
  return { projectRoot, moduleFile, write, profile, save, source, fresh, prepare, bundle };
}

test('BUILD retained and fresh transformer generations identify the code that actually transforms modules', async t => {
  const f = fixture(t), original = fs.readFileSync(f.moduleFile, 'utf8'), cached = require(f.moduleFile);
  const baseline = await f.bundle(cached), unchanged = await f.bundle(f.fresh(f.moduleFile));
  assert.equal(baseline.sha256, unchanged.sha256);
  assert.equal(baseline.manifest.cacheKey, unchanged.manifest.cacheKey);
  const preparedBeforeEdit = f.prepare(cached);
  const edited = original.replace("'/bundle/node_modules/'", "'/updated/node_modules/'");
  assert.notEqual(edited, original, 'the private edit changes an executed transformation rule');
  f.write('build/index.cjs', edited);
  const retained = await f.bundle(cached), fresh = f.fresh(f.moduleFile), updated = await f.bundle(fresh);
  const deferred = await f.bundle(cached, preparedBeforeEdit);
  assert.equal(baseline.value, '/bundle/node_modules/example-sdk');
  assert.equal(retained.value, baseline.value);
  assert.equal(updated.value, '/updated/node_modules/example-sdk');
  assert.equal(retained.sha256, baseline.sha256);
  assert.equal(deferred.sha256, baseline.sha256);
  assert.equal(deferred.manifest.cacheKey, baseline.manifest.cacheKey);
  assert.notEqual(updated.sha256, retained.sha256);
  assert.equal(retained.manifest.cacheKey, baseline.manifest.cacheKey);
  assert.notEqual(updated.manifest.cacheKey, retained.manifest.cacheKey);
  assert.equal(retained.manifest.transformer.sha256, hash(original));
  assert.equal(updated.manifest.transformer.sha256, hash(edited));
  assert.equal(updated.manifest.inputSha256, retained.manifest.inputSha256);
  for (const result of [baseline, unchanged, retained, updated, deferred]) {
    assert.deepEqual(result.manifest.transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
  }
  f.write('node_modules/example-sdk/index.js', f.source + '\n// unpinned source drift');
  for (const api of [cached, fresh]) assert.throws(() => f.prepare(api), error =>
    error.code === 'WGA_SCHEMA_MISMATCH' && error.diagnostic.kind === 'source-hash');
  const invalidAnchors = 'exports.directory = __dirname + __dirname;';
  f.write('node_modules/example-sdk/index.js', invalidAnchors);
  f.profile.files[0].sha256 = hash(invalidAnchors); f.save();
  for (const api of [cached, fresh]) {
    const report = api.inspectGoogleWorkerProfile({ projectRoot: f.projectRoot, typescript: ts });
    assert.equal(report.passed, false);
    assert.equal(report.diagnostics[0].reason, 'anchor-count');
  }
});

test('BUILD registry generation keeps retained host code in its original registry namespace', t => {
  const f = fixture(t), original = fs.readFileSync(f.moduleFile, 'utf8');
  const protobufRoot = path.dirname(googleRequire.resolve('protobufjs/package.json'));
  fs.symlinkSync(protobufRoot, path.join(f.projectRoot, 'node_modules/protobufjs'), process.platform === 'win32' ? 'junction' : 'dir');
  const pinned = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/build/profiles/google-static-v1.json')));
  const protobufPackage = { ...pinned.packages.find(pkg => pkg.name === 'protobufjs') };
  delete protobufPackage.resolveFrom;
  f.profile.packages = [protobufPackage]; f.profile.files = [];
  const json = { nested: { Example: { fields: { value: { id: 1, type: 'string' } } } } }, schema = JSON.stringify(json);
  f.profile.schemas = [{ path: 'schema.json', sha256: hash(schema) }];
  f.profile.codegenInputs = pinned.codegenInputs;
  f.write('schema.json', schema); f.save();
  const cached = require(f.moduleFile), baseline = f.prepare(cached);
  const unchanged = f.prepare(f.fresh(f.moduleFile));
  assert.equal(baseline.registryFile, unchanged.registryFile);
  const edited = original.replace("source.push('return root;}');", "source.push('root.__generation=\"updated\";return root;}');");
  assert.notEqual(edited, original, 'the private edit changes executed host generation code');
  f.write('build/index.cjs', edited);
  const retained = f.prepare(cached), fresh = f.fresh(f.moduleFile), updated = f.prepare(fresh);
  assert.equal(retained.registryFile, baseline.registryFile);
  assert.notEqual(updated.registryFile, retained.registryFile);
  assert.equal(retained.manifest().cacheKey, baseline.manifest().cacheKey);
  assert.notEqual(updated.manifest().cacheKey, retained.manifest().cacheKey);
  assert.equal(retained.manifest().transformer.sha256, hash(original));
  assert.equal(updated.manifest().transformer.sha256, hash(edited));
  assert.equal(updated.manifest().inputSha256, retained.manifest().inputSha256);
  const P = googleRequire('protobufjs');
  for (const [preset, marker] of [[baseline, undefined], [unchanged, undefined], [retained, undefined], [updated, 'updated']]) {
    assert.equal(hash(fs.readFileSync(preset.registryFile)), preset.manifest().registrySha256);
    const root = require(preset.registryFile).fromJSON(P, json), type = root.lookupType('Example');
    assert.equal(root.__generation, marker);
    const bytes = type.encode({ value: 'x' }).finish();
    assert.equal(Buffer.from(bytes).toString('hex'), '0a0178');
    assert.equal(type.decode(bytes).value, 'x');
  }
  f.write('schema.json', schema + ' ');
  for (const api of [cached, fresh]) assert.throws(() => f.prepare(api), error =>
    error.code === 'WGA_SCHEMA_MISMATCH' && error.diagnostic.kind === 'schema-hash');
});

test('PREBUNDLE implementation receipts belong to the loaded helper generation', async t => {
  const f = fixture(t), file = path.join(f.projectRoot, 'build/prebundle.cjs'), original = fs.readFileSync(file, 'utf8');
  f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  f.write('node_modules/@grpc/grpc-js/index.cjs', 'exports.client = () => 17;');
  f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; export {directory} from "example-sdk";');
  f.write('wrapper.d.ts', 'export declare function client(): number; export declare const directory: string;');
  const cached = require(file);
  let count = 0;
  async function build(api, bundler = esbuild) {
    const built = await api.buildGoogleWorkerPrebundle({ projectRoot: f.projectRoot, outdir: `out-${++count}`,
      entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts', exports: ['client', 'directory'], typescript: ts, esbuild: bundler });
    const manifest = JSON.parse(fs.readFileSync(built.manifestPath));
    assert.equal(require(built.bundlePath).client(), 17);
    assert.equal(require(built.bundlePath).directory, '/bundle/node_modules/example-sdk');
    return { manifest, blocked: path.join(built.outdir, 'server-only.cjs') };
  }
  const baseline = await build(cached), unchanged = await build(f.fresh(file));
  assert.equal(baseline.manifest.build.prebundleSha256, unchanged.manifest.build.prebundleSha256);
  assert.deepEqual(baseline.manifest.artifacts, unchanged.manifest.artifacts);
  const edited = original.replace('WGA_PREBUNDLE_SERVER_ONLY:', 'WGA_PREBUNDLE_UPDATED:');
  assert.notEqual(edited, original, 'the private edit changes a generated runtime guard');
  const editing = { ...esbuild, async build(options) {
    const built = await esbuild.build(options);
    f.write('build/prebundle.cjs', edited);
    return built;
  } };
  const retained = await build(cached, editing), updated = await build(f.fresh(file));
  assert.equal(retained.manifest.build.prebundleSha256, hash(original));
  assert.equal(updated.manifest.build.prebundleSha256, hash(edited));
  assert.deepEqual(retained.manifest.artifacts, baseline.manifest.artifacts);
  assert.notEqual(updated.manifest.artifacts['server-only.cjs'].sha256, retained.manifest.artifacts['server-only.cjs'].sha256);
  assert.throws(() => require(retained.blocked), /WGA_PREBUNDLE_SERVER_ONLY:/);
  assert.throws(() => require(updated.blocked), /WGA_PREBUNDLE_UPDATED:/);
});
