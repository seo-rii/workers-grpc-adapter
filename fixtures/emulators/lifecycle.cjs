'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const projectId = 'demo-wga-lifecycle';
const cases = [
  { id: 'ready-sigterm', phase: 'ready', signal: 'SIGTERM', modes: ['firestore'] },
  { id: 'ready-sigint', phase: 'ready', signal: 'SIGINT', modes: ['datastore'] },
  { id: 'startup-sigterm', phase: 'spawned', signal: 'SIGTERM', modes: ['firestore'] },
  { id: 'idempotent-stop', phase: 'ready', modes: ['firestore', 'datastore'] },
];

async function childMain(id) {
  const scenario = cases.find(item => item.id === id);
  assert.ok(scenario && process.send, 'Lifecycle child requires an IPC supervisor');
  // Observe the existing spawn boundary instead of adding a production launcher
  // callback. The startup case signals before the readiness promise resolves.
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (executable, args, options) => {
    const child = originalSpawn(executable, args, options);
    if (executable.endsWith('/bin/java')) {
      const log = fs.readlinkSync(`/proc/self/fd/${options.stdio[1]}`);
      process.send({ phase: 'spawned', pid: child.pid, cwd: options.cwd, log,
        mode: args.find(argument => argument.startsWith('--database-mode=')).split('=')[1],
        statusFile: log.replace(/\.log$/, '.exit.json') });
    }
    return child;
  };
  const { startEmulators } = require('./launcher.cjs');
  const emulators = await startEmulators({ projectId, modes: scenario.modes });
  if (scenario.signal) {
    process.send({ phase: 'ready' });
    setInterval(() => {}, 1000);
    return;
  }
  try {
    const first = emulators.stop();
    const second = emulators.stop();
    assert.strictEqual(first, second, 'Concurrent group stop calls share the completion promise');
    const [left, right] = await Promise.all([first, second]);
    assert.strictEqual(left, right);
    assert.strictEqual(await emulators.stop(), left, 'Stop after completion returns the same metadata');
    assert.ok(Object.values(left.instances).every(instance => instance.exit?.code === 0));
    process.send({ phase: 'stopped', concurrentStopSharedPromise: true, repeatedStopAfterExit: true });
  } finally {
    await emulators.stop();
    process.disconnect();
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function runCase(scenario, logDirectory, remainingMs) {
  const stem = path.join(logDirectory, `wga-emulator-lifecycle-${scenario.id}-${Date.now()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  const log = stem + '.log', statusFile = stem + '.exit.json';
  const fd = fs.openSync(log, 'wx', 0o600);
  const child = childProcess.spawn(process.execPath, [__filename, '--child', scenario.id], {
    cwd: root, env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
    stdio: ['ignore', fd, fd, 'ipc'],
  });
  fs.closeSync(fd);
  const result = { id: scenario.id, status: 'running', signal: scenario.signal || null, phase: scenario.phase,
    modes: scenario.modes, pid: child.pid, log, statusFile, children: [] };
  let sent = false, timedOut = false, stopEvidence;
  let hardStop;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    hardStop = setTimeout(() => child.kill('SIGKILL'), 3000);
  }, Math.min(15000, remainingMs));
  try {
    result.exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.on('message', message => {
        if (message.phase === 'spawned') result.children.push(message);
        if (message.phase === 'stopped') stopEvidence = message;
        if (message.phase === scenario.phase && scenario.signal && !sent) {
          sent = true;
          child.kill(scenario.signal);
        }
      });
      child.once('exit', (code, signal) => resolve({ pid: child.pid, code, signal }));
    });
    fs.writeFileSync(statusFile, `${JSON.stringify(result.exit, null, 2)}\n`, { mode: 0o600 });
    assert.equal(timedOut, false, 'Lifecycle child exceeded its bounded execution time');
    assert.equal(result.children.length, scenario.modes.length);
    if (scenario.signal) {
      assert.equal(sent, true);
      assert.equal(result.exit.signal, scenario.signal);
      assert.equal(result.exit.code, null);
    } else {
      assert.equal(result.exit.code, 0);
      assert.equal(result.exit.signal, null);
      assert.ok(stopEvidence?.concurrentStopSharedPromise && stopEvidence.repeatedStopAfterExit);
      result.stopEvidence = stopEvidence;
    }
    for (const witness of result.children) {
      assert.equal(alive(witness.pid), false, `Java PID ${witness.pid} survived the launcher`);
      assert.equal(fs.existsSync(witness.cwd), false, 'Ephemeral emulator working directory remains');
      assert.equal(fs.statSync(witness.log).mode & 0o777, 0o600);
      assert.equal(fs.statSync(witness.statusFile).mode & 0o777, 0o600);
      assert.ok(fs.statSync(witness.statusFile).size < 4096, 'Exit sidecar exceeds its evidence bound');
      witness.exit = JSON.parse(fs.readFileSync(witness.statusFile, 'utf8'));
      assert.equal(witness.exit.pid, witness.pid);
      if (scenario.signal) assert.equal(witness.exit.parentSignal, scenario.signal);
      if (scenario.phase === 'ready') assert.equal(witness.exit.code, 0);
      else assert.ok(witness.exit.code === 0 || witness.exit.code === 143 || witness.exit.signal === 'SIGTERM');
      witness.pidGone = true;
      witness.workingDirectoryRemoved = true;
    }
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = { class: error.constructor.name, message: error.message };
  } finally {
    clearTimeout(timer);
    clearTimeout(hardStop);
    // A failing regression must not itself leak the detached Java process.
    // Keep this emergency cleanup distinct from the launcher evidence above.
    for (const witness of result.children) {
      if (alive(witness.pid)) {
        witness.emergencyCleanup = true;
        process.kill(-witness.pid, 'SIGKILL');
        for (let count = 0; count < 60 && alive(witness.pid); count++) await new Promise(resolve => setTimeout(resolve, 50));
        witness.emergencyCleanupPidGone = !alive(witness.pid);
      }
      if (path.dirname(witness.cwd) === os.tmpdir() && path.basename(witness.cwd).startsWith('wga-emulators-')) fs.rmSync(witness.cwd, { recursive: true, force: true });
    }
  }
  return result;
}

async function main() {
  const { ensureToolchain } = require('./download.cjs');
  const report = { status: 'running', startedAt: new Date().toISOString(), projectId,
    officialEmulator: true, externalServiceRpcRequests: false, results: [] };
  try {
    const toolchain = await ensureToolchain();
    report.toolchain = { firestore: toolchain.manifest.firestore, java: toolchain.manifest.java };
    report.sourceHashes = Object.fromEntries(['lifecycle.cjs', 'launcher.cjs', 'download.cjs', 'toolchain.json'].map(name => [
      `fixtures/emulators/${name}`, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, name))).digest('hex'),
    ]));
    const logs = path.join(os.homedir(), 'logs');
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
    fs.chmodSync(logs, 0o700);
    const started = Date.now();
    const deadline = started + 45000;
    for (const scenario of cases) {
      assert.ok(Date.now() < deadline, 'Lifecycle cases exceeded the 45-second suite budget');
      const result = await runCase(scenario, logs, deadline - Date.now());
      report.results.push(result);
      assert.equal(result.status, 'passed', `${scenario.id}: ${result.error?.message}`);
    }
    report.caseDurationMs = Date.now() - started;
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = { class: error.constructor.name, message: error.message };
    process.exitCode = 1;
  } finally {
    report.completedAt = new Date().toISOString();
    fs.mkdirSync(path.join(root, 'verification'), { recursive: true });
    fs.writeFileSync(path.join(root, 'verification/emulator-lifecycle.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, cases: report.results.length, caseDurationMs: report.caseDurationMs, error: report.error }));
  }
}

if (process.argv[2] === '--child') childMain(process.argv[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
else main().catch(error => { console.error(error.message); process.exitCode = 1; });
