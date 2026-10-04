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
const schemas = Object.fromEntries(['datastore', 'secret-manager'].map(name => [name,
  P.Root.fromJSON(JSON.parse(fs.readFileSync(path.join(path.dirname(req.resolve(`@google-cloud/${name}/package.json`)), 'build/protos/protos.json'), 'utf8'))).resolveAll()]));
const suite = () => import('../fixtures/google/shared/cloud-catalog.mjs');
const keyId = key => `${key.partitionId.namespaceId}/${key.path.map(part => `${part.kind}:${part.name || part.id}`).join('/')}`;

// Real pinned SDKs and the actual adapter run against protobuf Fetch responses.
// This controlled peer checks requests and state; it is not cloud execution.
async function fixture(run, mutate = {}) {
  const entries = new Map(), calls = [];
  const project = 'wga-cloud-fixture', database = 'wga-probe-cloud-catalog';
  const names = [0, 1].map(index => `projects/${project}/secrets/wga-probe-cloud-${index}`);
  const payload = Buffer.from([0, 255, 128, 14, 17, 27]), label = 'cloud-catalog';
  const transport = createWorkersGrpcTransport({ mode: 'grpc-web', endpoints: {
    'datastore.googleapis.com': 'https://cloud-catalog.fixture.invalid', 'secretmanager.googleapis.com': 'https://cloud-catalog.fixture.invalid',
  } });
  const authClient = new OAuth2Client(); authClient.setCredentials({ access_token: 'controlled-cloud-catalog' });
  const options = transport.gaxOptions({ projectId: project, databaseId: database, authClient });
  const context = { options, allowedProjectId: project, runId: 'cloud-catalog-run', allowWrites: true,
    secretName: names[0], secretVersion: `${names[0]}/versions/1`, secretPayload: payload.toString('base64'), secretNames: names, resourceLabel: label };
  const secret = name => ({ name, labels: { 'wga-probe': label }, replication: { automatic: {} } });
  const original = globalThis.fetch;
  let failure;
  globalThis.fetch = async (target, init) => {
    try {
      const url = new URL(target); assert.equal(url.origin, 'https://cloud-catalog.fixture.invalid');
      const [, service, methodName] = url.pathname.split('/');
      const datastore = service === 'google.datastore.v1.Datastore';
      const schema = schemas[datastore ? 'datastore' : 'secret-manager'];
      const method = schema.lookupService(service).methods[methodName];
      assert.ok(method, 'known generated method');
      const bytes = Buffer.from(init.body); assert.equal(bytes[0], 0); assert.equal(bytes.readUInt32BE(1), bytes.length - 5);
      const request = method.resolvedRequestType.decode(bytes.subarray(5));
      calls.push({ method: methodName, request });
      let response = {}, code = 0, details = '';
      if (datastore) {
        assert.equal(request.projectId, project); assert.equal(request.databaseId, database, 'every Datastore RPC uses the supplied named database');
        if (methodName === 'Commit') {
          assert.ok(!request.transaction?.length, 'rollback fixture must never commit staged changes');
          for (const mutation of request.mutations) {
            if (mutation.delete) entries.delete(keyId(mutation.delete));
            else { const entity = mutation.upsert || mutation.insert || mutation.update; entries.set(keyId(entity.key), entity); }
          }
          response = { mutationResults: request.mutations.map(() => ({})), indexUpdates: 0 };
        } else if (methodName === 'Lookup') {
          response = { found: [], missing: [], deferred: [] };
          for (const key of request.keys) {
            const entity = entries.get(keyId(key));
            if (entity) response.found.push({ entity }); else response.missing.push({ entity: { key } });
          }
        } else if (methodName === 'RunQuery') {
          if (request.query.limit?.value === -1) { code = 3; details = 'controlled invalid negative query limit'; }
          else if (request.query.order.length === 2) { code = 9; details = 'controlled missing composite index'; }
          else {
            assert.equal(request.query.order.length, 1); assert.equal(request.query.order[0].property.name, 'rank');
            assert.equal(request.query.limit.value, 1);
            const kind = request.query.kind[0].name, namespace = request.partitionId.namespaceId;
            const all = [...entries.values()].filter(entity => entity.key.partitionId.namespaceId === namespace && entity.key.path.at(-1).kind === kind)
              .sort((a, b) => Number(a.properties.rank.integerValue) - Number(b.properties.rank.integerValue));
            const offset = request.query.startCursor.length ? Number(request.query.startCursor.toString().split(':')[1]) : 0;
            const page = all.slice(offset, offset + 1);
            if (mutate.wrongCursorOrder && offset === 1) page[0] = all[0];
            response = { batch: { entityResults: page.map(entity => ({ entity })),
              moreResults: offset + page.length >= all.length ? 3 : 2, endCursor: Buffer.from(`offset:${offset + page.length}`) } };
          }
        } else if (methodName === 'RunAggregationQuery') {
          const aggregation = request.aggregationQuery;
          assert.deepEqual(aggregation.aggregations.map(value => value.alias), ['total', 'sum', 'average']);
          assert.equal(aggregation.aggregations[1].sum.property.name, 'amount'); assert.equal(aggregation.aggregations[2].avg.property.name, 'amount');
          const values = [...entries.values()].filter(entity => entity.key.partitionId.namespaceId === request.partitionId.namespaceId
            && entity.key.path.at(-1).kind === aggregation.nestedQuery.kind[0].name).map(entity => Number(entity.properties.amount.integerValue));
          const total = values.reduce((sum, value) => sum + value, 0);
          response = { batch: { aggregationResults: [{ aggregateProperties: {
            total: { integerValue: String(values.length) }, sum: { integerValue: String(total) }, average: { doubleValue: total / values.length },
          } }] } };
        } else if (methodName === 'BeginTransaction') response = { transaction: Buffer.from('cloud-test-transaction') };
        else if (methodName === 'Rollback') assert.equal(request.transaction.toString(), 'cloud-test-transaction');
        else assert.fail('unexpected Datastore method');
      } else {
        const denied = new Headers(init.headers).get('authorization') === 'Bearer controlled-restricted-client';
        if (denied && !mutate.allowRestricted) { code = 7; details = 'controlled restricted identity denied'; }
        else if (methodName === 'GetSecret') { assert.equal(request.name, names[0]); response = secret(request.name); }
        else if (methodName === 'AccessSecretVersion') {
          assert.equal(request.name, context.secretVersion);
          response = { name: request.name, payload: { data: mutate.wrongPayload ? Buffer.from('incorrect') : payload } };
        } else if (methodName === 'ListSecrets') {
          assert.equal(request.parent, `projects/${project}`); assert.equal(request.pageSize, 1); assert.equal(request.filter, `labels.wga-probe=${label}`);
          const index = request.pageToken ? 1 : 0;
          response = { secrets: [secret(mutate.repeatSecret && index === 1 ? names[0] : names[index])], nextPageToken: index === 0 ? 'second-page' : '', totalSize: 2 };
        } else assert.fail('unexpected Secret Manager method');
      }
      if (mutate.wrongRemoteCode && code === 9) code = 3;
      const frames = code ? [] : [encodeFrame(method.resolvedResponseType.encode(method.resolvedResponseType.fromObject(response)).finish())];
      frames.push(encodeFrame(Buffer.from(`grpc-status: ${code}\r\ngrpc-message: ${encodeURIComponent(details)}\r\nx-cloud-catalog-result: controlled\r\n`), true));
      return new Response(Buffer.concat(frames), { headers: { 'content-type': 'application/grpc-web+proto' } });
    } catch (error) { failure = error; throw error; }
  };
  try {
    const result = await run({ context, calls, entries, transport });
    if (failure) throw failure;
    return result;
  } finally { globalThis.fetch = original; }
}

