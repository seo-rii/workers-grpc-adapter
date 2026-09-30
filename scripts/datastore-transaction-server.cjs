'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http2 = require('node:http2');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const grpc = req('@grpc/grpc-js'), loader = req('@grpc/proto-loader');
function check(condition, diagnostic) { if (!condition) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic }); }
async function createDatastoreTransactionServer() {
  const schema = path.resolve(path.dirname(req.resolve('@google-cloud/datastore')), '../protos/protos.json');
  const definition = grpc.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(schema)),
    { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true })).google.datastore.v1.Datastore.service;
  const methods = new Map(Object.values(definition).map(method => [method.path, method]));
  const server = http2.createServer(), active = new Set(), sessions = new Set(), arrivals = [], faults = [];
  let context;
  server.on('session', session => { sessions.add(session); session.on('error', () => {}); session.once('close', () => sessions.delete(session)); });
  function reply(stream, descriptor, response, code = 0) {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.once('wantTrailers', () => { if (!stream.destroyed) stream.sendTrailers({ 'grpc-status': String(code), 'grpc-message': code ? 'synthetic transaction failure' : '' }); });
    if (!code) { const message = descriptor.responseSerialize(response), frame = Buffer.alloc(5 + message.length); frame.writeUInt32BE(message.length, 1); message.copy(frame, 5); stream.end(frame); }
    else stream.end();
  }
  server.on('stream', (stream, headers) => {
    active.add(stream); stream.on('error', () => {}); stream.once('close', () => active.delete(stream));
    const chunks = []; let bytes = 0;
    stream.on('data', chunk => { bytes += chunk.length; if (bytes > 65536) stream.close(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM); else chunks.push(chunk); });
    stream.on('end', () => {
      try {
        const descriptor = methods.get(headers[':path']); check(descriptor, 'TX_PEER_METHOD');
        const data = Buffer.concat(chunks); check(data.length >= 5 && data[0] === 0 && data.readUInt32BE(1) === data.length - 5, 'TX_PEER_FRAME');
        const request = descriptor.requestDeserialize(data.subarray(5)), method = descriptor.path.split('/').at(-1);
        check(request.projectId === 'demo-wga-transactions' && request.databaseId === 'tx-db', 'TX_PEER_PROJECT');
        check(context && (!headers['x-wga-case'] || headers['x-wga-case'] === context.id), 'TX_PEER_CASE');
        check(/^\d{1,8}[HMSmun]$/.test(headers['grpc-timeout']), 'TX_PEER_DEADLINE');
        check(String(headers['x-goog-api-client']).includes('gl-node/'), 'TX_SDK_METADATA');
        const record = { caseId: context.id, method, identity: headers['x-wga-identity'] ?? null, transactionId: null,
          readOnly: false, deadlineBounded: true, query: null, keys: [], mutationValues: [], appliedMutations: 0, statusCode: 0,
          disconnect: false, cancelled: false, http2ResetCode: null, responseSent: false, termination: 'server-response' };
        arrivals.push(record);
        stream.once('close', () => { record.http2ResetCode = stream.rstCode; record.responseSent = stream.headersSent; });
        const txId = request.transaction?.length ? Buffer.from(request.transaction).toString('hex')
          : request.readOptions?.transaction?.length ? Buffer.from(request.readOptions.transaction).toString('hex') : null;
        record.transactionId = txId;
        const tx = txId ? context.transactions.get(txId) : null;
        if (txId) check(tx, 'TX_KNOWN_TRANSACTION');
        if (tx && method !== 'Rollback') check(record.identity === tx.identity, 'TX_TRANSACTION_IDENTITY');
        if (method === 'BeginTransaction') {
          const id = Buffer.from([0, 255, ++context.sequence, 128]); record.transactionId = id.toString('hex');
          record.readOnly = !!request.transactionOptions?.readOnly;
          context.transactions.set(record.transactionId, { readOnly: record.readOnly, identity: record.identity });
          reply(stream, descriptor, { transaction: id });
        } else if (method === 'Lookup' || method === 'RunQuery') {
          const keys = method === 'Lookup' ? request.keys : [{ partitionId: request.partitionId, path: [{ kind: 'TransactionValue', name: 'a' }] }];
          if (method === 'RunQuery') {
            const composite = request.query.filter?.compositeFilter, filter = composite?.filters?.[0]?.propertyFilter;
            check(request.query.kind.length === 1 && request.query.kind[0].name === 'TransactionValue' && request.query.limit?.value === 2
              && composite?.op === 'AND' && composite.filters.length === 1 && filter?.property?.name === 'count'
              && filter.op === 'EQUAL' && filter.value.integerValue === '1', 'TX_QUERY_REQUEST');
            record.query = { kind: request.query.kind[0].name, limit: request.query.limit.value,
              filter: { property: filter.property.name, op: filter.op, integerValue: filter.value.integerValue } };
          }
          const results = keys.map(key => {
            check(key.partitionId.namespaceId === 'tx-fixture' && key.path[0].kind === 'TransactionValue', 'TX_KEY_SHAPE');
            const id = key.path[0].name; check(context.values.has(id), 'TX_KEY_ID'); record.keys.push(id);
            return { entity: { key, properties: { count: { integerValue: String(context.values.get(id)) } } }, version: '1' };
          });
          reply(stream, descriptor, method === 'Lookup' ? { found: results } : { batch: { entityResults: results, moreResults: 'NO_MORE_RESULTS', endCursor: Buffer.from('done') } });
        } else if (method === 'Commit') {
          check(tx && request.mode === 'TRANSACTIONAL', 'TX_COMMIT_TRANSACTION');
          for (const mutation of request.mutations) {
            const entity = mutation.upsert; check(entity && entity.key.path.length === 1
              && entity.key.path[0].kind === 'TransactionValue' && ['a', 'b'].includes(entity.key.path[0].name)
              && entity.key.partitionId.projectId === (context.scenario === 'v1-deadline-commit' ? 'demo-wga-transactions' : '')
              && entity.key.partitionId.databaseId === (context.scenario === 'v1-deadline-commit' ? 'tx-db' : '')
              && entity.key.partitionId.namespaceId === 'tx-fixture', 'TX_MUTATION_KIND');
            record.keys.push(entity.key.path[0].name); record.mutationValues.push(Number(entity.properties.count.integerValue));
          }
          check(request.mutations.length === (context.scenario === 'readonly-read' ? 0 : 1), 'TX_SINGLE_MUTATION');
          const rejected = tx.readOnly && record.mutationValues.length ? 3 : context.scenario === 'commit-aborted' ? 10 : 0;
          const apply = !rejected && context.scenario !== 'disconnect-before-apply';
          if (apply) for (let i = 0; i < record.keys.length; i++) { context.values.set(record.keys[i], record.mutationValues[i]); record.appliedMutations++; }
          if (context.scenario.startsWith('disconnect-')) {
            record.statusCode = 14; record.disconnect = true; record.termination = 'server-reset';
            // An actual HTTP/2 reset without grpc-status or a response payload.
            stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
          } else if (context.scenario === 'v1-deadline-commit') {
            record.statusCode = 4; context.commitReceived = true; record.termination = 'pending-deadline';
            // Like a native gRPC server, enforce the received deadline even
            // where a Fetch/service-binding abort does not reach this socket.
            // Preserve which side actually completed the stream in the receipt.
            const timeout = /^(\d{1,8})([HMSmun])$/.exec(headers['grpc-timeout']);
            const timeoutMs = Number(timeout[1]) * { H: 3600000, M: 60000, S: 1000, m: 1, u: 0.001, n: 0.000001 }[timeout[2]];
            check(timeoutMs > 0 && timeoutMs <= 2100, 'TX_BOUNDED_PEER_DEADLINE');
            const timer = setTimeout(() => {
              if (stream.destroyed) return;
              record.termination = 'peer-deadline'; reply(stream, descriptor, {}, 4);
            }, Math.ceil(timeoutMs));
            stream.once('close', () => {
              clearTimeout(timer);
              if (record.termination === 'pending-deadline') record.termination = 'client-reset';
              record.cancelled = stream.rstCode === http2.constants.NGHTTP2_CANCEL;
            });
            context.commitWaiter?.();
          } else {
            record.statusCode = rejected;
            reply(stream, descriptor, { mutationResults: request.mutations.map(() => ({ version: '2', conflictDetected: false })), indexUpdates: request.mutations.length }, rejected);
          }
        } else if (method === 'Rollback') reply(stream, descriptor, {});
        else check(false, 'TX_UNEXPECTED_METHOD');
      } catch (error) {
        faults.push(/^TX_[A-Z_]+$/.test(error.fixtureDiagnostic) ? error.fixtureDiagnostic : 'TX_PEER_FAILURE');
        if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, active, arrivals, faults,
    prepare(scenario, id) { check(active.size === 0, 'TX_PREVIOUS_CALL_RELEASED'); context = { scenario, id, sequence: 0, transactions: new Map(), values: new Map([['a', 1], ['b', 1]]) }; },
    async control(operation, id) {
      check(context?.id === id && operation === 'await-commit', 'TX_CONTROL_OPERATION');
      if (context.commitReceived) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('TX_CONTROL_TIMEOUT'), { fixtureDiagnostic: 'TX_CONTROL_TIMEOUT' })), 1500);
        context.commitWaiter = () => { clearTimeout(timer); resolve(); };
      });
    },
    async close() { for (const session of sessions) session.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
module.exports = { createDatastoreTransactionServer };
