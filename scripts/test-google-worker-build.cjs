'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const workerRequire = createRequire(path.join(root, 'fixtures/worker/package.json'));
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = workerRequire('miniflare');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-google-worker-build-'));
const configFile = path.join(root, 'fixtures/google/wrangler.jsonc');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');

async function main() {
  assert.equal(config.vars.WGA_RUN_GOOGLE_TESTS, '0');
  assert.equal(config.vars.WGA_ALLOW_TEST_WRITES, '0');
  assert.equal(config.workers_dev, false);
  assert.equal(config.name, 'wga-google-compatibility-tests');
  // The custom build runs from the explicit fixture cwd; main is config-relative.
  const environment = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' };
  for (const key of Object.keys(environment)) {
    if (/^(?:CF_|CLOUDFLARE_|WGA_)/.test(key)) delete environment[key];
  }
  execFileSync(process.execPath, [
    path.join(path.dirname(workerRequire.resolve('wrangler/package.json')), 'bin/wrangler.js'),
    'deploy', '--dry-run', '--cwd', path.dirname(configFile), '--config', configFile, '--outdir', temporary, '--no-autoconfig',
  ], { cwd: os.tmpdir(), env: environment, stdio: 'pipe', maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });
  const buildDir = path.dirname(path.resolve(path.dirname(configFile), config.main));
  const manifest = JSON.parse(fs.readFileSync(path.join(buildDir, 'build-manifest.json'), 'utf8'));
  assert.equal(manifest.entry, 'fixtures/google/worker.mjs');
  for (const file of ['fixtures/google/worker.mjs', 'fixtures/google/bootstrap.mjs', 'fixtures/google/suites.mjs',
    'fixtures/google/shared/datastore.mjs', 'fixtures/google/shared/firestore.mjs', 'fixtures/google/shared/secret-manager.mjs']) {
    assert.equal(manifest.sourceHashes[file], digest(fs.readFileSync(path.join(root, file))), file);
    assert.ok(manifest.inputs.includes(file), file);
  }
  assert.equal(manifest.nodeModulesModified, false);
  assert.equal(manifest.globalPrototypePatched, false);
  const script = fs.readFileSync(path.join(temporary, 'worker.js'), 'utf8');
  const key = 'local-only-test-key-with-at-least-32-characters';
  let outboundRequests = 0;
  const runtime = bindings => new Miniflare(convertV4MiniflareOptions({
    log: new Log(LogLevel.NONE), modules: true, script,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: { ...config.vars, WGA_TEST_KEY: key, ...bindings },
    outboundService: () => { outboundRequests++; throw new Error('Unexpected outbound request'); },
  }));
  const disabled = runtime({});
  try {
    for (const request of [
      { method: 'GET', headers: { authorization: `Bearer ${key}` } },
      { method: 'POST' },
      { method: 'POST', headers: { authorization: 'Bearer invalid' } },
    ]) {
      const response = await disabled.dispatchFetch('https://fixture.test/datastore-crud', request);
      assert.equal(response.status, 404);
      assert.equal(await response.text(), 'Not found');
    }
    const response = await disabled.dispatchFetch('https://fixture.test/datastore-crud', {
      method: 'POST', headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), 'Disabled');
  } finally { await disabled.dispose(); }
  const enabled = runtime({ WGA_RUN_GOOGLE_TESTS: '1', WGA_DATASTORE_PROJECT: 'demo-wga-build-only' });
  try {
    const headers = { authorization: `Bearer ${key}` };
    const unknown = await enabled.dispatchFetch('https://fixture.test/unknown-suite', { method: 'POST', headers });
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), 'Not found');
    const writeDenied = await enabled.dispatchFetch('https://fixture.test/datastore-crud', { method: 'POST', headers });
    assert.equal(writeDenied.status, 500);
    assert.deepEqual(await writeDenied.json(), { suite: 'datastore-crud', status: 'failed', code: 'REDACTED_ERROR' });
  } finally { await enabled.dispose(); }
  assert.equal(outboundRequests, 0);
  console.log(JSON.stringify({ status: 'passed', entry: manifest.entry, profile: manifest.profile,
    protectedRequests: 3, disabledRequests: 1, unknownSuiteRequests: 1, writeDeniedRequests: 1, outboundRequests }));
}

main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => fs.rmSync(temporary, { recursive: true, force: true }));
