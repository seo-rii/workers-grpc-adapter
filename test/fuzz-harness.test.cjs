'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
function fixture(t, body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-fuzz-harness-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const sub of ['scripts', 'test']) fs.mkdirSync(path.join(dir, sub));
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
    fs.copyFileSync(path.join(root, 'scripts/fuzz.cjs'), path.join(dir, 'scripts/fuzz.cjs'));
    fs.copyFileSync(path.join(root, 'test/property-helpers.cjs'), path.join(dir, 'test/property-helpers.cjs'));
    fs.writeFileSync(path.join(dir, 'scripts/test-evidence.cjs'), `module.exports=require(${JSON.stringify(path.join(root, 'scripts/test-evidence.cjs'))});`);
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
    fs.writeFileSync(path.join(dir, 'test/probe-property.test.cjs'), `const {test}=require('node:test');const {fc,check}=require('./property-helpers.cjs');\n${body}`);
    return dir;
}
function run(dir, env = {}, args = []) {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('WGA_FUZZ_')));
    const result = cp.spawnSync(process.execPath, ['scripts/fuzz.cjs', ...args], {
        cwd: dir, env: { ...inherited, WGA_FUZZ_SEED: '42', WGA_FUZZ_RUNS: '20', ...env },
        encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.error, undefined);
    return { code: result.status, report: JSON.parse(fs.readFileSync(path.join(dir, 'verification/fuzz-node.json'))) };
}
test('FUZZ harness requires real completed property receipts and rejects skipped tests', t => {
    const dir = fixture(t, "test('FUZZ probe', () => check(fc.property(fc.integer(), value => Number.isInteger(value))));");
    const passed = run(dir);
    assert.equal(passed.code, 0, JSON.stringify(passed.report));
    assert.equal(passed.report.generatedRuns, 20);
    assert.equal(passed.report.properties[0].seed, 42);
    assert.equal(passed.report.properties[0].name, 'FUZZ probe');
    fs.writeFileSync(path.join(dir, 'test/probe-property.test.cjs'), "const {test}=require('node:test');test('FUZZ probe',{skip:true},()=>{});");
    const skipped = run(dir);
    assert.equal(skipped.code, 1);
    assert.equal(skipped.report.status, 'failed');
    assert.equal(skipped.report.generatedRuns, 0);
});
test('FUZZ harness rejects TODO assertions even after completed properties and a passing corpus test', t => {
    const dir = fixture(t, "test('FUZZ probe',{todo:true},()=>{check(fc.property(fc.constant(1),()=>true));throw new Error('post-property assertion');});");
    // Corpus tests do not emit fast-check receipts. Their pass count must not
    // mask a TODO property test that fails after completing its generated runs.
    fs.writeFileSync(path.join(dir, 'test/corpus-fuzz.test.cjs'), "require('node:test')('FUZZ corpus',()=>{});");
    const result = run(dir);
    assert.equal(result.code, 1);
    assert.equal(result.report.status, 'failed');
    assert.equal(result.report.properties[0].failed, false);
    assert.equal(result.report.properties[0].runs, 20);
    assert.equal(result.report.tests.pass, 1);
    assert.equal(result.report.tests.fail, 0);
    assert.equal(result.report.tests.todo, 1);
    assert.equal(result.report.error, 'Incomplete TAP execution');
    const replay = run(dir, { WGA_FUZZ_PATH: '0' }, ['--test-name-pattern=^FUZZ probe$']);
    assert.equal(replay.code, 1);
    assert.equal(replay.report.status, 'failed');
    assert.equal(replay.report.tests.todo, 1, 'Selected replay cannot accept a TODO result');
});
test('FUZZ harness preserves shrinking and can replay the exact failing counterexample', t => {
    const dir = fixture(t, "test('FUZZ probe', () => check(fc.property(fc.integer({min:1,max:100}), value => value < 10), {examples:[[100]]}));");
    const failed = run(dir);
    assert.equal(failed.code, 1);
    const original = failed.report.properties[0];
    assert.ok(original, JSON.stringify(failed.report));
    assert.equal(original.failed, true);
    assert.ok(original.shrinks > 0);
    assert.equal(original.counterexample, '[10]');
    assert.match(original.replayCommand, /WGA_FUZZ_SEED=42 WGA_FUZZ_PATH='/);
    const replay = run(dir, { WGA_FUZZ_PATH: original.path }, ['--test-name-pattern=^FUZZ probe$']);
    assert.equal(replay.code, 1);
    assert.equal(replay.report.properties[0].counterexample, original.counterexample);
    assert.equal(replay.report.properties[0].shrinks, 0);
});
test('FUZZ harness treats interrupted campaigns as failure and rejects ambiguous replay', t => {
    const dir = fixture(t, "test('FUZZ probe', () => check(fc.property(fc.constant(1), () => { const end=Date.now()+5; while(Date.now()<end){} return true; }), {interruptAfterTimeLimit:1}));");
    const interrupted = run(dir, { WGA_FUZZ_RUNS: '1000' });
    assert.ok(interrupted.report.properties[0], JSON.stringify(interrupted.report));
    assert.equal(interrupted.code, 1);
    assert.equal(interrupted.report.properties[0].interrupted, true);
    assert.equal(interrupted.report.properties[0].failed, true);
    assert.equal(run(dir, { WGA_FUZZ_PATH: '0' }).code, 1);
    assert.equal(run(dir, {}, ['--test-name-pattern=^missing$']).code, 1);
    assert.equal(run(dir, { WGA_FUZZ_SEED: 'not-a-seed' }).code, 1);
});
