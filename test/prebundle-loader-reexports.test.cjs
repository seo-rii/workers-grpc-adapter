'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');

function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-loader-reexports-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(projectRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return file;
  };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file)));
  write('build/profiles/google-static-v1.json', { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1,
    revision: 1, packages: [], files: [], schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: [], requiredChecks: [] });
  write('package.json', { name: 'loader-reexports-consumer', private: true });
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '0.0.1', main: 'index.cjs' });
  write('node_modules/@grpc/grpc-js/index.cjs', 'const state = {}; exports.client = () => state;');
  write('wrapper.d.ts', 'export declare function client(): object; export declare function inspect(base: string): unknown;');
  write('external.cjs', 'module.exports = "outside";');
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return { projectRoot, write, build: () => api.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'out',
    entryPoint: 'wrapper.mjs', declarationFile: 'wrapper.d.ts', exports: ['client', 'inspect'], typescript: ts, esbuild }) };
}

const graphs = [
  ['named namespace', { 'helper.mjs': 'import * as native from "node:module"; export {native};' }, 'import {native} from "./helper.mjs";', 'native'],
  ['namespace export', { 'helper.mjs': 'export * as native from "node:module";' }, 'import {native} from "./helper.mjs";', 'native'],
  ['default namespace', { 'helper.mjs': 'import * as native from "node:module"; export default native;' }, 'import native from "./helper.mjs";', 'native'],
  ['default re-export', { 'helper.mjs': 'export {default} from "node:module";' }, 'import native from "./helper.mjs";', 'native'],
  ['exported alias', { 'helper.mjs': 'import * as original from "node:module"; export const native = original;' }, 'import {native} from "./helper.mjs";', 'native'],
  ['renamed through two modules', { 'helper.mjs': 'export * as original from "node:module";', 'bridge.mjs': 'export {original as native} from "./helper.mjs";' }, 'import {native} from "./bridge.mjs";', 'native'],
  ['star through two modules', { 'helper.mjs': 'export * as native from "node:module";', 'bridge.mjs': 'export * from "./helper.mjs";' }, 'import {native} from "./bridge.mjs";', 'native'],
  ['namespace member', { 'helper.mjs': 'export * as native from "node:module";' }, 'import * as bridge from "./helper.mjs";', 'bridge.native'],
  ['reflected namespace member', { 'helper.mjs': 'export * as native from "node:module";' }, 'import * as bridge from "./helper.mjs";', 'Reflect.get(bridge, "native")'],
  ['nested namespace export', { 'helper.mjs': 'export * as native from "node:module";', 'bridge.mjs': 'export * as nested from "./helper.mjs";' }, 'import * as bridge from "./bridge.mjs";', 'bridge.nested.native'],
  ['cyclic star re-export', { 'helper.mjs': 'export * from "./bridge.mjs"; export * as native from "node:module";', 'bridge.mjs': 'export * from "./helper.mjs";' }, 'import {native} from "./bridge.mjs";', 'native'],
  ['builtin star re-export', { 'helper.mjs': 'export * from "node:module";' }, 'import * as native from "./helper.mjs";', 'native'],
];
for (const [name, files, imports, receiver] of graphs) {
  for (const loading of [true, false]) test(`PREBUNDLE ${loading ? 'rejects loaders' : 'preserves non-loading APIs'} through ${name}`, async t => {
    const f = fixture(t);
    for (const [file, contents] of Object.entries(files)) f.write(file, contents);
    const entry = f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; ' + imports
      + ` export function inspect(base) { return (${receiver}).${loading ? 'createRequire(base)("./external.cjs")' : 'isBuiltin("node:fs")'}; }`);
    assert.equal((await import(pathToFileURL(entry).href)).inspect(entry), loading ? 'outside' : true);
    if (loading) {
      await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
      assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
    } else {
      const built = await f.build();
      assert.equal(require(built.bundlePath).inspect(built.bundlePath), true);
    }
  });
}

for (const [name, helper, imports, expression] of [
  ['ordinary object', 'export const native = {createRequire: () => () => "ordinary"};', 'import {native} from "./helper.mjs";', 'native.createRequire(base)("ignored")'],
  ['shadowed binding', 'export * as native from "node:module";', 'import {native} from "./helper.mjs";', '((native) => native.createRequire())({createRequire: () => "ordinary"})'],
  ['explicit export over builtin star', 'export * from "node:module"; export const createRequire = () => "ordinary";', 'import * as native from "./helper.mjs";', 'native.createRequire()'],
  ['cyclic ordinary namespace', 'export * from "./bridge.mjs"; export const createRequire = () => "ordinary";', 'import * as native from "./bridge.mjs";', 'native.createRequire()'],
]) test(`PREBUNDLE accepts ${name} across static module edges`, async t => {
  const f = fixture(t);
  f.write('helper.mjs', helper); f.write('bridge.mjs', 'export * from "./helper.mjs";');
  f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; ' + imports + ` export function inspect(base) { return ${expression}; }`);
  const built = await f.build();
  assert.equal(require(built.bundlePath).inspect(built.bundlePath), 'ordinary');
});

