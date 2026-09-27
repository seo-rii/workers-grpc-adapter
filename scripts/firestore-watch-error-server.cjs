'use strict';
// Controlled native protocol peer; this does not test Google IAM or rules.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const nativeRequire = createRequire(path.resolve(__dirname, '../fixtures/native/package.json'));
const grpc = nativeRequire('@grpc/grpc-js');
const loader = nativeRequire('@grpc/proto-loader');
const token = Buffer.from([0, 255, 128, 1, 13, 10, 126]);
const time = seconds => ({ seconds: String(1700000000 + seconds), nanos: 123000000 });

async function createWatchErrorServer() {
    const schema = path.resolve(path.dirname(nativeRequire.resolve('@google-cloud/firestore')), '../protos/v1.json');
    const packages = grpc.loadPackageDefinition(loader.fromJSON(JSON.parse(fs.readFileSync(schema)), { longs: String, enums: String, bytes: Buffer, defaults: true, oneofs: true }));
    const server = new grpc.Server(), active = new Set(), arrivals = [], faults = [];
    let context;
    const change = (call, kind, ids = [1], extra = {}) => call.write({ targetChange: { targetChangeType: kind, targetIds: ids, ...extra } });
    const snapshot = (call, value) => {
        change(call, 'ADD');
        call.write({ documentChange: { targetIds: [1], document: {
            name: `projects/demo-wga-local/databases/(default)/documents/wga_errors_${context.scenario}/a`,
            fields: { value: { integerValue: String(value) } }, createTime: time(0), updateTime: time(value),
        } } });
        change(call, 'CURRENT');
        change(call, 'NO_CHANGE', [], { readTime: time(value), resumeToken: token });
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
                assert.equal(request.addTarget?.query?.structuredQuery?.from?.[0]?.collectionId, `wga_errors_${context.scenario}`, 'WATCH_TARGET_QUERY');
                assert.equal(request.addTarget.targetId, 1, 'WATCH_TARGET_ID');
                const attempt = ++context.attempts;
                assert.ok(attempt <= (context.phase === 'reuse' ? 1 : 2), 'WATCH_BOUNDED_RECONNECTS');
                const bytes = Buffer.from(request.addTarget.resumeToken ?? []);
                assert.deepEqual(bytes, attempt === 2 ? token : Buffer.alloc(0), 'WATCH_RESUME_TOKEN_BYTES');
                arrivals.push({ caseId: context.id, scenario: context.scenario, phase: context.phase, attempt, resumeTokenHex: bytes.toString('hex') });
                context.call = call;
                if (context.phase === 'primary' && context.scenario === 'permission' && attempt === 2) {
                    // Bound the unpatched SDK bug without asserting wrong parity.
                    change(call, 'REMOVE', [1], { cause: { code: 7, message: 'baseline reconnect sentinel' } });
                } else snapshot(call, context.phase === 'reuse' ? 3 : attempt);
            } catch (error) {
                faults.push(error.message.split('\n')[0]);
                call.emit('error', Object.assign(new Error('controlled assertion failure'), { code: 13 }));
            }
        });
    } });
    const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
    return { port, active, arrivals, faults,
        prepare(scenario, id) {
            assert.equal(active.size, 0, 'WATCH_PREVIOUS_CALL_RELEASED');
            context = { scenario, id, phase: 'primary', attempts: 0, advanced: false };
        },
        async control(action) {
            if (action === 'advance') {
                assert.ok(context?.call && !context.advanced, 'WATCH_ADVANCE_ONCE'); context.advanced = true;
                if (context.scenario === 'end') context.call.end();
                else context.call.emit('error', Object.assign(new Error(context.scenario === 'permission' ? 'controlled permission denied' : 'controlled unavailable'),
                    { code: context.scenario === 'permission' ? 7 : 14 }));
            } else if (action === 'settle') {
                const deadline = Date.now() + 7000;
                while (active.size) {
                    assert.ok(Date.now() < deadline, 'WATCH_NATIVE_STREAM_RELEASED');
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            } else if (action === 'reuse') {
                assert.equal(active.size, 0, 'WATCH_REUSE_AFTER_RELEASE');
                context.phase = 'reuse'; context.attempts = 0;
            } else throw new Error('WATCH_UNKNOWN_CONTROL');
        },
        close() { server.forceShutdown(); },
    };
}
module.exports = { createWatchErrorServer };
