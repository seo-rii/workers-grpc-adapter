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
for (const [filename, source] of [
  ['imports.mjs', 'import { identity } from "@grpc/grpc-js/conditional"; console.log(identity);'],
  ['module/imports.js', 'import { identity } from "@grpc/grpc-js/conditional"; console.log(identity);'],
  ['reexports.mjs', 'export { identity } from "@grpc/grpc-js/conditional";'],
  ['dynamic.cjs', 'import("@grpc/grpc-js/conditional").then(value => console.log(value.identity));'],
]) for (const condition of ['both', 'import-only', 'missing-import', 'directory-import']) {
  test(`DOCTOR uses native import conditions for ${filename}: ${condition}`, t => {
    const f = fixture(t), imported = `node_modules/example-sdk/${filename}`;
    const conditional = { ...(condition === 'import-only' ? {} : { require: './index.js' }),
      import: condition === 'missing-import' ? './missing.mjs' : condition === 'directory-import' ? './directory' : './esm.mjs' };
    f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', exports: { '.': './index.js', './conditional': conditional } });
    f.write('node_modules/@grpc/grpc-js/esm.mjs', 'export const identity = "esm";');
    f.write('node_modules/@grpc/grpc-js/directory/index.js', 'throw new Error("DIRECTORY_MUST_NOT_EXECUTE");');
    f.write('node_modules/example-sdk/module/package.json', { type: 'module' });
    f.write(imported, source);
    const report = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
    const command = spawnSync(process.execPath, [cli, f.directory, '--sdk=example-sdk'], { encoding: 'utf8' });
    const actual = spawnSync(process.execPath, [path.join(f.directory, imported)], { encoding: 'utf8' });
    const passed = condition === 'both' || condition === 'import-only';
    assert.equal(actual.status, passed ? 0 : 1, actual.stderr);
    assert.equal(report.passed, passed);
    assert.equal(command.status, passed ? 0 : 2, command.stderr);
    const imports = report.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.file === imported);
    assert.equal(imports.length, 1);
    assert.equal(imports[0].kind, 'import');
    assert.equal(imports[0].status, passed ? 'resolved-to-replacement' : 'resolution-failed');
    if (passed) assert.equal(imports[0].resolved, 'node_modules/@grpc/grpc-js/esm.mjs');
    assert.deepEqual(JSON.parse(command.stdout), report);
  });
}

test('DOCTOR distinguishes require and import of the same specifier in one CJS module without executing inspected code', t => {
  const f = fixture(t), file = 'node_modules/example-sdk/both.cjs';
  f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', exports: {
    '.': './index.js', './conditional': { require: './index.js', import: './esm.mjs' },
  } });
  const marker = path.join(f.directory, 'executed');
  const sideEffect = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`;
  f.write('node_modules/@grpc/grpc-js/index.js', sideEffect);
  f.write('node_modules/@grpc/grpc-js/esm.mjs', `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  f.write(file, `${sideEffect}\nrequire('@grpc/grpc-js/conditional'); import('@grpc/grpc-js/conditional');`);
  const report = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
  assert.equal(report.passed, true);
  const imports = report.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.file === file);
  assert.deepEqual(imports.map(item => [item.kind, item.resolved]).sort(), [
    ['import', 'node_modules/@grpc/grpc-js/esm.mjs'], ['require', 'node_modules/@grpc/grpc-js/index.js'],
  ]);
  assert.equal(fs.existsSync(marker), false);
  fs.unlinkSync(path.join(f.directory, 'node_modules/@grpc/grpc-js/esm.mjs'));
  const rejected = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
  assert.equal(rejected.passed, false);
  const checked = rejected.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.file === file);
  assert.equal(checked.find(item => item.kind === 'require').status, 'resolved-to-replacement');
  assert.equal(checked.find(item => item.kind === 'import').status, 'resolution-failed');
  assert.equal(fs.existsSync(marker), false);
});

test('DOCTOR does not satisfy a missing require target with its working import alternative', t => {
  const f = fixture(t), file = 'node_modules/example-sdk/both.cjs';
  f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', exports: {
    '.': './index.js', './conditional': { require: './missing.cjs', import: './esm.mjs' },
  } });
  f.write('node_modules/@grpc/grpc-js/esm.mjs', 'throw new Error("ADAPTER_MUST_NOT_EXECUTE");');
  f.write(file, 'require("@grpc/grpc-js/conditional"); import("@grpc/grpc-js/conditional");');
  const report = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
  assert.equal(report.passed, false);
  const imports = report.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.file === file);
  assert.equal(imports.find(item => item.kind === 'require').status, 'resolution-failed');
  assert.equal(imports.find(item => item.kind === 'import').status, 'resolved-to-replacement');
});

test('DOCTOR resolver excludes inherited preload hooks and fails closed when its process cannot start', t => {
  const f = fixture(t), file = 'node_modules/example-sdk/imports.mjs', marker = path.join(f.directory, 'preload-executed');
  f.write(file, 'import "@grpc/grpc-js";');
  f.write('preload.cjs', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  const savedOptions = process.env.NODE_OPTIONS, savedExecutable = process.execPath;
  try {
    process.env.NODE_OPTIONS = `--require=${JSON.stringify(path.join(f.directory, 'preload.cjs'))}`;
    assert.equal(inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] }).passed, true);
    assert.equal(fs.existsSync(marker), false, 'resolution must not run inherited preload scripts');
    process.execPath = path.join(f.directory, 'node-missing');
    const report = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
    assert.equal(report.passed, false);
    const imported = report.results[0].graph.flatMap(pkg => pkg.grpcImports).find(item => item.file === file);
    assert.equal(imported.status, 'resolution-failed');
    assert.equal(fs.existsSync(marker), false);
  } finally {
    process.execPath = savedExecutable;
    if (savedOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOptions;
  }
});

for (const extension of ['d.ts', 'd.cts', 'd.mts']) {
  test(`DOCTOR keeps .${extension} declaration availability separate from runtime imports`, t => {
    const f = fixture(t), file = `node_modules/example-sdk/types.${extension}`;
    f.write('node_modules/@grpc/grpc-js/package.json', { name: 'workers-grpc-adapter', version: '1.0.0', exports: {
      '.': { require: './index.js', import: './missing.mjs' },
    } });
    f.write(file, 'export { Metadata } from "@grpc/grpc-js";');
    const report = inspectGoogleWorkerGraph({ projectRoot: f.directory, sdks: ['example-sdk'] });
    assert.equal(report.passed, true);
    const imported = report.results[0].graph.flatMap(pkg => pkg.grpcImports).find(item => item.file === file);
    assert.equal(imported.kind, 'declaration');
    assert.equal(imported.resolved, 'node_modules/@grpc/grpc-js/index.js');
  });
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
    const kind = extension.startsWith('d.') ? 'declaration' : ['js', 'cjs'].includes(extension) ? 'require' : 'import';
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
      { file, specifier: '@grpc/grpc-js/unsupported-private-path', kind, status: 'resolution-failed' },
    ]);
    assert.equal(rejectedCli.status, 2, rejectedCli.stderr);
    assert.deepEqual(JSON.parse(rejectedCli.stdout), rejected, 'CLI reports the same failing graph as the public API');

    assert.equal(accepted.passed, true, 'a resolvable import of the replacement passes');
    assert.equal(accepted.results[0].grpcImportCount, 2);
    assert.deepEqual(accepted.results[0].graph.flatMap(pkg => pkg.grpcImports).filter(item => item.file === file), [
      { file, specifier: '@grpc/grpc-js', kind, resolved: 'node_modules/@grpc/grpc-js/index.js',
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
