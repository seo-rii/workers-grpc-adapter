'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { suites, parseTransactionArgs, summarizeTransactions } = require('../scripts/gcp-transactions.cjs');

function fixture() {
  const checks = (suite, mode) => suite.endsWith('-conflict') ? [
    'two-explicit-read-write-transactions', 'same-record-shared-snapshot', 'first-commit-accepted',
    'second-commit-real-aborted-10', 'no-sdk-or-application-retry', 'winner-value-preserved',
    'same-client-fresh-transaction-recovery', 'verified-delete-cleanup',
  ] : ['explicit-transaction-commit', 'commit-success-observed-before-discard',
    `response-discard-at-${mode === 'native' ? 'native-sdk-result' : 'adapter-fetch'}`,
    'caller-unavailable-14', 'one-commit-attempt-no-retry', 'independent-read-reconciles-applied-value',
    'same-client-recovery', 'verified-delete-cleanup'];
  return {
    databaseConcurrency: { datastore: 'OPTIMISTIC', firestore: 'OPTIMISTIC' },
    nativeTransactions: { status: 'passed', suites: suites.map(suite => ({ suite, status: 'passed', checks: checks(suite, 'native') })) },
    results: ['grpc-web', 'cloudflare'].flatMap(mode => suites.map(suite => ({
      route: `/gcp/${mode}/${suite}`, httpStatus: 200, body: { suite, mode, status: 'passed', checks: checks(suite, mode) },
    }))),
  };
}

test('transaction receipt requires all twelve distinct executions and verified concurrency modes', () => {
  const good = summarizeTransactions(fixture());
  assert.equal(good.status, 'passed');
  assert.equal(good.results.length, 12);
  for (let i = 0; i < 8; i++) {
    for (const mutate of [report => report.results.splice(i, 1),
      report => report.results.push(structuredClone(report.results[i])),
      report => { report.results[i].httpStatus = 500; },
      report => { report.results[i].body.mode = 'native'; },
      report => { report.results[i].body.suite = 'wrong-suite'; },
      report => { report.results[i].body.status = 'failed'; },
      report => { report.results[i].body.checks.pop(); },
      report => { report.results[i].body.checks.push('unverified-extra-claim'); }]) {
      const report = fixture(); mutate(report);
      assert.equal(summarizeTransactions(report).status, 'failed');
    }
  }
  for (let i = 0; i < 4; i++) {
    const missing = fixture(); missing.nativeTransactions.suites.splice(i, 1);
    assert.equal(summarizeTransactions(missing).status, 'failed');
    const duplicate = fixture(); duplicate.nativeTransactions.suites.push(duplicate.nativeTransactions.suites[i]);
    assert.equal(summarizeTransactions(duplicate).status, 'failed');
    const changed = fixture(); changed.nativeTransactions.suites[i].checks[2] = 'response-discard-at-adapter-fetch';
    assert.equal(summarizeTransactions(changed).status, 'failed');
  }
  for (const field of ['datastore', 'firestore']) {
    const report = fixture(); report.databaseConcurrency[field] = 'PESSIMISTIC';
    assert.equal(summarizeTransactions(report).status, 'failed');
  }
  const nativeFailed = fixture(); nativeFailed.nativeTransactions.status = 'failed';
  assert.equal(summarizeTransactions(nativeFailed).status, 'failed');
  assert.equal(summarizeTransactions({}).status, 'failed');
});

test('transaction receipt preserves the different injected failure boundaries', () => {
  const result = summarizeTransactions(fixture());
  const lost = result.results.filter(row => row.suite.endsWith('-response-lost'));
  assert.equal(lost.filter(row => row.checks.includes('response-discard-at-native-sdk-result')).length, 2);
  assert.equal(lost.filter(row => row.checks.includes('response-discard-at-adapter-fetch')).length, 4);
  assert.ok(result.limits.some(value => value.includes('not an uncontrolled network outage')));
  assert.equal(Object.hasOwn(result, 'releaseEligible'), false);
});

test('transaction flag is off by default and rejects ambiguous opt-ins', () => {
  assert.equal(parseTransactionArgs([]), false);
  assert.equal(parseTransactionArgs(['--verify-transactions']), true);
  for (const args of [null, [null], ['--verify-transactions=true'], ['--verify-transaction'],
    ['--verify-transactions', '--verify-transactions']]) assert.throws(() => parseTransactionArgs(args));
});
