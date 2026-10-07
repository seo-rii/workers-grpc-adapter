'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createWorkersGrpcTransport } = require('../dist/adapter.js');
const { encodeFrame } = require('../dist/wire.js');
const req = createRequire(path.resolve(__dirname, '../fixtures/google/package.json'));
const { OAuth2Client } = req('google-auth-library');
const P = req('protobufjs');
const schemas = Object.fromEntries(['datastore', 'firestore'].map(name => [name,
  P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(req.resolve(`@google-cloud/${name}/package.json`)), `build/protos/${name === 'firestore' ? 'v1' : 'protos'}.json`), 'utf8'))).resolveAll()]));
const suite = () => import('../fixtures/google/shared/cloud-transactions.mjs');

// These controlled protobuf peers test the shared scenario and fault injection.
// They cannot establish that the real databases enforce optimistic conflicts.
async function fixture(service, run, mutate = {}) {
  const cloud = await suite();
  const entries = new Map(), transactions = new Map(), calls = [];
  const project = 'wga-cloud-fixture', database = 'wga-probe-cloud-transactions';
  let nextTransaction = 0, failure;
  const keyId = key => `${key.partitionId.namespaceId}/${key.path.map(part => `${part.kind}:${part.name || part.id}`).join('/')}`;
  const loss = cloud.createCommitResponseLoss({ service, fetchImpl: async (target, init) => {
    try {
      const url = new URL(target); assert.equal(url.origin, 'https://cloud-transactions.fixture.invalid');
      const [, serviceName, methodName] = url.pathname.split('/');
      assert.equal(serviceName, `google.${service}.v1.${service === 'datastore' ? 'Datastore' : 'Firestore'}`);
      const method = schemas[service].lookupService(serviceName).methods[methodName];
      assert.ok(method, 'known generated method');
      const bytes = Buffer.from(init.body); assert.equal(bytes[0], 0); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
      const request = method.resolvedRequestType.decode(bytes.subarray(5));
      calls.push({ method: methodName, request });
      if (service === 'datastore') {
        assert.equal(request.projectId, project); assert.equal(request.databaseId, database);
      } else if (methodName === 'GetDocument') assert.ok(request.name.startsWith(`projects/${project}/databases/${database}/documents/`));
      else assert.equal(request.database, `projects/${project}/databases/${database}`);
      let response = {}, code = 0;
      const token = request.transaction?.length ? request.transaction.toString() : '';
      if (methodName === 'BeginTransaction') {
        const options = service === 'datastore' ? request.transactionOptions : request.options;
        assert.ok(options.readWrite && !options.readOnly);
        const transaction = `transaction-${++nextTransaction}`;
        transactions.set(transaction, new Map(entries)); response = { transaction: Buffer.from(transaction) };
      } else if (methodName === 'Rollback') {
        assert.ok(token); transactions.delete(token);
        if (mutate.failRollback) code = 14;
      }
      else if (methodName === 'Commit') {
        const writes = service === 'datastore' ? request.mutations : request.writes;
        assert.equal(writes.length, 1);
        const write = writes[0];
        const id = service === 'datastore' ? keyId(write.delete || write.upsert.key) : write.delete || write.update.name;
        if (write.delete) entries.delete(id);
        else {
          const previous = entries.get(id), snapshot = token ? transactions.get(token) : null;
          if (token) assert.ok(snapshot, 'begun transaction required');
          if (token && !mutate.allowConflict && snapshot.get(id) !== previous) { code = mutate.wrongConflictCode || 10; transactions.delete(token); }
          else {
            const stored = service === 'datastore' ? write.upsert : write.update;
            if (!mutate.discardWithoutApply || Number((stored.properties || stored.fields).count.integerValue) !== 2) entries.set(id, stored);
            if (token) transactions.delete(token);
          }
        }
        response = service === 'datastore' ? { mutationResults: [{}], indexUpdates: 0 }
          : { writeResults: [{ updateTime: { seconds: '1730000000', nanos: 0 } }], commitTime: { seconds: '1730000000', nanos: 0 } };
      } else if (methodName === 'Lookup') {
        assert.equal(request.keys.length, 1);
        const readToken = request.readOptions?.transaction?.toString();
        const source = readToken ? transactions.get(readToken) : entries;
        assert.ok(source); const stored = source.get(keyId(request.keys[0]));
        response = stored ? { found: [{ entity: stored }], missing: [], deferred: [] }
          : { found: [], missing: [{ entity: { key: request.keys[0] } }], deferred: [] };
      } else if (methodName === 'GetDocument') {
        const source = token ? transactions.get(token) : entries; assert.ok(source);
        const stored = source.get(request.name);
        if (stored) response = stored; else code = 5;
      } else assert.fail('unexpected generated method');
      const frames = code ? [] : [encodeFrame(method.resolvedResponseType.encode(method.resolvedResponseType.fromObject(response)).finish())];
      frames.push(encodeFrame(Buffer.from(`grpc-status: ${code}\r\ngrpc-message: ${code ? 'controlled%20transaction%20status' : ''}\r\n`), true));
      return new Response(Buffer.concat(frames), { headers: { 'content-type': 'application/grpc-web+proto' } });
    } catch (error) { failure = error; throw error; }
  } });
  const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: {
    [`${service}.googleapis.com`]: 'https://cloud-transactions.fixture.invalid',
  }, fetcher: loss.fetcher });
  const authClient = new OAuth2Client(); authClient.setCredentials({ access_token: 'controlled-cloud-transactions' });
  const context = { options: transport.gaxOptions({ projectId: project, databaseId: database, authClient }),
    allowedProjectId: project, runId: 'cloud-transactions-run', allowWrites: true, commitResponseLoss: loss };
  try {
    const result = await run({ cloud, context, entries, transactions, calls, transport, loss });
    if (failure) throw failure;
    return result;
  } finally { assert.equal(transport.resourceUsage().activeCalls, 0); }
}