test('CLOUD CATALOG shared pinned SDK probes cover typed cursor pages, aggregation, rollback and remote query errors locally', async () => {
  const cloud = await suite();
  await fixture(async ({ context, calls, entries, transport }) => {
    for (const name of ['cloudDatastoreTyped', 'cloudDatastoreAggregation', 'cloudDatastoreRollback', 'cloudDatastoreErrors']) {
      const checks = await cloud[name](context);
      assert.ok(checks.length >= 5 && checks.every(check => typeof check === 'string'));
      assert.equal(entries.size, 0, `${name} verifies entity cleanup`);
    }
    assert.equal(calls.filter(call => call.method === 'Commit').length, 6);
    assert.equal(calls.filter(call => call.method === 'Rollback').length, 1);
    assert.equal(calls.filter(call => call.method === 'RunQuery').length, 5);
    assert.equal(calls.filter(call => call.method === 'RunAggregationQuery').length, 1);
    assert.equal(transport.resourceUsage().activeCalls, 0);
  });
});
test('CLOUD CATALOG Secret Manager compares payload internally and enforces exact filtered pages with restricted-auth denial', async () => {
  const cloud = await suite();
  await fixture(async ({ context, calls }) => {
    const checks = await cloud.cloudSecretManager(context);
    assert.ok(checks.includes('secret-list-exact-two') && checks.includes('secret-access-payload-match'));
    assert.ok(!JSON.stringify(checks).includes(context.secretPayload));
    const restricted = new OAuth2Client(); restricted.setCredentials({ access_token: 'controlled-restricted-client' });
    const denied = await cloud.cloudPermissionDenied({ ...context, options: { ...context.options, authClient: restricted } });
    assert.ok(denied.includes('permission-denied-code-7'));
    assert.equal(calls.filter(call => call.method === 'ListSecrets').length, 2);
  });
});
test('CLOUD CATALOG rejects wrong payloads, duplicate pages, altered query errors and permission false positives', async () => {
  const cloud = await suite();
  for (const [mutate, name, diagnostic] of [
    [{ wrongPayload: true }, 'cloudSecretManager', 'cloud-secret-access-payload'],
    [{ repeatSecret: true }, 'cloudSecretManager', 'cloud-secret-filtered-membership'],
    [{ wrongRemoteCode: true }, 'cloudDatastoreErrors', 'cloud-datastore-missing-index-code'],
    [{ allowRestricted: true }, 'cloudPermissionDenied', 'cloud-permission-denied-code'],
  ]) await fixture(async ({ context }) => {
    await assert.rejects(cloud[name](context), error => error.code === 'WGA_FIXTURE_ASSERTION' && error.message === diagnostic);
  }, mutate);
  await fixture(async ({ context, entries }) => {
    await assert.rejects(cloud.cloudDatastoreTyped(context), { code: 'WGA_FIXTURE_ASSERTION' });
    assert.equal(entries.size, 0, 'failed typed assertion still deletes its data');
  }, { wrongCursorOrder: true });
});
test('CLOUD CATALOG refuses missing write authorization, default databases and foreign secret bindings before I/O', async () => {
  const cloud = await suite();
  await fixture(async ({ context, calls }) => {
    await assert.rejects(cloud.cloudDatastoreTyped({ ...context, allowWrites: false }), { code: 'WGA_FIXTURE_ASSERTION' });
    await assert.rejects(cloud.cloudDatastoreAggregation({ ...context, options: { ...context.options, databaseId: '(default)' } }), { code: 'WGA_FIXTURE_ASSERTION' });
    await assert.rejects(cloud.cloudSecretManager({ ...context, secretName: 'projects/foreign/secrets/wga-probe-cloud-test' }), { code: 'WGA_FIXTURE_ASSERTION' });
    await assert.rejects(cloud.cloudSecretManager({ ...context, secretPayload: 'bad base64' }), { code: 'WGA_FIXTURE_ASSERTION' });
    assert.equal(calls.length, 0);
  });
});
