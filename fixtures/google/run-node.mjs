import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { suites } from './suites.mjs';
import { configureTransport, contextFor } from './bootstrap.mjs';
if (process.env.WGA_RUN_GOOGLE_TESTS !== '1') {
    throw new Error('Explicit opt-in required: WGA_RUN_GOOGLE_TESTS=1');
}
const selected = (process.env.WGA_GOOGLE_SUITES || 'datastore-crud,firestore-crud').split(',');
configureTransport(process.env, 'node');
const results = [];
for (const name of selected) {
    const runId = randomUUID();
    try {
        const context = contextFor(process.env, name, runId);
        const run = await suites[name].load();
        const checks = await run(context);
        results.push({ suite: name, status: 'passed', checks });
    }
    catch (error) {
        // SDK errors can contain resource names and credentials. Do not persist message/cause.
        results.push({ suite: name, status: 'failed', code: error && typeof error.code === 'number' ? error.code : 'REDACTED_ERROR' });
    }
}
const report = { runtime: 'node', transport: 'grpc-web', liveCloud: true, results };
await writeFile(new URL('../../verification/google-live.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (results.some(x => x.status !== 'passed')) {
    process.exitCode = 1;
}
