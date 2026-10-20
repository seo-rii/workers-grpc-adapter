'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');
const root = path.resolve(__dirname, '..');
const { buildGoogleWorkerPrebundle } = require('../src/build/prebundle.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function write(file, contents) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); }
function synthetic(t) {
  const projectRoot = temporary(t);
  for (const name of ['index.cjs', 'prebundle.cjs']) write(path.join(projectRoot, 'build', name), fs.readFileSync(path.join(root, 'src/build', name)));
  const adapterRoot = path.join(projectRoot, 'node_modules/@grpc/grpc-js');
  write(path.join(adapterRoot, 'package.json'), JSON.stringify({ name: 'workers-grpc-adapter', version: '0.0.1', exports: { '.': './index.js', './config': './config.js' } }));
  write(path.join(adapterRoot, 'state.js'), 'exports.config = { timeout: 1000 };\n');
  write(path.join(adapterRoot, 'index.js'), 'const state = require("./state.js"); exports.client = () => ({ timeout: state.config.timeout });\n');
  write(path.join(adapterRoot, 'config.js'), 'const state = require("./state.js"); exports.configure = config => { state.config = config; };\n');
  const sdkRoot = path.join(projectRoot, 'node_modules/example-sdk');
  const sdkPackage = JSON.stringify({ name: 'example-sdk', version: '1.0.0', main: './index.js' });
  write(path.join(sdkRoot, 'package.json'), sdkPackage);
  write(path.join(sdkRoot, 'index.js'), '/*! @license Example SDK copyright notice */\nexports.createClient = require("@grpc/grpc-js").client;\n');
  // Include an independently pinned transform target so omission can be tested.
  const transformSource = 'exports.root = Proto.Root.fromJSON({});\n';
  write(path.join(sdkRoot, 'static.js'), transformSource);
  const profile = { id: 'google-static-v1', schemaVersion: 1, transformerVersion: 1, revision: 1,
    packages: [{ path: 'node_modules/example-sdk', name: 'example-sdk', version: '1.0.0', packageJsonSha256: hash(sdkPackage) }],
    files: [{ path: 'node_modules/example-sdk/static.js', sha256: hash(transformSource), transforms: [{ rule: 'static-root-from-json', expectedMatches: 1 }] }],
    schemas: [], codegenInputs: [], loaderOptions: {}, capabilities: ['static-protobuf-codecs'], requiredChecks: ['node --test test/google-prebundle.test.cjs'] };
  write(path.join(projectRoot, 'build/profiles/google-static-v1.json'), JSON.stringify(profile));
  const entryPoint = 'wrapper.mjs', declarationFile = 'wrapper.d.ts';
  write(path.join(projectRoot, entryPoint), 'export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config";\n');
  write(path.join(projectRoot, declarationFile), 'export declare function createClient(): { timeout: number };\nexport declare function configure(config: { timeout: number }): void;\n');
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  const build = options => api.buildGoogleWorkerPrebundle({ projectRoot, outdir: 'out', typescript: ts, esbuild, entryPoint, exports: ['createClient', 'configure'], declarationFile, ...options });
  return { projectRoot, adapterRoot, sdkRoot, profile, build, writeEntry: source => write(path.join(projectRoot, entryPoint), source) };
}

const unsafe = [
  ['await import options', 'export async function load(name) { const m = await import("node:module", {}); return m.createRequire("/app.cjs")(name); }'],
  ['await destructuring options', 'export async function load(name) { const {createRequire} = await import("node:module", {}); return createRequire("/app.cjs")(name); }'],
  ['module namespace rest', 'export async function load(name) { const {...m} = await import("node:module"); return m.createRequire("/app.cjs")(name); }'],
  ['await namespace', 'export async function load(name) { const m = await import("node:module"); return m.createRequire("/app.cjs")(name); }'],
  ['await destructuring', 'export async function load(name) { const {createRequire} = await import("module"); return createRequire("/app.cjs")(name); }'],
  ['await default', 'export async function load(name) { const {default: m} = await import("node:module"); return m["create" + "Require"]("/app.cjs")(name); }'],
  ['computed static property', 'import m from "node:module"; export function load(name) { return m["create" + "Require"]("/app.cjs")(name); }'],
  ['constant property alias', 'import m from "node:module"; const key = "create" + "Require"; export function load(name) { return m[key]("/app.cjs")(name); }'],
  ['computed destructuring', 'import m from "node:module"; const {["create" + "Require"]: make} = m; export function load(name) { return make("/app.cjs")(name); }'],
  ['unknown module property', 'import m from "node:module"; export function load(name) { return m[name]; }'],
  ['then namespace callback', 'export function load(name) { return import("node:module").then(m => m.createRequire("/app.cjs")(name)); }'],
  ['then function callback', 'export function load(name) { return import("node:module").then(function(m) { return m.createRequire("/app.cjs")(name); }); }'],
  ['then destructured callback', 'export function load(name) { return import("node:module").then(({createRequire: make}) => make("/app.cjs")(name)); }'],
  ['then namespace rest callback', 'export function load(name) { return import("node:module").then(({...m}) => m.createRequire("/app.cjs")(name)); }'],
  ['then default namespace callback', 'export function load(name) { return import("node:module").then(({default: m}) => m.createRequire("/app.cjs")(name)); }'],
  ['aliased pending import callback', 'export function load(name) { return pending.then(m => m.createRequire("/app.cjs")(name)); } const pending = import("node:module");'],
  ['named then callback', 'function use(m) { return m.createRequire("/app.cjs")("node:fs"); } export function load() { return import("node:module").then(use); }'],
  ['aliased then callback', 'const use = m => m.createRequire("/app.cjs")("node:fs"); const callback = use; export function load() { return import("node:module").then(callback); }'],
  ['reflective namespace member', 'import m from "node:module"; export function load(name) { return Reflect.get(m, "createRequire")("/app.cjs")(name); }'],
  ['parenthesized Reflect receiver', 'import m from "node:module"; export function load(name) { return (Reflect).get(m, "createRequire")("/app.cjs")(name); }'],
  ['parenthesized computed Reflect receiver', 'import m from "node:module"; export function load(name) { return (Reflect)["get"](m, "createRequire")("/app.cjs")(name); }'],
  ['reflective computed member', 'import m from "node:module"; const key = "create" + "Require"; export function load(name) { return Reflect.get(m, key)("/app.cjs")(name); }'],
  ['reflective unknown namespace member', 'import m from "node:module"; export function load(name) { return Reflect.get(m, name); }'],
  ['reflective default namespace', 'import * as m from "node:module"; export function load(name) { return Reflect.get(m, "default").createRequire("/app.cjs")(name); }'],
  ['reflective module require', 'import helper from "./helper.cjs"; export function load(name) { return helper.load(name); }', 'exports.load = name => Reflect.get(module, "require").call(module, name);'],
  ['reflective unknown module member', 'import helper from "./helper.cjs"; export function load(name) { return helper.load(name); }', 'exports.load = name => Reflect.get(module, name);'],
];
for (const [name, body, helper] of unsafe) test(`PREBUNDLE rejects ${name} module loaders`, async t => {
  const f = synthetic(t);
  if (helper) write(path.join(f.projectRoot, 'helper.cjs'), helper);
  f.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; ' + body);
  fs.appendFileSync(path.join(f.projectRoot, 'wrapper.d.ts'), 'export declare function load(name: string): unknown;');
  await assert.rejects(f.build({ exports: ['createClient', 'configure', 'load'] }), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
});
for (const [name, body] of [
  ['dynamic import options', 'export async function probe() { const m = await import("node:module", {}); return m.isBuiltin("node:fs"); }'],
  ['ordinary object method', 'const ordinary = {createRequire: () => 7}; export function probe() { return ordinary["create" + "Require"](); }'],
  ['computed builtin property', 'import m from "node:module"; const key = "is" + "Builtin"; export function probe() { return m[key]("node:fs"); }'],
  ['destructured builtin', 'export async function probe() { const {isBuiltin} = await import("node:module"); return isBuiltin("node:fs"); }'],
  ['then builtin callback', 'export function probe() { return import("node:module").then(m => m.isBuiltin("node:fs")); }'],
  ['then destructured builtin callback', 'export function probe() { return import("node:module").then(({isBuiltin}) => isBuiltin("node:fs")); }'],
  ['named then builtin callback', 'function use(m) { return m.isBuiltin("node:fs"); } export function probe() { return import("node:module").then(use); }'],
  ['application promise callback', 'export function probe() { return Promise.resolve({createRequire: () => 7}).then(m => m.createRequire()); }'],
  ['application rejection callback', 'export function probe() { return Promise.reject({createRequire: () => 7}).then(() => 0, m => m.createRequire()); }'],
  ['shadowed callback binding', 'export function probe() { return import("node:module").then(m => { function use(m) { return m.createRequire(); } return use({createRequire: () => 7}); }); }'],
  ['reflective builtin', 'import m from "node:module"; export function probe() { return Reflect.get(m, "isBuiltin")("node:fs"); }'],
  ['reflective application object', 'const ordinary = {require: () => 7}; export function probe() { return Reflect.get(ordinary, "require")(); }'],
  ['parenthesized Reflect application read', 'const ordinary = {require: () => 7}; export function probe() { return (Reflect).get(ordinary, "require")(); }'],
  ['parenthesized Reflect builtin read', 'import m from "node:module"; export function probe() { return (Reflect).get(m, "isBuiltin")("node:fs"); }'],
  ['parenthesized shadowed Reflect', 'import m from "node:module"; const Reflect = {get: () => () => 7}; export function probe() { return (Reflect).get(m, "createRequire")(); }'],
  ['shadowed Reflect', 'import m from "node:module"; const Reflect = {get: () => () => 7}; export function probe() { return Reflect.get(m, "createRequire")(); }'],
]) test(`PREBUNDLE preserves ordinary objects and non-loading builtin APIs: ${name}`, async t => {
  const f = synthetic(t);
  f.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; ' + body);
  fs.appendFileSync(path.join(f.projectRoot, 'wrapper.d.ts'), 'export declare function probe(): unknown;');
  const built = await f.build({ exports: ['createClient', 'configure', 'probe'] });
  assert.ok(await require(built.bundlePath).probe());
});
