'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const ts = require('typescript');
const { createGoogleWorkerBuild } = require('../src/build/index.cjs');
const root = path.resolve(__dirname, '..');
const projectRoot = path.join(root, 'fixtures/google');
const buildSource = fs.readFileSync(path.join(root, 'src/build/index.cjs'), 'utf8');
const sourcePath = 'node_modules/gaxios/build/cjs/src/gaxios.js';
const upstream = fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-build-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function loader(preset) {
  let onLoad;
  preset.plugin.setup({ onLoad(options, callback) { onLoad = callback; } });
  return onLoad;
}

test('BUILD pinned Gaxios uses native Fetch and preserves explicit fetch precedence', async t => {
  const preset = createGoogleWorkerBuild({ projectRoot, outdir: temporary(t), typescript: ts });
  const onLoad = loader(preset);
  const cjs = onLoad({ path: path.join(projectRoot, sourcePath) });
  const esm = onLoad({ path: path.join(projectRoot, 'node_modules/gaxios/build/esm/src/gaxios.js') });
  assert.ok(esm.contents.includes('config.fetchImplementation || this.defaults.fetchImplementation || globalThis.fetch'));
  const calls = [];
  const fetcher = label => async () => { calls.push(label); return Response.json({ label }); };
  // The isolated context supplies a fetch without mutating Node's global or any
  // installed module. The real transformed Gaxios method handles the response.
  const module = { exports: {} };
  vm.runInNewContext(cjs.contents, { module, exports: module.exports,
    require: createRequire(path.join(projectRoot, sourcePath)), globalThis: { fetch: fetcher('native') },
    Headers, URL, URLSearchParams, Response, Buffer }, { filename: 'pinned-gaxios.cjs' });
  const { Gaxios } = module.exports;
  const options = { url: 'https://auth.fixture.invalid/token', method: 'POST', responseType: 'json' };
  const normal = new Gaxios();
  assert.equal((await normal._defaultAdapter(options)).data.label, 'native');
  const custom = new Gaxios({ fetchImplementation: fetcher('client') });
  assert.equal((await custom._defaultAdapter(options)).data.label, 'client');
  assert.equal((await custom._defaultAdapter({ ...options, fetchImplementation: fetcher('request') })).data.label, 'request');
  assert.deepEqual(calls, ['native', 'client', 'request']);
  assert.deepEqual(preset.manifest().transformed.map(item => item.nativeFetchDefaults), [1, 1]);
  assert.equal(preset.manifest().revision, 5);
  assert.equal(preset.manifest().nodeModulesModified, false);
  assert.equal(preset.manifest().globalPrototypePatched, false);
  assert.equal(fs.readFileSync(path.join(projectRoot, sourcePath), 'utf8'), upstream);
});

test('BUILD Gaxios transport transform rejects source drift and unexpected AST anchors', t => {
  const directory = temporary(t);
  const fixtures = [
    { name: 'hash', source: upstream + '\n// drift\n', expected: 'WGA_SCHEMA_MISMATCH', hash: sha256(upstream) },
    { name: 'missing', source: upstream.replace('const fetchImpl =', 'const renamed ='), expected: 'WGA_SCHEMA_MISMATCH' },
    { name: 'selector', source: upstream.replace('this.defaults.fetchImplementation ||', 'this.defaults.otherFetch ||'), expected: 'WGA_SCHEMA_MISMATCH' },
    { name: 'method', source: upstream.replace('async _defaultAdapter(config)', 'async otherAdapter(config)'), expected: 'WGA_SCHEMA_MISMATCH' },
    { name: 'duplicate', source: upstream.replace('const preparedOpts = { ...config };', 'const fetchImpl = config.fetchImplementation || this.defaults.fetchImplementation || (await _a.#getFetch());\nconst preparedOpts = { ...config };'), expected: 'WGA_SCHEMA_MISMATCH' },
  ];
  for (const fixture of fixtures) {
    const folder = path.join(directory, fixture.name);
    const source = path.join(folder, sourcePath);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.join(folder, 'build/profiles'), { recursive: true });
    fs.writeFileSync(source, fixture.source);
    fs.writeFileSync(path.join(folder, 'build/index.cjs'), buildSource);
    // An isolated profile trusts this fixture's bytes to independently exercise
    // structural guards; installed packages and the real profile stay intact.
    fs.writeFileSync(path.join(folder, 'build/profiles/google-static-v1.json'), JSON.stringify({
      id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, capabilities: [], requiredChecks: [], revision: 3, packages: [], files: [{ path: sourcePath, sha256: fixture.hash || sha256(fixture.source), transforms: [{ rule: 'native-fetch-default', expectedMatches: 1 }] }], schemas: [], codegenInputs: [], loaderOptions: {},
    }));
    const build = require(path.join(folder, 'build/index.cjs'));
    assert.throws(() => {
      const preset = build.createGoogleWorkerBuild({ projectRoot: folder, outdir: path.join(folder, 'out'), typescript: ts });
      loader(preset)({ path: source });
    }, error => error.code === fixture.expected, fixture.name);
  }
});
