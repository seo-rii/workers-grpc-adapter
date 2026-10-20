'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');
function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-module-strictness-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(projectRoot, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return file;
  };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file)));
  write('build/profiles/google-static-v1.json', { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1,
    revision: 1, packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] });
  write('package.json', { name: 'strictness-consumer', private: true });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'const state = {}; exports.client = () => state;');
  write('wrapper.d.ts', 'export declare function client(): object; export declare function inspect(): unknown;');
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return { projectRoot, write, build: options => api.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'out',
    entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts', exports: ['client', 'inspect'], typescript: ts, esbuild, ...options }) };
}


for (const extension of ['mjs', 'js']) test(`PREBUNDLE preserves dynamic CJS import attributes in ${extension}`, async t => {
  const f = fixture(t);
  f.write('package.json', { name: 'strictness-consumer', private: true, type: 'module' });
  f.write('dependency.cjs', 'module.exports = {__esModule: true, default: "inner", kind: "namespace"};');
  const entryPoint = `wrapper.${extension}`;
  const entry = f.write(entryPoint, `export {client} from '@grpc/grpc-js'; export async function inspect(){ return (await import('./dependency.cjs', {with: {}})).default; }`);
  const original = await import(pathToFileURL(entry).href);
  const baseline = await esbuild.build({ absWorkingDir: f.projectRoot, entryPoints: [entryPoint], bundle: true,
    platform: 'node', format: 'cjs', target: 'es2022', minify: true, write: false });
  const previous = require(f.write('baseline.cjs', baseline.outputFiles[0].text));
  const expected = await original.inspect();
  assert.deepEqual(await previous.inspect(), expected, 'the first compilation agrees with Node');
  const built = await f.build({ entryPoint });
  const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
  assert.deepEqual(await cjs.inspect(), expected);
  assert.deepEqual(await esm.inspect(), expected);
  assert.deepEqual(expected, {__esModule: true, default: 'inner', kind: 'namespace'});
});

test('PREBUNDLE preserves captured JSON import attributes', async t => {
  const f = fixture(t);
  f.write('data.json', { __esModule: true, default: 'inner', label: 'json namespace' });
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export async function inspect(){ return (await import('./data.json', {with: {type: 'json'}})).default; }`);
  const original = await import(pathToFileURL(entry).href);
  const built = await f.build();
  assert.deepEqual(await require(built.bundlePath).inspect(), await original.inspect());
});

for (const other of ['other.cjs', 'other.mjs']) test(`PREBUNDLE preserves conditional import attributes with ${other}`, async t => {
  const f = fixture(t);
  f.write('dependency.cjs', 'module.exports = {__esModule: true, default: "inner", kind: "namespace"};');
  f.write('other.cjs', 'module.exports = {__esModule: true, default: "other", kind: "namespace"};');
  f.write('other.mjs', 'export default {kind: "esm"};');
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export async function inspect(flag){
    const trace = []; const choose = () => { trace.push('choose'); return flag; };
    const result = import(choose() ? './dependency.cjs' : './${other}', {with: {}});
    trace.push('requested'); return {value: (await result).default, trace};
  }`);
  const original = await import(pathToFileURL(entry).href);
  const built = await f.build();
  const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
  for (const flag of [true, false]) {
    const expected = await original.inspect(flag);
    assert.deepEqual(await cjs.inspect(flag), expected);
    assert.deepEqual(await esm.inspect(flag), expected);
    assert.deepEqual(expected.trace, ['choose', 'requested']);
  }
});

test('PREBUNDLE import attributes retain the captured package import condition', async t => {
  const f = fixture(t);
  f.write('node_modules/conditional/package.json', { name: 'conditional', exports: {import: './import.cjs', require: './require.cjs'} });
  f.write('node_modules/conditional/import.cjs', 'module.exports = {__esModule: true, default: "inner", condition: "import"};');
  f.write('node_modules/conditional/require.cjs', 'module.exports = {condition: "require"};');
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export async function inspect(){ return (await import('conditional', {with: {}})).default; }`);
  const original = await import(pathToFileURL(entry).href);
  const built = await f.build();
  assert.deepEqual(await require(built.bundlePath).inspect(), await original.inspect());
  assert.equal((await original.inspect()).condition, 'import');
});

for (const options of ['{}', '{ get with() { throw new Error("options"); } }', '{with: {}, ...sideEffect()}']) {
  test(`PREBUNDLE still rejects uncaptured runtime import options: ${options}`, async t => {
    const f = fixture(t);
    f.write('dependency.cjs', 'module.exports = {__esModule: true, default: "inner"};');
    f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; function sideEffect(){ throw new Error('options'); } export async function inspect(){ return import('./dependency.cjs', ${options}); }`);
    await assert.rejects(f.build());
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
  });
}
