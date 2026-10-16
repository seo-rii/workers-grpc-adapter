'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');
const { createGoogleWorkerBuild, buildGoogleWorkerPrebundle } = require('../src/build/index.cjs');
const root = path.resolve(__dirname, '..');
const projectRoot = path.join(root, 'fixtures/modern');
const sourcePath = 'node_modules/google-gax/build/src/observability/metadataResolver.js';
const upstream = fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8');
const buildSource = fs.readFileSync(path.join(root, 'src/build/index.cjs'));
const digest = value => createHash('sha256').update(value).digest('hex');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-gax-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function write(file, contents) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
function loader(preset) {
  let onLoad;
  preset.plugin.setup({ onLoad(options, callback) { onLoad = callback; } });
  return onLoad;
}
function synthetic(t, source = upstream, expectedHash = digest(source)) {
  const directory = temporary(t), manifest = JSON.stringify({ name: 'google-gax', version: '6.7.0' });
  write(path.join(directory, sourcePath), source);
  write(path.join(directory, 'node_modules/google-gax/package.json'), manifest);
  write(path.join(directory, 'build/index.cjs'), buildSource);
  const profile = { id: 'google-modern-v1', schemaVersion: 1, transformerVersion: 1, revision: 3,
    packages: [{ path: 'node_modules/google-gax', name: 'google-gax', version: '6.7.0', packageJsonSha256: digest(manifest) }],
    files: [{ path: sourcePath, sha256: expectedHash, transforms: [{ rule: 'gax-package-metadata', expectedMatches: 1 }] }],
    schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] };
  write(path.join(directory, 'build/profiles/google-modern-v1.json'), JSON.stringify(profile));
  const api = require(path.join(directory, 'build/index.cjs'));
  const prepare = () => api.createGoogleWorkerBuild({ projectRoot: directory, outdir: path.join(directory, 'out'), profile: profile.id, typescript: ts });
  return { directory, prepare, transform: () => loader(prepare())({ path: path.join(directory, sourcePath) }) };
}
test('BUILD modern GAX metadata prebundle includes its pinned package version without runtime imports', async t => {
  const directory = temporary(t);
  write(path.join(directory, 'package.json'), '{"name":"gax-metadata-consumer","private":true}');
  fs.symlinkSync(fs.realpathSync(path.join(projectRoot, 'node_modules')), path.join(directory, 'node_modules'), 'dir');
  // This focused wrapper selects the actual installed internal module used by
  // GAX's public entrypoint; dependencies and package exports stay unmodified.
  write(path.join(directory, 'wrapper.mjs'), `export {extractFromSettings} from './${sourcePath}';
export {createWorkersGrpcTransport} from '@grpc/grpc-js/adapter';\n`);
  write(path.join(directory, 'wrapper.d.ts'), 'export declare function extractFromSettings(settings?: unknown): unknown;\nexport declare function createWorkersGrpcTransport(config?: unknown): unknown;\n');
  const result = await buildGoogleWorkerPrebundle({ projectRoot: directory, outdir: 'out', profile: 'google-modern-v1',
    typescript: ts, esbuild, entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts', exports: ['extractFromSettings', 'createWorkersGrpcTransport'] });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath));
  const receipt = manifest.transformed.find(item => item.path === sourcePath);
  assert.deepEqual(receipt?.rules, [{ rule: 'gax-package-metadata', matches: 1 }]);
  assert.equal(receipt.upstreamSha256, digest(upstream));
  assert.equal(manifest.transformCoverage.required, 1);
  assert.equal(manifest.transformCoverage.applied, 1);
  assert.equal(manifest.transformCoverage.passed, true);
  assert.ok(manifest.sources.some(item => item.path === 'google-gax@6.7.0/package.json'));
  const portable = path.join(temporary(t), 'portable');
  fs.cpSync(result.outdir, portable, { recursive: true });
  const sdk = require(path.join(portable, 'index.cjs'));
  assert.deepEqual(sdk.extractFromSettings({}), { gcpVersion: '6.7.0' });
  assert.deepEqual(sdk.extractFromSettings(), {});
  assert.equal(sdk.extractFromSettings({ otherArgs: { headers: { 'x-goog-api-client': 'gapic/1.2.3' } } }).gcpVersion, '1.2.3');
  assert.equal(typeof sdk.createWorkersGrpcTransport, 'function');
  assert.equal(fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8'), upstream);
});
test('BUILD modern GAX metadata transform preserves version fallback and header precedence', t => {
  const preset = createGoogleWorkerBuild({ projectRoot, outdir: temporary(t), profile: 'google-modern-v1', typescript: ts });
  const loaded = loader(preset)({ path: path.join(projectRoot, sourcePath) });
  assert.ok(loaded, 'the installed metadata resolver must be a required profile transform');
  assert.equal(loaded.contents.includes("require('../../package.json')"), false);
  assert.equal(loaded.contents.match(/require\((?:'|")\.\.\/\.\.\/\.\.\/package\.json(?:'|")\)/g)?.length, 2);
  const module = { exports: {} }, filename = path.join(projectRoot, sourcePath);
  vm.runInNewContext(loaded.contents, { module, exports: module.exports, require: createRequire(filename), process }, { filename });
  const original = require(filename), settings = [{}, undefined, { otherArgs: { headers: { 'x-goog-api-client': 'gapic/4.5.6' } } }];
  for (const value of settings) assert.deepEqual(JSON.parse(JSON.stringify(module.exports.extractFromSettings(value))), original.extractFromSettings(value));
  assert.deepEqual(preset.manifest().transformed[0].rules, [{ rule: 'gax-package-metadata', matches: 1 }]);
});
test('BUILD GAX metadata rejects source drift and independently rejects changed AST anchors', t => {
  const fixtures = [
    { name: 'hash', source: upstream + '\n// drift\n', hash: digest(upstream), kind: 'source-hash' },
    { name: 'primary', source: upstream.replace("require('../../package.json')", "require('../../other.json')"), kind: 'transformation' },
    { name: 'fallback', source: upstream.replace("require('../../../package.json')", "require('../../../other.json')"), kind: 'transformation' },
    { name: 'property', source: upstream.replace("require('../../../package.json').version", "require('../../../package.json').release"), kind: 'transformation' },
    { name: 'catch-binding', source: upstream.replace('catch {', 'catch (error) {'), kind: 'transformation' },
    { name: 'extra-effect', source: upstream.replace('// Ignore fallback failure', 'console.log("unexpected side effect");'), kind: 'transformation' },
    { name: 'missing', source: upstream.replaceAll('fallbackVersion = require', 'otherVersion = require'), kind: 'transformation' },
    { name: 'duplicate', source: upstream + '\nlet fallbackVersion; try { fallbackVersion = require("../../package.json").version; } catch { try { fallbackVersion = require("../../../package.json").version; } catch {} }\n', kind: 'transformation' },
  ];
  for (const fixture of fixtures) {
    // Only isolated fixture manifests trust changed bytes, to exercise AST
    // guards separately from the real profile's exact source hash.
    const clone = synthetic(t, fixture.source, fixture.hash);
    assert.throws(clone.transform, error => error.code === 'WGA_SCHEMA_MISMATCH' && error.diagnostic.kind === fixture.kind
      && (fixture.kind === 'source-hash' || ['anchor-shape', 'anchor-count'].includes(error.diagnostic.reason)), fixture.name);
  }
});
test('BUILD GAX metadata rejects shadow package metadata and requires an audited transform', t => {
  const clone = synthetic(t), preset = clone.prepare();
  assert.throws(() => preset.verifyBuild({ inputs: { [sourcePath]: {} } }), { code: 'WGA_TRANSFORM_COVERAGE' });
  loader(preset)({ path: path.join(clone.directory, sourcePath) });
  assert.deepEqual(preset.verifyBuild({ inputs: { [sourcePath]: {} } }), { required: 1, applied: 1, unused: 0, passed: true });
  write(path.join(clone.directory, 'node_modules/google-gax/build/package.json'), '{"version":"unexpected"}');
  assert.throws(() => preset.verifyBuild({ inputs: { [sourcePath]: {} } }), error => error.code === 'WGA_SCHEMA_MISMATCH' && error.diagnostic.rule === 'gax-package-metadata');
  assert.equal(preset.manifest().transformCoverage.passed, false);
  assert.throws(clone.transform, error => error.code === 'WGA_SCHEMA_MISMATCH' && error.diagnostic.rule === 'gax-package-metadata');
});
test('BUILD GAX metadata requires fallback metadata from the verified physical package root', t => {
  const clone = synthetic(t), physical = path.join(clone.directory, 'unverified/build/src/observability/metadataResolver.js');
  write(physical, upstream);
  write(path.join(clone.directory, 'unverified/package.json'), '{"name":"google-gax","version":"6.7.0"}');
  fs.unlinkSync(path.join(clone.directory, sourcePath));
  fs.symlinkSync(physical, path.join(clone.directory, sourcePath));
  assert.throws(clone.transform, error => error.code === 'WGA_SCHEMA_MISMATCH' && error.diagnostic.reason === 'package-layout');
});
