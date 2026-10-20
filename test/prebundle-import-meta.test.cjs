'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');
const esbuild = require('../fixtures/worker/node_modules/esbuild');
function fixture(t) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-prebundle-boundary-'));
  t.after(() => fs.rmSync(projectRoot, {recursive: true, force: true}));
  const write = (name, value) => { const file = path.join(projectRoot, name); fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); return file; };
  for (const file of ['index.cjs', 'prebundle.cjs']) write('build/' + file, fs.readFileSync(path.join(__dirname, '../src/build', file)));
  write('build/profiles/google-static-v1.json', {id:'google-static-v1',schemaVersion:1,transformerVersion:1,revision:1,packages:[],files:[],schemas:[],codegenInputs:[],loaderOptions:{},capabilities:[],requiredChecks:[]});
  write('package.json', {name:'prebundle-consumer',private:true,type:'module',imports:{'#inside':'./inside.d.ts'}});
  write('node_modules/@grpc/grpc-js/package.json', {name:'workers-grpc-adapter',version:'0.0.1',main:'index.cjs'});
  write('node_modules/@grpc/grpc-js/index.cjs', 'exports.client = () => 17;');
  write('wrapper.mjs', 'export {client} from "@grpc/grpc-js";');
  write('wrapper.d.ts', 'export declare function client(): number;');
  const api = require(path.join(projectRoot, 'build/prebundle.cjs'));
  return {projectRoot, write, build: options => api.buildGoogleWorkerPrebundle({projectRoot,outdir:'out',entryPoint:'wrapper.mjs',declarationFile:'wrapper.d.ts',exports:['client'],typescript:ts,esbuild,...options})};
}

for (const dependency of [false,true]) test('PREBUNDLE rejects import.meta in ' + (dependency?'an imported module':'the wrapper'), async t => {
  const f=fixture(t);
  const body='export function location(){return new URL(".",import.meta.url).protocol;}';
  f.write('wrapper.mjs','export {client} from "@grpc/grpc-js"; '+(dependency?'export {location} from "./helper.mjs";':body));
  if(dependency)f.write('helper.mjs',body);
  f.write('wrapper.d.ts','export declare function client():number;export declare function location():string;');
  const original=await import(pathToFileURL(path.join(f.projectRoot,'wrapper.mjs')).href);
  assert.equal(original.location(),'file:');
  await assert.rejects(f.build({exports:['client','location']}),{code:'WGA_PREBUNDLE_IMPORT_META'});
  assert.equal(fs.existsSync(path.join(f.projectRoot,'out')),false);
});
test('PREBUNDLE preserves a static URL through CJS, ESM and a relocated package', async t => {
  const f=fixture(t);
  f.write('wrapper.mjs','export {client} from "@grpc/grpc-js";export function location(){return new URL(".","https://example.invalid/worker.mjs").protocol;}');
  f.write('wrapper.d.ts','export declare function client():number;export declare function location():string;');
  const built=await f.build({exports:['client','location']});
  assert.equal(require(built.bundlePath).location(),'https:');
  assert.equal((await import(pathToFileURL(path.join(built.outdir,'index.mjs')).href)).location(),'https:');
  fs.cpSync(built.outdir,path.join(f.projectRoot,'relocated'),{recursive:true});
  assert.equal(require(path.join(f.projectRoot,'relocated')).location(),'https:');
});