for (const hidden of ['default', 'shadowed']) {
  test(`PREBUNDLE excludes ${hidden} star exports from an unknown namespace property`, async t => {
    const f = fixture(t);
    f.write('helper.mjs', hidden === 'default'
      ? 'import * as native from "node:module"; export default native;'
      : 'export * as ordinary from "node:module";');
    f.write('bridge.mjs', 'export * from "./helper.mjs"; export const ordinary = {createRequire: () => "ordinary"};');
    const entry = f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; import * as bridge from "./bridge.mjs"; '
      + 'export function inspect(base) { return bridge[base.length ? "ordinary" : "ordinary"].createRequire(); }');
    assert.equal((await import(pathToFileURL(entry).href)).inspect(entry), 'ordinary');
    const built = await f.build();
    assert.equal(require(built.bundlePath).inspect(built.bundlePath), 'ordinary');
  });
}

for (const collision of ['ordinary export', 'independent namespace aliases']) {
  test(`PREBUNDLE excludes ambiguous stars from an unknown property: ${collision}`, async t => {
    const f = fixture(t);
    const alias = 'import * as original from "node:module"; export const native = original;';
    f.write('left.mjs', collision === 'ordinary export' ? 'export * as native from "node:module";' : alias);
    f.write('right.mjs', collision === 'ordinary export' ? 'export const native = {};' : alias);
    f.write('bridge.mjs', 'export * from "./left.mjs"; export * from "./right.mjs"; export const ordinary = {createRequire: () => "ordinary"};');
    const namespace = await import(pathToFileURL(path.join(f.projectRoot, 'bridge.mjs')).href);
    assert.equal(Object.hasOwn(namespace, 'native'), false);
    const entry = f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; import * as bridge from "./bridge.mjs"; '
      + 'export function inspect(base) { return bridge[base.length ? "ordinary" : "ordinary"].createRequire(); }');
    assert.equal((await import(pathToFileURL(entry).href)).inspect(entry), 'ordinary');
    const built = await f.build();
    assert.equal(require(built.bundlePath).inspect(built.bundlePath), 'ordinary');
  });
}

test('PREBUNDLE retains the same loader binding through a diamond of renamed exports', async t => {
  const f = fixture(t);
  f.write('helper.mjs', 'export * as original from "node:module";');
  f.write('left.mjs', 'export {original as native} from "./helper.mjs";');
  f.write('right.mjs', 'import {original as alias} from "./helper.mjs"; export {alias as native};');
  f.write('bridge.mjs', 'export * from "./left.mjs"; export * from "./right.mjs";');
  const entry = f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; import * as bridge from "./bridge.mjs"; '
    + 'export function inspect(base) { return bridge.native.createRequire(base)("./external.cjs"); }');
  assert.equal((await import(pathToFileURL(entry).href)).inspect(entry), 'outside');
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
});

test('PREBUNDLE does not invent a conflicting builtin binding for another star export', async t => {
  const f = fixture(t);
  f.write('helper.mjs', 'export * as native from "node:module";');
  f.write('bridge.mjs', 'export * from "node:module"; export * from "./helper.mjs";');
  const entry = f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; import * as bridge from "./bridge.mjs"; '
    + 'export function inspect(base) { return bridge.native.createRequire(base)("./external.cjs"); }');
  assert.equal((await import(pathToFileURL(entry).href)).inspect(entry), 'outside');
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
});

test('PREBUNDLE follows captured package export conditions for namespace re-exports', async t => {
  const f = fixture(t);
  f.write('node_modules/bridge/package.json', { name: 'bridge', exports: { import: './esm.mjs', require: './cjs.cjs' } });
  f.write('node_modules/bridge/esm.mjs', 'export * as native from "node:module";');
  f.write('node_modules/bridge/cjs.cjs', 'exports.native = {createRequire: () => () => "ordinary"};');
  f.write('wrapper.mjs', 'export {client} from "@grpc/grpc-js"; import {native} from "bridge"; export function inspect(base) { return native.createRequire(base)("./external.cjs"); }');
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
});
