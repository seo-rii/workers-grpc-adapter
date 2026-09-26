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
const workerDeploySource = section('async function deployWorker(', '\nasync function workerRequest(');
const wranglerSource = section('function wranglerCommand(', '\nasync function buildWorker(');

const workerVersionId = '11111111-2222-4333-8444-555555555555';
const workerDeploymentId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const workerVersion = () => ({ id: workerVersionId, annotations: { 'workers/tag': 'fixture-run' } });
const workerDeployment = () => ({ id: workerDeploymentId,
  versions: [{ version_id: workerVersionId, percentage: 100 }] });

async function workerCleanup({ replacement = false, changedTag = false, changedDeployment = false,
  ambiguous = false, missing = false, lookupFailure = false, deleteFailure = false,
  versionMissing = false, retryDelete = false, collision = false, splitTraffic = false,
  replacementAfterDelete = false, noDeployment = false, missingCapturedDeployment = false } = {}) {
  const resource = { kind: 'cloudflare-worker', name: 'fixture-worker', url: 'https://fixture/worker',
    attempted: true, owned: !ambiguous && !collision, absentBefore: true, ownershipTag: 'fixture-run',
    ...(ambiguous ? { ambiguousCreate: true } : { versionId: workerVersionId,
      ...(!missingCapturedDeployment ? { deploymentId: workerDeploymentId } : {}),
      uploadAcknowledged: true, creationSettled: true }),
    ...(collision ? { collision: true } : {}) };
  const report = { run: 'fixture-run', resources: [resource], cleanup: [], status: 'passed' };
  const events = [];
  let deleted = false;
  let deleteAttempts = 0;
  const context = {
    report, project: 'fixture-project', directory: undefined, before: undefined, accessToken: undefined,
    root: '', reportFile: '', secret: value => value, gcloud: () => 'synthetic-token',
    phase() {}, save() {}, redact: String, pause: async () => {}, onSignal() {},
    process: { exitCode: 0, off() {} }, console: { log() {} }, path: { relative: () => '' },
    ok(response) {
      if (response.status < 200 || response.status >= 300 || response.data.success === false) {
        throw new Error('Fixture HTTP ' + response.status);
      }
      return response.data;
    },
    async api(url, method = 'GET') {
      events.push({ method, url });
      assert.equal(collision, false, 'Never inspect or delete a collision');
      if (method === 'DELETE') {
        assert.equal(url, resource.url);
        deleteAttempts++;
        if (deleteFailure || (retryDelete && deleteAttempts === 1)) return { status: 503, data: {} };
        deleted = true;
        return { status: 200, data: { success: true } };
      }
      assert.equal(method, 'GET');
      if (url === resource.url + '/settings') return {
        status: (deleted && !replacementAfterDelete) || missing ? 404 : 200, data: { success: true, result: {} },
      };
      if (url === resource.url + '/deployments') {
        if (lookupFailure) return { status: 403, data: { success: false } };
        const deployment = workerDeployment();
        if (replacement || (deleted && replacementAfterDelete)) deployment.versions[0].version_id = 'replacement-version';
        if (changedDeployment) deployment.id = 'replacement-deployment';
        if (splitTraffic) deployment.versions = [{ version_id: workerVersionId, percentage: 50 },
          { version_id: 'another-version', percentage: 50 }];
        return { status: 200, data: { success: true, result: { deployments: noDeployment ? [] : [deployment] } } };
      }
      assert.equal(url, resource.url + '/versions/' + workerVersionId);
      if (versionMissing) return { status: 404, data: {} };
      const version = workerVersion();
      if (changedTag) version.annotations['workers/tag'] = 'another-run';
      return { status: 200, data: { success: true, result: version } };
    },
  };
  const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  await vm.runInContext(identitySource + '\n(' + cleanupSource + ')', isolated)();
  if (collision) {
    assert.equal(events.length, 0);
    assert.equal(report.cleanup.length, 0);
    assert.equal(report.allCreatedResourcesDeleted, !ambiguous,
      'A collision observed after an uncertain upload stays unresolved without being deleted');
    return;
  }
  const receipt = report.cleanup[0];
  assert.ok(receipt, 'Uncertain created resources must not disappear from cleanup accounting');
  const passed = !(replacement || changedTag || changedDeployment || ambiguous || lookupFailure ||
    deleteFailure || versionMissing || splitTraffic || replacementAfterDelete || noDeployment);
  assert.equal(receipt.verifiedAbsent, passed);
  assert.equal(report.allCreatedResourcesDeleted, passed);
  assert.equal(context.process.exitCode, passed ? 0 : 1);
  assert.equal(deleted, (passed && !missing) || replacementAfterDelete);
  assert.equal(deleteAttempts, passed && !missing ? (retryDelete ? 2 : 1) : deleteFailure ? 3 : replacementAfterDelete ? 1 : 0);
  if (passed) {
    assert.equal(receipt.error, undefined, 'A recovered transient failure must not remain in the success receipt');
    if (!missing) assert.equal(receipt.identityVerified, true);
  } else {
    assert.equal(report.status, 'cleanup-failed');
    assert.ok(receipt.error, 'Failure reason must survive cleanup');
    if (replacement || changedTag || changedDeployment || splitTraffic || replacementAfterDelete || noDeployment) {
      assert.match(receipt.error, /IDENTITY_CHANGED_REFUSING_DELETE/);
    }
    if (ambiguous) assert.match(receipt.error, /CREATION_IDENTITY_UNPROVEN/);
  }
}

