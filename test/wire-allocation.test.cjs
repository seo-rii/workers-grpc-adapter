'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { runAllocationChecks, measureParser } = require('../scripts/wire-allocation.cjs');

test('WIRE allocation receipts prove exact linear copies, all flags, and rejection before payload demand', async () => {
  const report = await runAllocationChecks({ sourceBuild: true });
  assert.equal(report.status, 'passed'); assert.equal(report.spyRestored, true);
  assert.deepEqual([...new Set(report.rows.map(row => row.id))], Array.from({ length: 15 }, (_, index) => `WIRE-${String(index + 1).padStart(3, '0')}`));
  assert.equal(report.rows.filter(row => row.id === 'WIRE-004').length, 4);
  assert.equal(report.rows.filter(row => row.id === 'WIRE-012').length, 252);
  for (const row of report.rows.filter(row => row.id === 'WIRE-005')) {
    assert.equal(row.allocUnsafeBytes, row.setBytes + 5);
    assert.equal(row.setCalls, row.setBytes); assert.equal(row.concatCalls, 0);
  }
  const representations = report.rows.filter(row => row.id === 'WIRE-006');
  assert.deepEqual(representations[0].frames, representations[1].frames);
  assert.equal(representations[0].allocUnsafeBytes, representations[1].allocUnsafeBytes);
  assert.equal(representations[0].setBytes, representations[1].setBytes);
  for (const row of report.rows.filter(row => row.id === 'WIRE-009' || (row.id === 'WIRE-008' && row.code === 8))) {
    assert.deepEqual(row.allocUnsafeSizes, [5]); assert.deepEqual(row.pulledChunkSizes, [5]); assert.equal(row.pulls, 1);
  }
});

test('WIRE allocation spies restore inherited Buffer methods after actual source read failure', async () => {
  const before = [Object.getOwnPropertyDescriptor(Buffer, 'allocUnsafe'),
    Object.getOwnPropertyDescriptor(Buffer.prototype, 'set'), Object.getOwnPropertyDescriptor(Buffer, 'concat')];
  const result = await measureParser({ sourceBuild: true, chunks: [Uint8Array.of(0, 0)], sourceError: new Error('injected source failure') });
  assert.equal(result.code, null); assert.equal(result.errorId, 'injected source failure');
  assert.deepEqual(result.allocUnsafeSizes, [5]); assert.equal(result.setBytes, 2);
  assert.equal(result.pulls, 2); assert.equal(result.readerLocked, false); assert.equal(result.finalResources.bufferedBytes, 0);
  assert.deepEqual([Object.getOwnPropertyDescriptor(Buffer, 'allocUnsafe'),
    Object.getOwnPropertyDescriptor(Buffer.prototype, 'set'), Object.getOwnPropertyDescriptor(Buffer, 'concat')], before);
  const recovered = await measureParser({ sourceBuild: true, chunks: [Uint8Array.of(0, 0, 0, 0, 0)] });
  assert.equal(recovered.code, 0); assert.equal(recovered.frames.length, 1); assert.equal(recovered.frames[0].bytes, 0);
  assert.deepEqual(recovered.allocUnsafeSizes, [5, 0, 5]); assert.equal(recovered.finalResources.bufferedBytes, 0);
});
