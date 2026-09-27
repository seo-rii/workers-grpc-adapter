'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { namedTests } = require('./test-evidence.cjs');
const root = path.resolve(__dirname, '..');
let files = fs.readdirSync(path.join(root, 'test'))
    .filter(name => /(?:-fuzz|-property)\.test\.cjs$/.test(name))
    .sort().map(name => path.join('test', name));
const output = path.resolve(process.env.WGA_FUZZ_OUTPUT || path.join(root, 'verification/fuzz-node.json'));
const args = process.argv.slice(2), prefix = '--test-name-pattern=';
const report = { status: 'failed', startedAt: new Date().toISOString(), fastCheck: require('fast-check/package.json').version,
    runtime: process.version, liveCloud: false, properties: [], generatedRuns: 0 };
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
let receipts;
try {
    if (args.length > 1 || args.length === 1 && !args[0].startsWith(prefix)) throw new Error('Only --test-name-pattern=<exact property name> is supported');
    let selected;
    if (args.length) {
        const pattern = new RegExp(args[0].slice(prefix.length));
        const matches = files.filter(file => file.endsWith('-property.test.cjs')).flatMap(file =>
            namedTests(fs.readFileSync(path.join(root, file), 'utf8'), file).filter(name => pattern.test(name)).map(name => ({ file, name })));
        if (matches.length !== 1) throw new Error('Replay pattern must match exactly one property test');
        selected = matches[0]; files = [selected.file];
    }
    if (process.env.WGA_FUZZ_PATH !== undefined && !selected) throw new Error('Replay requires only --test-name-pattern=<exact test name>');
    const expected = files.filter(file => file.endsWith('-property.test.cjs')).flatMap(file =>
        namedTests(fs.readFileSync(path.join(root, file), 'utf8'), file).map(name => ({ file, name })))
        .filter(item => !selected || item.name === selected.name);
    if (!expected.length) throw new Error('No property tests discovered');
    report.expectedProperties = expected.length;
    report.replay = process.env.WGA_FUZZ_PATH !== undefined;
    report.sources = Object.fromEntries([...files, 'test/property-helpers.cjs', 'scripts/fuzz.cjs', 'package-lock.json'].map(file =>
        [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
    receipts = fs.mkdtempSync(path.join(path.dirname(output), '.fuzz-receipts-'));
    const log = output.replace(/\.json$/, '') + '.log', fd = fs.openSync(log, 'w', 0o600); fs.fchmodSync(fd, 0o600);
    let result;
    try {
        const environment = { ...process.env, WGA_FUZZ_RECEIPTS: receipts };
        // This is a fresh test runner, including when invoked by harness tests.
        delete environment.NODE_TEST_CONTEXT;
        result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args, ...files], {
            cwd: root, stdio: ['ignore', fd, fd], timeout: 180000,
            env: environment,
        });
    } finally { fs.closeSync(fd); }
    report.exitCode = result.status; report.signal = result.signal;
    report.log = path.relative(root, log);
    for (const file of files.filter(file => file.endsWith('-property.test.cjs'))) {
        const receipt = path.join(receipts, `${path.basename(file)}.jsonl`);
        if (!fs.existsSync(receipt)) continue;
        const names = expected.filter(item => item.file === file).map(item => item.name);
        for (const line of fs.readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean)) {
            const item = JSON.parse(line), name = names[item.index];
            if (!name) throw new Error(`Unexpected property receipt: ${file}:${item.index}`);
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            report.properties.push({ ...item, file, name, ...(item.failed && item.path !== null ? {
                replayCommand: `WGA_FUZZ_SEED=${item.seed} WGA_FUZZ_PATH='${item.path}' npm run test:fuzz -- '--test-name-pattern=^${escaped}$'`,
            } : {}) });
        }
    }
    report.generatedRuns = report.properties.reduce((sum, item) => sum + item.runs, 0);
    const tap = fs.readFileSync(log, 'utf8');
    report.tests = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key =>
        [key, Number(tap.match(new RegExp(`^# ${key} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
    if (result.error || result.status !== 0) throw new Error(`Property subprocess failed; see ${report.log}`);
    if (report.properties.length !== expected.length || new Set(report.properties.map(item => `${item.file}:${item.name}`)).size !== expected.length
        || report.properties.some(item => item.failed || item.interrupted || item.runs <= 0 || (!report.replay && item.runs !== item.requestedRuns))) {
        throw new Error('Incomplete, failed or interrupted property receipts');
    }
    if (!Number.isInteger(report.tests.tests) || report.tests.fail !== 0 || report.tests.cancelled !== 0 || report.tests.todo !== 0
        || !selected && report.tests.skipped !== 0 || report.tests.pass < expected.length) throw new Error('Incomplete TAP execution');
    report.status = 'passed';
} catch (error) {
    report.error = error.message; process.exitCode = 1;
} finally {
    if (receipts) fs.rmSync(receipts, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(output, 0o600);
    console.log(JSON.stringify({ status: report.status, properties: report.properties.length, generatedRuns: report.generatedRuns,
        report: path.relative(root, output), ...(report.error ? { error: report.error } : {}) }));
}
