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

for (const [name,copy] of [
  ['spread','const copy={...m};'],
  ['Object.assign return','const copy=Object.assign({},m);'],
  ['Object.assign mutation','const copy={};Object.assign(copy,m);'],
  ['transitive spread','const first={...m};const copy={...first};'],
]) test('PREBUNDLE rejects copied Node loaders through '+name, async t => {
  const f=fixture(t);
  f.write('loader.cjs','const m=require("node:module");'+copy+'exports.load=name=>copy.createRequire(__filename)(name);');
  f.write('wrapper.mjs','export {client} from "@grpc/grpc-js";export {load} from "./loader.cjs";');
  f.write('wrapper.d.ts','export declare function client():number;export declare function load(name:string):unknown;');
  await assert.rejects(f.build({exports:['client','load']}),{code:'WGA_PREBUNDLE_DYNAMIC_IMPORT'});
  assert.equal(fs.existsSync(path.join(f.projectRoot,'out')),false);
});
for (const [name,source] of [
  ['spread builtin','const m=require("node:module");const copy={...m};exports.probe=()=>copy.isBuiltin("node:fs");'],
  ['assigned builtin','const m=require("node:module");const copy={};Object.assign(copy,m);exports.probe=()=>copy.isBuiltin("node:fs");'],
  ['ordinary spread','const ordinary={createRequire:()=>true};const copy={...ordinary};exports.probe=()=>copy.createRequire();'],
  ['shadowed Object','const m=require("node:module");const Object={assign(){return {createRequire:()=>true};}};const copy=Object.assign({},m);exports.probe=()=>copy.createRequire();'],
]) test('PREBUNDLE preserves non-loader copied properties: '+name, async t => {
  const f=fixture(t);f.write('helper.cjs',source);
  f.write('wrapper.mjs','export {client} from "@grpc/grpc-js";export {probe} from "./helper.cjs";');
  f.write('wrapper.d.ts','export declare function client():number;export declare function probe():boolean;');
  const built=await f.build({exports:['client','probe']});assert.equal(require(built.bundlePath).probe(),true);
});
