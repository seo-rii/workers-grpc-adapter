'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { Worker } = require('node:worker_threads');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const googleRequire = createRequire(path.join(root, 'fixtures/google/package.json'));
const esbuild = workerRequire('esbuild');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
function temporary(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-build-registry-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return project;
}
function integrityError(error) {
  return error.code === 'WGA_REGISTRY_INTEGRITY'
    || error.errors?.some(item => item.detail?.code === 'WGA_REGISTRY_INTEGRITY'
      || item.text.startsWith('WGA_REGISTRY_INTEGRITY:'));
}
function fixture(t) {
  const project = temporary(t);
  write(path.join(project, 'package.json'), '{}');
  write(path.join(project, 'build/index.cjs'), fs.readFileSync(path.join(root, 'src/build/index.cjs')));
  const protobufRoot = path.dirname(googleRequire.resolve('protobufjs/package.json'));
  fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
  fs.symlinkSync(protobufRoot, path.join(project, 'node_modules/protobufjs'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const [profile, name, type] of [['google-static-v1', 'codec-a', 'A'], ['google-modern-v1', 'codec-b', 'B']]) {
    const relative = 'node_modules/' + name;
    const manifest = JSON.stringify({ name, version: '1.0.0', main: 'index.js' });
    const source = 'const Proto=require("protobufjs");module.exports=Proto.Root.fromJSON(require("./schema.json"));';
    const schema = JSON.stringify({ nested: { [type]: { fields: { value: { type: 'string', id: 1 } } } } });
    write(path.join(project, relative, 'package.json'), manifest);
    write(path.join(project, relative, 'index.js'), source);
    write(path.join(project, relative, 'schema.json'), schema);
    write(path.join(project, 'build/profiles', profile + '.json'), JSON.stringify({
      id: profile, schemaVersion: 1, transformerVersion: 1, revision: 1,
      packages: [{ path: relative, name, version: '1.0.0', packageJsonSha256: hash(manifest) }],
      files: [{ path: relative + '/index.js', sha256: hash(source), transforms: [{ rule: 'static-root-from-json', expectedMatches: 1 }] }],
      schemas: [{ path: relative + '/schema.json', sha256: hash(schema) }], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [],
    }));
    write(path.join(project, name + '.cjs'), `module.exports=require(${JSON.stringify(name)}).lookupType(${JSON.stringify(type)}).fieldsArray.map(field=>field.name);`);
  }
  const api = require(path.join(project, 'build/index.cjs'));
  let builds = 0;
  const prepare = (profile = 'google-static-v1', outdir = path.join(project, 'generated')) => api.createGoogleWorkerBuild({ projectRoot: project, outdir, profile, typescript: ts });
  async function bundle(preset, name = 'codec-a', plugins = []) {
    const result = await esbuild.build({ absWorkingDir: project, entryPoints: [name + '.cjs'], bundle: true,
      platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins: [...plugins, preset.plugin] });
    const output = path.join(project, `output-${++builds}.cjs`);
    write(output, result.outputFiles[0].contents);
    return { value: require(output), metafile: result.metafile };
  }
  return { project, prepare, bundle };
}

test('BUILD registry keeps different prepared profile identities isolated in a shared outdir', async t => {
  const f = fixture(t), first = f.prepare(), second = f.prepare('google-modern-v1');
  assert.notEqual(first.manifest().cacheKey, second.manifest().cacheKey);
  assert.deepEqual((await f.bundle(first)).value, ['value']);
  assert.deepEqual((await f.bundle(second, 'codec-b')).value, ['value']);
  for (const preset of [first, second]) {
    assert.equal(hash(fs.readFileSync(preset.registryFile)), preset.manifest().registrySha256);
    assert.deepEqual(preset.manifest().transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
  }
});

test('BUILD registry reuses an unchanged identity without invalidating an existing preset', async t => {
  const f = fixture(t), first = f.prepare(), before = fs.readFileSync(first.registryFile), second = f.prepare();
  assert.equal(first.registryFile, second.registryFile);
  assert.deepEqual(fs.readFileSync(first.registryFile), before);
  assert.deepEqual((await f.bundle(first)).value, ['value']);
  assert.deepEqual((await f.bundle(second)).value, ['value']);
});

test('BUILD concurrent preparations share only identical registry bytes', { timeout: 30_000 }, async t => {
  const f = fixture(t), gate = new SharedArrayBuffer(4), workers = [];
  t.after(() => Promise.all(workers.map(worker => worker.terminate())));
  const preparations = ['google-static-v1', 'google-static-v1', 'google-modern-v1'].map(profile => {
    const worker = new Worker(`
      const {parentPort, workerData} = require('node:worker_threads');
      const {createGoogleWorkerBuild} = require(workerData.api);
      const typescript = require(workerData.typescript);
      parentPort.postMessage('ready');
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      const preset = createGoogleWorkerBuild({...workerData.options, typescript});
      parentPort.postMessage({registryFile: preset.registryFile, sha256: preset.manifest().registrySha256});
    `, { eval: true, workerData: { api: path.join(f.project, 'build/index.cjs'), typescript: require.resolve('typescript'), gate,
      options: { projectRoot: f.project, outdir: path.join(f.project, 'generated'), profile } } });
    workers.push(worker);
    const ready = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    const done = new Promise((resolve, reject) => {
      worker.on('message', value => { if (value !== 'ready') resolve(value); });
      worker.once('error', reject);
      worker.once('exit', code => { if (code !== 0) reject(new Error(`Registry worker exited ${code}`)); });
    });
    return { ready, done };
  });
  await Promise.all(preparations.map(item => item.ready));
  Atomics.store(new Int32Array(gate), 0, 1);
  Atomics.notify(new Int32Array(gate), 0);
  const [first, same, other] = await Promise.all(preparations.map(item => item.done));
  assert.equal(first.registryFile, same.registryFile);
  assert.notEqual(first.registryFile, other.registryFile);
  for (const receipt of [first, same, other]) assert.equal(hash(fs.readFileSync(receipt.registryFile)), receipt.sha256);
  assert.equal(fs.readdirSync(path.join(f.project, 'generated')).some(name => name.startsWith('.wga-registry-')), false);
  assert.deepEqual((await f.bundle(f.prepare())).value, ['value']);
  assert.deepEqual((await f.bundle(f.prepare('google-modern-v1'), 'codec-b')).value, ['value']);
});

for (const change of ['deleted', 'tampered']) {
  const damage = preset => change === 'deleted' ? fs.unlinkSync(preset.registryFile)
    : fs.writeFileSync(preset.registryFile, 'exports.fromJSON=()=>({lookupType:()=>({fieldsArray:[{name:"unverified"}]})});');

  test(`BUILD ${change} registry fails direct verification and a later build without retaining passed coverage`, async t => {
    const f = fixture(t), preset = f.prepare(), first = await f.bundle(preset);
    assert.equal(preset.manifest().transformCoverage.passed, true);
    damage(preset);
    assert.throws(() => preset.verifyBuild(first.metafile), integrityError);
    assert.equal(preset.manifest().transformCoverage.passed, false);
    await assert.rejects(f.bundle(preset), integrityError);
    assert.equal(preset.manifest().transformCoverage.passed, false);
  });

  test(`BUILD ${change} registry during module loading fails closed`, async t => {
    const f = fixture(t), preset = f.prepare();
    let changed = false;
    const damageDuringLoad = { name: 'change-registry-after-start', setup(build) {
      build.onLoad({ filter: /\.cjs$/ }, args => {
        if (args.path !== path.join(f.project, 'codec-a.cjs')) return;
        damage(preset); changed = true;
      });
    } };
    await assert.rejects(f.bundle(preset, 'codec-a', [damageDuringLoad]), integrityError);
    assert.equal(changed, true);
    assert.equal(preset.manifest().transformCoverage.passed, false);
  });

  test(`BUILD ${change} registry after loading is rejected before a successful build is reported`, async t => {
    const f = fixture(t), preset = f.prepare();
    let changed = false;
    const damageAtEnd = { name: 'change-registry-before-audit', setup(build) {
      build.onEnd(() => { damage(preset); changed = true; });
    } };
    await assert.rejects(f.bundle(preset, 'codec-a', [damageAtEnd]), integrityError);
    assert.equal(changed, true);
    assert.equal(preset.manifest().transformCoverage.passed, false);
  });
}

for (const namespace of ['file', 'registry-copy']) {
  test(`BUILD an earlier plugin cannot replace the ${namespace} registry module while its disk hash remains valid`, async t => {
    const f = fixture(t), preset = f.prepare(), before = fs.readFileSync(preset.registryFile);
    let replaced = false;
    const replaceRegistry = { name: 'replace-generated-registry', setup(build) {
      if (namespace !== 'file') build.onResolve({ filter: /.*/ }, args => args.path === preset.registryFile
        ? { path: preset.registryFile, namespace } : undefined);
      build.onLoad({ filter: /\.cjs$/, namespace }, args => {
        if (args.path !== preset.registryFile) return;
        replaced = true;
        return { contents: 'exports.fromJSON=()=>({lookupType:()=>({fieldsArray:[{name:"unverified"}]})});', loader: 'js' };
      });
    } };
    await assert.rejects(f.bundle(preset, 'codec-a', [replaceRegistry]), integrityError);
    assert.equal(replaced, true);
    assert.deepEqual(fs.readFileSync(preset.registryFile), before, 'source integrity alone cannot prove which plugin supplied the bundled module');
    assert.equal(preset.manifest().transformCoverage.passed, false);
  });
}

test('BUILD actual pinned SDK clients both construct and close after preparing two profiles in one outdir', async t => {
  const scratch = temporary(t), outdir = path.join(scratch, 'generated');
  const { createGoogleWorkerBuild } = require('../src/build/index.cjs');
  const google = path.join(root, 'fixtures/google'), modern = path.join(root, 'fixtures/modern');
  const first = createGoogleWorkerBuild({ projectRoot: google, outdir, profile: 'google-static-v1', typescript: ts });
  let outputs = 0;
  async function construct(projectRoot, preset) {
    const installed = createRequire(path.join(projectRoot, 'package.json'));
    const entry = path.join(scratch, `entry-${++outputs}.cjs`);
    write(entry, `const {v1}=require(${JSON.stringify(installed.resolve('@google-cloud/datastore'))});module.exports=()=>new v1.DatastoreClient({projectId:'wga-registry-local'});`);
    const result = await esbuild.build({ absWorkingDir: projectRoot, entryPoints: [entry], bundle: true,
      platform: 'node', format: 'cjs', write: false, logLevel: 'silent', plugins: [preset.plugin] });
    const output = path.join(scratch, `client-${outputs}.cjs`);
    write(output, result.outputFiles[0].contents);
    const factory = require(output), originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = () => { fetches++; throw new Error('Unexpected RPC or authentication request in constructor-only registry test'); };
    try {
      const client = factory();
      assert.equal(client.constructor.name, 'DatastoreClient');
      await client.close();
      assert.equal(fetches, 0);
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(hash(fs.readFileSync(preset.registryFile)), preset.manifest().registrySha256);
    const coverage = preset.manifest().transformCoverage;
    assert.ok(coverage.required > 0);
    assert.equal(coverage.applied, coverage.required);
    assert.equal(coverage.passed, true);
  }
  await construct(google, first);
  const second = createGoogleWorkerBuild({ projectRoot: modern, outdir, profile: 'google-modern-v1', typescript: ts });
  await construct(google, first);
  await construct(modern, second);
});
