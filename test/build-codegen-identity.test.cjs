'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const api = path.join(root, 'src/build/index.cjs');
const typescript = require.resolve('typescript');
const original = fs.realpathSync(path.join(root, 'fixtures/google/node_modules'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const link = (target, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir'); };

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-codegen-identity-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  write(path.join(project, 'package.json'), '{"private":true}');
  for (const entry of fs.readdirSync(original)) {
    if (entry === '@google-cloud' || entry.startsWith('.')) continue;
    link(path.join(original, entry), path.join(project, 'node_modules', entry));
  }
  for (const entry of fs.readdirSync(path.join(original, '@google-cloud'))) {
    if (entry === 'datastore') continue;
    link(path.join(original, '@google-cloud', entry), path.join(project, 'node_modules/@google-cloud', entry));
  }
  const datastore = path.join(project, 'node_modules/@google-cloud/datastore');
  fs.cpSync(path.join(original, '@google-cloud/datastore'), datastore, { recursive: true });
  const shadow = path.join(datastore, 'node_modules/protobufjs');
  return { project, shadow };
}

// Separate processes avoid Node's resolution/module cache hiding a changed
// installation between preparations; only synthetic modules touch this counter.
function inspect(project, prepare = false) {
  const result = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const api = require(${JSON.stringify(api)});
    const options = {projectRoot: ${JSON.stringify(project)}};
    const report = api.inspectGoogleWorkerProfile(options);
    let build, error;
    if (${prepare}) {
      try {
        const preset = api.createGoogleWorkerBuild({...options, outdir: options.projectRoot + '/generated', typescript: require(${JSON.stringify(typescript)})});
        build = {manifest: preset.manifest(), registry: fs.readFileSync(preset.registryFile, 'utf8')};
      } catch (caught) { error = {code: caught.code, diagnostic: caught.diagnostic}; }
    }
    console.log(JSON.stringify({report, build, error, loads: globalThis.unverifiedCodegenLoads || 0}));
  `], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const duplicate of ['wrapper', 'identical-copy']) {
  test(`BUILD shipped profile rejects schema-local ${duplicate} before executing a generator`, t => {
    const f = fixture(t);
    if (duplicate === 'identical-copy') fs.cpSync(path.join(original, 'protobufjs'), f.shadow, { recursive: true });
    else {
      write(path.join(f.shadow, 'package.json'), fs.readFileSync(path.join(original, 'protobufjs/package.json')));
      write(path.join(f.shadow, 'index.js'), `globalThis.unverifiedCodegenLoads = (globalThis.unverifiedCodegenLoads || 0) + 1; module.exports = require(${JSON.stringify(path.join(original, 'protobufjs'))});`);
    }
    const result = inspect(f.project, true);
    assert.equal(result.report.passed, false);
    assert.equal(result.report.transformationsChecked, false);
    assert.equal(result.report.diagnostics[0].kind, 'source-identity');
    assert.equal(result.report.diagnostics[0].reason, 'unverified-codegen-installation');
    assert.equal(result.error.code, 'WGA_SOURCE_IDENTITY');
    assert.equal(result.loads, 0, 'reject before unverified generator top-level code can run');
    assert.equal(fs.existsSync(path.join(f.project, 'generated')), false);
  });
}

test('BUILD shipped profile accepts schema-local links to the same pinned generator with stable cache identity', t => {
  const baseline = fixture(t), linked = fixture(t);
  link(path.join(original, 'protobufjs'), linked.shadow);
  const first = inspect(baseline.project, true), second = inspect(linked.project, true);
  for (const result of [first, second]) {
    assert.equal(result.report.passed, true, JSON.stringify(result.report.diagnostics));
    assert.equal(result.error, undefined);
    assert.equal(result.loads, 0);
  }
  assert.equal(first.build.manifest.cacheKey, second.build.manifest.cacheKey);
  assert.equal(first.build.manifest.inputSha256, second.build.manifest.inputSha256);
  assert.equal(first.build.registry, second.build.registry);
});

function generatorFixture(t, layout = 'hoisted') {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-pinned-generator-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const generator = path.join(project, layout === 'hoisted' ? 'node_modules/protobufjs'
    : layout === 'workspace' ? 'packages/protobufjs' : 'node_modules/.pnpm/protobufjs@7.6.6/node_modules/protobufjs');
  fs.mkdirSync(path.dirname(generator), { recursive: true });
  fs.cpSync(path.join(original, 'protobufjs'), generator, { recursive: true });
  if (layout !== 'hoisted') link(generator, path.join(project, 'node_modules/protobufjs'));
  link(path.join(original, '@protobufjs'), path.join(project, 'node_modules/@protobufjs'));
  link(path.join(original, 'long'), path.join(project, 'node_modules/long'));
  write(path.join(project, 'package.json'), '{"private":true}');
  const pinned = JSON.parse(fs.readFileSync(path.join(root, 'src/build/profiles/google-static-v1.json'), 'utf8'));
  const protobufPackage = { ...pinned.packages.find(pkg => pkg.name === 'protobufjs') };
  delete protobufPackage.resolveFrom;
  const schema = JSON.stringify({ nested: { Example: { fields: { value: { type: 'string', id: 1 } } } } });
  const profile = { ...pinned, packages: [protobufPackage], files: [],
    schemas: [{ path: 'schemas/example.json', sha256: hash(schema) }] };
  write(path.join(project, 'schemas/example.json'), schema);
  write(path.join(project, 'build/index.cjs'), fs.readFileSync(api));
  const save = () => write(path.join(project, 'build/profiles/google-static-v1.json'), JSON.stringify(profile));
  save();
  const build = require(path.join(project, 'build/index.cjs'));
  const options = { projectRoot: project, outdir: path.join(project, 'generated'), typescript: require(typescript) };
  return { project, generator, profile, save, build, options, prepare: () => build.createGoogleWorkerBuild(options) };
}

for (const layout of ['hoisted', 'isolated', 'workspace']) {
  test(`BUILD pinned generator bootstrap changes fail before execution in ${layout} layout`, t => {
    const f = generatorFixture(t, layout), baseline = f.prepare().manifest();
    const file = path.join(f.generator, 'index.js');
    fs.appendFileSync(file, '\nthrow new Error("unverified entry executed");\n');
    assert.throws(f.prepare, error => error.code === 'WGA_SCHEMA_MISMATCH'
      && error.diagnostic.kind === 'codegen-hash' && error.diagnostic.path === 'node_modules/protobufjs/index.js');
    fs.writeFileSync(file, fs.readFileSync(path.join(original, 'protobufjs/index.js')) + '\n// reviewed bootstrap update\n');
    f.profile.codegenInputs.find(input => input.path === 'node_modules/protobufjs/index.js').sha256 = hash(fs.readFileSync(file));
    f.save();
    const updated = f.prepare().manifest();
    assert.notEqual(updated.cacheKey, baseline.cacheKey);
    assert.notEqual(updated.inputSha256, baseline.inputSha256);
  });
}

test('BUILD generator startup and final checks reject a newly inserted schema-local installation', t => {
  const f = generatorFixture(t), preset = f.prepare();
  let start;
  preset.plugin.setup({ onLoad() {}, onStart(callback) { start = callback; } });
  const shadow = path.join(f.project, 'schemas/node_modules/protobufjs');
  write(path.join(shadow, 'package.json'), fs.readFileSync(path.join(original, 'protobufjs/package.json')));
  write(path.join(shadow, 'index.js'), 'throw new Error("unverified entry executed");');
  assert.throws(start, error => error.code === 'WGA_SOURCE_IDENTITY' && error.diagnostic.reason === 'unverified-codegen-installation');
  assert.throws(() => preset.verifyBuild({ inputs: {}, outputs: {} }), { code: 'WGA_SOURCE_IDENTITY' });
});

test('BUILD schema generation requires declared entry and bootstrap hashes', t => {
  const f = generatorFixture(t);
  f.profile.codegenInputs = f.profile.codegenInputs.filter(input => input.path !== 'node_modules/protobufjs/src/index-light.js');
  f.save();
  assert.throws(f.prepare, error => error.code === 'WGA_SCHEMA_MISMATCH' && error.diagnostic.reason === 'undeclared-codegen-input');
  assert.equal(fs.existsSync(f.options.outdir), false);
});
