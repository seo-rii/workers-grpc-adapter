'use strict';
// A controlled protocol peer, not a Firestore emulator or IAM test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const nativeRequire = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const grpc = nativeRequire('@grpc/grpc-js');
const loader = nativeRequire('@grpc/proto-loader');
const token = Buffer.from([0, 255, 128, 1, 13, 10, 126]);
const time = seconds => ({ seconds: String(1700000000 + seconds), nanos: 123000000 });
async function createRecoveryServer() {
    const schema = path.resolve(path.dirname(nativeRequire.resolve('@google-cloud/firestore')), '../protos/v1.json');
    const packages = grpc.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(schema)), { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
    const server = new grpc.Server(), active = new Set(), arrivals = [], faults = [];
    let context;
    const change = (call, kind, ids = [1], extra = {}) => call.write({ targetChange: { targetChangeType: kind, targetIds: ids, ...extra } });
    const document = (call, id, value) => call.write({ documentChange: { targetIds: [1], document: {
        name: `projects/demo-wga-local/databases/(default)/documents/wga_recovery_${context.scenario}/${id}`,
        fields: { value: { integerValue: String(value) } }, createTime: time(0), updateTime: time(value),
    } } });
    const snapshot = (call, sequence) => {
        change(call, 'CURRENT');
        change(call, 'NO_CHANGE', [], { readTime: time(sequence), resumeToken: sequence === 1 ? token : Buffer.from('next') });
    };
    server.addService(packages.google.firestore.v1.Firestore.service, { listen(call) {
        active.add(call);
        call.on('error', () => {});
        call.once('close', () => active.delete(call));
        call.once('cancelled', () => { active.delete(call); call.end(); });
        call.on('end', () => { active.delete(call); call.end(); });
        call.on('data', request => {
            try {
                assert.ok(context, 'WATCH_SERVER_CONTEXT');
                assert.equal(request.database, 'projects/demo-wga-local/databases/(default)', 'WATCH_DATABASE');
                assert.equal(request.addTarget?.query?.structuredQuery?.from?.[0]?.collectionId, `wga_recovery_${context.scenario}`, 'WATCH_TARGET_QUERY');
                assert.equal(request.addTarget.targetId, 1, 'WATCH_TARGET_ID');
                const attempt = ++context.attempts;
                assert.ok(attempt <= 2, 'WATCH_BOUNDED_RECONNECTS');
                const bytes = Buffer.from(request.addTarget.resumeToken ?? []);
                const expected = attempt === 2 && ['resume', 'disconnect'].includes(context.scenario) ? token : Buffer.alloc(0);
                assert.deepEqual(bytes, expected, 'WATCH_RESUME_TOKEN_BYTES');
                arrivals.push({ caseId: context.id, scenario: context.scenario, attempt, resumeTokenHex: bytes.toString('hex') });
                context.call = call;
                change(call, 'ADD');
                document(call, attempt === 1 || ['resume', 'disconnect'].includes(context.scenario) ? 'a' : 'b', attempt);
                snapshot(call, attempt);
            } catch (error) { faults.push(error.message.split('\n')[0]); call.emit('error', Object.assign(new Error('controlled assertion failure'), { code: 13 })); }
        });
    } });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
    return { port, active, arrivals, faults,
        prepare(scenario, id) { assert.equal(active.size, 0, 'WATCH_PREVIOUS_CALL_RELEASED'); context = { scenario, id, attempts: 0, advanced: false }; },
        advance() {
            assert.ok(context?.call && !context.advanced, 'WATCH_ADVANCE_ONCE'); context.advanced = true;
            const { call, scenario } = context;
            if (scenario === 'resume' || scenario === 'disconnect') {
                document(call, 'pending', 99); // No consistent snapshot boundary: this change must be discarded.
                if (scenario === 'resume') call.emit('error', Object.assign(new Error('controlled transient failure'), { code: 14 }));
                else { assert.ok(call.call.stream, 'WATCH_PINNED_NATIVE_STREAM'); call.call.stream.close(2); }
            } else if (scenario === 'reset') {
                change(call, 'RESET'); document(call, 'b', 2); snapshot(call, 2);
            } else if (scenario === 'filter') call.write({ filter: { targetId: 1, count: 0 } });
            else if (scenario === 'remove') {
                call.write({ documentRemove: { document: `projects/demo-wga-local/databases/(default)/documents/wga_recovery_${scenario}/a`, removedTargetIds: [1] } });
                snapshot(call, 2);
            } else if (scenario === 'target-error') change(call, 'REMOVE', [1], { cause: { code: 7, message: 'controlled target denial' } });
            else throw new Error('WATCH_UNKNOWN_SCENARIO');
        },
        close() { server.forceShutdown(); },
    };
}
module.exports = { createRecoveryServer };
