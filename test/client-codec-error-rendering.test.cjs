'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const kind of ['ordinary', 'string', 'null', 'null-prototype', 'message-getter', 'message-object',
  'prototype-proxy', 'message-proxy', 'revoked-proxy', 'primitive-getter', 'throwing-string']) {
  test(`CLIENT ${kind} codec failures complete with INTERNAL and release resources`, { timeout: 10000 }, () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/client-codec-error-rendering.cjs'), kind],
      { encoding: 'utf8', timeout: 7000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { complete: true, failures: 12, controls: 12, uncaught: 0, logged: 0 });
  });
}
