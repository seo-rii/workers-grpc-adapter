'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');

function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-esm-graph-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(projectRoot, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file), 'utf8'));
  write('build/profiles/google-static-v1.json', { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1,
    revision: 1, packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] });
  write('package.json', { name: 'esm-graph-consumer', private: true });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'const state = {}; exports.client = () => state;');
  write('wrapper.d.ts', 'export declare function client(): object; export declare function inspect(): unknown;');
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return { projectRoot, write, async outputs() {
    const built = await api.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'out', entryPoint: 'wrapper.mjs',
      declarationFile: 'wrapper.d.ts', exports: ['client', 'inspect'], typescript: ts, esbuild });
    const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
    assert.strictEqual(cjs.client(), esm.client());
    return [cjs, esm];
  } };
}

for (const mode of ['indirect-cycle', 'direct-cycle', 'reexport-first', 'acyclic']) {
  test(`PREBUNDLE preserves instantiated ESM function bindings in ${mode}`, async t => {
    const f = fixture(t);
    const exported = mode === 'direct-cycle' ? 'export function value(){ return "hoisted function"; }' : 'export {value} from "./c.mjs";';
    const imported = 'import {result} from "./b.mjs";';
    f.write('a.mjs', (mode === 'reexport-first' ? exported + imported : imported + exported) + 'export function inspect(){ return result; }');
    f.write('b.mjs', `import {value} from './${mode === 'acyclic' ? 'c' : 'a'}.mjs'; export const result = value();`);
    f.write('c.mjs', 'export function value(){ return "hoisted function"; }');
    const entry = f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; export {inspect} from "./a.mjs";');
    assert.equal((await import(pathToFileURL(entry).href)).inspect(), 'hoisted function');
    for (const value of await f.outputs()) assert.equal(value.inspect(), 'hoisted function');
  });
}

test('PREBUNDLE retains one ESM namespace for static, re-exported, and dynamic imports', async t => {
  const f = fixture(t);
  f.write('helper.mjs', 'export let value = 1; export const state = {}; export default () => value; export function update(){ value++; }');
  f.write('a.mjs', 'import * as namespace from "./helper.mjs"; export {namespace};');
  f.write('b.mjs', 'export * as namespace from "./helper.mjs";');
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js';
    import * as namespace from './helper.mjs'; import {namespace as a} from './a.mjs'; import {namespace as b} from './b.mjs';
    export async function inspect(){
      const first = await import('./helper.mjs'), second = await import('./helper.mjs');
      const before = namespace.value; namespace.update();
      return {static: namespace === a && a === b, dynamic: first === second, mixed: namespace === first,
        state: namespace.state === a.state, default: namespace.default === first.default, live: namespace.value === before + 1 && first.value === namespace.value};
    }`);
  const expected = { static: true, dynamic: true, mixed: true, state: true, default: true, live: true };
  assert.deepEqual(await (await import(pathToFileURL(entry).href)).inspect(), expected);
  for (const value of await f.outputs()) assert.deepEqual(await value.inspect(), expected);
});

test('PREBUNDLE keeps dynamically imported ESM lazy and evaluates it once', async t => {
  const f = fixture(t);
  f.write('state.cjs', 'module.exports = {count: 0};');
  f.write('lazy.mjs', 'import state from "./state.cjs"; state.count++; export default () => state.count;');
  f.write('unselected.mjs', 'throw new Error("unselected module"); export default null;');
  f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; import state from './state.cjs';
    export async function inspect(flag = true){ const before = state.count;
      const first = await import(flag ? './lazy.mjs' : './unselected.mjs'), second = await import('./lazy.mjs');
      return [before, state.count, first === second, first.default()]; }`);
  const [cjs, esm] = await f.outputs();
  assert.deepEqual(await cjs.inspect(), [0, 1, true, 1]);
  assert.deepEqual(await esm.inspect(), [1, 1, true, 1]);
  await assert.rejects(cjs.inspect(false), /unselected module/);
});

test('PREBUNDLE shares the ESM namespace with a sloppy CJS dynamic importer and shadowed require', async t => {
  const f = fixture(t);
  f.write('helper.mjs', 'export default () => "default"; export const state = {};');
  f.write('bridge.cjs', `var require = () => { throw new Error('shadowed require'); };
    exports.inspect = async namespace => { const imported = await import('./helper.mjs');
      return [imported === namespace, imported.default(), (function(value){ arguments[0] = 2; return value; })(1),
        (function(){ return this; })() === globalThis]; };`);
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js';
    import * as namespace from './helper.mjs'; import bridge from './bridge.cjs';
    export function inspect(){ return bridge.inspect(namespace); }`);
  const expected = [true, 'default', 2, true];
  assert.deepEqual(await (await import(pathToFileURL(entry).href)).inspect(), expected);
  for (const value of await f.outputs()) assert.deepEqual(await value.inspect(), expected);
});

test('PREBUNDLE preserves require(ESM) default interop separately from import namespaces', async t => {
  const f = fixture(t);
  f.write('helper.mjs', 'export default () => "default"; export const state = {};');
  f.write('bridge.cjs', `const imported = require('./helper.mjs');
    exports.inspect = () => [imported.__esModule, imported.default(), imported === require('./helper.mjs')];`);
  f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; import bridge from './bridge.cjs';
    export function inspect(){ const first = require('./helper.mjs');
      return [...bridge.inspect(), first === require('./helper.mjs')]; }`);
  for (const value of await f.outputs()) assert.deepEqual(value.inspect(), [true, 'default', true, true]);
});

test('PREBUNDLE retains static dependency side-effect order', async t => {
  const f = fixture(t);
  f.write('state.cjs', 'module.exports = [];');
  f.write('d.mjs', 'import state from "./state.cjs"; state.push("d");');
  f.write('b.mjs', 'import "./d.mjs"; import state from "./state.cjs"; state.push("b");');
  f.write('c.mjs', 'import state from "./state.cjs"; state.push("c");');
  f.write('a.mjs', 'import "./b.mjs"; import "./c.mjs"; import state from "./state.cjs"; state.push("a");');
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; import state from './state.cjs'; import './a.mjs';
    export function inspect(){ return state; }`);
  const expected = ['d', 'b', 'c', 'a'];
  assert.deepEqual((await import(pathToFileURL(entry).href)).inspect(), expected);
  for (const value of await f.outputs()) assert.deepEqual(value.inspect(), expected);
});

test('PREBUNDLE keeps the audited CJS to ESM to CJS cycle', async t => {
  const f = fixture(t);
  f.write('state.cjs', 'module.exports = [];');
  f.write('bridge.cjs', `const state = require('./state.cjs'); state.push('cjs-start');
    exports.value = () => 'from CJS'; const leaf = require('./leaf.mjs');
    exports.result = leaf.fromCjs(); state.push('cjs-end');`);
  f.write('leaf.mjs', 'import bridge from "./bridge.cjs"; export function fromCjs(){ return bridge.value(); }');
  f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; import bridge from './bridge.cjs'; import state from './state.cjs';
    export function inspect(){ return [bridge.result, state]; }`);
  const baseline = await esbuild.build({ absWorkingDir: f.projectRoot, entryPoints: ['wrapper.mjs'],
    bundle: true, format: 'cjs', platform: 'node', target: 'es2022', write: false });
  const expected = require(f.write('baseline.cjs', baseline.outputFiles[0].text)).inspect();
  assert.deepEqual(expected, ['from CJS', ['cjs-start', 'cjs-end']]);
  for (const value of await f.outputs()) assert.deepEqual(value.inspect(), expected);
});
