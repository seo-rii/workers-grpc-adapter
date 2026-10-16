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
test('PREBUNDLE owns one adapter/config closure through both CJS and ESM exports', async t => {
  const fixture = synthetic(t), result = await fixture.build();
  const cjs = require(result.bundlePath), esm = await import(pathToFileURL(path.join(result.outdir, 'index.mjs')).href);
  assert.deepEqual(Object.keys(esm).sort(), ['configure', 'createClient']);
  cjs.configure({ timeout: 37 });
  assert.equal(esm.createClient().timeout, 37);
  esm.configure({ timeout: 91 });
  assert.equal(cjs.createClient().timeout, 91);
  const outside = require(path.join(fixture.adapterRoot, 'index.js'));
  assert.equal(outside.client().timeout, 1000, 'applications configure the public wrapper, not a separately installed adapter');
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath));
  assert.equal(manifest.runtime.physicalInstallations, 1);
  assert.equal(manifest.runtime.ownership, 'prebundle');
  assert.equal(manifest.transformCoverage.passed, true);
  assert.match(manifest.artifactSha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.artifacts['index.cjs'].sha256, hash(fs.readFileSync(result.bundlePath)));
  assert.match(fs.readFileSync(result.bundlePath, 'utf8'), /@license Example SDK copyright notice/);
  assert.equal(fs.readFileSync(result.typesPath, 'utf8'), fs.readFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'utf8'));
  assert.deepEqual(fs.readFileSync(path.join(result.outdir, 'index.d.mts')), fs.readFileSync(result.typesPath));
  assert.deepEqual(fs.readFileSync(path.join(result.outdir, 'index.d.cts')), fs.readFileSync(result.typesPath));
  assert.throws(() => require(path.join(result.outdir, 'server-only.cjs')), /WGA_PREBUNDLE_SERVER_ONLY/);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.packageJsonPath)).exports['.'].browser, './server-only.cjs');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(result.packageJsonPath)).exports['.']).slice(0, 3), ['workerd', 'worker', 'browser']);
  const independent = temporary(t);
  fs.cpSync(result.outdir, path.join(independent, 'portable'), { recursive: true });
  assert.equal(require(path.join(independent, 'portable')).createClient().timeout, 1000, 'the runtime package has no source SDK dependency');
});
test('PREBUNDLE rejects mutable public bindings instead of snapshotting ESM state', async t => {
  const cases = [
    ['exported let', 'export let activeClient; export function initialize() { activeClient = createClient(); }'],
    ['exported var', 'export var activeClient = createClient(); export function initialize() {}'],
    ['local mutable export alias', 'let local; export {local as activeClient}; export function initialize() { local = createClient(); }'],
    ['function reassignment', 'export function activeClient() { return createClient(); } export function initialize() { activeClient = () => ({timeout: 2}); }'],
    ['re-export assignment', 'export {activeClient, initialize} from "./mutable.mjs";', 'export let activeClient; export function initialize() { activeClient = {timeout: 2}; }'],
    ['re-export destructuring', 'export {activeClient, initialize} from "./mutable.mjs";', 'export let activeClient; export function initialize() { ({value: activeClient} = {value: {timeout: 2}}); }'],
    ['re-export update', 'export {activeClient, initialize} from "./mutable.mjs";', 'export let activeClient = 0; export function initialize() { activeClient++; }'],
    ['re-export class reassignment', 'export {activeClient, initialize} from "./mutable.mjs";', 'export class activeClient {} export function initialize() { activeClient = class {}; }'],
  ];
  for (const [name, body, dependency] of cases) await t.test(name, async t => {
    const fixture = synthetic(t);
    fixture.writeEntry(`import {createClient} from "example-sdk"; export {createClient}; export {configure} from "@grpc/grpc-js/config"; ${body}`);
    if (dependency) write(path.join(fixture.projectRoot, 'mutable.mjs'), dependency);
    fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare const activeClient: unknown;\nexport declare function initialize(): void;\n');
    await assert.rejects(fixture.build({ exports: ['createClient', 'configure', 'activeClient', 'initialize'] }), { code: 'WGA_PREBUNDLE_EXPORT_STABILITY' });
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
  });
});
test('PREBUNDLE shares stable public objects while allowing their private state to change', async t => {
  const fixture = synthetic(t);
  fixture.writeEntry('import {createClient} from "example-sdk"; export {createClient}; export {configure} from "@grpc/grpc-js/config"; let current; export const activeClient = {current: null}; export function initialize() { current = createClient(); activeClient.current = current; }');
  fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare const activeClient: { current: {timeout: number} | null };\nexport declare function initialize(): void;\n');
  const result = await fixture.build({ exports: ['createClient', 'configure', 'activeClient', 'initialize'] });
  const cjs = require(result.bundlePath), esm = await import(pathToFileURL(path.join(result.outdir, 'index.mjs')).href);
  assert.strictEqual(cjs.activeClient, esm.activeClient);
  cjs.configure({timeout: 17});
  cjs.initialize();
  assert.equal(esm.activeClient.current.timeout, 17);
  esm.configure({timeout: 23});
  esm.initialize();
  assert.equal(cjs.activeClient.current.timeout, 23);
});
test('PREBUNDLE records reproducible artifact hashes and invalidates changed wrappers/types', async t => {
  const fixture = synthetic(t), first = await fixture.build();
  const second = await fixture.build({ outdir: 'elsewhere' });
  const a = JSON.parse(fs.readFileSync(first.manifestPath)), b = JSON.parse(fs.readFileSync(second.manifestPath));
  assert.equal(a.artifactSha256, b.artifactSha256);
  assert.equal(a.artifacts['index.cjs'].sha256, b.artifacts['index.cjs'].sha256);
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; const tag="wrapper-v2"; export {tag};\n');
  fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare const tag: string;\n');
  const changed = await fixture.build({ outdir: 'changed', exports: ['createClient', 'configure', 'tag'] });
  const c = JSON.parse(fs.readFileSync(changed.manifestPath));
  assert.notEqual(a.wrapper.sha256, c.wrapper.sha256);
  assert.notEqual(a.artifactSha256, c.artifactSha256);
  fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export interface ExtraType { optional: boolean }\n');
  const types = JSON.parse(fs.readFileSync((await fixture.build({ outdir: 'types', exports: ['createClient', 'configure', 'tag'] })).manifestPath));
  assert.notEqual(c.artifactSha256, types.artifactSha256);
  assert.equal(c.artifacts['index.cjs'].sha256, types.artifacts['index.cjs'].sha256);
});
test('PREBUNDLE file modes and npm archives are reproducible across caller umasks', async t => {
  const fixture = synthetic(t), built = [], initial = process.umask();
  try {
    for (const mask of [0o022, 0o077]) {
      process.umask(mask);
      const result = await fixture.build({ outdir: `mask-${mask}` }), packedDirectory = temporary(t);
      const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packedDirectory], { cwd: result.outdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      built.push({ result, archive: fs.readFileSync(path.join(packedDirectory, packed.filename)), files: packed.files });
    }
  } finally { process.umask(initial); }
  assert.equal(hash(built[0].archive), hash(built[1].archive), 'the actual npm archives must have identical bytes');
  for (const { result, files } of built) {
    assert.equal(fs.statSync(result.outdir).mode & 0o777, 0o755);
    for (const file of fs.readdirSync(result.outdir)) assert.equal(fs.statSync(path.join(result.outdir, file)).mode & 0o777, 0o644, file);
    for (const file of files) assert.equal(file.mode, 0o644, file.path);
  }
});
test('PREBUNDLE rejects export mismatch and does not execute wrapper code during a build', async t => {
  const fixture = synthetic(t);
  globalThis.WGA_TEST_BUILD_MUST_NOT_EXECUTE = true;
  t.after(() => delete globalThis.WGA_TEST_BUILD_MUST_NOT_EXECUTE);
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; if (globalThis.WGA_TEST_BUILD_MUST_NOT_EXECUTE) throw new Error("a build must not execute this");\n');
  const built = await fixture.build();
  assert.ok(fs.existsSync(built.bundlePath));
  await assert.rejects(fixture.build({ outdir: 'missing-export', exports: ['createClient', 'missing'] }), { code: 'WGA_PREBUNDLE_EXPORTS' });
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'missing-export')), false);
  fixture.writeEntry('module.exports = { createClient() {}, configure() {} };');
  await assert.rejects(fixture.build({ outdir: 'cjs-entry' }), { code: 'WGA_PREBUNDLE_EXPORTS' });
});
test('PREBUNDLE rejects a second physical adapter installation even at the same version', async t => {
  const fixture = synthetic(t), duplicate = path.join(fixture.sdkRoot, 'node_modules/@grpc/grpc-js');
  fs.cpSync(fixture.adapterRoot, duplicate, { recursive: true });
  await assert.rejects(fixture.build(), error => error.code === 'WGA_PREBUNDLE_RUNTIME_IDENTITY' && error.diagnostic.installations.length === 2);
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
});
test('PREBUNDLE audits imported transform targets and rejects an unverified SDK copy', async t => {
  const fixture = synthetic(t);
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export {root} from "example-sdk/static.js";');
  fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare const root: unknown;\n');
  const result = await fixture.build({ exports: ['createClient', 'configure', 'root'] });
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath));
  assert.deepEqual(manifest.transformCoverage, { required: 1, applied: 1, unused: 0, passed: true });
  assert.equal(manifest.transformed.length, 1);
  assert.equal(manifest.transformed[0].upstreamSha256, fixture.profile.files[0].sha256);
  const duplicate = path.join(fixture.projectRoot, 'duplicate/example-sdk');
  fs.cpSync(fixture.sdkRoot, duplicate, { recursive: true });
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export {root} from "./duplicate/example-sdk/static.js";');
  await assert.rejects(fixture.build({ outdir: 'duplicate-output', exports: ['createClient', 'configure', 'root'] }), { code: 'WGA_SOURCE_IDENTITY' });
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'duplicate-output')), false);
});
test('PREBUNDLE rejects native grpc and variable runtime imports before creating artifacts', async t => {
  const fixture = synthetic(t);
  const packagePath = path.join(fixture.adapterRoot, 'package.json'), pkg = JSON.parse(fs.readFileSync(packagePath));
  pkg.name = '@grpc/grpc-js'; write(packagePath, JSON.stringify(pkg));
  await assert.rejects(fixture.build(), { code: 'WGA_PREBUNDLE_NATIVE_GRPC' });
  pkg.name = 'workers-grpc-adapter'; write(packagePath, JSON.stringify(pkg));
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export const load = name => import(name);');
  await assert.rejects(fixture.build({ exports: ['createClient', 'configure', 'load'] }), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export const load = name => require(name);');
  await assert.rejects(fixture.build({ exports: ['createClient', 'configure', 'load'] }), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export const load = name => { const loader = require; return loader(name); };');
  await assert.rejects(fixture.build({ exports: ['createClient', 'configure', 'load'] }), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
});
test('PREBUNDLE rejects Node module loaders and their direct aliases', async t => {
  const cases = [
    'export const load = name => module.require(name);',
    'export const load = name => module["require"](name);',
    'const current = module; export const load = name => current.require(name);',
    'const {require: loader} = module; export const load = name => loader(name);',
    'let current; current = module; export const load = name => current.require(name);',
    'import {createRequire as makeLoader} from "node:module"; export const load = name => makeLoader("/wrapper.cjs")(name);',
    'import * as builtins from "module"; const alias = builtins; export const load = name => alias.createRequire("/wrapper.cjs")(name);',
    'const {createRequire: makeLoader} = require("node:module"); export const load = name => makeLoader("/wrapper.cjs")(name);',
    'import Module from "node:module"; export const load = name => Module.prototype.require.call(module, name);',
  ];
  for (const [index, loader] of cases.entries()) await t.test(`loader ${index + 1}`, async t => {
    const fixture = synthetic(t);
    fixture.writeEntry(`export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; ${loader}`);
    fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare function load(name: string): unknown;\n');
    await assert.rejects(fixture.build({ exports: ['createClient', 'configure', 'load'] }), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
  });
  await t.test('CommonJS dependency module parameter', async t => {
    const fixture = synthetic(t);
    fs.appendFileSync(path.join(fixture.sdkRoot, 'index.js'), 'const current = module; exports.load = name => current.require(name);\n');
    fixture.writeEntry('export {createClient, load} from "example-sdk"; export {configure} from "@grpc/grpc-js/config";');
    fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare function load(name: string): unknown;\n');
    await assert.rejects(fixture.build({ exports: ['createClient', 'configure', 'load'] }), { code: 'WGA_PREBUNDLE_DYNAMIC_IMPORT' });
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
  });
});
test('PREBUNDLE permits ordinary require methods and non-loader Node module APIs', async t => {
  const fixture = synthetic(t);
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; import {isBuiltin} from "node:module"; const ordinary = {require: name => name}; export const load = name => ordinary.require(name); export const check = module => module.require("value"); export {isBuiltin};');
  fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare function load(name: string): string;\nexport declare function check(module: { require(name: string): string }): string;\nexport declare function isBuiltin(name: string): boolean;\n');
  const result = await fixture.build({ exports: ['createClient', 'configure', 'load', 'check', 'isBuiltin'] });
  const api = require(result.bundlePath);
  assert.equal(api.load('value'), 'value');
  assert.equal(api.check({ require: value => value }), 'value');
  assert.equal(api.isBuiltin('node:fs'), true);
});
test('PREBUNDLE preserves strict profile checks and never inlines environment credentials', async t => {
  const fixture = synthetic(t), marker = 'wga-private-credential-must-not-be-built';
  const previous = process.env.WGA_PREBUNDLE_TEST_TOKEN;
  process.env.WGA_PREBUNDLE_TEST_TOKEN = marker;
  t.after(() => previous === undefined ? delete process.env.WGA_PREBUNDLE_TEST_TOKEN : process.env.WGA_PREBUNDLE_TEST_TOKEN = previous);
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export const runtimeToken = () => process.env.WGA_PREBUNDLE_TEST_TOKEN;');
  fs.appendFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'export declare function runtimeToken(): string | undefined;\n');
  const result = await fixture.build({ exports: ['createClient', 'configure', 'runtimeToken'] });
  for (const file of fs.readdirSync(result.outdir)) assert.equal(fs.readFileSync(path.join(result.outdir, file), 'utf8').includes(marker), false, file);
  const source = path.join(fixture.sdkRoot, 'static.js');
  fs.appendFileSync(source, '// tampered');
  await assert.rejects(fixture.build({ outdir: 'tampered' }), { code: 'WGA_SCHEMA_MISMATCH' });
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'tampered')), false);
});
test('PREBUNDLE diagnoses missing optional dependencies instead of retaining runtime require fallbacks', async t => {
  const fixture = synthetic(t);
  fs.appendFileSync(path.join(fixture.sdkRoot, 'index.js'), 'try { require("missing-optional-dependency"); } catch {}\n');
  await assert.rejects(fixture.build(), error => error.code === 'WGA_PREBUNDLE_EXTERNAL'
    && error.message.includes('missing-optional-dependency') && error.message.includes('install it in the build graph'));
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
});
test('PREBUNDLE rejects unprofiled Google service SDKs', async t => {
  const fixture = synthetic(t), sdk = path.join(fixture.projectRoot, 'node_modules/@google-cloud/unverified-service');
  write(path.join(sdk, 'package.json'), JSON.stringify({ name: '@google-cloud/unverified-service', version: '1.0.0', main: './index.js' }));
  write(path.join(sdk, 'index.js'), 'exports.unverified = true;');
  fixture.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; export {unverified} from "@google-cloud/unverified-service";');
  await assert.rejects(fixture.build({ exports: ['createClient', 'configure', 'unverified'] }), error => error.code === 'WGA_UNSUPPORTED_DEPENDENCY' && error.message.includes('@google-cloud/unverified-service'));
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
});
test('PREBUNDLE rejects alternate profiled package copies even without a transform target', async t => {
  const fixture = synthetic(t), duplicate = path.join(fixture.projectRoot, 'duplicate/example-sdk');
  fs.cpSync(fixture.sdkRoot, duplicate, { recursive: true });
  // Nested package scopes must not hide the named package identity.
  write(path.join(duplicate, 'build/package.json'), JSON.stringify({ type: 'commonjs' }));
  write(path.join(duplicate, 'build/index.js'), 'exports.createClient = () => ({ timeout: 0 });');
  fixture.writeEntry('export {createClient} from "./duplicate/example-sdk/build/index.js"; export {configure} from "@grpc/grpc-js/config";');
  await assert.rejects(fixture.build(), { code: 'WGA_SOURCE_IDENTITY' });
  assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
});
test('PREBUNDLE requires portable declarations and an explicit matching value contract', async t => {
  const fixture = synthetic(t), original = fs.readFileSync(path.join(fixture.projectRoot, 'wrapper.d.ts'), 'utf8');
  const declarations = [
    `${original}\nimport type {Extra} from './not-copied';`,
    `${original}\nexport type Extra = import('../not-copied').Extra;`,
    `/// <reference path='./not-copied.d.ts' />\n${original}`,
    `${original}\nexport * from 'unverified-types';`,
    'export declare const missing: true;',
  ];
  for (const source of declarations) {
    write(path.join(fixture.projectRoot, 'wrapper.d.ts'), source);
    await assert.rejects(fixture.build(), { code: 'WGA_PREBUNDLE_DECLARATIONS' });
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
  }
});
test('PREBUNDLE rejects valid declaration companions that are not copied', async t => {
  for (const kind of ['types reference', 'module augmentation']) await t.test(kind, async t => {
    const fixture = synthetic(t), declaration = path.join(fixture.projectRoot, 'wrapper.d.ts');
    const original = fs.readFileSync(declaration, 'utf8'), local = path.join(fixture.projectRoot, 'local-types.d.ts');
    const source = kind === 'types reference'
      ? `/// <reference types="./local-types" />\n${original.replace('{ timeout: number }', 'LocalClient')}`
      : `${original}\ndeclare module './local-types' { interface LocalClient { extra?: boolean } }`;
    write(local, kind === 'types reference' ? 'interface LocalClient { timeout: number }\n' : 'export interface LocalClient { timeout: number }\n');
    write(declaration, source);
    const program = ts.createProgram([declaration, local], { strict: true, noEmit: true, skipLibCheck: false, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [], 'the original declaration and its local companion must be valid');
    await assert.rejects(fixture.build(), { code: 'WGA_PREBUNDLE_DECLARATIONS' });
    assert.equal(fs.existsSync(path.join(fixture.projectRoot, 'out')), false);
  });
});
test('PREBUNDLE permits external package type-reference directives', async t => {
  const fixture = synthetic(t), declaration = path.join(fixture.projectRoot, 'wrapper.d.ts');
  write(declaration, `/// <reference types="external-types" />\n${fs.readFileSync(declaration, 'utf8')}`);
  const result = await fixture.build();
  assert.match(fs.readFileSync(result.typesPath, 'utf8'), /reference types="external-types"/);
});
test('PREBUNDLE validates options and preserves existing artifacts on failure', async t => {
  const fixture = synthetic(t), result = await fixture.build();
  const before = fs.readFileSync(result.bundlePath);
  await assert.rejects(fixture.build(), { code: 'WGA_PREBUNDLE_OUTPUT' });
  assert.deepEqual(fs.readFileSync(result.bundlePath), before);
  for (const change of [{ exports: ['default'] }, { exports: ['same', 'same'] }, { exports: [] }, { packageName: 'Invalid Name' }, { credentials: 'not-a-build-option' }]) {
    await assert.rejects(fixture.build({ outdir: 'invalid', ...change }), { code: 'WGA_PREBUNDLE_OPTIONS' });
  }
  await assert.rejects(buildGoogleWorkerPrebundle({}), { code: 'WGA_PREBUNDLE_OPTIONS' });
});
test('PREBUNDLE declarations resolve for direct ESM and CJS imports with strict NodeNext checking', async t => {
  const fixture = synthetic(t);
  await fixture.build();
  const files = [];
  for (const [extension, runtime] of [['mts', 'mjs'], ['cts', 'cjs']]) {
    const file = path.join(fixture.projectRoot, `consumer.${extension}`);
    write(file, `import {createClient, configure} from './out/index.${runtime}';\nconfigure({timeout: 5});\nconst timeout: number = createClient().timeout;\n// @ts-expect-error timeout must be numeric\nconfigure({timeout: 'invalid'});\n`);
    files.push(file);
  }
  const program = ts.createProgram(files, { strict: true, noEmit: true, skipLibCheck: false, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), []);
});
test('PREBUNDLE publishes atomically and preserves files created in outdir during the build', async t => {
  const fixture = synthetic(t);
  const concurrent = { ...esbuild, async build(options) {
    const built = await esbuild.build(options);
    write(path.join(fixture.projectRoot, 'out/user-file.txt'), 'keep this file');
    return built;
  } };
  await assert.rejects(fixture.build({ esbuild: concurrent }), { code: 'WGA_PREBUNDLE_OUTPUT' });
  assert.deepEqual(fs.readdirSync(path.join(fixture.projectRoot, 'out')), ['user-file.txt']);
  assert.equal(fs.readFileSync(path.join(fixture.projectRoot, 'out/user-file.txt'), 'utf8'), 'keep this file');
  assert.equal(fs.readdirSync(fixture.projectRoot).some(name => name.startsWith('.wga-prebundle-output-')), false);
});
