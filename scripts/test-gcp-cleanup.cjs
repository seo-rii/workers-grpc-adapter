'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate only the real lifecycle/identity functions. Do not import the runner's
// top-level tool resolution or make its deployment entry point available.
const source = fs.readFileSync(path.join(__dirname, 'gcp-cloud-probe.cjs'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing runner section: ${start}`);
  return source.slice(first, last);
}
const identitySource = section('function ownedIdentity(', '\nasync function createResource(');
const createSource = section('async function createResource(', '\nasync function inventory(');
const cleanupSource = section('async function cleanup() {', '\nif (require.main === module)');

async function scenario({ unresolved = false, identityMismatch = false } = {}) {
  const events = [];
  const deleted = new Set();
  const lookupsAfterDelete = new Set();
  const startedAt = '2026-09-24T00:00:00.000Z';
  const resources = [
    { kind: 'service-account', name: 'sa', url: 'sa', uid: 'sa-uid', owned: true, creationSettled: true },
    ...['database-a', 'database-b'].map(name => ({
      kind: 'database', name, url: name, uid: name + '-uid', databaseType: 'FIRESTORE_NATIVE',
      owned: true, creationSettled: true, operationBase: 'fixture-operations',
    })),
    { kind: 'cloud-run', name: 'run', url: 'run', uid: 'run-uid', owned: true,
      creationSettled: true, operationBase: 'fixture-operations' },
    { kind: 'database', name: 'collision', url: 'collision', owned: false, collision: true },
  ];
  const report = { run: 'fixture-run', startedAt, resources, cleanup: [], status: 'passed' };
  const processMock = { exitCode: 0, off() {} };
  let credentialReads = 0;
  let networkAttempts = 0;
  let credentialCommands = 0;
  Object.defineProperty(processMock, 'env', { get() {
    credentialReads++;
    throw new Error('Environment credentials are unavailable in this test');
  } });
  const context = {
    report, directory: 'virtual', before: { existing: [] }, project: 'fixture-project',
    region: 'fixture-region', accessToken: undefined, root: '', reportFile: '',
    secret: value => value,
    gcloud(args) {
      assert.equal(JSON.stringify(args), JSON.stringify(['auth', 'print-access-token']));
      credentialCommands++;
      return 'synthetic-token';
    },
    fetch() { networkAttempts++; throw new Error('Network unavailable in this test'); },
    phase() {}, save() {}, redact: String, pause: async () => {}, onSignal() {},
    process: processMock, console: { log() {} },
    fs: { rmSync() {}, writeFileSync() {} },
    path: { join: () => '', relative: () => '' },
    inventory: async () => ({ existing: [] }),
    ok(response) {
      if (response.status < 200 || response.status >= 300) throw new Error('Fixture HTTP error');
      return response.data;
    },
    async api(url, method = 'GET') {
      const name = url.startsWith('https://iam.') ? 'sa' : url.split('?')[0];
      assert.ok(['sa', 'database-a', 'database-b', 'run'].includes(name), 'Unexpected resource');
      events.push(method + ' ' + name);
      if (method === 'DELETE') {
        if (name !== 'sa') assert.match(url, /\?etag=%22fixture%22$/);
        else assert.ok(url.endsWith('/serviceAccounts/sa-uid'), 'Delete account by unique ID');
        deleted.add(name);
        return { status: 200, data: name === 'sa' ? {} : { name: 'projects/x/operations/' + name } };
      }
      assert.equal(method, 'GET');
      // This simulates Firestore returning 404 before its delete operation ends.
      if (deleted.has(name)) {
        lookupsAfterDelete.add(name);
        return { status: 404, data: {} };
      }
      return { status: 200, data: {
        uid: identityMismatch && name === 'database-b' ? 'replacement-resource-uid' : name + '-uid',
        etag: '"fixture"', description: report.run, email: name,
        labels: { 'wga-probe': report.run }, type: 'FIRESTORE_NATIVE',
        locationId: context.region, createTime: startedAt,
      } };
    },
    async operation(data) {
      const name = data.name.split('/').at(-1);
      events.push('OP ' + name);
      if (name.startsWith('database')) {
        assert.ok(deleted.has('database-a'), 'First database delete must already be submitted');
        if (!identityMismatch) assert.ok(deleted.has('database-b'), 'Second delete must precede waiting');
        assert.ok(deleted.has('sa'), 'Other independent cleanup must precede database waiting');
        if (unresolved && name === 'database-b') throw new Error('OPERATION_TIMEOUT');
      }
    },
  };
  const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  const cleanup = vm.runInContext(identitySource + '\n(' + cleanupSource + ')', isolated);
  assert.equal(vm.runInContext('typeof require', isolated), 'undefined');
  await cleanup();

  assert.equal(credentialCommands, 1);
  assert.equal(credentialReads, 0);
  assert.equal(networkAttempts, 0);
  assert.ok(events.indexOf('OP run') < events.indexOf('DELETE database-b') || identityMismatch,
    'Cloud Run cleanup remains sequential');
  assert.equal(report.cleanup.some(item => item.name === 'collision'), false);
  const receipt = report.cleanup.find(item => item.name === 'database-b');
  if (unresolved) {
    assert.equal(events.filter(event => event === 'OP database-b').length, 3);
    assert.equal(receipt.deleteOperationSettled, false);
    assert.equal(lookupsAfterDelete.has('database-b'), false, '404 cannot replace operation completion');
    assert.equal(receipt.error, 'OPERATION_TIMEOUT');
  } else if (identityMismatch) {
    assert.equal(deleted.has('database-b'), false, 'Never delete a resource with a replacement UID');
    assert.equal(receipt.error, 'RESOURCE_IDENTITY_CHANGED_REFUSING_DELETE');
    assert.equal(report.cleanup.find(item => item.name === 'database-a').verifiedAbsent, true);
  } else {
    assert.ok(events.indexOf('DELETE database-a') < events.indexOf('OP database-b'));
    assert.ok(events.indexOf('DELETE database-b') < events.indexOf('OP database-b'));
    assert.equal(receipt.deleteOperationSettled, true);
    assert.equal(receipt.verifiedAbsent, true);
  }
  assert.equal(report.allCreatedResourcesDeleted, !unresolved && !identityMismatch);
  assert.equal(report.existingResourcesUnchanged, true);
  assert.equal(processMock.exitCode, unresolved || identityMismatch ? 1 : 0);
  if (unresolved || identityMismatch) {
    assert.equal(receipt.verifiedAbsent, false);
    assert.equal(report.status, 'cleanup-failed');
  }
}

async function accountPropagation({ uidHidden = false, deleteMissing = false, replacement = false } = {}) {
  const project = 'fixture-project';
  const email = 'fixture@fixture-project.iam.gserviceaccount.com';
  const base = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/`;
  const resource = { kind: 'service-account', name: email, url: base + email, uid: 'original-uid',
    owned: true, creationSettled: true, creationIdentityVerified: true };
  const report = { run: 'fixture-run', resources: [resource], cleanup: [], status: 'passed' };
  const events = [];
  let deleted = false;
  const context = {
    report, project, directory: undefined, before: undefined, accessToken: undefined, root: '', reportFile: '',
    secret: value => value, gcloud: () => 'synthetic-token', phase() {}, save() {}, redact: String,
    pause: async () => {}, onSignal() {}, process: { exitCode: 0, off() {} }, console: { log() {} },
    path: { relative: () => '' },
    ok(response) { assert.ok(response.status >= 200 && response.status < 300); return response.data; },
    async api(url, method = 'GET') {
      events.push({ method, url });
      // The email lookup is stale even when immutable-ID lookup can see the account.
      if (url === resource.url && method === 'GET') return { status: 404, data: {} };
      assert.equal(url, base + resource.uid, 'Only the acknowledged immutable UID may be addressed');
      if (method === 'DELETE') {
        assert.equal(replacement, false, 'A mismatching identity must never be deleted');
        if (deleteMissing) return { status: 404, data: {} };
        deleted = true;
        return { status: 200, data: {} };
      }
      assert.equal(method, 'GET');
      return deleted || uidHidden ? { status: 404, data: {} } : { status: 200, data: {
        uniqueId: resource.uid, email, description: replacement ? 'different-run' : report.run,
      } };
    },
  };
  const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  await vm.runInContext(identitySource + '\n(' + cleanupSource + ')', isolated)();
  const receipt = report.cleanup[0];
  const success = !deleteMissing && !replacement;
  assert.equal(receipt.verifiedAbsent, success);
  assert.equal(report.allCreatedResourcesDeleted, success);
  assert.equal(deleted, success);
  assert.equal(events.some(event => event.url === resource.url), false, 'Cleanup never relies on stale email reads');
  assert.equal(context.process.exitCode, success ? 0 : 1);
  if (success) {
    assert.equal(receipt.deleteStatus, 200);
    assert.equal(receipt.deleteAcknowledged, true);
    assert.equal(receipt.lookupStatus, 404);
  } else {
    assert.equal(receipt.deleteAcknowledged, undefined, '404 without successful DELETE is not cleanup proof');
    if (replacement) assert.equal(receipt.error, 'RESOURCE_IDENTITY_CHANGED_REFUSING_DELETE');
  }
}

async function accountCreation({ neverVisible = false } = {}) {
  const project = 'fixture-project';
  const email = 'fixture@fixture-project.iam.gserviceaccount.com';
  const base = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`;
  const resource = { kind: 'service-account', name: email, url: base + '/' + email };
  const report = { run: 'fixture-run', resources: [] };
  const account = { name: base + '/' + email, uniqueId: 'original-uid', email, description: report.run };
  let uidReads = 0;
  let pausedMs = 0;
  const context = {
    report, project, interrupted: false, save() {}, operation: async () => {},
    pause: async ms => { pausedMs += ms; },
    ok(response) { if (response.status !== 200) throw new Error('Fixture HTTP ' + response.status); return response.data; },
    async api(url, method = 'GET') {
      if (method === 'POST') { assert.equal(url, base); return { status: 200, data: account }; }
      assert.equal(method, 'GET');
      if (url === resource.url) return { status: 404, data: {} };
      assert.equal(url, base + '/' + account.uniqueId);
      uidReads++;
      return neverVisible || uidReads <= 2 ? { status: 404, data: {} } : { status: 200, data: account };
    },
  };
  const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  const create = vm.runInContext(identitySource + '\n(' + createSource + ')', isolated);
  if (neverVisible) {
    await assert.rejects(create(resource, base, {}), /Fixture HTTP 404/);
    assert.equal(uidReads, 16);
    assert.equal(pausedMs, 30000, 'Propagation retry is bounded to 30 seconds');
    assert.equal(report.resources[0].created, undefined);
  } else {
    assert.equal(await create(resource, base, {}), account);
    assert.equal(uidReads, 3);
    assert.equal(pausedMs, 4000);
    assert.equal(report.resources[0].created, true);
  }
  assert.equal(report.resources[0].uid, account.uniqueId);
  assert.equal(report.resources[0].creationIdentityVerified, true, 'Cleanup retains verified POST identity even after lookup timeout');
}

async function main() {
  const originalExitCode = process.exitCode;
  const signalListeners = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
  await scenario();
  await scenario({ unresolved: true });
  await scenario({ identityMismatch: true });
  await accountPropagation();
  await accountPropagation({ uidHidden: true });
  await accountPropagation({ uidHidden: true, deleteMissing: true });
  await accountPropagation({ replacement: true });
  await accountCreation();
  await accountCreation({ neverVisible: true });
  assert.equal(process.exitCode, originalExitCode, 'Runner cannot mutate the host process exit status');
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signalListeners);
  console.log(JSON.stringify({ status: 'passed', cases: 9, networkRequests: 0,
    credentialReads: 0, scope: 'database cleanup ordering, unresolved operations, IAM propagation, immutable identity protection' }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
