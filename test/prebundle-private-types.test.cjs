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

for (const form of [
  'import type {Value} from "#inside"; export declare const client: Value;',
  'export {client} from "#inside";',
  'export declare const client: import("#inside").Value;',
  'import inner = require("#inside"); export declare const client: inner.Value;',
  '/// <reference types="#inside" />\nexport declare const client: unknown;',
]) test('PREBUNDLE rejects package-private declaration resources: ' + form.split(';')[0], async t => {
  const f = fixture(t);
  f.write('inside.d.ts', 'export type Value = () => number; export declare const client: Value;');
  f.write('wrapper.d.ts', form);
  await assert.rejects(f.build(), {code:'WGA_PREBUNDLE_DECLARATIONS'});
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'out')), false);
});
test('PREBUNDLE preserves installed external types for a relocated ESM consumer', async t => {
  const f = fixture(t);
  f.write('node_modules/external-types/package.json', {name:'external-types',version:'1.0.0',types:'index.d.ts'});
  f.write('node_modules/external-types/index.d.ts', 'export type Value = () => number;');
  f.write('wrapper.d.ts', 'import type {Value} from "external-types"; export declare const client: Value;');
  const built = await f.build();
  const consumer = f.write('consumer.mts', 'import {client} from "./out/index.mjs"; const value: number = client();');
  const program = ts.createProgram([consumer], {strict:true,noEmit:true,skipLibCheck:false,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,types:[]});
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')), []);
  assert.equal((await import(pathToFileURL(path.join(built.outdir,'index.mjs')).href)).client(), 17);
});
