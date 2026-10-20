'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const kind of ['ordinary', 'callsites', 'object', 'symbol', 'null', 'undefined', 'throwing-formatter', 'throwing-coercion']) {
  test(`CLIENT ${kind} error stacks preserve callback, stream error and terminal status`, { timeout: 10000 }, () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/client-error-stack.cjs'), kind],
      { encoding: 'utf8', timeout: 7000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { complete: true, checked: 12, uncaught: 0, coercions: 0 });
  });
}
