'use strict';
// Controlled native peer. It emits only fixture documents and bounds retries.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const grpc = req('@grpc/grpc-js');
const loader = req('@grpc/proto-loader');
const database = 'projects/demo-wga-read-errors/databases/(default)';
const parent = `${database}/documents`;
const resource = id => `${parent}/wga_read_errors/${id}`;
const timestamp = { seconds: '1700000000', nanos: 123000000 };
function check(condition, diagnostic) { if (!condition) throw Object.assign(new Error(diagnostic), { fixtureDiagnostic: diagnostic }); }
async function createFirestoreReadErrorServer() {
  const schema = path.resolve(path.dirname(req.resolve('@google-cloud/firestore')), '../protos/v1.json');
  const packages = grpc.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(schema)),
    { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
  const server = new grpc.Server(), active = new Set(), arrivals = [], faults = [], timers = new Set();
  let context;
  function document(id) { return { name: resource(id), fields: { value: { integerValue: String(id === 'marker' ? 99 : id.charCodeAt(0) - 96) } },
    createTime: timestamp, updateTime: timestamp }; }
  function start(call, method) {
    check(context && call.metadata.get('x-wga-case')[0] === context.id, 'READ_PEER_CASE');
    check(String(call.metadata.get('x-goog-api-client')[0]).includes('gl-node/'), 'READ_SDK_METADATA');
    const remaining = Number(call.getDeadline()) - Date.now();
    check(Number.isFinite(remaining) && remaining > 0 && remaining <= 1500, 'READ_BOUNDED_RPC_DEADLINE');
    active.add(call); call.on('error', () => {});
    call.once('close', () => active.delete(call));
    call.once('cancelled', () => { active.delete(call); call.end(); });
    const record = { caseId: context.id, method, attempt: 0, request: null, sentDocuments: [], statusCode: null, deadlineBounded: true, progressAcknowledged: false, releaseAfterDestroy: false };
    arrivals.push(record); return record;
  }
  function write(call, record, method, id) {
    record.sentDocuments.push(id);
    call.write(method === 'BatchGetDocuments' ? id === 'a' ? { missing: resource(id), readTime: timestamp }
      : { found: document(id), readTime: timestamp } : { document: document(id), readTime: timestamp });
  }
  function finish(call, record, code) {
    record.statusCode = code;
    if (code) call.emit('error', Object.assign(new Error('synthetic read failure'), { code }));
    else call.end();
  }
  function fail(call, error) {
    faults.push(/^READ_[A-Z_]+$/.test(error.fixtureDiagnostic) ? error.fixtureDiagnostic : 'READ_PEER_FAILURE');
    call.emit('error', Object.assign(new Error('synthetic peer assertion'), { code: 7 }));
  }
  function serve(call, method) {
    try {
      const record = start(call, method), request = call.request;
      const marker = method === 'BatchGetDocuments' && request.documents?.length === 1 && request.documents[0] === resource('marker');
      record.attempt = marker ? 1 : ++context.attempts;
      if (method === 'BatchGetDocuments') {
        check(request.database === database, 'READ_BATCH_DATABASE');
        const ids = request.documents.map(name => { check(name.startsWith(`${parent}/wga_read_errors/`), 'READ_BATCH_RESOURCE'); return name.split('/').at(-1); });
        record.request = { documents: ids };
      } else {
        const query = request.structuredQuery;
        check(request.parent === parent && query.from?.length === 1 && query.from[0].collectionId === 'wga_read_errors', 'READ_QUERY_PARENT');
        const resumed = record.attempt === 2 && context.scenario.endsWith('partial');
        check(query.orderBy.length === (resumed ? 2 : 1) && query.orderBy[0].field.fieldPath === 'value'
          && (!resumed || query.orderBy[1].field.fieldPath === '__name__')
          && query.orderBy.every(value => value.direction === 'ASCENDING'), 'READ_QUERY_ORDER');
        record.request = { limit: query.limit?.value ?? null,
          cursor: query.startAt ? { before: query.startAt.before, values: query.startAt.values.map(value => value.referenceValue
            ? value.referenceValue.split('/').at(-1) : Number(value.integerValue)) } : null,
          readTime: request.readTime ? { seconds: String(request.readTime.seconds), nanos: request.readTime.nanos } : null };
      }
      if (marker) { record.attempt = 1; write(call, record, method, 'marker'); finish(call, record, 0); return; }
      const expectedMethod = context.scenario.startsWith('batch-') ? 'BatchGetDocuments' : 'RunQuery';
      check(method === expectedMethod, 'READ_EXPECTED_METHOD');
      check(record.attempt <= 2, 'READ_RETRY_BOUND');
      const partial = context.scenario.endsWith('partial'), permanent = context.scenario.includes('permanent');
      if (method === 'BatchGetDocuments') check(JSON.stringify(record.request.documents)
        === JSON.stringify(record.attempt === 2 && partial ? ['c'] : ['b', 'a', 'c']), 'READ_BATCH_REMAINING_DOCUMENTS');
      else {
        const expected = record.attempt === 2 && partial ? { limit: 2, cursor: { before: false, values: [1, 'a'] }, readTime: timestamp }
          : { limit: 3, cursor: null, readTime: null };
        check(JSON.stringify(record.request) === JSON.stringify(expected), 'READ_QUERY_RESUME_CURSOR');
      }
      if (record.attempt === 1) {
        const destroyed = context.scenario === 'query-stream-destroy';
        if (destroyed) write(call, record, method, 'a');
        if (partial) for (const id of method === 'BatchGetDocuments' ? ['b', 'a'] : ['a']) write(call, record, method, id);
        if (partial || destroyed) {
          const timer = setTimeout(() => {
            timers.delete(timer); faults.push('READ_PROGRESS_TIMEOUT'); finish(call, record, 7);
          }, 1000);
          timers.add(timer);
          context.pending = { call, record, code: destroyed ? 0 : permanent ? 7 : 14, timer };
        }
        else finish(call, record, 14);
      } else {
        for (const id of method === 'BatchGetDocuments' ? partial ? ['c'] : ['c', 'a', 'b'] : partial ? ['b', 'c'] : ['a', 'b', 'c']) write(call, record, method, id);
        finish(call, record, 0);
      }
    } catch (error) { fail(call, error); }
  }
  server.addService(packages.google.firestore.v1.Firestore.service, {
    batchGetDocuments: call => serve(call, 'BatchGetDocuments'), runQuery: call => serve(call, 'RunQuery'),
  });
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  return { port, arrivals, faults, active,
    prepare(scenario, id) { check(active.size === 0, 'READ_PREVIOUS_CALL_RELEASED'); context = { scenario, id, attempts: 0 }; },
    advanceProgress(id) {
      check(context?.id === id && context.pending && !context.progressAcknowledged, 'READ_PROGRESS_CONTROL');
      context.progressAcknowledged = true;
      const { call, record, code, timer } = context.pending;
      clearTimeout(timer); timers.delete(timer);
      if (context.scenario === 'query-stream-destroy') {
        check(active.has(call) && !call.cancelled && arrivals.at(-1).request.documents?.[0] === 'marker', 'READ_DESTROY_RETAINED_UNTIL_RELEASE');
        record.releaseAfterDestroy = true;
      } else record.progressAcknowledged = true;
      finish(call, record, code);
    },
    async close() {
      for (const timer of timers) clearTimeout(timer); timers.clear();
      server.forceShutdown();
      await new Promise((resolve, reject) => server.tryShutdown(error => error ? reject(error) : resolve()));
    },
  };
}
module.exports = { createFirestoreReadErrorServer };