function workerReceiptsAndEnvironment() {
  const isolated = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const acknowledge = vm.runInContext(identitySource + '\nacknowledgeWorkerUpload', isolated);
  const name = 'fixture-worker';
  const valid = { type: 'deploy', version: 1, worker_name: name, version_id: workerVersionId, worker_tag: null };
  for (const contents of [JSON.stringify(valid) + '\n' + JSON.stringify(valid),
    JSON.stringify({ ...valid, version_id: '../other-worker' }), JSON.stringify({ ...valid, version: 2 }),
    JSON.stringify({ ...valid, type: 'versions-upload' }), '']) {
    const resource = { name, attempted: true, ambiguousCreate: true, owned: false };
    assert.throws(() => acknowledge(resource, contents), /WORKER_UPLOAD_IDENTITY_UNPROVEN/);
    assert.equal(resource.owned, false);
    assert.equal(resource.ambiguousCreate, true);
    assert.equal(resource.versionId, undefined);
  }
  const collision = { name, attempted: true, ambiguousCreate: true, owned: false };
  assert.throws(() => acknowledge(collision, JSON.stringify({ ...valid, worker_tag: 'pre-existing-script-tag' })),
    /CF_WORKER_NAME_COLLISION/);
  assert.equal(collision.collision, true);
  assert.equal(collision.owned, false);
  assert.equal(collision.versionId, undefined);
  let called = false;
  const context = vm.createContext({
    cfToken: 'synthetic-token', cfAccount: 'fixture-account', directory: '/virtual', wrangler: '/wrangler.js',
    process: { execPath: '/node', env: { PATH: '/fixture/bin',
      WRANGLER_OUTPUT_FILE_PATH: '/unrelated-output', WRANGLER_OUTPUT_FILE_DIRECTORY: '/unrelated-directory',
      WRANGLER_CI_OVERRIDE_NAME: 'shared-worker', WRANGLER_CI_MATCH_TAG: 'shared-tag',
      CLOUDFLARE_API_TOKEN: 'unrelated-token', CF_TOKEN: 'unrelated-token', WGA_TEST_KEY: 'unrelated-key' } },
    command(program, args, { env }) {
      called = true;
      assert.equal(program, '/node');
      assert.equal(args[0], '/wrangler.js');
      assert.equal(env.PATH, '/fixture/bin');
      assert.equal(env.WRANGLER_OUTPUT_FILE_PATH, '/owned-output');
      for (const key of ['WRANGLER_OUTPUT_FILE_DIRECTORY', 'WRANGLER_CI_OVERRIDE_NAME', 'WRANGLER_CI_MATCH_TAG',
        'CF_TOKEN', 'WGA_TEST_KEY']) assert.equal(env[key], undefined, 'No inherited deployment override: ' + key);
      assert.equal(env.CLOUDFLARE_API_TOKEN, 'synthetic-token');
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'fixture-account');
    },
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext('(' + wranglerSource + ')', context)(['deploy'], true, '/owned-output');
  assert.equal(called, true);
}

async function workerUpload({ commandFails = false, missingReceipt = false, wrongWorker = false,
  malformedReceipt = false, replacement = false, collision = false, interrupted = false,
  lateCollision = false } = {}) {
  const files = new Map();
  const report = { run: 'fixture-run', bundle: { sha256: 'fixture-sha' }, resources: [] };
  const events = [];
  const context = {
    report, directory: '/virtual', cfAccount: undefined, workerKey: 'synthetic-key',
    accessToken: 'synthetic-token', identityToken: 'synthetic-identity', interrupted,
    process: { env: {} }, path, save() {}, sha: () => 'fixture-sha',
    fs: {
      readFileSync(name) {
        if (name === '/bundle/main.js') return 'fixture-script';
        assert.ok(files.has(name), 'Missing virtual file: ' + name);
        return files.get(name);
      },
      writeFileSync(name, data, options) {
        if (name.endsWith('secrets.json') || name.endsWith('.ndjson')) assert.equal(options.mode, 0o600);
        files.set(name, data);
      },
      rmSync(name) { files.delete(name); },
    },
    redact: String,
    ok(response) {
      if (response.status !== 200) throw new Error('Fixture HTTP ' + response.status);
      return response.data;
    },
    wranglerCommand(args, authenticated, outputFile) {
      events.push('deploy');
      assert.equal(authenticated, true);
      assert.equal(args[args.indexOf('--tag') + 1], report.run);
      assert.ok(outputFile, 'Capture the immutable upload identity from structured Wrangler output');
      if (!missingReceipt) files.set(outputFile, malformedReceipt ? 'invalid json' : JSON.stringify({
        type: 'deploy', version: 1, worker_name: wrongWorker ? 'someone-elses-worker' : 'fixture-run-auto',
        version_id: workerVersionId, worker_tag: lateCollision ? 'pre-existing-script-tag' : null,
      }) + '\n');
      if (commandFails) throw new Error('COMMAND_FAILED');
    },
    async api(url, method = 'GET') {
      assert.equal(method, 'GET', 'All cloud mutations are replaced by the Wrangler mock');
      events.push(url);
      if (url.includes('/accounts?')) return { status: 200, data: { result: [{ id: 'fixture-account' }] } };
      if (url.endsWith('/workers/subdomain')) return { status: 200, data: { result: { subdomain: 'fixture-subdomain' } } };
      if (url.endsWith('/scripts/fixture-run-auto')) return { status: collision ? 200 : 404, data: {} };
      if (url.endsWith('/settings')) return { status: 200, data: { result: { compatibility_flags: ['nodejs_compat'] } } };
      if (url.endsWith('/deployments')) {
        const deployment = workerDeployment();
        if (replacement) deployment.versions[0].version_id = 'replacement-version';
        return { status: 200, data: { result: { deployments: [deployment] } } };
      }
      assert.ok(url.endsWith('/versions/' + workerVersionId));
      return { status: 200, data: { result: workerVersion() } };
    },
  };
  const isolated = vm.createContext(context, { codeGeneration: { strings: false, wasm: false } });
  const deploy = vm.runInContext(identitySource + '\n(' + workerDeploySource + ')', isolated);
  const promise = deploy({ main: '/bundle/main.js', configFile: '/virtual/wrangler.json' }, {}, 'cloudflare');
  const fails = commandFails || missingReceipt || wrongWorker || malformedReceipt || replacement || collision || interrupted || lateCollision;
  if (fails) await assert.rejects(promise);
  else await promise;
  assert.equal(files.has('/virtual/secrets.json'), false, 'No credential file survives success or failure');
  if (collision || interrupted) {
    assert.equal(events.includes('deploy'), false);
    assert.equal(report.resources.some(record => record.attempted), false);
    return;
  }
  const record = report.resources[0];
  assert.equal(record.attempted, true);
  assert.equal(record.owned || record.ambiguousCreate, true, 'Every possible upload remains tracked');
  const acknowledged = !(missingReceipt || wrongWorker || malformedReceipt || lateCollision);
  assert.equal(record.uploadAcknowledged === true, acknowledged);
  assert.equal(record.versionId, acknowledged ? workerVersionId : undefined);
  if (lateCollision) assert.equal(record.collision, true);
  if (acknowledged && !commandFails && !replacement) {
    assert.equal(record.deploymentId, workerDeploymentId);
    assert.equal(record.creationIdentityVerified, true);
  }
}

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
  for (const options of [{}, { replacement: true }, { changedTag: true }, { changedDeployment: true },
    { ambiguous: true }, { ambiguous: true, missing: true }, { missing: true }, { lookupFailure: true },
    { deleteFailure: true }, { versionMissing: true }, { retryDelete: true }, { collision: true },
    { collision: true, ambiguous: true },
    { splitTraffic: true }, { replacementAfterDelete: true }, { noDeployment: true },
    { missingCapturedDeployment: true }]) {
    await workerCleanup(options);
  }
  for (const options of [{}, { commandFails: true }, { commandFails: true, missingReceipt: true },
    { missingReceipt: true }, { wrongWorker: true }, { malformedReceipt: true }, { replacement: true },
    { collision: true }, { interrupted: true }, { lateCollision: true }]) await workerUpload(options);
  workerReceiptsAndEnvironment();
  assert.equal(process.exitCode, originalExitCode, 'Runner cannot mutate the host process exit status');
  assert.deepEqual(['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal)), signalListeners);
  console.log(JSON.stringify({ status: 'passed', cases: 43, networkRequests: 0,
    credentialReads: 0, scope: 'database cleanup ordering, unresolved operations, IAM propagation, Worker upload and cleanup identity protection' }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
