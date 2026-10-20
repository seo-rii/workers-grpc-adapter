'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createHash } = require('node:crypto');
const { reportFile, validateSdkDeadlineEvidence: validate } = require('../scripts/sdk-deadline-evidence.cjs');
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-sdk-deadline-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function put(file, bytes) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), bytes);
  }
  const report = { status: 'passed', liveCloud: false, cloudflareTranslation: false, controlledFetchPeer: true,
    responseLossInjectedLocally: true, backendCancellationProven: false, sourceHashes: {}, profiles: [], results: [] };
  for (const file of ['src/sdk.ts', 'scripts/test-sdk-deadline.cjs', 'fixtures/google/shared/sdk-deadline.mjs']) {
    put(file, file); report.sourceHashes[file] = digest(file);
  }
  for (const [id, sdkVersion, revision] of [['google-static-v1', '10.1.1', 6], ['google-modern-v1', '11.1.0', 4]]) {
    const profile = { id, revision };
    put(`src/build/profiles/${id}.json`, JSON.stringify(profile));
    report.profiles.push({ id, sdkVersion, installedHelperSha256: digest('helper'), bundleSha256: digest('bundle'),
      build: { profile: id, revision, profileSha256: digest(JSON.stringify(profile)) } });
    for (const runtime of ['node', 'workerd']) for (const mode of ['grpc-web', 'cloudflare']) {
      for (const scenario of ['query-lazy', 'query-budget', 'commit-response-lost']) {
        const trace = scenario === 'query-lazy' ? [] : scenario === 'query-budget'
          ? [0, 1].map(page => ({ method: 'RunQuery', primary: true, timeoutMs: 1000 - page * 100, kind: 'Primary', page }))
          : [{ method: 'Commit', primary: true, timeoutMs: 1000, kind: null, page: null },
            { method: 'Lookup', primary: false, timeoutMs: 5000, kind: null, page: null }];
        trace.push(...[0, 1, 2].map(page => ({ method: 'RunQuery', primary: false, timeoutMs: 5000, kind: 'Recovery', page })));
        const held = scenario === 'query-lazy' ? 0 : 1;
        report.results.push({ profile: id, runtime, mode, scenario, status: 'passed', trace, result: {
          scenario, errorCode: 4, deadlineOrigin: 'helper', partialRows: scenario === 'query-budget' ? [0, 1] : [],
          persisted: scenario === 'commit-response-lost', primaryFetches: held ? 2 : 0, fetches: trace.length,
          aborts: held, held, recoveryRows: [0, 1, 2, 3, 4, 5],
          resources: { activeCalls: 0, queuedCalls: 0, bufferedBytes: 0 }, authNetworkRequests: 0,
        } });
      }
    }
  }
  const aggregate = { sdkDeadline: report, commands: [{ id: 'sdk-deadline', status: 'passed', exitCode: 0 }] };
  const save = () => put(reportFile, JSON.stringify(report));
  save(); return { root, report, aggregate, save, put };
}

test('EVIDENCE SDK deadline binds the completed command, stored receipt and aggregate', t => {
  const f = fixture(t);
  assert.strictEqual(validate(f.root, f.aggregate), f.report);
  f.report.status = 'failed';
  assert.throws(() => validate(f.root, f.aggregate), /aggregate report drift/);
  f.save(); assert.throws(() => validate(f.root, f.aggregate), /completed command/);
  f.report.status = 'passed'; f.save();
  for (const command of [[], [{ id: 'sdk-deadline', status: 'passed', exitCode: 1 }],
    [{ id: 'sdk-deadline', status: 'blocked', exitCode: 0 }]]) {
    assert.throws(() => validate(f.root, { ...f.aggregate, commands: command }), /completed command/);
  }
  fs.unlinkSync(path.join(f.root, reportFile));
  assert.throws(() => validate(f.root, f.aggregate), /ENOENT/);
});

test('EVIDENCE SDK deadline rejects missing profiles, runtime cells and stale sources', t => {
  for (const change of [
    f => f.report.profiles.pop(),
    f => f.report.profiles[1] = f.report.profiles[0],
    f => f.report.profiles[0].sdkVersion = '11.1.0',
    f => f.report.profiles[0].build.profileSha256 = digest('other profile'),
    f => f.report.results.pop(),
    f => f.report.results[1] = f.report.results[0],
    f => f.report.results[0].status = 'failed',
    f => f.report.results[0].runtime = 'unknown',
    f => f.report.liveCloud = true,
    f => f.report.backendCancellationProven = true,
    f => f.report.sourceHashes = {},
    f => f.report.sourceHashes['../outside'] = digest('outside'),
    ...['src/sdk.ts', 'scripts/test-sdk-deadline.cjs', 'fixtures/google/shared/sdk-deadline.mjs']
      .map(file => f => f.put(file, 'changed after execution')),
  ]) {
    const f = fixture(t); change(f); f.save();
    assert.throws(() => validate(f.root, f.aggregate), /WGA_EVIDENCE_INVALID/);
  }
});

test('EVIDENCE SDK deadline verifies budget reduction, cleanup and accepted commit receipts', t => {
  for (const [scenario, change] of [
    ['query-lazy', row => row.result.primaryFetches++],
    ['query-lazy', row => row.result.deadlineOrigin = 'adapter'],
    ['query-budget', row => row.trace[1].timeoutMs = row.trace[0].timeoutMs],
    ['query-budget', row => row.result.partialRows.push(2)],
    ['query-budget', row => row.result.errorCode = 1],
    ['query-budget', row => row.result.aborts = 0],
    ['query-budget', row => row.result.resources.activeCalls++],
    ['query-budget', row => row.result.fetches++],
    ['query-budget', row => row.result.recoveryRows.pop()],
    ['query-budget', row => row.trace[0].timeoutMs = -1],
    ['commit-response-lost', row => row.result.persisted = false],
    ['commit-response-lost', row => row.trace[1].method = 'Commit'],
    ['commit-response-lost', row => row.result.authNetworkRequests++],
  ]) {
    const f = fixture(t); change(f.report.results.find(row => row.scenario === scenario)); f.save();
    assert.throws(() => validate(f.root, f.aggregate), /WGA_EVIDENCE_INVALID/);
  }
});
