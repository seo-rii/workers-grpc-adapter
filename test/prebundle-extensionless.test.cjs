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

for (const [name,source] of [
  ['CommonJS namespace','const m=require("node:module");exports.load = name => m.createRequire(__filename)(name);'],
  ['CommonJS module','exports.load = name => module.require(name);'],
  ['ES module namespace','import m from "node:module";export function load(name){return m.createRequire("/app.cjs")(name);}'],
  ['side-effect script','const m=require("node:module");globalThis.wgaLoader=name=>m.createRequire(__filename)(name);'],
]) test('PREBUNDLE audits extensionless '+name+' input', async t => {
  const f=fixture(t);f.write('loader',source);
  f.write('wrapper.mjs','export {client} from "@grpc/grpc-js";'+(name==='side-effect script'?'import "./loader";':'export {load} from "./loader";'));
  const exports=['client'];
  if(name!=='side-effect script'){exports.push('load');f.write('wrapper.d.ts','export declare function client():number; export declare function load(name:string):unknown;');}
  await assert.rejects(f.build({exports}),{code:'WGA_PREBUNDLE_DYNAMIC_IMPORT'});
  assert.equal(fs.existsSync(path.join(f.projectRoot,'out')),false);
});
for (const [name,source] of [['CommonJS','exports.load = name => "safe:"+name;'],['ES module','export function load(name){return "safe:"+name;}']]) test('PREBUNDLE preserves safe extensionless '+name, async t => {
  const f=fixture(t);f.write('loader',source);
  f.write('wrapper.mjs','export {client} from "@grpc/grpc-js";export {load} from "./loader";');
  f.write('wrapper.d.ts','export declare function client():number; export declare function load(name:string):string;');
  const built=await f.build({exports:['client','load']});
  assert.equal(require(built.bundlePath).load('value'),'safe:value');
  assert.equal((await import(pathToFileURL(path.join(built.outdir,'index.mjs')).href)).load('value'),'safe:value');
});
