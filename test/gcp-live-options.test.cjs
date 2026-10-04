'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseSoakSeconds } = require('../scripts/gcp-soak.cjs');
const source = fs.readFileSync(path.join(__dirname, '../scripts/gcp-cloud-probe.cjs'), 'utf8');
const start = source.indexOf('async function main() {');
const end = source.indexOf('\nasync function cleanup()', start);
assert.ok(start >= 0 && end > start);
const main = source.slice(start, end);

async function rejectBeforeCredentials(args, expected) {
  let credentialReads = 0;
  const run = vm.runInNewContext(`(${main})`, {
    process: { argv: ['node', 'gcp-cloud-probe.cjs', ...args], env: {} },
    report: {}, root: '/fixture', parseSoakSeconds,
    catalog: { sourceHashes: () => ({}) },
    secret() { credentialReads++; throw new Error('CREDENTIAL_BOUNDARY'); },
  });
  await assert.rejects(run(), expected);
  assert.equal(credentialReads, 0);
}

test('live opt-in and malformed repetition options fail before credential discovery', async () => {
  await rejectBeforeCredentials(['--soak-seconds=600'], /EXPLICIT_DEPLOY_TEMPORARY_REQUIRED/);
  for (const args of [['--soak-seconds=59'], ['--soak-seconds=601'], ['--soak-seconds=60.5'],
    ['--soak-seconds=600', '--soak-seconds=600']]) {
    await rejectBeforeCredentials(['--deploy-temporary', ...args], /[Ss]oak/);
  }
});

test('temporary-account token grant requires catalog mode and exactly one explicit flag', async () => {
  await rejectBeforeCredentials(['--deploy-temporary', '--grant-owned-token-creator'], /CATALOG_REQUIRED_FOR_OWNED_IAM_GRANT/);
  for (const args of [['--grant-owned-token-creator=true'], ['--grant-owned-token-creator=false'],
    ['--grant-owned-token-creator', '--grant-owned-token-creator']]) {
    await rejectBeforeCredentials(['--deploy-temporary', '--catalog', ...args], /INVALID_OWNED_IAM_GRANT_OPTION/);
  }
});

test('valid owned-account grant cannot bypass an explicit target project', async () => {
  await rejectBeforeCredentials(['--deploy-temporary', '--catalog', '--grant-owned-token-creator', '--soak-seconds=600'],
    /EXPLICIT_PROJECT_AND_VALID_REGION_REQUIRED/);
});
