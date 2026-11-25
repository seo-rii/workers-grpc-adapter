'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const typescript = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');

function fixture(t, expression, { selection = 'values[index]', extension = 'mjs', loaderIndex = 2, destructure = false } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-property-key-'));
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
  write('package.json', { name: 'property-key-consumer', private: true, type: 'module' });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'exports.client = () => 17;');
  const source = `export {client} from '@grpc/grpc-js'; import mod from 'node:module';
    const ordinary = {createRequire: () => () => 'ordinary'};
    const values = [${Array.from({ length: 12 }, (_, index) => index === loaderIndex ? 'mod' : 'ordinary').join(',')}];
    const one = 1, two = one + one, index = ${expression};
    ${destructure ? 'const {[index]: selected} = values' : `const selected = ${selection}`};
    export function probe(base) { return selected.createRequire(base)('./external.cjs'); }`;
  write('wrapper.' + extension, source);
  const native = write('native.mjs', extension === 'mjs' ? source : typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.ESNext },
  }).outputText);
  write('wrapper.d.ts', 'export declare function client(): number; export declare function probe(base: string): unknown;');
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return {
    projectRoot, write,
    native: async () => (await import(pathToFileURL(native).href)).probe(native),
    build: () => api.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'out', entryPoint: 'wrapper.' + extension,
      declarationFile: 'wrapper.d.ts', exports: ['client', 'probe'], typescript, esbuild }),
  };
}

for (const expression of [
  '1 + 1', '2 + 0', '0 + 1 + 1', '(0 + 1) + (0 + 1)', 'one + one', 'two',
  '0x1 + 0b1', '0o1 + 1e0', '0.5 + 1.5', '1_0 + 0 + ""',
  '2', '"2" + ""', '1 + 1 + ""', '"" + (1 + 1)',
]) test(`PREBUNDLE rejects a loader selected by the computed key ${expression}`, async t => {
  // The separator case selects slot 10; every other case selects slot 2.
  const f = fixture(t, expression, { loaderIndex: expression === '1_0 + 0 + ""' ? 10 : 2 });
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'external.cjs')), false);
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
  f.write('external.cjs', 'module.exports = "created-after-build";');
  assert.equal(await f.native(), 'created-after-build', 'The computed key selects the actual Node loader');
});

for (const selection of [
  'Reflect.get(values, index)',
  'Object.getOwnPropertyDescriptor(values, index).value',
  'Reflect.getOwnPropertyDescriptor(values, index).value',
  'Object.getOwnPropertyDescriptors(values)[index].value',
]) test(`PREBUNDLE checks a numeric key used by ${selection}`, async t => {
  const f = fixture(t, 'one + one', { selection });
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  f.write('external.cjs', 'module.exports = "created-after-build";');
  assert.equal(await f.native(), 'created-after-build');
});

test('PREBUNDLE checks numeric keys in object destructuring', async t => {
  const f = fixture(t, 'one + one', { destructure: true });
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  f.write('external.cjs', 'module.exports = "created-after-build";');
  assert.equal(await f.native(), 'created-after-build');
});

for (const expression of ['(one as number) + (one satisfies number)', '(two!)', '(<number>one) + one']) {
  test(`PREBUNDLE keeps numeric types through TypeScript key wrappers: ${expression}`, async t => {
    const f = fixture(t, expression, { extension: 'ts' });
    await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
    f.write('external.cjs', 'module.exports = "created-after-build";');
    assert.equal(await f.native(), 'created-after-build');
  });
}

for (const expression of ['"1" + 1', '1 + "1"', '"" + 1 + 1', '"1" + (0 + 1)', '1 + ("" + 1)']) {
  test(`PREBUNDLE preserves string concatenation selecting an ordinary slot: ${expression}`, async t => {
    const f = fixture(t, expression);
    const built = await f.build();
    const manifest = JSON.parse(fs.readFileSync(built.manifestPath, 'utf8'));
    assert.equal(manifest.sources.some(source => source.path.includes('external.cjs')), false);
    assert.equal(await f.native(), 'ordinary');
    assert.equal(require(built.bundlePath).probe(), 'ordinary');
  });
}

test('PREBUNDLE keeps a numeric sum selecting an ordinary slot distinct from a loader slot', async t => {
  const f = fixture(t, 'one + one', { loaderIndex: 11 });
  assert.equal(await f.native(), 'ordinary');
  const built = await f.build();
  assert.equal(require(built.bundlePath).probe(), 'ordinary');
});

for (const expression of ['Number("2")', '3 + -1']) {
  test(`PREBUNDLE retains conservative loader origins for an unknown computed key: ${expression}`, async t => {
    const f = fixture(t, expression);
    await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
    f.write('external.cjs', 'module.exports = "created-after-build";');
    assert.equal(await f.native(), 'created-after-build');
  });
}
