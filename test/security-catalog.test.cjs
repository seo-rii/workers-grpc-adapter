'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const grpc = require('../dist/index.js');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
let runs;
before(async () => {
  const { runSecurityCatalog } = await import('../fixtures/worker/security-catalog.mjs');
  runs = [];
  for (const mode of ['cloudflare', 'grpc-web']) runs.push(await runSecurityCatalog({ grpc, createWorkersGrpcTransport,
    runtime: 'node', mode, authMarker: randomBytes(32).toString('hex'), payloadMarker: randomBytes(32).toString('hex'),
    network: async (_url, init) => new Response(null, { status: Number(new Headers(init.headers).get('x-security-redirect')),
      headers: { location: 'https://security-attacker.test/capture' } }) }));
});
const rows = id => runs.flatMap(run => run.rows.filter(row => row.id === id));
test('SECURITY redirect 301 302 307 308 preserve manual mode and one authenticated fetch', () => {
  assert.equal(rows('SEC-001').length, 8);
  for (const row of rows('SEC-001')) { assert.equal(row.fetchCount, 1); assert.equal(row.authCalls, 1); assert.equal(row.manualRedirect, true); }
});
test('SECURITY encoded method and target vectors reject before authentication or network', () => {
  assert.equal(rows('SEC-002').length, 38);
  for (const row of rows('SEC-002')) assert.deepEqual([row.fetchCount, row.authCalls, row.outgoingHeaders], [0, 0, 0]);
});
test('SECURITY CRLF keys and values reject before producing outgoing headers', () => {
  assert.equal(rows('SEC-003').length, 4);
  for (const row of rows('SEC-003')) { assert.equal(row.directMetadataRejected, true); assert.equal(row.outgoingHeaders, 0); assert.equal(row.fetchCount, 0); }
});
test('SECURITY real cached and expired Google credentials cannot reach HTTP loopback', () => {
  assert.equal(rows('SEC-004').length, 2);
  for (const row of rows('SEC-004')) assert.deepEqual([row.tokenRequests, row.credentialCalls, row.tokenTransmissions, row.fetchCount], [0, 0, 0, 0]);
});
test('SECURITY auth and payload markers stay out of errors observer events and captured logs', () => {
  assert.equal(rows('SEC-006').length, 4);
  for (const row of rows('SEC-006')) assert.equal(row.redacted, true);
});
test('SECURITY mTLS environment and credential variants fail explicitly while defaults remain valid', () => {
  assert.equal(rows('SEC-007').length, 18);
  for (const row of rows('SEC-007')) assert.ok(row.acceptedControl || row.errorCode === 'WGA_UNSUPPORTED_TLS');
});
