'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { inspectGoogleWorkerGraph } = require('../src/build/index.cjs');
const cli = path.resolve(__dirname, '../src/build/doctor-cli.cjs');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-public-doctor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (relative, value) => {
    const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  write('package.json', { name: 'consumer', private: true, packageManager: 'pnpm@10.30.0' });
  write('pnpm-lock.yaml', 'lockfileVersion: 9.0\n');
  write('node_modules/example-sdk/package.json', { name: 'example-sdk', version: '1.0.0', dependencies: { 'google-gax': '1.0.0' } });
  write('node_modules/example-sdk/index.js', 'throw new Error("SDK_MUST_NOT_EXECUTE");');
  write('node_modules/google-gax/package.json', { name: 'google-gax', version: '1.0.0', dependencies: { '@grpc/grpc-js': '1.0.0' } });
  write('node_modules/google-gax/index.js', 'require("@grpc/grpc-js"); throw new Error("GAX_MUST_NOT_EXECUTE");');
  write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', main: 'index.js' });
  write('node_modules/@grpc/grpc-js/index.js', 'throw new Error("ADAPTER_MUST_NOT_EXECUTE");');
  return { directory, write };
}
test('DOCTOR public API fingerprints non-npm lockfiles and declared package manager offline', t => {
  const f = fixture(t), report = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
  assert.equal(report.passed, true);
  assert.equal(report.identity.status, 'single-installation');
  assert.equal(report.environment.packageManager, 'pnpm@10.30.0');
  assert.deepEqual(report.lockfiles, [{ path: 'pnpm-lock.yaml', sha256: createHash('sha256').update('lockfileVersion: 9.0\n').digest('hex') }]);
  assert.equal(report.lockfileSha256, null, 'legacy field describes npm package-lock only');
  assert.equal(report.buildProfile, undefined, 'graph inspection does not claim AST or bundle validation');
});
test('DOCTOR installed CLI uses the current project, writes full reports, and exits 2 for duplicates', t => {
  const f = fixture(t), args = [cli, '.', 'report.json', '--sdk=example-sdk'];
  const first = spawnSync(process.execPath, args, { cwd: f.directory, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout), report = JSON.parse(fs.readFileSync(path.join(f.directory, 'report.json')));
  assert.equal(summary.results[0].packageCount, 3);
  assert.equal(report.results[0].graph.length, 3);
  assert.equal(fs.statSync(path.join(f.directory, 'report.json')).mode & 0o777, 0o600);
  fs.chmodSync(path.join(f.directory, 'report.json'), 0o644);
  f.write('node_modules/workers-grpc-adapter/package.json', { name: 'workers-grpc-adapter', version: '1.0.0' });
  const second = spawnSync(process.execPath, args, { cwd: f.directory, encoding: 'utf8' });
  assert.equal(second.status, 2);
  assert.equal(fs.statSync(path.join(f.directory, 'report.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(second.stdout).diagnostics[0].code, 'WGA_DUPLICATE_ADAPTER_INSTALLATIONS');
});
test('DOCTOR fails closed for invalid options and unsupported CLI flags', t => {
  const f = fixture(t);
  for (const options of [undefined, {}, { projectRoot: '' }, { projectRoot: f.directory, sdks: [] },
    { projectRoot: f.directory, sdks: [null] }, { projectRoot: f.directory, expectedImplementation: 'anything' }]) {
    assert.throws(() => inspectGoogleWorkerGraph(options), /WGA_DOCTOR_OPTIONS/);
  }
  const result = spawnSync(process.execPath, [cli, '--no-check-hashes'], { cwd: f.directory, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /Usage:/);
});
test('DOCTOR profile CLI requires an inspected supported compiler instead of skipping AST checks', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cli, '--profile=google-static-v1'], { cwd: f.directory, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 2); assert.match(result.stderr, /TypeScript >=5.8 <6/);
});
