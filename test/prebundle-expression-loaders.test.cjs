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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-expression-'));
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
  write('package.json', { name: 'expression-consumer', private: true, type: 'module' });
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
  ['conditional', 'const selected = globalThis.pickModule ? mod : mod;'],
  ['logical or', 'const selected = globalThis.pickModule || mod;'],
  ['logical and', 'const selected = mod && mod;'],
  ['nullish', 'const selected = globalThis.pickModule ?? mod;'],
  ['comma', 'const selected = (0, mod);'],
  ['array member', 'const selected = [mod][0];'],
  ['aliased array', 'const values = [mod]; const selected = values[0];'],
  ['array with holes', 'const selected = [,,mod][2];'],
  ['computed array member', 'const values = [mod]; const selected = values[globalThis.moduleIndex ?? 0];'],
  ['nested arrays', 'const selected = [[mod]][0][0];'],
  ['cyclic aliases', 'let selected, other; selected = globalThis.pickModule ? other : mod; other = selected;'],
];
for (const [name, selection] of selections) {
  test(`PREBUNDLE rejects Node loaders through ${name}`, async t => {
    const f = fixture(t, `import mod from 'node:module'; ${selection}
      export function probe(base) { return selected.createRequire(base)('./outside.cjs'); }`);
    assert.equal(await f.native(), 'unbundled', 'The selected value is a real Node namespace');
    await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
  });
  test(`PREBUNDLE preserves non-loading builtins through ${name}`, async t => {
    const f = fixture(t, `import mod from 'node:module'; ${selection}
      export function probe() { return selected.isBuiltin('node:fs'); }`);
    assert.equal(await f.native(), true);
    const built = await f.build();
    assert.equal(require(built.bundlePath).probe(), true);
  });
  test(`PREBUNDLE preserves ordinary objects through ${name}`, async t => {
    const f = fixture(t, `const mod = {createRequire: () => 23}; ${selection}
      export function probe() { return selected.createRequire(); }`);
    assert.equal(await f.native(), 23);
    const built = await f.build();
    assert.equal(require(built.bundlePath).probe(), 23);
  });
}

test('PREBUNDLE does not assign a discarded comma operand to its result', async t => {
  const f = fixture(t, `import mod from 'node:module'; const ordinary = {createRequire: () => 23};
    const selected = (mod, ordinary); export function probe() { return selected.createRequire(); }`);
  assert.equal(await f.native(), 23);
  assert.equal(require((await f.build()).bundlePath).probe(), 23);
});

test('PREBUNDLE keeps static array members distinct', async t => {
  const f = fixture(t, `import mod from 'node:module'; const values = [mod, {createRequire: () => 23}];
    export function probe() { return values[1].createRequire(); }`);
  assert.equal(await f.native(), 23);
  assert.equal(require((await f.build()).bundlePath).probe(), 23);
});

test('PREBUNDLE keeps array entries preceding a spread distinct', async t => {
  const f = fixture(t, `import mod from 'node:module'; const values = [mod];
    const selected = [{createRequire: () => 23}, ...values][0]; export function probe() { return selected.createRequire(); }`);
  assert.equal(await f.native(), 23);
  assert.equal(require((await f.build()).bundlePath).probe(), 23);
});

for (const expression of ['[...[mod], {createRequire: () => 23}][1]', '[...values, {createRequire: () => 23}][1]']) {
  test(`PREBUNDLE does not guess positions after a spread: ${expression}`, async t => {
    const f = fixture(t, `import mod from 'node:module'; const values = [mod];
      const selected = ${expression}; export function probe() { return selected.createRequire(); }`);
    assert.equal(await f.native(), 23);
    assert.equal(require((await f.build()).bundlePath).probe(), 23);
  });
}

for (const [name, expression] of [
  ['duplicate property', '{native: mod, native: {createRequire: () => 23}}'],
  ['spread overwrite', '{native: mod, ...{native: {createRequire: () => 23}}}'],
  ['explicit after spread', '{...{native: mod}, native: {createRequire: () => 23}}'],
  ['computed overwrite', '{native: mod, [key]: {createRequire: () => 23}}'],
]) test(`PREBUNDLE preserves an ordinary ${name}`, async t => {
  const f = fixture(t, `import mod from 'node:module'; const key = 'native';
    const selected = (${expression}).native; export function probe() { return selected.createRequire(); }`);
  assert.equal(await f.native(), 23);
  assert.equal(require((await f.build()).bundlePath).probe(), 23);
});

for (const kind of ['conditional', 'array']) for (const cyclic of [false, true]) test(`PREBUNDLE bounds ${kind} alias graph traversal with cyclic=${cyclic}`, () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/build/prebundle.cjs'), 'utf8');
  const start = source.indexOf('function bindSources('), end = source.indexOf('function checkExportStability(');
  const check = new Function('require', 'path', 'fail', source.slice(start, end) + '; return checkModuleLoaders;')(
    require, path, (code, message) => { throw Object.assign(new Error(message), { code }); });
  const layers = 24, limit = 64 * layers ** 2;
  let lookups = 0;
  const measuredTs = { ...typescript, createProgram(...args) {
    const program = typescript.createProgram(...args), checker = program.getTypeChecker();
    return { ...program, getTypeChecker: () => ({ ...checker, getSymbolAtLocation(node) {
      assert.ok(++lookups <= limit, 'Repeatedly expanded the same expression alias graph');
      return checker.getSymbolAtLocation(node);
    } }) };
  } };
  let contents = cyclic ? 'import mod from "node:module"; let current0, loop; current0 = globalThis.pickModule ? loop : mod; loop = current0;\n'
    : 'import current0 from "node:module";\n';
  for (let index = 1; index <= layers; index++) {
    const previous = `current${index - 1}`;
    contents += `const current${index} = ${kind === 'conditional' ? `globalThis.pickModule ? ${previous} : ${previous}` : `[${previous}, ${previous}][0]`};\n`;
  }
  contents += `export function probe() { return current${layers}.isBuiltin('node:fs'); }`;
  check(measuredTs, [{ input: 'wrapper.mjs', source: { physical: path.join(__dirname, '__expression_graph__/wrapper.mjs'), contents: Buffer.from(contents) },
    info: { format: 'esm', imports: [{ kind: 'import-statement', path: 'node:module', external: true }] } }]);
  assert.ok(lookups <= limit);
});
