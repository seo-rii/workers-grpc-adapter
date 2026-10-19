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

for (const suffix of ['?second', '#second']) test(`PREBUNDLE rejects duplicate adapter modules through ${suffix}`, async t => {
  const f = synthetic(t);
  f.writeEntry('export {createClient} from "example-sdk"; const owned = require("@grpc/grpc-js/config' + suffix + '"); export const configure = owned.configure; const other = require("./node_modules/@grpc/grpc-js/state.js' + suffix + '"); console.log(other);');
  await assert.rejects(f.build(), { code: 'WGA_PREBUNDLE_RUNTIME_IDENTITY' });
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
});
test('PREBUNDLE accepts shared aliases of one adapter module instance', async t => {
  const f = synthetic(t);
  f.writeEntry('export {createClient} from "example-sdk"; export {configure} from "@grpc/grpc-js/config"; const state = require("./node_modules/@grpc/grpc-js/state.js"); console.log(state);');
  const built = await f.build();
  const api = require(built.bundlePath); api.configure({timeout: 77}); assert.equal(api.createClient().timeout, 77);
});
test('PREBUNDLE keeps unrelated non-adapter module suffixes valid', async t => {
  const f = synthetic(t);
  write(path.join(f.projectRoot, 'label.cjs'), 'module.exports = "label";');
  fs.appendFileSync(path.join(f.projectRoot, 'wrapper.mjs'), 'console.log(require("./label.cjs"), require("./label.cjs?other"));');
  const built = await f.build(); assert.equal(JSON.parse(fs.readFileSync(built.manifestPath)).runtime.physicalInstallations, 1);
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

test('PREBUNDLE rejects actual adapter deep-subpath suffix copies', async t => {
  const f = synthetic(t);
  fs.cpSync(path.join(root, 'dist'), path.join(f.adapterRoot, 'dist'), { recursive: true });
  write(path.join(f.adapterRoot, 'package.json'), fs.readFileSync(path.join(root, 'package.json')));
  f.writeEntry('import {Client} from "@grpc/grpc-js"; const duplicate = require("@grpc/grpc-js/build/src/client.js?other"); export function probe() { return Client === duplicate.Client; }');
  write(path.join(f.projectRoot, 'wrapper.d.ts'), 'export declare function probe(): boolean;');
  await assert.rejects(f.build({ exports: ['probe'] }), error => error.code === 'WGA_PREBUNDLE_RUNTIME_IDENTITY'
    && error.diagnostic.physicalPath.endsWith('/dist/client.js'));
});
