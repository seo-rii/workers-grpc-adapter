'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const typescript = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');

function fixture(t, source) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-destructuring-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  function write(name, value) {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return file;
  }
  for (const name of ['index.cjs', 'prebundle.cjs']) write('build/' + name, fs.readFileSync(path.join(__dirname, '../src/build', name)));
  write('build/profiles/google-static-v1.json', {
    id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, revision: 1,
    packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [],
  });
  write('package.json', { name: 'destructuring-consumer', private: true, type: 'module' });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'exports.client = () => 17;');
  write('outside.cjs', 'module.exports = "unbundled";');
  const entry = write('wrapper.mjs', 'export {client} from "@grpc/grpc-js";\n' + source);
  write('wrapper.d.ts', 'export declare function client(): number; export declare function probe(base: string): unknown;');
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return {
    projectRoot,
    native: async () => (await import(pathToFileURL(entry).href)).probe(entry),
    build: () => api.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'out', entryPoint: 'wrapper.mjs',
      declarationFile: 'wrapper.d.ts', exports: ['client', 'probe'], typescript, esbuild }),
  };
}

const selections = [
  ['array binding', 'const [selected] = [mod];'],
  ['aliased array binding', 'const values = [mod]; const [selected] = values;'],
  ['array holes', 'const [,,selected] = [null, null, mod];'],
  ['nested array binding', 'const [[selected]] = [[mod]];'],
  ['array inside object binding', 'const {0:[selected]} = [[mod]];'],
  ['object inside array binding', 'const [{0:selected}] = [[mod]];'],
  ['object default', 'const {selected = mod} = {};'],
  ['renamed object default', 'const {value:selected = mod} = {};'],
  ['nested object default', 'const {value:{selected = mod}} = {value:{}};'],
  ['array default', 'const [selected = mod] = [];'],
  ['nested array default', 'const [[selected] = [mod]] = [];'],
  ['array assignment', 'let selected; [selected] = [mod];'],
  ['object assignment', 'let selected; ({0:selected} = [mod]);'],
  ['nested assignment', 'let selected; ({0:[selected]} = [[mod]]);'],
  ['array assignment default', 'let selected; [selected = mod] = [];'],
  ['object shorthand assignment default', 'let selected; ({selected = mod} = {});'],
  ['object renamed assignment default', 'let selected; ({value:selected = mod} = {});'],
  ['nested assignment default', 'let selected; [[selected] = [mod]] = [];'],
  ['array rest binding', 'const [,...values] = [null, mod]; const [selected] = values;'],
  ['array rest assignment', 'let values; [,...values] = [null, mod]; const [selected] = values;'],
  ['nested array rest binding', 'const [,...[selected]] = [null, mod];'],
  ['nested array rest assignment', 'let selected; [,...[selected]] = [null, mod];'],
  ['object rest binding', 'const {...selected} = mod;'],
  ['object rest assignment', 'let selected; ({...selected} = mod);'],
];
for (const [name, selection] of selections) {
  test(`PREBUNDLE rejects Node loaders through ${name}`, async t => {
    const f = fixture(t, `import mod from 'node:module'; ${selection}
      export function probe(base) { return selected.createRequire(base)('./outside.cjs'); }`);
    assert.equal(await f.native(), 'unbundled');
    await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
  });
  test(`PREBUNDLE preserves non-loading builtins through ${name}`, async t => {
    const f = fixture(t, `import mod from 'node:module'; ${selection}
      export function probe() { return selected.isBuiltin('node:fs'); }`);
    assert.equal(await f.native(), true);
    assert.equal(require((await f.build()).bundlePath).probe(), true);
  });
  test(`PREBUNDLE preserves ordinary values through ${name}`, async t => {
    const f = fixture(t, `const mod = {createRequire: () => 23}; ${selection}
      export function probe() { return selected.createRequire(); }`);
    assert.equal(await f.native(), 23);
    assert.equal(require((await f.build()).bundlePath).probe(), 23);
  });
}
for (const [name, selection] of [
  ['fixed slot binding', 'const [selected] = [ordinary, mod];'],
  ['fixed slot assignment', 'let selected; [selected] = [ordinary, mod];'],
  ['fixed nested slot', 'const [[, selected]] = [[mod, ordinary]];'],
  ['rest binding offset', 'const [,...values] = [mod, ordinary, mod]; const [selected] = values;'],
  ['rest assignment offset', 'let values; [,...values] = [mod, ordinary, mod]; const [selected] = values;'],
  ['nested rest offset', 'const [,...[, selected]] = [mod, mod, ordinary];'],
  ['spread source', 'const [selected] = [ordinary, ...[mod]];'],
  ['spread source rest', 'const [,...values] = [mod, ordinary, ...[mod]]; const [selected] = values;'],
]) test(`PREBUNDLE preserves an ordinary ${name}`, async t => {
  const f = fixture(t, `import mod from 'node:module'; const ordinary = {createRequire: () => 23};
    ${selection} export function probe() { return selected.createRequire(); }`);
  assert.equal(await f.native(), 23);
  assert.equal(require((await f.build()).bundlePath).probe(), 23);
});

test('PREBUNDLE retains a default namespace origin after a later assignment', async t => {
  const f = fixture(t, `import mod from 'node:module'; let selected;
    [selected = mod] = []; selected = {createRequire: () => 23};
    export function probe() { return selected.createRequire(); }`);
  assert.equal(await f.native(), 23);
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
});
