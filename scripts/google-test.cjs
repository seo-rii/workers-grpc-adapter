'use strict';
const path = require('node:path'), fs = require('node:fs'), cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const selected = (process.env.WGA_GOOGLE_SUITES || 'datastore-crud,firestore-crud').split(',');
const packages = [...new Set(selected.map(name => name.startsWith('datastore') ? '@google-cloud/datastore' : name.startsWith('firestore') ? '@google-cloud/firestore' : name === 'secret-manager-read' ? '@google-cloud/secret-manager' : null))];
if (packages.includes(null)) {
    console.error('Unknown Google suite. See fixtures/google/suites.mjs.');
    process.exit(2);
}
const report = require('./doctor.cjs').inspect(path.join(root, 'fixtures/google'), packages);
fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
fs.writeFileSync(path.join(root, 'verification/google-preflight.json'), JSON.stringify({ ...report, liveCloudExecuted: false }, null, 2) + '\n');
if (!report.passed) {
    console.log(JSON.stringify(report, null, 2));
    console.error('BLOCKED: install the isolated Google fixture dependencies first; no Google API request was sent.');
    process.exit(2);
}
if (process.env.WGA_RUN_GOOGLE_TESTS !== '1') {
    console.error('BLOCKED: explicit Google test opt-in is missing. No API request was sent.');
    process.exit(2);
}
const result = cp.spawnSync(process.execPath, [path.join(root, 'fixtures/google/run-node.mjs')], { cwd: root, stdio: 'inherit', env: process.env });
process.exitCode = result.status ?? 1;
