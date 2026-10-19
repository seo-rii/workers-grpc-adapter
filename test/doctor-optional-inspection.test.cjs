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

for (const damage of ['dangling source link', 'invalid package manifest']) {
  test('DOCTOR fails an installed optional dependency with ' + damage, t => {
    const f = fixture(t);
    f.write('node_modules/sdk/package.json', {name:'sdk',version:'1.0.0',dependencies:{'google-gax':'*'},optionalDependencies:{helper:'*'}});
    f.write('node_modules/helper/package.json', {name:'helper',version:'1.0.0',main:'index.cjs'});
    f.write('node_modules/helper/index.cjs', 'require("@grpc/grpc-js/missing");');
    assert.equal(f.inspect().passed, false, 'the installed helper has an unresolved runtime import');
    if (damage === 'dangling source link') fs.symlinkSync(path.join(f.root,'absent'), path.join(f.root,'node_modules/helper/aaa-broken'));
    else f.write('node_modules/helper/package.json', '{');
    const report = f.inspect();
    assert.equal(report.passed, false, 'a failed walk must not hide an installed optional package');
    assert.equal(report.results[0].status, 'blocked');
    assert.equal(report.results[0].reason, 'resolution-failed');
  });
}
test('DOCTOR permits a genuinely absent optional dependency and inspects an installed valid one', t => {
  const f = fixture(t);
  f.write('node_modules/sdk/package.json', {name:'sdk',version:'1.0.0',dependencies:{'google-gax':'*'},optionalDependencies:{helper:'*'}});
  let report = f.inspect();
  assert.equal(report.passed, true);
  assert.deepEqual(report.results[0].graph.find(p=>p.name==='sdk').dependencies.find(d=>d.name==='helper'), {name:'helper',missing:true,optional:true});
  f.write('node_modules/helper/package.json', {name:'helper',version:'1.0.0',main:'index.cjs'});
  f.write('node_modules/helper/index.cjs', 'require("@grpc/grpc-js");');
  report = f.inspect();
  assert.equal(report.passed, true);
  assert.ok(report.results[0].graph.some(p=>p.name==='helper'));
});
test('DOCTOR still rejects a genuinely absent required dependency', t => {
  const f = fixture(t);
  f.write('node_modules/sdk/package.json', {name:'sdk',version:'1.0.0',dependencies:{'google-gax':'*',helper:'*'}});
  const report=f.inspect(); assert.equal(report.passed,false);
  assert.deepEqual(report.results[0].unresolved,['node_modules/sdk:helper']);
});

for (const cycle of [false,true]) test('DOCTOR never reuses a failed partial package across SDK roots'+(cycle?' through a dependency cycle':''), t => {
  const f=fixture(t);
  f.write('node_modules/sdk/package.json',{name:'sdk',version:'1.0.0',dependencies:{'google-gax':'*'},optionalDependencies:{helper:'*'}});
  f.write('node_modules/second/package.json',{name:'second',version:'1.0.0',dependencies:{'google-gax':'*'},optionalDependencies:{[cycle?'cycle':'helper']:'*'}});
  f.write('node_modules/helper/package.json',{name:'helper',version:'1.0.0',...(cycle?{dependencies:{cycle:'*'}}:{})});
  f.write('node_modules/helper/index.cjs','require("@grpc/grpc-js");');
  if(cycle){f.write('node_modules/cycle/package.json',{name:'cycle',version:'1.0.0',dependencies:{helper:'*'}});f.write('node_modules/cycle/index.cjs','require("@grpc/grpc-js");');}
  const inspect=()=>inspectGoogleWorkerGraph({projectRoot:f.root,sdks:['sdk','second']});
  assert.equal(inspect().passed,true,'valid shared packages and cycles still complete');
  fs.symlinkSync(path.join(f.root,'absent'),path.join(f.root,'node_modules/helper/aaa-broken'));
  const report=inspect();assert.equal(report.passed,false);
  assert.deepEqual(report.results.map(result=>result.status),['blocked','blocked']);
});
