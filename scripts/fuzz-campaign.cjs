'use strict';
// Fixed seeds are reviewable and repeatable; extended runs never replace CI evidence.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const profiles = {
    ci: { seeds: [1470698469, 20260927], nodeRuns: 1000, workerRuns: 150 },
    extended: { seeds: [1470698469, 20260927, -314159, 8675309], nodeRuns: 5000, workerRuns: 750 },
};
const profile = process.argv[2]?.replace(/^--profile=/, '') || 'ci';
if (process.argv.length > 3 || !profiles[profile]) throw new Error('Use --profile=ci or --profile=extended');
const directory = path.join(root, 'verification', `fuzz-${profile}`);
const output = path.join(root, 'verification', `fuzz-campaign-${profile}.json`);
const plan = profiles[profile];
const report = { status: 'failed', startedAt: new Date().toISOString(), profile, plan,
    fastCheck: require('fast-check/package.json').version, runs: [], liveCloud: false,
    nodeGeneratedRuns: 0, workerGeneratedRuns: 0, workerRpcCalls: 0 };
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
// Ambient replay/count overrides must not silently shrink a required CI campaign.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('WGA_FUZZ_') && !key.startsWith('WGA_WORKER_FUZZ_')));
function run(kind, seed) {
    const target = path.join(directory, `${kind}-${seed}.json`), log = path.join(directory, `${kind}-${seed}.runner.log`);
    const command = kind === 'node' ? 'scripts/fuzz.cjs' : 'scripts/test-workerd-fuzz.cjs';
    const env = { ...environment, WGA_RUN_GOOGLE_TESTS: '0', WGA_ALLOW_TEST_WRITES: '0',
        ...(kind === 'node' ? { WGA_FUZZ_SEED: String(seed), WGA_FUZZ_RUNS: String(plan.nodeRuns), WGA_FUZZ_OUTPUT: target }
            : { WGA_WORKER_FUZZ_SEED: String(seed), WGA_WORKER_FUZZ_RUNS: String(plan.workerRuns), WGA_WORKER_FUZZ_OUTPUT: target }) };
    fs.rmSync(target, { force: true });
    const fd = fs.openSync(log, 'w', 0o600); fs.fchmodSync(fd, 0o600);
    let result;
    try { result = cp.spawnSync(process.execPath, [command], { cwd: root, env, stdio: ['ignore', fd, fd], timeout: 240000 }); }
    finally { fs.closeSync(fd); }
    const entry = { kind, seed, exitCode: result.status, signal: result.signal,
        report: path.relative(root, target), log: path.relative(root, log) };
    report.runs.push(entry);
    if (fs.existsSync(target)) {
        const bytes = fs.readFileSync(target); entry.sha256 = createHash('sha256').update(bytes).digest('hex');
        entry.result = JSON.parse(bytes);
    }
    if (result.error || result.status !== 0 || entry.result?.status !== 'passed') throw new Error(`${kind} seed ${seed} failed; see ${entry.log}`);
    const properties = entry.result.properties;
    if (!Array.isArray(properties) || !properties.length || properties.some(item => item.failed || item.interrupted
        || item.seed !== seed || item.runs !== (kind === 'node' ? plan.nodeRuns : plan.workerRuns))) {
        throw new Error(`${kind} seed ${seed}: incomplete property execution`);
    }
    if (kind === 'workerd' && JSON.stringify(properties.map(item => item.name)) !==
        JSON.stringify(['valid-unary', 'valid-stream', 'malformed-response', 'stream-boundaries'])) {
        throw new Error('The workerd campaign must execute all four properties');
    }
    if (kind === 'node') report.nodeGeneratedRuns += properties.reduce((sum, item) => sum + item.runs, 0);
    else {
        report.workerGeneratedRuns += properties.reduce((sum, item) => sum + item.runs, 0);
        report.workerRpcCalls += entry.result.rpcCalls;
    }
}
try {
    for (const seed of plan.seeds) {
        run('node', seed);
        run('workerd', seed);
    }
    if (report.runs.length !== plan.seeds.length * 2 || !Number.isSafeInteger(report.workerRpcCalls) || report.workerRpcCalls <= 0) throw new Error('Incomplete campaign');
    report.status = 'passed';
} catch (error) {
    report.error = error.message; process.exitCode = 1;
} finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); fs.chmodSync(output, 0o600);
    console.log(JSON.stringify({ status: report.status, profile, nodeGeneratedRuns: report.nodeGeneratedRuns,
        workerGeneratedRuns: report.workerGeneratedRuns, workerRpcCalls: report.workerRpcCalls,
        report: path.relative(root, output), ...(report.error ? { error: report.error } : {}) }));
}
