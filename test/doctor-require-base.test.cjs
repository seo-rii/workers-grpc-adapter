'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectGoogleWorkerGraph } = require('../src/build/index.cjs');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-doctor-walk-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (name, value) => {
        const file = path.join(root, name);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        return file;
    };
    write('package.json', { private: true });
    write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0', dependencies: { 'google-gax': '*' } });
    write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '*' } });
    write('node_modules/google-gax/index.cjs', 'require("@grpc/grpc-js");');
    write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.cjs' });
    write('node_modules/@grpc/grpc-js/index.cjs', 'throw new Error("INSPECTED_MODULE_EXECUTED");');
    return { root, write, inspect: () => inspectGoogleWorkerGraph({ projectRoot: root, sdks: ['sdk'] }) };
}


const {pathToFileURL}=require('node:url');
function withForeign(f,implementation='@grpc/grpc-js') {
  f.write('node_modules/@grpc/grpc-js/index.cjs','module.exports={tag:"local"};');
  f.write('foreign/node_modules/@grpc/grpc-js/package.json',{name:implementation,version:'1.0.0',main:'index.cjs'});
  f.write('foreign/node_modules/@grpc/grpc-js/index.cjs','module.exports={tag:"foreign"};');
  return path.join(f.root,'foreign/loader.cjs');
}
for(const kind of ['absolute path','file URL','relative URL','namespace factory']) test('DOCTOR resolves createRequire from its '+kind, async t=>{
  const f=fixture(t),foreign=withForeign(f);
  const expression=kind==='file URL'?JSON.stringify(pathToFileURL(foreign).href):kind==='relative URL'?'new URL("../../foreign/loader.cjs",import.meta.url)':JSON.stringify(foreign);
  const source=(kind==='namespace factory'?'import * as m from "node:module";const require=m.createRequire(':'import {createRequire as make} from "node:module";const require=make(')+expression+');export const loaded=require("@grpc/grpc-js");';
  const file=f.write('node_modules/sdk/index.mjs',source);
  assert.equal((await import(pathToFileURL(file).href)).loaded.tag,'foreign');
  const report=f.inspect();assert.equal(report.passed,false);
  const imported=report.results[0].graph.find(p=>p.name==='sdk').grpcImports[0];
  assert.equal(imported.implementation,'@grpc/grpc-js');
  assert.equal(imported.resolved,'foreign/node_modules/@grpc/grpc-js/index.cjs');
});
test('DOCTOR records a second adapter selected by a foreign createRequire base',t=>{
  const f=fixture(t),foreign=withForeign(f,'workers-grpc-adapter');
  f.write('node_modules/sdk/index.mjs','import {createRequire} from "module";const require=createRequire('+JSON.stringify(foreign)+');require("@grpc/grpc-js");');
  const report=f.inspect();assert.equal(report.passed,false);assert.equal(report.identity.status,'duplicate-installations');assert.equal(report.identity.installations.length,2);
});
test('DOCTOR checks distinct createRequire bases for the same specifier and source',t=>{
  const f=fixture(t),foreign=withForeign(f);
  f.write('node_modules/sdk/index.mjs','import {createRequire} from "node:module";{const require=createRequire(import.meta.url);require("@grpc/grpc-js");}{const require=createRequire('+JSON.stringify(foreign)+');require("@grpc/grpc-js");}');
  const report=f.inspect();assert.equal(report.passed,false);
  const imported=report.results[0].graph.find(p=>p.name==='sdk').grpcImports;
  assert.equal(imported.length,2);assert.deepEqual(imported.map(x=>x.implementation).sort(),['@grpc/grpc-js','workers-grpc-adapter']);
});
test('DOCTOR fails closed on an unproven createRequire base',t=>{
  const f=fixture(t),foreign=withForeign(f);
  f.write('node_modules/sdk/index.mjs','import {createRequire} from "node:module";const base='+JSON.stringify(foreign)+';const require=createRequire(base);require("@grpc/grpc-js");');
  const report=f.inspect();assert.equal(report.passed,false);
  assert.equal(report.results[0].graph.find(p=>p.name==='sdk').grpcImports[0].status,'resolution-base-unverified');
});
test('DOCTOR does not treat import.meta-like string contents as a source URL', t => {
  const f = fixture(t);
  f.write('node_modules/sdk/index.mjs', 'import {createRequire} from "node:module"; const require = createRequire("import . meta . url"); require("@grpc/grpc-js");');
  const report = f.inspect();
  assert.equal(report.passed, false);
  assert.equal(report.results[0].graph.find(p => p.name === 'sdk').grpcImports[0].status, 'resolution-failed');
});
for(const expression of ['import.meta.url','(import.meta.url)','new URL("./index.mjs",import.meta.url)']) test('DOCTOR preserves source-local createRequire control: '+expression,async t=>{
  const f=fixture(t);withForeign(f);
  const file=f.write('node_modules/sdk/index.mjs','import {createRequire} from "node:module";const require=createRequire('+expression+');export const loaded=require("@grpc/grpc-js");');
  assert.equal((await import(pathToFileURL(file).href)).loaded.tag,'local');
  const report=f.inspect();assert.equal(report.passed,true);
  assert.equal(report.results[0].graph.find(p=>p.name==='sdk').grpcImports[0].resolved,'node_modules/@grpc/grpc-js/index.cjs');
});
