'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');
function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-esm-default-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(projectRoot, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file), 'utf8'));
  write('build/profiles/google-static-v1.json', { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1,
    revision: 1, packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] });
  write('package.json', { name: 'esm-default-consumer', private: true });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'const state = {}; exports.client = () => state;');
  const exports = ['client', 'forwarded', 'forwardedNamespace', 'inspect'];
  write('wrapper.d.ts', exports.map(name => `export declare const ${name}: unknown;`).join('\n'));
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return { projectRoot, write, build: options => api.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'out',
    entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts', exports, typescript: ts, esbuild, ...options }) };
}
const helper = `export let state = 'before'; export default function make() { return state; }
  export const label = 'ESM namespace';
  export function replace(flag) { state = flag ? 'after' : 'before'; }`;
for (const scope of ['mjs', 'package-module', 'mts', 'babel']) {
  test(`PREBUNDLE preserves static ESM default and namespace imports in ${scope}`, async t => {
    const f = fixture(t);
    const entryPoint = `scope/wrapper.${scope === 'mjs' ? 'mjs' : scope === 'mts' ? 'mts' : 'js'}`;
    f.write('scope/package.json', { type: scope === 'package-module' ? 'module' : 'commonjs' });
    f.write('scope/helper.mjs', helper);
    const entry = f.write(entryPoint, `export {client} from '@grpc/grpc-js';
      import make, * as namespace from './helper.mjs';
      import {default as namedDefault, replace, state} from './helper.mjs';
      export {default as forwarded} from './helper.mjs';
      export * as forwardedNamespace from './helper.mjs';
      export function inspect() {
        replace(false);
        const before = [make(), namedDefault(), namespace.default(), state, namespace.state];
        replace(true);
        return { before, after: [make(), namedDefault(), namespace.default(), state, namespace.state],
          same: make === namespace.default && make === namedDefault, label: namespace.label };
      }`);
    const baseline = await esbuild.build({ absWorkingDir: f.projectRoot, entryPoints: [entry], bundle: true,
      format: 'cjs', platform: 'node', target: 'es2022', minify: true, write: false });
    const flat = require(f.write('baseline.cjs', baseline.outputFiles[0].text));
    const expected = { before: ['before', 'before', 'before', 'before', 'before'], after: ['after', 'after', 'after', 'after', 'after'], same: true, label: 'ESM namespace' };
    assert.deepEqual(flat.inspect(), expected);
    if (scope === 'mjs' || scope === 'package-module') assert.deepEqual((await import(pathToFileURL(entry).href)).inspect(), expected);
    const built = await f.build({ entryPoint });
    const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
    for (const value of [cjs, esm]) {
      assert.deepEqual(value.inspect(), expected);
      assert.equal(value.forwarded(), 'after');
      assert.equal(value.forwardedNamespace.default(), 'after');
      assert.strictEqual(value.forwarded, value.forwardedNamespace.default, 're-exported defaults share the original function');
    }
    assert.strictEqual(cjs.client(), esm.client(), 'CJS and ESM consumers share the adapter runtime');
  });
}

test('PREBUNDLE keeps ESM default imports distinct from Node/Babel CJS interop and require conditions', async t => {
  const f = fixture(t);
  f.write('node_modules/conditional/package.json', { name: 'conditional', exports: { import: './import.mjs', require: './require.cjs' } });
  f.write('node_modules/conditional/import.mjs', 'export default () => "import";');
  f.write('node_modules/conditional/require.cjs', 'module.exports = () => "require";');
  f.write('dependency.cjs', 'module.exports = {__esModule: true, default: "inner", kind: "CJS namespace"};');
  f.write('babel.js', 'import value from "./dependency.cjs"; export function inspect(){ return value; }');
  f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js';
    import imported from 'conditional'; import nodeCjs from './dependency.cjs'; import {inspect as babelCjs} from './babel.js';
    export {default as forwarded} from 'conditional'; export * as forwardedNamespace from 'conditional';
    export function inspect() { return [imported(), require('conditional')(), nodeCjs, babelCjs()]; }`);
  const built = await f.build();
  const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
  for (const value of [cjs, esm]) {
    assert.deepEqual(value.inspect(), ['import', 'require', {__esModule: true, default: 'inner', kind: 'CJS namespace'}, 'inner']);
    assert.equal(value.forwarded(), 'import');
    assert.equal(value.forwardedNamespace.default(), 'import');
  }
});

test('PREBUNDLE keeps user helper calls and shadowed require distinct from generated interop', async t => {
  const f = fixture(t);
  f.write('helper.mjs', 'export default () => "ESM default";');
  f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js';
    import make from './helper.mjs';
    export {default as forwarded} from './helper.mjs'; export * as forwardedNamespace from './helper.mjs';
    function __toESM(value, mode) { return [value, mode]; }
    function shadowed(require) { return __toESM(require('wga-captured-import:1'), 1); }
    export function inspect() { return [make(), shadowed(value => value)]; }`);
  const built = await f.build();
  assert.deepEqual(require(built.bundlePath).inspect(), ['ESM default', ['wga-captured-import:1', 1]]);
});
