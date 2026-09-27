'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');
const { inspectGoogleWorkerProfile, createGoogleWorkerBuild } = require('../src/build/index.cjs');
const root = path.resolve(__dirname, '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath = 'node_modules/example/runtime.js';
function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-profile-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true })); return directory;
}
function synthetic(t) {
  const project = temp(t), moduleFile = path.join(project, 'build/index.cjs');
  const pkg = { name: 'example', version: '1.0.0' };
  const source = 'const root = Proto.Root.fromJSON({});\n';
  fs.mkdirSync(path.join(project, 'node_modules/example'), { recursive: true });
  fs.mkdirSync(path.join(project, 'build/profiles'), { recursive: true });
  fs.writeFileSync(moduleFile, fs.readFileSync(path.join(root, 'src/build/index.cjs')));
  fs.writeFileSync(path.join(project, 'node_modules/example/package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(project, sourcePath), source);
  const profile = { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, revision: 4,
    packages: [{ path: 'node_modules/example', name: pkg.name, version: pkg.version, packageJsonSha256: hash(JSON.stringify(pkg)) }],
    files: [{ path: sourcePath, sha256: hash(source), transforms: [{ rule: 'static-root-from-json', expectedMatches: 1 }] }],
    schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: ['static-protobuf-codecs'], requiredChecks: ['node --test test/build-profiles.test.cjs'] };
  const save = () => fs.writeFileSync(path.join(project, 'build/profiles/google-static-v1.json'), JSON.stringify(profile));
  save();
  const build = () => require(moduleFile);
  const inspect = compiler => build().inspectGoogleWorkerProfile({ projectRoot: project, typescript: compiler });
  const prepare = (outdir = path.join(project, 'out'), compiler = ts) => build().createGoogleWorkerBuild({ projectRoot: project, outdir, typescript: compiler });
  const replaceSource = text => { fs.writeFileSync(path.join(project, sourcePath), text); profile.files[0].sha256 = hash(text); save(); };
  return { project, moduleFile, profile, save, inspect, prepare, replaceSource };
}
for (const [fixture, profile] of [['google', 'google-static-v1'], ['modern', 'google-modern-v1']]) {
  test(`BUILD profile inspector validates every declared ${profile} transformation`, () => {
    const projectRoot = path.join(root, 'fixtures', fixture);
    const report = inspectGoogleWorkerProfile({ projectRoot, profile, typescript: ts });
    assert.equal(report.passed, true, JSON.stringify(report.diagnostics));
    assert.equal(report.transformationsChecked, true);
    assert.deepEqual(report.diagnostics, []);
    assert.match(report.buildIdentity.cacheKey, /^[a-f0-9]{64}$/);
    assert.equal(report.buildIdentity.transformer.typescriptVersion, ts.version);
    assert.ok(report.capabilities.includes('native-fetch-auth'));
    assert.ok(report.requiredChecks.some(command => command.includes('build-profiles.test.cjs')));
  });
}
test('BUILD profile diagnostics collect precise package, schema, source and codegen differences', t => {
  const fixture = synthetic(t), { project, profile } = fixture;
  profile.schemas.push({ path: 'schema.json', sha256: hash('{}') });
  profile.codegenInputs.push({ path: 'encoder.js', sha256: hash('encoder') });
  fixture.save();
  fs.writeFileSync(path.join(project, 'node_modules/example/package.json'), JSON.stringify({ name: 'renamed', version: '2.0.0' }));
  fs.writeFileSync(path.join(project, sourcePath), '// changed');
  fs.writeFileSync(path.join(project, 'schema.json'), '{"nested":{}}');
  const report = fixture.inspect(ts);
  assert.equal(report.passed, false);
  assert.equal(report.transformationsChecked, false);
  assert.deepEqual(report.diagnostics.map(item => item.kind), ['package-name', 'package-version', 'package-hash', 'source-hash', 'schema-hash', 'codegen-hash']);
  const version = report.diagnostics.find(item => item.kind === 'package-version');
  assert.deepEqual(version, { kind: 'package-version', path: 'node_modules/example/package.json', expected: '1.0.0', actual: '2.0.0' });
  assert.equal(report.diagnostics.find(item => item.kind === 'schema-hash').actual, hash('{"nested":{}}'));
  assert.equal(report.diagnostics.find(item => item.kind === 'codegen-hash').reason, 'missing');
  assert.throws(() => fixture.prepare(), error => error.code === 'WGA_UNSUPPORTED_DEPENDENCY' && error.diagnostic.kind === 'package-name');
  assert.equal(fs.existsSync(path.join(project, 'out')), false, 'invalid inputs never generate output');
});
test('BUILD profile doctor diagnoses unknown, missing, duplicate and malformed transform rules', t => {
  const fixture = synthetic(t);
  for (const [transforms, reason] of [[[{ rule: 'unknown-rule', expectedMatches: 1 }], 'unknown-rule'],
    [[{ rule: 'static-root-from-json', expectedMatches: 0 }], 'invalid-count'],
    [[{ rule: 'static-root-from-json', expectedMatches: 1 }, { rule: 'static-root-from-json', expectedMatches: 1 }], 'duplicate-rule']]) {
    fixture.profile.files[0].transforms = transforms; fixture.save();
    const report = fixture.inspect(ts);
    assert.equal(report.passed, false);
    assert.equal(report.diagnostics[0].reason, reason);
    assert.throws(() => fixture.prepare(), { code: 'WGA_SCHEMA_MISMATCH' });
  }
  delete fixture.profile.files[0].transforms; fixture.save();
  assert.equal(fixture.inspect().diagnostics[0].kind, 'transformation');
});
test('BUILD profile doctor identifies changed AST count and shape even with updated source hashes', t => {
  const fixture = synthetic(t);
  fixture.replaceSource('Proto.Root.fromJSON({}); Proto.Root.fromJSON({});');
  let report = fixture.inspect(ts);
  assert.equal(report.passed, false);
  assert.equal(report.transformationsChecked, true);
  assert.deepEqual(report.diagnostics[0], { kind: 'transformation', path: sourcePath, rule: 'static-root-from-json', expected: 1, actual: 2, reason: 'anchor-count' });
  fixture.replaceSource('Proto.Root.fromJSON({}, {});');
  report = fixture.inspect(ts);
  assert.equal(report.diagnostics[0].rule, 'static-root-from-json');
  assert.equal(report.diagnostics[0].reason, 'anchor-shape');
  assert.equal(fixture.inspect().transformationsChecked, false, 'hash-only inspection clearly reports omitted AST checks');
});
test('BUILD generated registry identity covers transformer bytes/version, TypeScript and all pinned inputs', t => {
  const fixture = synthetic(t), first = fixture.prepare().manifest();
  const relocated = fixture.prepare(path.join(fixture.project, 'relocated')).manifest();
  assert.equal(first.cacheKey, relocated.cacheKey, 'output location does not alter registry identity');
  assert.equal(first.registrySha256, relocated.registrySha256);
  fixture.replaceSource('const anotherRoot = Proto.Root.fromJSON({});');
  const input = fixture.prepare().manifest();
  assert.notEqual(input.inputSha256, first.inputSha256);
  assert.notEqual(input.cacheKey, first.cacheKey);
  assert.notEqual(input.registrySha256, first.registrySha256);
  const compiler = fixture.prepare(undefined, { ...ts, version: `${ts.version}-test` }).manifest();
  assert.notEqual(input.cacheKey, compiler.cacheKey);
  assert.equal(input.inputSha256, compiler.inputSha256);
  fs.appendFileSync(fixture.moduleFile, '\n// controlled transformer implementation drift\n');
  const changed = fixture.prepare().manifest();
  assert.notEqual(input.cacheKey, changed.cacheKey);
  assert.notEqual(input.transformer.sha256, changed.transformer.sha256);
  assert.equal(input.inputSha256, changed.inputSha256);
  const manifestBytes = JSON.stringify({ name: 'example', version: '1.0.0', description: 'controlled package manifest drift' });
  fs.writeFileSync(path.join(fixture.project, 'node_modules/example/package.json'), manifestBytes);
  fixture.profile.packages[0].packageJsonSha256 = hash(manifestBytes); fixture.save();
  const packageInput = fixture.prepare().manifest();
  assert.notEqual(packageInput.inputSha256, changed.inputSha256);
  assert.notEqual(packageInput.cacheKey, changed.cacheKey);
  fixture.profile.codegenInputs = [{ path: 'generator.js', sha256: hash('generator-v1') }];
  fs.writeFileSync(path.join(fixture.project, 'generator.js'), 'generator-v1'); fixture.save();
  const generatorInput = fixture.prepare().manifest();
  assert.notEqual(generatorInput.inputSha256, packageInput.inputSha256);
  assert.notEqual(generatorInput.cacheKey, packageInput.cacheKey);
  fixture.profile.transformerVersion++; fixture.save();
  assert.equal(fixture.inspect().diagnostics[0].kind, 'transformer');
  assert.throws(() => fixture.prepare(), { code: 'WGA_UNSUPPORTED_DEPENDENCY' });
});
test('BUILD profile format failures stay structured and never generate artifacts', t => {
  const fixture = synthetic(t);
  fixture.profile.files = null; fixture.save();
  let report = fixture.inspect(ts);
  assert.equal(report.passed, false);
  assert.equal(report.diagnostics[0].kind, 'manifest');
  assert.equal(report.diagnostics[0].path, 'files');
  fixture.profile.files = []; fixture.profile.packages[0].path = '../outside'; fixture.save();
  report = fixture.inspect(ts);
  assert.equal(report.passed, false);
  assert.equal(report.diagnostics[0].kind, 'manifest');
  assert.equal(fs.existsSync(path.join(fixture.project, 'out')), false);
});
test('BUILD transformed source is checked again when the bundler loads it', t => {
  const fixture = synthetic(t), preset = fixture.prepare();
  let load; preset.plugin.setup({ onLoad(_options, callback) { load = callback; } });
  fs.appendFileSync(path.join(fixture.project, sourcePath), '// late drift');
  assert.throws(() => load({ path: path.join(fixture.project, sourcePath) }), { code: 'WGA_SCHEMA_MISMATCH' });
});
test('BUILD doctor CLI includes requested profile diagnostics and preserves graph checks', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.cjs'), path.join(root, 'fixtures/google'), '--profile=google-static-v1'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.buildProfile.transformationsChecked, true);
  assert.equal(report.results.length, 3);
  const bad = spawnSync(process.execPath, [path.join(root, 'scripts/doctor.cjs'), path.join(root, 'fixtures/google'), '--profile=google-modern-v1'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(bad.status, 2, bad.stderr);
  const mismatched = JSON.parse(bad.stdout);
  assert.equal(mismatched.buildProfile.passed, false);
  assert.ok(mismatched.buildProfile.diagnostics.some(item => item.kind === 'package-version'));
  assert.equal(mismatched.results.every(item => item.status === 'resolved-to-replacement'), true, 'a resolved transport graph alone does not certify a different SDK profile');
});
