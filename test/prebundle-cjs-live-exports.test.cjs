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

const mutable = [
  ['imported getter alias write', 'const box = require("./box.cjs"), alias = box; Object.defineProperty(exports, "activeClient", {enumerable: true, get() { return box.current; }}); exports.initialize = () => { alias.current = 2; };'],
  ['imported getter Object.assign write', 'const box = require("./box.cjs"); Object.defineProperty(exports, "activeClient", {enumerable: true, get() { return box.current; }}); exports.initialize = () => { Object.assign(box, {current: 2}); };'],
  ['imported getter Reflect.set write', 'const box = require("./box.cjs"); Object.defineProperty(exports, "activeClient", {enumerable: true, get() { return box.current; }}); exports.initialize = () => { Reflect.set(box, "current", 2); };'],
  ['getter object alias write', 'const box = {current: 1}; const alias = box; Object.defineProperty(exports, "activeClient", {enumerable: true, get() { return box.current; }}); exports.initialize = () => { alias.current = 2; };'],
  ['getter Object.assign write', 'const box = {current: 1}; Object.defineProperty(exports, "activeClient", {enumerable: true, get() { return box.current; }}); exports.initialize = () => { Object.assign(box, {current: 2}); };'],
  ['getter Reflect.set write', 'const box = {current: 1}; Object.defineProperty(exports, "activeClient", {enumerable: true, get() { return box.current; }}); exports.initialize = () => { Reflect.set(box, "current", 2); };'],
  ['computed getter descriptor', 'let current = 1; const key = "get"; Object.defineProperty(exports, "activeClient", {enumerable: true, [key]() { return current; }}); exports.initialize = () => { current = 2; };'],
  ['spread getter descriptor', 'let current = 1; const descriptor = {get() { return current; }}; Object.defineProperty(exports, "activeClient", {enumerable: true, ...descriptor}); exports.initialize = () => { current = 2; };'],
  ['namespace object escape', 'const holder = {target: exports}; exports.activeClient = 1; exports.initialize = () => { holder.target.activeClient = 2; };'],
  ['destructuring write', 'exports.activeClient = 1; exports.initialize = () => { ({value: exports.activeClient} = {value: 2}); };'],
  ['computed assign', 'exports.activeClient = 1; exports.initialize = key => { Object.assign(exports, {[key]: 2}); };'],
  ['loop write', 'exports.activeClient = 1; exports.initialize = () => { for (exports.activeClient of [2]) {} };'],
  ['property assignment', 'exports.activeClient = 1; exports.initialize = () => { exports.activeClient = 2; };'],
  ['property getter', 'let current = 1; Object.defineProperty(exports, "activeClient", {enumerable:true, get(){ return current; }}); exports.initialize = () => { current = 2; };'],
  ['Object.assign', 'exports.activeClient = 1; exports.initialize = () => { Object.assign(exports, {activeClient: 2}); };'],
  ['assigned exports alias', 'let target; target = exports; target.activeClient = 1; target.initialize = () => { target.activeClient++; };'],
  ['exports alias', 'const target = exports; target.activeClient = 1; target.initialize = () => { target.activeClient++; };'],
  ['module exports replacement', 'module.exports = {activeClient: 1, initialize() { module.exports.activeClient = 2; }};'],
];
for (const [name, source] of mutable) test(`PREBUNDLE rejects live CJS re-export ${name}`, async t => {
  const f = synthetic(t);
  write(path.join(f.projectRoot, 'box.cjs'), 'exports.current = 1;');
  write(path.join(f.projectRoot, 'mutable.cjs'), source);
  f.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export {activeClient, initialize} from "./mutable.cjs";');
  fs.appendFileSync(path.join(f.projectRoot, 'wrapper.d.ts'), 'export declare const activeClient: unknown; export declare function initialize(): void;');
  await assert.rejects(f.build({ exports: ['createClient', 'configure', 'activeClient', 'initialize'] }), { code: 'WGA_PREBUNDLE_EXPORT_STABILITY' });
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
});
for (const style of ['re-export', 'stable wrapper object']) test(`PREBUNDLE permits stable CJS state objects (${style})`, async t => {
  const f = synthetic(t);
  write(path.join(f.projectRoot, 'state.cjs'), 'const state = {current: 1}; exports.state = state; exports.initialize = () => { state.current = 2; };');
  f.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; ' + (style === 're-export'
    ? 'export {state, initialize} from "./state.cjs";'
    : 'import owned from "./state.cjs"; export const state = owned.state; export const initialize = owned.initialize;'));
  fs.appendFileSync(path.join(f.projectRoot, 'wrapper.d.ts'), 'export declare const state: {current: number}; export declare function initialize(): void;');
  const built = await f.build({ exports: ['createClient', 'configure', 'state', 'initialize'] });
  const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
  assert.equal(cjs.state, esm.state);
  cjs.initialize(); assert.equal(esm.state.current, 2);
});

test('PREBUNDLE preserves actual adapter constructor and private channel identity', async t => {
  const f = synthetic(t);
  fs.cpSync(path.join(root, 'dist'), path.join(f.adapterRoot, 'dist'), { recursive: true });
  write(path.join(f.adapterRoot, 'package.json'), fs.readFileSync(path.join(root, 'package.json')));
  f.writeEntry('export {Client, credentials, getClientChannel} from "@grpc/grpc-js";');
  write(path.join(f.projectRoot, 'wrapper.d.ts'), 'export declare const Client: unknown; export declare const credentials: unknown; export declare function getClientChannel(value: unknown): unknown;');
  const built = await f.build({ exports: ['Client', 'credentials', 'getClientChannel'] });
  const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
  assert.equal(cjs.Client, esm.Client);
  const instance = new esm.Client('example.test:443', cjs.credentials.createSsl());
  try { assert.equal(cjs.getClientChannel(instance), instance.getChannel()); } finally { instance.close(); }
});

test('PREBUNDLE permits stable CJS getters and TypeScript-style initial assignments', async t => {
  const f = synthetic(t);
  write(path.join(f.projectRoot, 'stable.cjs'), 'exports.state = void 0; const state = {current: 1}; Object.defineProperty(exports, "state", {enumerable: true, get() { return state; }}); exports.initialize = () => { state.current = 2; };');
  f.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export {state, initialize} from "./stable.cjs";');
  fs.appendFileSync(path.join(f.projectRoot, 'wrapper.d.ts'), 'export declare const state: {current: number}; export declare function initialize(): void;');
  const built = await f.build({ exports: ['createClient', 'configure', 'state', 'initialize'] });
  const cjs = require(built.bundlePath), esm = await import(pathToFileURL(path.join(built.outdir, 'index.mjs')).href);
  assert.equal(cjs.state, esm.state); esm.initialize(); assert.equal(cjs.state.current, 2);
});