for (const service of ['datastore', 'firestore']) {
  const title = service[0].toUpperCase() + service.slice(1);
  test(`CLOUD TRANSACTIONS ${title} explicit conflicting SDK transactions preserve winner and recover without retry`, async () => {
    await fixture(service, async ({ cloud, context, entries, transactions, calls }) => {
      const checks = await cloud[`cloud${title}Conflict`](context);
      assert.ok(checks.includes('second-commit-real-aborted-10'));
      assert.ok(checks.includes('same-client-fresh-transaction-recovery'));
      assert.equal(calls.filter(call => call.method === 'BeginTransaction').length, 3);
      assert.equal(calls.filter(call => call.method === 'Commit').length, 5, 'setup, first, conflicted second, recovery and cleanup only');
      assert.equal(calls.filter(call => call.method === 'Rollback').length, 1);
      assert.equal(entries.size, 0); assert.equal(transactions.size, 0);
    });
  });
  test(`CLOUD TRANSACTIONS ${title} hides one successful Commit response and reconciles applied state with independent read`, async () => {
    await fixture(service, async ({ cloud, context, entries, transactions, calls, loss }) => {
      const checks = await cloud[`cloud${title}CommitResponseLost`](context);
      assert.ok(checks.includes('response-discard-at-adapter-fetch'));
      assert.ok(checks.includes('caller-unavailable-14'));
      assert.equal(calls.filter(call => call.method === 'Commit').length, 3, 'setup, discarded Commit and cleanup; no retry');
      assert.equal(calls.filter(call => call.method === 'Rollback').length, 0, 'applied Commit is reconciled, not rolled back');
      assert.equal(loss.snapshot().discardedResponses, 1);
      assert.equal(entries.size, 0); assert.equal(transactions.size, 0);
    });
  });
  test(`CLOUD TRANSACTIONS ${title} rejects conflict false positives and successful-response-without-applied-state`, async () => {
    for (const [mutation, name, diagnostic] of [
      [{ allowConflict: true }, 'Conflict', 'cloud-transaction-real-aborted'],
      [{ wrongConflictCode: 14 }, 'Conflict', 'cloud-transaction-real-aborted'],
      [{ discardWithoutApply: true }, 'CommitResponseLost', 'cloud-transaction-lost-applied-state'],
    ]) await fixture(service, async ({ cloud, context, entries }) => {
      await assert.rejects(cloud[`cloud${title}${name}`](context), error => error.code === 'WGA_FIXTURE_ASSERTION' && error.message === diagnostic);
      assert.equal(entries.size, 0, 'failed assertion still removes its record');
    }, mutation);
  });
  test(`CLOUD TRANSACTIONS ${title} native SDK result discard is explicit and reported separately from Fetch`, async () => {
    await fixture(service, async ({ cloud, context, calls }) => {
      const checks = await cloud[`cloud${title}CommitResponseLost`]({ ...context, commitResponseLoss: undefined, nativeCommitResponseLoss: true });
      assert.ok(checks.includes('response-discard-at-native-sdk-result'));
      assert.equal(calls.filter(call => call.method === 'Commit').length, 3);
    });
  });
  test(`CLOUD TRANSACTIONS ${title} rollback failure remains visible and still deletes the owned record`, async () => {
    await fixture(service, async ({ cloud, context, entries, transactions, calls }) => {
      await assert.rejects(cloud[`cloud${title}Conflict`](context), error =>
        error instanceof AggregateError && error.errors.every(cause => cause.code === 14));
      assert.equal(entries.size, 0, 'rollback error must not skip owned-record deletion');
      assert.equal(transactions.size, 0);
      assert.equal(calls.filter(call => call.method === 'Commit').length, 4,
        'setup, winner, conflict and cleanup despite failed Rollback');
    }, { failRollback: true });
  });
}

