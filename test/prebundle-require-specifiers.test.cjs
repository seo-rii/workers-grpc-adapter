'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const typescript = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');

function fixture(t, source) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-require-specifiers-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return file;
  };
  for (const name of ['index.cjs', 'prebundle.cjs']) write('build/' + name, fs.readFileSync(path.join(__dirname, '../src/build', name)));
  write('build/profiles/google-static-v1.json', {
    id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, revision: 1,
    packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [],
  });
  write('package.json', { private: true, type: 'module' });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'exports.client = () => 17;');
  write('outside.cjs', 'module.exports = "unbundled";');
  write('ordinary.cjs', 'exports.createRequire = () => 23;');
  const bridge = write('bridge.cjs', source);
  const entry = write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; export {probe} from "./bridge.cjs";');
  write('wrapper.d.ts', 'export declare function client(): number; export declare function probe(base: string): unknown;');
  return {
    projectRoot,
    native: () => require(bridge).probe(entry),
    build: () => require(path.join(projectRoot, 'build/prebundle.cjs')).buildGoogleWorkerPrebundle({
      projectRoot, outdir: 'out', entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts',
      exports: ['client', 'probe'], typescript, esbuild,
    }),
  };
}

for (const name of ['module', 'node:module']) {
  const forms = [
    JSON.stringify(name),
    '`' + name + '`',
    '(' + JSON.stringify(name) + ')',
    JSON.stringify(name.slice(0, 2)) + '+' + JSON.stringify(name.slice(2)),
    '`' + name.slice(0, 2) + '${' + JSON.stringify(name.slice(2)) + '}`',
    '`${' + JSON.stringify(name.slice(0, 2)) + '}${' + JSON.stringify(name.slice(2)) + '}`',
  ];
  for (const specifier of forms) {
    test(`PREBUNDLE rejects Node loader obtained from require(${specifier})`, async t => {
      const f = fixture(t, `const selected = require(${specifier});
        exports.probe = base => selected.createRequire(base)('./outside.cjs');`);
      assert.equal(f.native(), 'unbundled');
      await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
      assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
    });
    test(`PREBUNDLE preserves non-loader builtin from require(${specifier})`, async t => {
      const f = fixture(t, `const selected = require(${specifier}); exports.probe = () => selected.isBuiltin('node:fs');`);
      assert.equal(f.native(), true);
      assert.equal(require((await f.build()).bundlePath).probe(), true);
    });
  }
}
for (const specifier of ['`./ordinary.cjs`', '("./ordinary.cjs")', '"./ordinary" + ".cjs"', '`./${"ordinary"}.cjs`']) {
  test(`PREBUNDLE preserves ordinary module from require(${specifier})`, async t => {
    const f = fixture(t, `const selected = require(${specifier}); exports.probe = () => selected.createRequire();`);
    assert.equal(f.native(), 23);
    assert.equal(require((await f.build()).bundlePath).probe(), 23);
  });
}
for (const specifier of ['globalThis.moduleSpecifier', '"node:" + globalThis.moduleSuffix', '`node:${globalThis.moduleSuffix}`']) {
  test(`PREBUNDLE still rejects runtime require(${specifier})`, async t => {
    const f = fixture(t, `const selected = require(${specifier}); exports.probe = base => selected.createRequire(base);`);
    await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  });
}
test('PREBUNDLE resolves constant template substitutions without confusing numeric addition', async t => {
  const f = fixture(t, 'const name = "module"; const selected = require(`node:${name}`); exports.probe = base => selected.createRequire(base);');
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  const ordinary = fixture(t, 'const values = {"2": {createRequire: () => 23}, "11": require("node:module")}; const selected = values[`${1 + 1}`]; exports.probe = () => selected.createRequire();');
  assert.equal(ordinary.native(), 23);
  assert.equal(require((await ordinary.build()).bundlePath).probe(), 23);
});
