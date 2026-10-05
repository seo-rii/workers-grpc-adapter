'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseSoakSeconds, parseSoakBurst } = require('../scripts/gcp-soak.cjs');
const { parseAuthRenewalArgs } = require('../scripts/gcp-auth-renewal.cjs');
const source = fs.readFileSync(path.join(__dirname, '../scripts/gcp-cloud-probe.cjs'), 'utf8');
const start = source.indexOf('async function main() {');
const end = source.indexOf('\nasync function cleanup()', start);
assert.ok(start >= 0 && end > start);
const main = source.slice(start, end);

async function rejectBeforeCredentials(args, expected) {
  let credentialReads = 0;
  const run = vm.runInNewContext(`(${main})`, {
    process: { argv: ['node', 'gcp-cloud-probe.cjs', ...args], env: {} },
    report: {}, root: '/fixture', parseSoakSeconds, parseSoakBurst, parseAuthRenewalArgs,
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
  for (const args of [['--soak-burst=4'], ['--soak-seconds=600', '--soak-burst=2'],
    ['--soak-seconds=600', '--soak-burst=4', '--soak-burst=4']]) {
    await rejectBeforeCredentials(['--deploy-temporary', ...args], /soak-burst/);
  }
  await rejectBeforeCredentials(['--deploy-temporary', '--soak-seconds=600', '--soak-burst=4'],
    /EXPLICIT_PROJECT_AND_VALID_REGION_REQUIRED/);
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

test('credential renewal requires exact opt-in and catalog before credential discovery', async () => {
  await rejectBeforeCredentials(['--deploy-temporary', '--verify-auth-renewal'], /CATALOG_REQUIRED_FOR_AUTH_RENEWAL/);
  for (const args of [['--verify-auth-renewal=true'], ['--verify-auth-renewal=false'],
    ['--verify-auth-renewal', '--verify-auth-renewal']]) {
    await rejectBeforeCredentials(['--deploy-temporary', '--catalog', ...args], /INVALID_AUTH_RENEWAL_OPTION/);
  }
  await rejectBeforeCredentials(['--deploy-temporary', '--catalog', '--verify-auth-renewal'],
    /EXPLICIT_PROJECT_AND_VALID_REGION_REQUIRED/);
});

test('live IAM failures retain only a fixed step, HTTP status and mutation state', async () => {
  const start = source.indexOf('  if (grantOwnedTokenCreator) {');
  const end = source.indexOf('  const ownedAccount =', start);
  assert.ok(start >= 0 && end > start);
  for (const diagnostic of [
    { stage: 'policy-write', httpStatus: 400, mutationAttempted: true },
    { stage: 'private-marker', httpStatus: 'private-marker', mutationAttempted: 'private-marker' },
  ]) {
    const report = { resources: [{ kind: 'service-account', name: 'owned@example.test' }] };
    const error = Object.assign(new Error('private-marker'), diagnostic);
    let saved = 0, attempts = 0;
    const run = vm.runInNewContext(`(async () => {${source.slice(start, end)}})`, {
      report, grantOwnedTokenCreator: true, interrupted: false, project: 'owned-project',
      serviceAccount: 'owned@example.test', phase() {}, api() { throw new Error('UNEXPECTED_API'); },
      save() { saved++; }, gcloud: () => JSON.stringify([{ account: 'operator@example.test' }]),
      async grantOwnedServiceAccountTokenCreator() { attempts++; throw error; },
    });
    await assert.rejects(run(), value => value === error);
    assert.equal(attempts, 1);
    assert.equal(saved, 1);
    assert.equal(report.ownedIamGrant, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(report.ownedIamGrantFailure)), diagnostic.stage === 'policy-write'
      ? diagnostic : { stage: 'validation', httpStatus: null, mutationAttempted: false });
    assert.ok(!JSON.stringify(report).includes('private-marker'));
  }
});
