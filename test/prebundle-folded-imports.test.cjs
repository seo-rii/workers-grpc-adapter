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


for (const expression of [
  'if (false) import("./missing.cjs");',
  'if (false) import(process.env.TARGET);',
  'false && import("./missing.cjs");',
  'true || import("./missing.cjs");',
  '0 ? import("./missing.cjs") : null;',
  'export function unused(){ if (false) return import(process.env.TARGET); }',
  'export function unused(){ if (false) return import("./missing.cjs"); }',
]) test(`PREBUNDLE preserves erased dynamic import: ${expression}`, async t => {
  const f = fixture(t);
  f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; ${expression} export function inspect(){ return 1; }`);
  const exports = expression.startsWith('export') ? ['client', 'inspect', 'unused'] : ['client', 'inspect'];
  if (exports.includes('unused')) f.write('wrapper.d.ts', 'export declare function client(): object; export declare function inspect(): unknown; export declare function unused(): unknown;');
  const built = await f.build({exports});
  const cjs = require(built.bundlePath);
  assert.equal(cjs.inspect(), 1);
  if (cjs.unused) assert.equal(cjs.unused(), undefined);
});

for (const expression of [
  'true ? "./dependency.cjs" : "./missing.cjs"',
  'false ? "./missing.cjs" : "./dependency.cjs"',
  'true ? (choose() ? "./dependency.cjs" : "./other.cjs") : "./missing.cjs"',
]) test(`PREBUNDLE preserves folded import targets: ${expression}`, async t => {
  const f = fixture(t);
  f.write('dependency.cjs', 'module.exports = {__esModule: true, default: "inner", kind: "namespace"};');
  f.write('other.cjs', 'module.exports = {__esModule: true, default: "other", kind: "namespace"};');
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export async function inspect(flag){
    let calls = 0; const choose = () => { calls++; return flag; };
    return {value: (await import(${expression})).default, calls};
  }`);
  const original = await import(pathToFileURL(entry).href);
  const built = await f.build();
  for (const flag of [true, false]) assert.deepEqual(await require(built.bundlePath).inspect(flag), await original.inspect(flag));
});

for (const statement of ['return import(process.env.TARGET);', 'if (flag) return import(process.env.TARGET);', 'return import(flag ? "./dependency.cjs" : "./missing.cjs");', 'if (flag) return import("./missing.cjs");']) {
  test(`PREBUNDLE rejects reachable unresolved import: ${statement}`, async t => {
    const f = fixture(t);
    f.write('dependency.cjs', 'module.exports = 1;');
    f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export function inspect(flag){ ${statement} }`);
    await assert.rejects(f.build());
    assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
  });
}

test('PREBUNDLE still rejects an unbounded original target that folds to a live CommonJS import', async t => {
  const f = fixture(t);
  f.write('dependency.cjs', 'module.exports = {__esModule: true, default: "inner"};');
  f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export function inspect(){ return import(true ? './dependency.cjs' : process.env.TARGET); }`);
  await assert.rejects(f.build(), {code: 'WGA_PREBUNDLE_AUDIT'});
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
});

for (const attributes of ['', ", {with: {type: 'json'}}"]) test(`PREBUNDLE rejects an unbounded original target that folds to JSON${attributes}`, async t => {
  const f = fixture(t);
  const expected = {__esModule: true, default: 'inner', kind: 'json'};
  f.write('data.json', expected);
  const entry = f.write('wrapper.mjs', `export {client} from '@grpc/grpc-js'; export async function inspect(){ return (await import(true ? './data.json' : process.env.TARGET${attributes})).default; }`);
  if (attributes) assert.deepEqual(await (await import(pathToFileURL(entry).href)).inspect(), expected);
  const baseline = await esbuild.build({ absWorkingDir: f.projectRoot, entryPoints: [entry], bundle: true,
    platform: 'node', format: 'cjs', target: 'es2022', minify: true, write: false });
  assert.deepEqual(await require(f.write('baseline.cjs', baseline.outputFiles[0].text)).inspect(), expected);
  await assert.rejects(f.build(), {code: 'WGA_PREBUNDLE_AUDIT'});
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
});
