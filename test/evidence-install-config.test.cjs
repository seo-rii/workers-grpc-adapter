'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { captureInputs, validateSnapshot } = require('../scripts/test-evidence.cjs');

test('EVIDENCE records pnpm installation policy and rejects stale or missing configuration', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-evidence-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['src', 'scripts', 'test', 'fixtures', 'docs', 'vendor', 'compatibility']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const configs = ['fixtures/hono/.npmrc', 'fixtures/sveltekit/.npmrc'];
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'PLAN.md',
    'LICENSE', 'NOTICE', '.github/workflows/local.yml', 'fixtures/google/.env.example', ...configs]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), configs.includes(file) ? 'node-linker=isolated\nhoist=false\nstrict-peer-dependencies=true\n' : 'fixture\n');
  }
  fs.writeFileSync(path.join(root, 'fixtures/hono/.env'), 'PRIVATE_TEST_VALUE=not-an-input\n');
  const before = captureInputs(root);
  for (const config of configs) {
    assert.match(before[config] || '', /^[a-f0-9]{64}$/);
    const file = path.join(root, config);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, 'node-linker=hoisted\nhoist=true\nstrict-peer-dependencies=false\n');
    assert.throws(() => validateSnapshot(before, captureInputs(root), 'installation inputs'), /stale or missing hashes/);
    fs.writeFileSync(file, original);
    validateSnapshot(before, captureInputs(root), 'unchanged inputs');
    fs.unlinkSync(file);
    assert.throws(() => captureInputs(root), /ENOENT/);
    fs.writeFileSync(file, original);
  }
  assert.equal(Object.hasOwn(before, 'fixtures/hono/.env'), false);
});
