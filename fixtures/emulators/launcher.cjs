'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ensureToolchain } = require('./download.cjs');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
// A verification timeout signals the Node harness, while Java has its own process
// group. Keep the children registered during startup as well as normal operation.
const activeEmulators = new Set();
let signalCleanup;
let handlersInstalled = false;
const signalHandlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
  if (signalCleanup) return;
  const otherHandlerExists = process.listeners(signal).some(listener => listener !== signalHandlers[signal]);
  signalCleanup = (async () => {
    const instances = [...activeEmulators];
    const results = await Promise.allSettled(instances.map(instance => {
      instance.metadata.parentSignal = signal;
      return instance.stop();
    }));
    for (const scratch of new Set(instances.map(instance => instance.scratch))) fs.rmSync(scratch, { recursive: true, force: true });
    removeSignalHandlers();
    if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
    // A caller's signal handler owns its remaining resources and final exit.
    // Otherwise restore the usual shell-visible signal termination after cleanup.
    if (!otherHandlerExists) process.kill(process.pid, signal);
  })();
}]));

function removeSignalHandlers() {
  for (const [signal, handler] of Object.entries(signalHandlers)) process.removeListener(signal, handler);
  handlersInstalled = false;
}

function installSignalHandlers() {
  if (handlersInstalled) return;
  for (const [signal, handler] of Object.entries(signalHandlers)) process.on(signal, handler);
  handlersInstalled = true;
}

async function unusedPort() {
  const server = net.createServer();
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function localRequest(port, method, pathname, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname, agent: false }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
      response.once('error', reject);
    });
    request.setTimeout(timeout, () => request.destroy(new Error('Local emulator request timed out')));
    request.once('error', reject);
    request.end();
  });
}

async function startOne(toolchain, name, projectId, scratch, logDirectory) {
  const mode = name === 'firestore' ? 'firestore-native' : 'datastore-mode';
  const port = await unusedPort();
  if (signalCleanup) throw new Error('Emulator launch interrupted by a termination signal');
  const tag = `wga-emulator-${name}-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const log = path.join(logDirectory, `${tag}.log`);
  const statusFile = path.join(logDirectory, `${tag}.exit.json`);
  const fd = fs.openSync(log, 'wx', 0o600);
  const args = ['-Xms32m', '-Xmx512m', '-XX:ActiveProcessorCount=2', '-Duser.language=en',
    '-cp', toolchain.jar, toolchain.manifest.firestore.mainClass, 'start',
    '--host=127.0.0.1', `--port=${port}`, `--database-mode=${mode}`,
    `--project_id=${projectId}`, '--single_project_mode=true', '--single_project_mode_error=true'];
  let child;
  try {
    // Install before spawning: a supervisor can signal as soon as Java's PID
    // exists, before Node has finished constructing the registration below.
    installSignalHandlers();
    child = spawn(toolchain.java, args, {
      cwd: scratch,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const metadata = {
    name, mode, projectId, endpoint: `127.0.0.1:${port}`, port, pid: child.pid ?? null,
    log, statusFile, startedAt: new Date().toISOString(),
    persistentData: false, imports: false, exports: false, loopbackOnly: true,
    status: 'starting', exit: null,
  };
  let outcome;
  let stopping;
  let registration;
  const exited = new Promise(resolve => {
    const settle = value => {
      if (outcome) return;
      outcome = value;
      if (metadata.parentSignal) value.parentSignal = metadata.parentSignal;
      metadata.exit = value;
      metadata.status = 'stopped';
      fs.writeFileSync(statusFile, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      activeEmulators.delete(registration);
      if (activeEmulators.size === 0 && !signalCleanup) removeSignalHandlers();
      resolve(value);
    };
    child.once('error', error => settle({ pid: child.pid ?? null, code: null, signal: null, errorCode: error.code || 'SPAWN_ERROR', stoppedAt: new Date().toISOString() }));
    child.once('exit', (code, signal) => settle({ pid: child.pid, code, signal, stoppedAt: new Date().toISOString() }));
  });
  function signal(signalName) {
    if (outcome || !child.pid) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signalName); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!outcome) await localRequest(port, 'POST', '/shutdown').catch(() => {});
      for (let i = 0; i < 100 && !outcome; i++) await delay(50);
      if (!outcome) signal('SIGTERM');
      for (let i = 0; i < 100 && !outcome; i++) await delay(50);
      if (!outcome) signal('SIGKILL');
      return exited;
    })();
    return stopping;
  }
  registration = { metadata, stop, scratch };
  activeEmulators.add(registration);
  try {
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      if (outcome) throw new Error(`${name} emulator exited during startup (${outcome.code ?? outcome.signal ?? outcome.errorCode}); see ${log}`);
      const ready = await localRequest(port, 'GET', '/').catch(() => false);
      if (ready) {
        metadata.status = 'running';
        metadata.readyAt = new Date().toISOString();
        return {
          endpoint: metadata.endpoint, port, projectId, metadata, stop,
          async reset() {
            const code = await localRequest(port, name === 'datastore' ? 'POST' : 'DELETE', name === 'datastore'
              ? '/reset' : `/emulator/v1/projects/${projectId}/databases/(default)/documents`, 30000);
            if (code < 200 || code >= 300) throw new Error(`${name} emulator reset returned HTTP ${code}`);
          },
        };
      }
      await delay(100);
    }
    throw new Error(`${name} emulator startup timed out; see ${log}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function startEmulators({ projectId = 'demo-wga-local', modes = ['firestore', 'datastore'] } = {}) {
  if (!/^demo-[a-z0-9-]{1,24}$/.test(projectId)) throw new Error('Emulator fixture requires a synthetic demo- project ID');
  if (!Array.isArray(modes) || modes.length === 0 || new Set(modes).size !== modes.length || modes.some(mode => !['firestore', 'datastore'].includes(mode))) {
    throw new Error('Emulator modes must be a nonempty unique list of firestore and/or datastore');
  }
  const toolchain = await ensureToolchain();
  const logDirectory = path.join(os.homedir(), 'logs');
  fs.mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDirectory, 0o700);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-emulators-'));
  const instances = {};
  const metadata = {
    projectId, modeNames: modes.slice(), officialEmulator: toolchain.manifest.firestore,
    java: toolchain.manifest.java, documentation: toolchain.manifest.documentation,
    instances: {}, cloudServiceRpcRequests: false, credentialsPassed: false,
    artifactDownloadMayUseNetwork: true, gcloudConfigurationRead: false,
  };
  let stopping;
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      const results = await Promise.allSettled(Object.values(instances).map(instance => instance.stop()));
      fs.rmSync(scratch, { recursive: true, force: true });
      const errors = results.filter(result => result.status === 'rejected');
      if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Emulator cleanup failed');
      return metadata;
    })();
    return stopping;
  };
  try {
    // Sequential startup keeps partial failures easy to clean up and limits Java startup spikes.
    for (const name of modes) {
      instances[name] = await startOne(toolchain, name, projectId, scratch, logDirectory);
      metadata.instances[name] = instances[name].metadata;
    }
    return { ...instances, projectId, metadata, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = { startEmulators };
if (require.main === module) (async () => {
  const emulators = await startEmulators();
  try {
    await emulators.firestore.reset();
    await emulators.datastore.reset();
  } finally {
    await emulators.stop();
  }
  console.log(JSON.stringify({ status: 'passed', ...emulators.metadata }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
