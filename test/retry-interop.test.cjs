'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runRetryInterop } = require('../scripts/test-security-catalog.cjs');
test('RETRY native UNAVAILABLE arrives once and real token HTTP is separate from GAX new calls', { timeout: 20000 }, async () => {
  const report = await runRetryInterop({ grpc: require('../dist/index.js'), createWorkersGrpcTransport: require('../dist/adapter.js').createWorkersGrpcTransport });
  const [once, authenticated] = report.results;
  assert.equal(once.dataFetches, 1); assert.equal(once.serverArrivals, 1); assert.equal(once.tokenRequests, 0);
  assert.equal(authenticated.tokenRequests, 1); assert.equal(authenticated.dataFetches, 4); assert.equal(authenticated.serverArrivals, 4);
  assert.equal(authenticated.gaxLogicalCalls, 1); assert.equal(authenticated.gaxNewGrpcCalls, 2);
  assert.equal(authenticated.serverBearerMatches, 3); assert.equal(authenticated.serverBearerUnexpected, 0);
  assert.deepEqual(authenticated.adapterCallEnds.map(event => event.fetchCount), [1, 1, 1, 1]);
});
