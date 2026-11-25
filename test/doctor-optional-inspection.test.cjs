'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
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

for (const owner of ['sdk', 'google-gax']) for (const range of ['', '*']) {
  test(`DOCTOR optional dependency range ${JSON.stringify(range)} permits an absent package below ${owner}`, t => {
    const f = fixture(t);
    f.write(`node_modules/${owner}/package.json`, { name: owner, version: '1.0.0',
      dependencies: { [owner === 'sdk' ? 'google-gax' : '@grpc/grpc-js']: '*' },
      optionalDependencies: { helper: range } });
    const report = f.inspect();
    assert.equal(report.passed, true, 'empty and wildcard npm ranges are both optional declarations');
    assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === owner).dependencies.find(edge => edge.name === 'helper'),
      { name: 'helper', missing: true, optional: true });
    assert.deepEqual(report.results[0].unresolved, []);
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../src/build/doctor-cli.cjs'), f.root, '--sdk=sdk'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).passed, true);
  });
}

for (const owner of ['sdk', 'google-gax']) for (const state of ['required missing', 'installed valid', 'installed invalid']) {
  test(`DOCTOR optional dependency range controls ${owner}: ${state}`, t => {
    const f = fixture(t), required = state === 'required missing';
    f.write(`node_modules/${owner}/package.json`, { name: owner, version: '1.0.0',
      dependencies: { [owner === 'sdk' ? 'google-gax' : '@grpc/grpc-js']: '*', ...(required ? { helper: '' } : {}) },
      optionalDependencies: required ? {} : { helper: '' } });
    if (!required) {
      f.write('node_modules/helper/package.json', { name: 'helper', version: '1.0.0', main: 'index.cjs' });
      f.write('node_modules/helper/index.cjs', state === 'installed invalid'
        ? 'require("@grpc/grpc-js/missing");' : 'require("@grpc/grpc-js");');
    }
    const report = f.inspect();
    assert.equal(report.passed, state === 'installed valid');
    const edge = report.results[0].graph.find(pkg => pkg.name === owner).dependencies.find(item => item.name === 'helper');
    if (required) {
      assert.deepEqual(edge, { name: 'helper', missing: true, optional: false });
      assert.deepEqual(report.results[0].unresolved, [`node_modules/${owner}:helper`]);
    } else {
      assert.deepEqual(edge, { name: 'helper', path: 'node_modules/helper' });
      assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'helper').grpcImports.map(item => item.status),
        [state === 'installed valid' ? 'resolved-to-replacement' : 'resolution-failed']);
    }
  });
}

for (const optional of [false, true]) {
  test(`DOCTOR optional dependency ownership excludes inherited names: optional=${optional}`, t => {
    const f = fixture(t);
    f.write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0',
      dependencies: { 'google-gax': '*', constructor: '' }, optionalDependencies: optional ? { constructor: '' } : {} });
    const report = f.inspect();
    assert.equal(report.passed, optional);
    assert.deepEqual(report.results[0].graph.find(pkg => pkg.name === 'sdk').dependencies.find(edge => edge.name === 'constructor'),
      { name: 'constructor', missing: true, optional });
    assert.deepEqual(report.results[0].unresolved, optional ? [] : ['node_modules/sdk:constructor']);
  });
}

