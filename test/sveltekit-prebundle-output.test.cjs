'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const script = fs.readFileSync(path.join(__dirname, '../fixtures/sveltekit/build/prebundle.mjs'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function write(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
function snapshot(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map(file => [file, fs.readFileSync(path.join(directory, file), 'utf8')]));
}
function artifact(directory, tag) {
  const files = { 'index.cjs': `exports.value = ${JSON.stringify(tag)};\n`,
    'package.json': JSON.stringify({ name: '@wga-fixture/google-workers', private: true }) + '\n' };
  for (const [file, bytes] of Object.entries(files)) write(path.join(directory, file), bytes);
  write(path.join(directory, 'manifest.json'), JSON.stringify({ kind: 'google-worker-prebundle',
    artifacts: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, { sha256: hash(bytes) }])) }) + '\n');
  return snapshot(directory);
}
function fixture(t, { existing = true } = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-sveltekit-output-'));
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  const outdir = path.join(projectRoot, 'packages/google-workers/generated');
  const before = existing ? artifact(outdir, 'original') : undefined;
  const next = artifact(path.join(projectRoot, 'next-package'), 'replacement');
  write(path.join(projectRoot, 'build/prebundle.mjs'), script);
  // Only generation is stubbed. The shipped script performs all real filesystem
  // publication, validation, backup, restore and cleanup operations unchanged.
  for (const [name, source] of [['esbuild', 'export const version = "fixture";'],
    ['typescript', 'export default {version: "5.8.3"};']]) {
    write(path.join(projectRoot, 'node_modules', name, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.mjs' }));
    write(path.join(projectRoot, 'node_modules', name, 'index.mjs'), source);
  }
  const helper = path.join(projectRoot, 'node_modules/@grpc/grpc-js');
  write(path.join(helper, 'package.json'), JSON.stringify({ name: 'workers-grpc-adapter', type: 'module', exports: { './build': './build.mjs' } }));
  write(path.join(helper, 'build.mjs'), `import fs from 'node:fs';
import path from 'node:path';
export async function buildGoogleWorkerPrebundle({projectRoot, outdir}) {
  fs.cpSync(path.join(projectRoot, 'next-package'), outdir, {recursive: true});
  return {get outdir() {
    // Argument evaluation injects failure immediately before the real publish
    // rename, after the script has moved the previous artifact into its backup.
    if (process.env.WGA_PUBLISH_TEST_MODE === 'missing-source') fs.rmSync(outdir, {recursive: true});
    if (process.env.WGA_PUBLISH_TEST_MODE === 'concurrent-output') {
      const destination = path.join(projectRoot, 'packages/google-workers/generated');
      fs.mkdirSync(destination, {recursive: true});
      fs.writeFileSync(path.join(destination, 'user-file'), 'concurrent user data');
    }
    return outdir;
  }};
}
`);
  const run = (mode = 'normal') => spawnSync(process.execPath, [path.join(projectRoot, 'build/prebundle.mjs')], {
    cwd: projectRoot, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), WGA_PUBLISH_TEST_MODE: mode },
  });
  const temporary = () => fs.readdirSync(projectRoot).filter(name => name.startsWith('.prebundle-'));
  return { projectRoot, outdir, before, next, run, temporary };
}

for (const existing of [false, true]) {
  test(`SVELTEKIT prebundle publishes ${existing ? 'over a verified previous artifact' : 'into a fresh output directory'}`, t => {
    const f = fixture(t, { existing }), result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(f.outdir), f.next);
    assert.deepEqual(f.temporary(), []);
  });
}

test('SVELTEKIT prebundle restores the exact previous artifact when publication fails', t => {
  const f = fixture(t), result = f.run('missing-source');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(snapshot(f.outdir), f.before);
  assert.deepEqual(f.temporary(), []);
});

test('SVELTEKIT prebundle keeps a changed previous artifact and rejects replacement', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.outdir, 'index.cjs'), 'user changed this artifact');
  const changed = snapshot(f.outdir), result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /changed or unrecognized files/);
  assert.deepEqual(snapshot(f.outdir), changed);
  assert.deepEqual(f.temporary(), []);
});

test('SVELTEKIT prebundle retains its backup and concurrent user files when restoration fails', t => {
  const f = fixture(t), result = f.run('concurrent-output');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(snapshot(f.outdir), { 'user-file': 'concurrent user data' });
  const directories = f.temporary();
  assert.equal(directories.length, 1, 'Failed restoration must leave the recovery directory intact');
  const previous = path.join(f.projectRoot, directories[0], 'previous');
  assert.deepEqual(snapshot(previous), f.before);
  assert.ok(result.stderr.includes(previous), 'The build error must identify the preserved recovery path');
  assert.ok(result.stderr.includes(f.outdir), 'The build error must identify the untouched current output');
});