test('CLOUD TRANSACTIONS reject missing write opt-in, foreign project and default database before I/O', async () => {
  await fixture('datastore', async ({ cloud, context, calls }) => {
    for (const changed of [{ ...context, allowWrites: false }, { ...context, allowedProjectId: 'foreign' },
      { ...context, options: { ...context.options, databaseId: '(default)' } }]) {
      await assert.rejects(cloud.cloudDatastoreConflict(changed), { code: 'WGA_FIXTURE_ASSERTION' });
    }
    assert.equal(calls.length, 0);
  });
});

test('CLOUD TRANSACTIONS response discard validates success, framing and bounded bytes before injecting', async () => {
  const cloud = await suite();
  const success = Buffer.concat([encodeFrame(Buffer.alloc(0)), encodeFrame(Buffer.from('grpc-status: 0\r\n'), true)]);
  const url = 'https://transactions.fixture.invalid/google.datastore.v1.Datastore/Commit';
  let sends = 0;
  const loss = cloud.createCommitResponseLoss({ service: 'datastore', fetchImpl: async () => { sends++; return new Response(success, { status: 200 }); } });
  await loss.fetcher.fetch(url, {}); assert.equal(loss.snapshot().commitAttempts, 0);
  loss.arm();
  await assert.rejects(loss.fetcher.fetch(url, {}), { name: 'TypeError', message: 'WGA_INJECTED_COMMIT_RESPONSE_DISCARD' });
  await loss.fetcher.fetch(url, {});
  assert.equal(sends, 3); assert.equal(loss.snapshot().discardedResponses, 1); assert.equal(loss.snapshot().commitAttempts, 2);
  assert.throws(() => loss.arm(), { code: 'WGA_FIXTURE_ASSERTION' });
  for (const body of [Buffer.from([0, 0]), Buffer.concat([encodeFrame(Buffer.alloc(0)), encodeFrame(Buffer.from('grpc-status: 10\r\n'), true)]),
    Buffer.concat([success, encodeFrame(Buffer.alloc(0))]), Buffer.alloc(65537)]) {
    const invalid = cloud.createCommitResponseLoss({ service: 'datastore', fetchImpl: async () => new Response(body) });
    invalid.arm();
    await assert.rejects(invalid.fetcher.fetch(url, {}), { code: 'WGA_FIXTURE_ASSERTION' });
    assert.equal(invalid.snapshot().discardedResponses, 0);
  }
});
