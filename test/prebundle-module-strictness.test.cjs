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
const strictModule = `export function inspect() {
  function frozen() { const value = Object.freeze({x: 1}); value.x = 2; }
  function unbound() { return this; }
  function argumentsAlias(value) { arguments[0] = 2; return value; }
  function undeclared() { wgaPrebundleStrictAssignment = 1; }
  let frozenError; try { frozen(); } catch (error) { frozenError = error.name; }
  let assignmentError; try { undeclared(); } catch (error) { assignmentError = error.name; }
  finally { delete globalThis.wgaPrebundleStrictAssignment; }
  return { frozenError, assignmentError, unboundThis: unbound() === undefined, argumentsValue: argumentsAlias(1) };
}`;
for (const imported of [false, true]) {
  test(`PREBUNDLE preserves implicit ESM strictness in ${imported ? 'a dependency' : 'the entry'} and sloppy CJS`, async t => {
    const f = fixture(t);
    f.write('sloppy.cjs', 'exports.inspect = function(value) { const frozen = Object.freeze({x: 1}); frozen.x = 2; arguments[0] = 2; return {frozen: frozen.x, globalThis: this === globalThis, argument: value}; };');
    const body = strictModule.replace('return { frozenError,', 'return { sloppy: (0, sloppy.inspect)(1), frozenError,');
    const source = 'import sloppy from "./sloppy.cjs";\n' + body;
    f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js";\n' + (imported ? 'export {inspect} from "./helper.mjs";' : source));
    if (imported) f.write('helper.mjs', source);
    const original = await import(pathToFileURL(path.join(f.projectRoot, 'wrapper.mjs')).href);
    const expected = original.inspect();
    assert.deepEqual(expected, { sloppy: { frozen: 1, globalThis: true, argument: 2 }, frozenError: 'TypeError', assignmentError: 'ReferenceError', unboundThis: true, argumentsValue: 1 });
    const built = await f.build();
    fs.renameSync(built.outdir, path.join(f.projectRoot, 'relocated'));
    const cjs = require(path.join(f.projectRoot, 'relocated/index.cjs'));
    const esm = await import(pathToFileURL(path.join(f.projectRoot, 'relocated/index.mjs')).href);
    assert.deepEqual(cjs.inspect(), expected); assert.deepEqual(esm.inspect(), expected);
    assert.strictEqual(cjs.client(), esm.client(), 'both consumers own one adapter state');
  });
}

test('PREBUNDLE preserves strict top-level ESM execution without making CJS strict', async t => {
  const f = fixture(t);
  f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; const frozen = Object.freeze({x: 1}); let result; try { frozen.x = 2; } catch(error) { result = error.name; } export function inspect(){ return result; }');
  const built = await f.build();
  assert.equal(require(built.bundlePath).inspect(), 'TypeError');
});

test('PREBUNDLE preserves an ESM hashbang entry when adding a strict module factory', async t => {
  const f = fixture(t);
  f.write('wrapper.mjs', '#!/usr/bin/env node\nexport {client} from "@grpc/grpc-js";\n' + strictModule);
  const built = await f.build();
  assert.deepEqual(require(built.bundlePath).inspect(), { frozenError: 'TypeError', assignmentError: 'ReferenceError', unboundThis: true, argumentsValue: 1 });
});

for (const moduleScope of [false, true]) {
  test(`PREBUNDLE preserves ${moduleScope ? 'Node ESM' : 'Babel'} default import interop from a .js file`, async t => {
    const f = fixture(t);
    f.write('scope/package.json', { type: moduleScope ? 'module' : 'commonjs' });
    f.write('scope/dependency.cjs', 'module.exports = {__esModule: true, default: "inner", kind: "namespace"};');
    f.write('scope/wrapper.js', 'export {client} from "@grpc/grpc-js"; import value from "./dependency.cjs"; export function inspect(){ return value; }');
    const built = await f.build({ entryPoint: 'scope/wrapper.js' });
    assert.deepEqual(require(built.bundlePath).inspect(), moduleScope ? { __esModule: true, default: 'inner', kind: 'namespace' } : 'inner');
  });
}

test('PREBUNDLE retains captured import/require conditions and TypeScript class lowering', async t => {
  const f = fixture(t);
  f.write('node_modules/conditional/package.json', { name: 'conditional', exports: { import: './import.cjs', require: './require.cjs' } });
  f.write('node_modules/conditional/import.cjs', 'exports.value = "import";');
  f.write('node_modules/conditional/require.cjs', 'exports.value = "require";');
  f.write('tsconfig.json', { compilerOptions: { useDefineForClassFields: false } });
  f.write('wrapper.ts', `export {client} from '@grpc/grpc-js'; import {value} from 'conditional';
    const required = require('conditional');
    class Base { set field(value: number) { this.observed = value; } observed?: number; }
    class Derived extends Base { field = 7; }
    export function inspect(){ return [value, required.value, new Derived().observed]; }`);
  const built = await f.build({ entryPoint: 'wrapper.ts' });
  assert.deepEqual(require(built.bundlePath).inspect(), ['import', 'require', 7]);
});

for (const alwaysStrict of [false, true]) {
  test(`PREBUNDLE preserves CommonJS TypeScript alwaysStrict=${alwaysStrict}`, async t => {
    const f = fixture(t);
    f.write('tsconfig.json', { compilerOptions: { alwaysStrict } });
    f.write('helper.cts', 'exports.inspect = function(){ function value(){ return this; } return value() === undefined; };');
    f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; export {inspect} from "./helper.cts";');
    const built = await f.build();
    assert.equal(require(built.bundlePath).inspect(), alwaysStrict);
  });
}

