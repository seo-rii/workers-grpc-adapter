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


for (const bypassFirst of [false, true]) for (const useContext of [false, true]) {
  test(`BUILD rejects concurrent preset reuse (bypass=${bypassFirst}, context=${useContext}) without lending receipts`, async t => {
    const f = fixture(t, 'hoisted'), preset = f.prepare();
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const pause = { name: 'pause-audit', setup(build) { build.onEnd(async () => { entered(); await blocked; }); } };
    const bypass = { name: 'bypass-source', setup(build) { build.onLoad({ filter: /codec[/\\]index\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'js' })); } };
    const observe = promise => promise.then(result => ({ result }), error => ({ error }));
    let context;
    if (useContext) context = await esbuild.context({ absWorkingDir: f.project, entryPoints: ['entry.cjs'], bundle: true,
      platform: 'node', write: false, logLevel: 'silent', plugins: [...(bypassFirst ? [bypass] : []), pause, preset.plugin] });
    try {
      const first = observe(context ? context.rebuild() : f.bundle(preset, [...(bypassFirst ? [bypass] : []), pause]));
      await waiting;
      let second;
      try { second = await observe(f.bundle(preset)); } finally { release(); }
      const initial = await first;
      assert.match(second.error?.message || '', /WGA_BUILD_CONCURRENT/);
      if (bypassFirst) assert.match(initial.error?.message || '', /WGA_TRANSFORM_COVERAGE/);
      else {
        assert.ok(initial.result);
        assert.equal(initial.result.outputFiles[0].text.includes('Proto.Root.fromJSON({})'), false);
        assert.equal(preset.verifyBuild(initial.result.metafile).passed, true);
      }
      // A rejected overlapping build must release only its own state.
      const recovered = await f.bundle(preset);
      assert.equal(preset.verifyBuild(recovered.metafile).passed, true);
      if (context && !bypassFirst) assert.ok(await context.rebuild());
    } finally { release(); await context?.dispose(); }
  });
}
