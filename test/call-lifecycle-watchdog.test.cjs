'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const runner = require.resolve('../scripts/test-call-lifecycle.cjs');

function child(source) {
  const result = spawnSync(process.execPath, ['-e', `const {withNodeWatchdog}=require(${JSON.stringify(runner)});${source}`],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, 'watchdog must settle and clear its real timer');
  assert.equal(result.signal, null);
  return result;
}

test('LIFECYCLE watchdog rejects a stalled suite instead of exiting successfully with a pending promise', () => {
  const result = child(`withNodeWatchdog(()=>new Promise(()=>{}),25).catch(error=>{console.error(error.message);process.exitCode=1;});`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LIFECYCLE_NODE_TIMEOUT/);
});

test('LIFECYCLE watchdog uses real timers while deadline schedules replace global timers', () => {
  const result = child(`withNodeWatchdog(()=>{
    globalThis.setTimeout=()=>{throw Error('FAKE_SET_TIMEOUT');};
    globalThis.clearTimeout=()=>{throw Error('FAKE_CLEAR_TIMEOUT');};
    return new Promise(()=>{});
  },25).catch(error=>{console.error(error.message);process.exitCode=1;});`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LIFECYCLE_NODE_TIMEOUT/);
  assert.doesNotMatch(result.stderr, /FAKE_/);
});

test('LIFECYCLE watchdog clears its timer on suite success and failure', () => {
  const success = child(`withNodeWatchdog(()=>42).then(value=>console.log(value));`);
  assert.equal(success.status, 0);
  assert.equal(success.stdout.trim(), '42');
  const failure = child(`withNodeWatchdog(()=>{throw Error('SUITE_FAILURE');}).catch(error=>console.log(error.message));`);
  assert.equal(failure.status, 0);
  assert.equal(failure.stdout.trim(), 'SUITE_FAILURE');
});
