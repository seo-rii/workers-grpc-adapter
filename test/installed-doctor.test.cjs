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
for (const extension of ['js', 'cjs', 'mjs', 'd.ts', 'd.mts', 'd.cts']) {
  test(`DOCTOR API and CLI inspect installed .${extension} grpc-js imports`, t => {
    const f = fixture(t), file = `node_modules/example-sdk/nested/imports.${extension}`;
    const source = specifier => ['js', 'cjs'].includes(extension)
      ? `module.exports = require("${specifier}");`
      : `export { Metadata } from "${specifier}";`;
    const args = [cli, '.', '--sdk=example-sdk'];
    f.write(file, source('@grpc/grpc-js/unsupported-private-path'));
    const rejected = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
    const rejectedCli = spawnSync(process.execPath, args, { cwd: f.directory, encoding: 'utf8' });
    f.write(file, source('@grpc/grpc-js'));
    const accepted = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
    const acceptedCli = spawnSync(process.execPath, args, { cwd: f.directory, encoding: 'utf8' });

    assert.equal(rejected.passed, false, 'an unresolved import in any scanned extension must fail the graph');
    assert.equal(rejected.results[0].status, 'wrong-implementation');
    assert.equal(rejected.results[0].grpcImportCount, 2, 'includes the SDK import and existing GAX runtime import');
    assert.deepEqual(rejected.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.status === 'resolution-failed'), [
      { file, specifier: '@grpc/grpc-js/unsupported-private-path', status: 'resolution-failed' },
    ]);
    assert.equal(rejectedCli.status, 2, rejectedCli.stderr);
    assert.deepEqual(JSON.parse(rejectedCli.stdout), rejected, 'CLI reports the same failing graph as the public API');

    assert.equal(accepted.passed, true, 'a resolvable import of the replacement passes');
    assert.equal(accepted.results[0].grpcImportCount, 2);
    assert.deepEqual(accepted.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.file === file), [
      { file, specifier: '@grpc/grpc-js', resolved: 'node_modules/@grpc/grpc-js/index.js',
        implementation: 'workers-grpc-adapter', version: '1.0.0', status: 'resolved-to-replacement' },
    ]);
    assert.equal(acceptedCli.status, 0, acceptedCli.stderr);
    assert.deepEqual(JSON.parse(acceptedCli.stdout), accepted, 'CLI reports the same passing graph as the public API');
  });
}
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
  for (const profile of ['', null, false, 'unreviewed-sdk']) {
    assert.throws(() => inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'], profile }),
      { code: 'WGA_UNSUPPORTED_DEPENDENCY' }, 'an explicitly supplied profile cannot become graph-only inspection');
  }
  const result = spawnSync(process.execPath, [cli, '--no-check-hashes'], { cwd: f.directory, encoding: 'utf8' });
  assert.equal(result.status, 2); assert.match(result.stderr, /Usage:/);
});
test('DOCTOR profile CLI requires an inspected supported compiler instead of skipping AST checks', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [cli, '--profile=google-static-v1'], { cwd: f.directory, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(result.status, 2); assert.match(result.stderr, /TypeScript >=5.8 <6/);
});
