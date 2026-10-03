'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const http2 = require('node:http2');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const grpc = req('@grpc/grpc-js'), loader = req('@grpc/proto-loader');
function keyId(key) { const part = key.path[0]; return `${part.kind}/${part.id ? `id:${part.id}` : part.name ? `name:${part.name}` : 'incomplete'}`; }
function valueSummary(value) {
  const type = value.valueType;
  const data = value[type];
  return { type, value: type === 'blobValue' ? data.toString('hex') : type === 'timestampValue' ? { seconds: data.seconds, nanos: data.nanos }
    : type === 'entityValue' ? properties(data.properties) : type === 'arrayValue' ? data.values.map(valueSummary) : data,
  excluded: value.excludeFromIndexes };
}
function properties(values) { return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, valueSummary(value)])); }
function trailer(headers) {
  const bytes = Buffer.from(Object.entries(headers).filter(([name]) => !name.startsWith(':')).map(([name, value]) => `${name}: ${value}\r\n`).join(''));
  const prefix = Buffer.alloc(5); prefix[0] = 128; prefix.writeUInt32BE(bytes.length, 1); return Buffer.concat([prefix, bytes]);
}
async function createDatastoreMutationServer() {
  const proto = path.join(path.dirname(req.resolve('@google-cloud/datastore/package.json')), 'build/protos/protos.json');
  const packages = grpc.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(proto)),
    { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
  const server = new grpc.Server(), states = new Map(), failures = [], sessions = new Set();
  let grpcWebRequests = 0, bridge;
  function setup(runtime, scenario) {
    const namespace = `${runtime}-${scenario}`, state = { runtime, scenario, namespace, trace: [], receipts: [], values: new Map() };
    for (const name of ['existing', 'other']) state.values.set(`MutationValue/name:${name}`, { properties: { label: { stringValue: 'before' } } });
    states.set(namespace, state); return state;
  }
  function handler(method) { return (call, callback) => {
    try {
      const request = call.request;
      assert.equal(request.projectId, 'wga-mutations'); assert.equal(request.databaseId, 'mutation-db');
      const keys = method === 'Commit' ? request.mutations.map(item => item.delete ?? (item.insert ?? item.update ?? item.upsert).key) : request.keys;
      assert.ok(keys.length > 0 && keys.length <= 3);
      const state = states.get(keys[0].partitionId.namespaceId); assert.ok(state, 'Known isolated namespace');
      for (const key of keys) { assert.equal(key.partitionId.namespaceId, state.namespace); assert.equal(key.partitionId.projectId, '');
        assert.equal(key.partitionId.databaseId, ''); assert.equal(key.path.length, 1); }
      assert.equal(call.metadata.get('authorization').length, 0, 'Anonymous local fixture');
      const routing = Object.fromEntries(new URLSearchParams(call.metadata.get('x-goog-request-params')[0]));
      assert.deepEqual(routing, { project_id: 'wga-mutations', database_id: 'mutation-db' });
      const logicalCallId = call.metadata.get('x-wga-sdk-call-id')[0] ?? null;
      assert.equal(logicalCallId === null, state.runtime === 'native');
      const row = { method, keys: keys.map(keyId), statusCode: 0, mutations: [] }; state.trace.push(row);
      state.receipts.push({ logicalCallId, projectId: request.projectId, databaseId: request.databaseId, namespace: state.namespace, routing });
      if (method === 'Lookup') {
        assert.equal(request.readOptions.readConsistency, 'STRONG');
        const found = [], missing = [];
        for (const key of keys) {
          const item = key.path[0].kind === 'MutationMarker' ? { properties: { alive: { booleanValue: true } } } : state.values.get(keyId(key));
          (item ? found : missing).push({ entity: { key, ...(item ?? {}) } });
        }
        callback(null, { found, missing }); return;
      }
      if (method === 'AllocateIds') {
        assert.equal(state.scenario, 'allocate-ids'); assert.equal(keys.length, 3);
        assert.ok(keys.every(key => keyId(key) === 'MutationValue/incomplete'));
        callback(null, { keys: keys.map((key, index) => ({ ...key, path: [{ kind: 'MutationValue', id: String(9007199254740993n + BigInt(index)) }] })) }); return;
      }
      assert.equal(request.mode, 'NON_TRANSACTIONAL'); assert.equal(request.transaction?.length ?? 0, 0);
      for (const mutation of request.mutations) {
        const operation = mutation.operation;
        assert.ok(['insert', 'update', 'upsert', 'delete'].includes(operation));
        row.mutations.push({ operation, key: keyId(operation === 'delete' ? mutation.delete : mutation[operation].key),
          properties: operation === 'delete' ? null : properties(mutation[operation].properties) });
      }
      const injected = state.scenario.includes('error');
      const duplicate = row.mutations.some(item => item.operation === 'insert' && state.values.has(item.key));
      const missing = row.mutations.some(item => item.operation === 'update' && !state.values.has(item.key));
      row.statusCode = injected ? 7 : duplicate ? 6 : missing ? 5 : 0;
      if (row.statusCode) {
        const metadata = new grpc.Metadata(); metadata.set('x-mutation-error', 'controlled-whole-rpc'); metadata.set('x-mutation-error-bin', Buffer.from([0, 255, 128]));
        callback({ code: row.statusCode, details: `mutation-fixture-${row.statusCode}`, metadata }); return;
      }
      const mutationResults = request.mutations.map((mutation, index) => {
        const operation = mutation.operation, original = operation === 'delete' ? mutation.delete : mutation[operation].key;
        const incomplete = keyId(original).endsWith('/incomplete');
        const assigned = incomplete ? { ...original, path: [{ kind: 'MutationValue', id: '9007199254740993' }] } : original;
        if (operation === 'delete') state.values.delete(keyId(assigned));
        else state.values.set(keyId(assigned), { properties: mutation[operation].properties });
        return { version: String(101 + index), ...(incomplete ? { key: assigned } : {}) };
      });
      callback(null, { mutationResults, indexUpdates: mutationResults.length * 2 });
    } catch (error) { failures.push(error.message); callback({ code: 13, details: 'mutation-peer-invariant-failed' }); }
  }; }
  server.addService(packages.google.datastore.v1.Datastore.service, { commit: handler('Commit'), lookup: handler('Lookup'), allocateIds: handler('AllocateIds') });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)));
  bridge = http.createServer((request, response) => {
    const contentType = request.headers['content-type'];
    if (request.method !== 'POST' || !/^\/google\.datastore\.v1\.Datastore\/(Commit|Lookup|AllocateIds)$/.test(request.url)
      || !['application/grpc-web', 'application/grpc-web+proto'].includes(contentType)) {
      failures.push('Unexpected mutation bridge request'); response.writeHead(400).end(); return;
    }
    grpcWebRequests++;
    const session = http2.connect(`http://127.0.0.1:${port}`); sessions.add(session);
    session.on('close', () => sessions.delete(session)); session.on('error', () => response.destroy());
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !['host', 'connection', 'transfer-encoding', 'content-length', 'content-type'].includes(name)));
    const upstream = session.request({ ...headers, ':method': 'POST', ':path': request.url, 'content-type': 'application/grpc', te: 'trailers' });
    let hasStatus = false, ended = false;
    upstream.on('response', received => { response.writeHead(200, { 'content-type': contentType }); if (received['grpc-status'] !== undefined) { hasStatus = true; response.write(trailer(received)); } });
    upstream.on('data', chunk => response.write(chunk));
    upstream.on('trailers', received => { hasStatus = true; response.write(trailer(received)); });
    upstream.on('end', () => { ended = true; if (!hasStatus) response.destroy(); else response.end(); session.close(); });
    upstream.on('error', () => { ended = true; response.destroy(); session.destroy(); });
    response.on('close', () => { if (!ended) { upstream.close(http2.constants.NGHTTP2_CANCEL); session.destroy(); } });
    request.pipe(upstream);
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  return { port, bridgeOrigin: `http://127.0.0.1:${bridge.address().port}`, setup, failures, get grpcWebRequests() { return grpcWebRequests; },
    async close() { bridge.closeAllConnections(); for (const session of sessions) session.destroy(); await new Promise(resolve => bridge.close(resolve)); server.forceShutdown(); } };
}
module.exports = { createDatastoreMutationServer };
