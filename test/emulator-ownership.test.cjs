'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

async function scenario(kind) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-launcher-ownership-'));
    const launcher = require.resolve('../fixtures/emulators/launcher.cjs');
    const downloader = require.resolve('../fixtures/emulators/download.cjs');
    const saved = { downloader: require.cache[downloader], launcher: require.cache[launcher],
        createServer: net.createServer, spawn: cp.spawn, homedir: os.homedir, kill: process.kill };
    const requests = [], signals = [], children = [];
    let child, instance, exitTimer, port;
    const foreign = http.createServer((request, response) => {
        requests.push({ method: request.method, path: request.url });
        if (kind === 'exit-during-probe') child.emit('exit', 1, null);
        response.statusCode = kind === 'foreign-500' ? 500 : 200;
        response.end('test peer');
        if (request.url === '/shutdown') setImmediate(() => child.emit('exit', 0, null));
    });
    require.cache[downloader] = { id: downloader, filename: downloader, loaded: true,
        exports: { ensureToolchain: async () => ({ java: '/unused/java', jar: '/unused/emulator.jar',
            manifest: { firestore: { mainClass: 'Fixture' }, java: {}, documentation: {} } }) } };
    delete require.cache[launcher];
    net.createServer = (...args) => {
        const reservation = saved.createServer(...args), close = reservation.close;
        net.createServer = saved.createServer;
        reservation.once('listening', () => { port = reservation.address().port; });
        reservation.close = callback => close.call(reservation, () => foreign.listen(port, '127.0.0.1', callback));
        return reservation;
    };
    cp.spawn = (_executable, _args, options) => {
        child = new EventEmitter(); child.pid = 10000001; children.push(child);
        if (['healthy', 'exit-during-probe', 'wrong-port'].includes(kind)) {
            fs.writeSync(options.stdio[1], `API endpoint: http://127.0.0.1:${port + (kind === 'wrong-port' ? 1 : 0)}\nDev App Server is now running.\n`);
        }
        if (kind.startsWith('foreign') || kind === 'wrong-port') exitTimer = setTimeout(() => child.emit('exit', 1, null), 150);
        return child;
    };
    process.kill = (pid, signal) => {
        if (Math.abs(pid) !== child?.pid) return saved.kill(pid, signal);
        signals.push(signal);
        setImmediate(() => child.emit('exit', null, signal));
        return true;
    };
    os.homedir = () => directory;
    try {
        const start = require(launcher).startEmulators({ projectId: 'demo-owner-check', modes: ['firestore'] });
        if (kind === 'healthy') {
            instance = await start;
            assert.equal(instance.firestore.metadata.status, 'running');
            assert.deepEqual(requests, [{ method: 'GET', path: '/' }]);
            const stopped = instance.stop();
            assert.strictEqual(instance.stop(), stopped);
            await stopped;
            assert.deepEqual(signals, ['SIGTERM']);
            assert.equal(instance.firestore.metadata.exit.signal, 'SIGTERM');
        } else {
            // Keep ownership even if the buggy launcher unexpectedly succeeds.
            await assert.rejects(start.then(value => { instance = value; return value; }), /exited during startup/);
            assert.equal(requests.length, kind === 'exit-during-probe' ? 1 : 0);
        }
        assert.equal(requests.some(request => request.path === '/shutdown'), false);
        assert.equal(children.length, 1);
    } finally {
        clearTimeout(exitTimer);
        if (instance) await instance.stop();
        net.createServer = saved.createServer; cp.spawn = saved.spawn;
        os.homedir = saved.homedir; process.kill = saved.kill;
        for (const [key, original] of [[downloader, saved.downloader], [launcher, saved.launcher]]) {
            if (original) require.cache[key] = original; else delete require.cache[key];
        }
        await new Promise(resolve => foreign.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

for (const kind of ['foreign-200', 'foreign-500', 'wrong-port', 'exit-during-probe', 'healthy']) {
    test(`EMULATOR verifies its child endpoint and signals only its process: ${kind}`, { timeout: 5000 }, () => scenario(kind));
}