for (const layout of ['directory', 'symlink', 'nested shadow']) {
  test('DOCTOR blocks a loadable optional package without a manifest: ' + layout, t => {
    const f = fixture(t);
    f.write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0',
      dependencies: { 'google-gax': '*' }, optionalDependencies: { helper: '*' } });
    let installed = layout === 'nested shadow' ? 'node_modules/sdk/node_modules/helper' : 'node_modules/helper';
    if (layout === 'nested shadow') {
      // An ancestor's valid package must not hide the closer runtime installation.
      f.write('node_modules/helper/package.json', { name: 'helper', version: '1.0.0', main: 'index.js' });
      f.write('node_modules/helper/index.js', 'module.exports = 42;');
    }
    if (layout === 'symlink') {
      installed = 'linked-helper';
      fs.mkdirSync(path.join(f.root, installed));
      fs.symlinkSync(path.join(f.root, installed), path.join(f.root, 'node_modules/helper'), 'dir');
    }
    const entry = f.write(installed + '/index.js', 'module.exports = require("@grpc/grpc-js/missing");');
    const loader = createRequire(path.join(f.root, 'node_modules/sdk/package.json'));
    assert.equal(fs.realpathSync(loader.resolve('helper')), fs.realpathSync(entry), 'Node loads the manifestless package');
    assert.throws(() => loader('helper'), { code: 'MODULE_NOT_FOUND' });
    const report = f.inspect();
    assert.equal(report.passed, false, 'a loadable installed optional package must not become an absent edge');
    assert.equal(report.results[0].status, 'blocked');
    assert.equal(report.results[0].reason, 'resolution-failed');
    const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../src/build/doctor-cli.cjs'), f.root, '--sdk=sdk'], { encoding: 'utf8' });
    assert.equal(cli.status, 2, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).passed, false);
  });
}
test('DOCTOR still rejects a genuinely absent required dependency', t => {
  const f = fixture(t);
  f.write('node_modules/sdk/package.json', {name:'sdk',version:'1.0.0',dependencies:{'google-gax':'*',helper:'*'}});
  const report=f.inspect(); assert.equal(report.passed,false);
  assert.deepEqual(report.results[0].unresolved,['node_modules/sdk:helper']);
});

for (const extension of ['.js', '.json', '.node']) for (const nested of [false, true]) {
  test(`DOCTOR blocks a manifestless optional file ${extension}${nested ? ' before an ancestor package' : ''}`, t => {
    const f = fixture(t);
    f.write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0',
      dependencies: { 'google-gax': '*' }, optionalDependencies: { helper: '*' } });
    if (nested) {
      f.write('node_modules/helper/package.json', { name: 'helper', version: '1.0.0', main: 'index.js' });
      f.write('node_modules/helper/index.js', 'module.exports = {};');
    }
    const entry = f.write(`${nested ? 'node_modules/sdk/' : ''}node_modules/helper${extension}`,
      extension === '.json' ? '{}' : 'module.exports = require("@grpc/grpc-js/missing");');
    const loader = createRequire(path.join(f.root, 'node_modules/sdk/package.json'));
    assert.equal(loader.resolve('helper'), entry, 'Node loads the extension candidate before an ancestor package');
    const report = f.inspect();
    assert.equal(report.passed, false);
    assert.equal(report.results[0].status, 'blocked');
    assert.equal(report.results[0].reason, 'resolution-failed');
  });
}

for (const hasExports of [false, true]) {
  test(`DOCTOR respects ${hasExports ? 'package exports' : 'a bare file before a legacy directory main'}`, t => {
    const f = fixture(t);
    f.write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0',
      dependencies: { 'google-gax': '*' }, optionalDependencies: { helper: '*' } });
    const manifest = f.write('node_modules/helper/package.json', { name: 'helper', version: '1.0.0',
      main: 'index.js', ...(hasExports ? { exports: './index.js' } : {}) });
    const main = f.write('node_modules/helper/index.js', 'module.exports = {};');
    const file = f.write('node_modules/helper.js', 'module.exports = require("@grpc/grpc-js/missing");');
    const loader = createRequire(path.join(f.root, 'node_modules/sdk/package.json'));
    assert.equal(loader.resolve('helper'), hasExports ? main : file);
    assert.equal(f.inspect().passed, hasExports, manifest);
  });
}

test('DOCTOR does not mistake a helper.cjs file for a loadable bare optional package', t => {
  const f = fixture(t);
  f.write('node_modules/sdk/package.json', { name: 'sdk', version: '1.0.0',
    dependencies: { 'google-gax': '*' }, optionalDependencies: { helper: '*' } });
  f.write('node_modules/helper.cjs', 'require("@grpc/grpc-js/missing");');
  assert.throws(() => createRequire(path.join(f.root, 'node_modules/sdk/package.json')).resolve('helper'), { code: 'MODULE_NOT_FOUND' });
  assert.equal(f.inspect().passed, true);
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
