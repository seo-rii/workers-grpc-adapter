'use strict';
// A controlled native grpc-js service shared by Node and workerd harnesses.
// It models only the explicitly tested RPC cases; it is not a cloud emulator.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const nativeRequire = createRequire(path.join(root, 'fixtures/native/package.json'));
const grpc = nativeRequire('@grpc/grpc-js');
const loader = nativeRequire('@grpc/proto-loader');
const timestamp = { seconds: '1700000000', nanos: 0 };
const transaction = Buffer.from('local-transaction');
async function createControlledServer() {
    const server = new grpc.Server();
    const datastore = new Map(), firestore = new Map(), arrivals = [], abortedTransactions = new Set();
    const keyString = key => JSON.stringify({ partitionId: key.partitionId, path: key.path });
    const datastoreMethods = {
        lookup(request) {
            const found = [], missing = [];
            for (const key of request.keys) {
                const entity = datastore.get(keyString(key));
                (entity ? found : missing).push({ entity: entity || { key }, version: '1' });
            }
            return { found, missing, deferred: [] };
        },
        commit(request) {
            for (const mutation of request.mutations) {
                const entity = mutation.upsert || mutation.insert || mutation.update;
                if (entity) datastore.set(keyString(entity.key), entity);
                if (mutation.delete) datastore.delete(keyString(mutation.delete));
            }
            return { mutationResults: request.mutations.map(mutation => ({ key: (mutation.upsert || mutation.insert || mutation.update)?.key, version: '1' })), indexUpdates: 0 };
        },
        runQuery(request) {
            const entities = [...datastore.values()].filter(entity => entity.key.partitionId.namespaceId === request.partitionId.namespaceId && entity.key.path.at(-1).kind === request.query.kind[0].name);
            return { batch: { entityResults: entities.map(entity => ({ entity })), entityResultType: 'FULL', moreResults: 'NO_MORE_RESULTS', endCursor: Buffer.from('local-end') } };
        },
        beginTransaction() { return { transaction }; },
        rollback() { return {}; },
    };
    const firestoreMethods = {
        commit(request) {
            for (const write of request.writes) {
                if (write.delete) firestore.delete(write.delete);
                if (write.update) {
                    const previous = firestore.get(write.update.name);
                    const fields = write.updateMask ? { ...previous?.fields, ...write.update.fields } : write.update.fields;
                    firestore.set(write.update.name, { ...write.update, fields, createTime: timestamp, updateTime: timestamp });
                }
            }
            return { writeResults: request.writes.map(() => ({ updateTime: timestamp })), commitTime: timestamp };
        },
        batchGetDocuments(request) {
            // BatchGetDocuments does not promise request order; exercise SDK reordering.
            return [...request.documents].reverse().map(name => ({ ...(firestore.has(name) ? { found: firestore.get(name) } : { missing: name }), readTime: timestamp, ...(request.newTransaction ? { transaction } : {}) }));
        },
        runQuery(request) {
            const collection = request.structuredQuery.from[0].collectionId;
            return [...firestore.values()].filter(doc => doc.name.split('/').at(-2) === collection).map(document => ({ document, readTime: timestamp }));
        },
        beginTransaction() { return { transaction }; },
        rollback() { return {}; },
        getDocument(request) { return firestore.get(request.name); },
    };
    const secretMethods = {
        getSecret(request) {
            if (request.name.endsWith('/missing')) throw Object.assign(new Error('controlled missing'), { code: grpc.status.NOT_FOUND });
            if (request.name.endsWith('/denied')) throw Object.assign(new Error('controlled denied'), { code: grpc.status.PERMISSION_DENIED });
            return { name: request.name, replication: { automatic: {} }, createTime: timestamp };
        },
    };
    for (const [sdk, file, serviceName, methods] of [
        ['datastore', 'protos.json', 'google.datastore.v1.Datastore', datastoreMethods],
        ['firestore', 'v1.json', 'google.firestore.v1.Firestore', firestoreMethods],
        ['secret-manager', 'protos.json', 'google.cloud.secretmanager.v1.SecretManagerService', secretMethods],
    ]) {
        const sdkEntry = nativeRequire.resolve('@google-cloud/' + sdk);
        const proto = path.resolve(path.dirname(sdkEntry), '../protos', file);
        const packages = grpc.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(proto)), { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
        const service = serviceName.split('.').reduce((value, part) => value[part], packages).service;
        const handlers = {};
        for (const [name, definition] of Object.entries(service)) {
            const invoke = methods[definition.originalName];
            if (!invoke) continue;
            handlers[name] = (call, callback) => {
                const entry = { method: definition.path, status: 0, requestContentType: call.metadata.get('content-type')[0] || 'application/grpc' };
                arrivals.push(entry);
                try {
                    const transactional = definition.originalName === 'commit' && call.request.transaction?.length > 0;
                    const kind = call.request.mutations?.[0]?.upsert?.key?.path?.at(-1)?.kind;
                    const document = call.request.writes?.[0]?.update?.name;
                    if (transactional && (kind === 'WgaAdapterAbort' || document?.split('/').at(-2)?.startsWith('wga_abort_'))) {
                        const faultId = kind || document;
                        if (!abortedTransactions.has(faultId)) {
                            abortedTransactions.add(faultId);
                            entry.fault = 'aborted-before-apply';
                            throw Object.assign(new Error('controlled transaction conflict'), { code: grpc.status.ABORTED });
                        }
                    }
                    const result = invoke(call.request);
                    if (transactional && kind === 'WgaAdapterLostResponse') {
                        // The write happened, but no response is sent. The client must
                        // retain an uncertain outcome even if the SDK sends Rollback.
                        entry.fault = 'commit-applied-response-withheld';
                        entry.status = null;
                        entry.expectedClientStatus = grpc.status.DEADLINE_EXCEEDED;
                        entry.applicationResponseWithheld = true;
                        return;
                    }
                    if (definition.responseStream) {
                        for (const message of result) call.write(message);
                        call.end();
                    } else callback(null, result);
                } catch (error) {
                    entry.status = error.code || 13;
                    if (definition.responseStream) call.destroy(error);
                    else callback(error);
                }
            };
        }
        server.addService(service, handlers);
    }
    const nativePort = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
    return {
        server, nativePort, arrivals,
        reset() { datastore.clear(); firestore.clear(); abortedTransactions.clear(); },
    };
}
module.exports = { createControlledServer };