test('PREBUNDLE accepts repeated imports that share one captured resolution', async t => {
  const f = fixture(t);
  f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; import {client as first} from "@grpc/grpc-js"; import {client as second} from "@grpc/grpc-js"; export function inspect(){ return first() === second(); }');
  const built = await f.build();
  assert.equal(require(built.bundlePath).inspect(), true);
});

for (const moduleScope of ['mjs', 'package-module', 'babel']) {
  test(`PREBUNDLE preserves dynamic CJS default import interop in ${moduleScope}`, async t => {
    const f = fixture(t);
    f.write('scope/package.json', { type: moduleScope === 'package-module' ? 'module' : 'commonjs' });
    f.write('scope/dependency.cjs', 'module.exports = {__esModule: true, default: "inner", kind: "namespace"};');
    const entryPoint = `scope/wrapper.${moduleScope === 'mjs' ? 'mjs' : 'js'}`;
    f.write(entryPoint, 'export {client} from "@grpc/grpc-js"; export async function inspect(){ return (await import("./dependency.cjs")).default; }');
    const built = await f.build({ entryPoint });
    assert.deepEqual(await require(built.bundlePath).inspect(), moduleScope === 'babel' ? 'inner' : { __esModule: true, default: 'inner', kind: 'namespace' });
  });
}

for (const [form, statement] of [
  ['literal', "const required = require('react/jsx-runtime');"],
  ['template', 'const required = require(`react/jsx-runtime`);'],
  ['parenthesized', "const required = (require)('react/jsx-runtime');"],
  ['concatenated', "const required = require('react/' + 'jsx-runtime');"],
  ['template-expression', "const required = require(`react/${'jsx-runtime'}`);"],
  ['import-equals', "import required = require('react/jsx-runtime');"],
]) test(`PREBUNDLE keeps JSX imports distinct from ${form} and shadowed require`, async t => {
  const f = fixture(t);
  f.write('tsconfig.json', { compilerOptions: { jsx: 'react-jsx' } });
  f.write('node_modules/react/package.json', { name: 'react', exports: { './jsx-runtime': { import: './import.cjs', require: './require.cjs' } } });
  f.write('node_modules/react/import.cjs', 'exports.jsx = (type, props) => ({type, props, condition: "import"});');
  f.write('node_modules/react/require.cjs', 'exports.condition = "require";');
  f.write('wrapper.tsx', `export {client} from '@grpc/grpc-js';
    ${statement}
    function shadowed(require: (value: string) => string) { return require('react/jsx-runtime'); }
    export function inspect(){ return [<div/>, required.condition, shadowed(value => value)]; }`);
  const built = await f.build({ entryPoint: 'wrapper.tsx' });
  assert.deepEqual(require(built.bundlePath).inspect(), [{ type: 'div', props: {}, condition: 'import' }, 'require', 'react/jsx-runtime']);
});

for (const specifier of ['`./dependency.cjs`', "'./' + 'dependency.cjs'", "`./${'dependency'}.cjs`"]) {
  test(`PREBUNDLE preserves dynamic CJS default interop for ${specifier}`, async t => {
    const f = fixture(t);
    f.write('dependency.cjs', 'module.exports = {__esModule: true, default: "inner", kind: "namespace"};');
    f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export async function inspect(){ return (await import(${specifier})).default; }`);
    const built = await f.build();
    assert.deepEqual(await require(built.bundlePath).inspect(), { __esModule: true, default: 'inner', kind: 'namespace' });
  });
}

for (const change of ['nearest', 'inherited', 'package', 'added', 'after-compilation']) {
  test(`PREBUNDLE rejects ${change} compiler configuration changes between compilation stages`, async t => {
    const f = fixture(t);
    let config = 'tsconfig.json';
    if (change === 'inherited') {
      config = 'settings/base.json'; f.write('tsconfig.json', { extends: './settings/base.json' });
    } else if (change === 'package') {
      config = 'node_modules/build-settings/base.json';
      f.write('node_modules/build-settings/package.json', { name: 'build-settings', tsconfig: './base.json' });
      f.write('tsconfig.json', { extends: 'build-settings' });
    }
    if (change !== 'added') f.write(config, { compilerOptions: { useDefineForClassFields: false } });
    f.write('wrapper.ts', `export {client} from '@grpc/grpc-js';
      class Base { set field(value: number) { this.observed = value; } observed?: number; }
      class Derived extends Base { field = 7; }
      export function inspect(){ return new Derived().observed; }`);
    let calls = 0;
    const changing = { ...esbuild, async build(options) {
      const built = await esbuild.build(options);
      if (++calls === (change === 'after-compilation' ? 2 : 1)) f.write(config, { compilerOptions: { useDefineForClassFields: true } });
      return built;
    } };
    await assert.rejects(f.build({ entryPoint: 'wrapper.ts', esbuild: changing }), { code: 'WGA_PREBUNDLE_INPUT_CHANGED' });
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
  });
}

test('PREBUNDLE preserves stable inherited compiler settings', async t => {
  const f = fixture(t);
  f.write('tsconfig.json', { extends: './settings/base.json' });
  f.write('settings/base.json', { compilerOptions: { useDefineForClassFields: false } });
  f.write('wrapper.ts', `export {client} from '@grpc/grpc-js';
    class Base { set field(value: number) { this.observed = value; } observed?: number; }
    class Derived extends Base { field = 7; }
    export function inspect(){ return new Derived().observed; }`);
  const built = await f.build({ entryPoint: 'wrapper.ts' });
  assert.equal(require(built.bundlePath).inspect(), 7);
});
