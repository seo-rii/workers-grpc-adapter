'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { EventEmitter, once } = require('node:events');
const { reserveEnvoyPorts } = require('../scripts/emulator-envoy.cjs');

// Deterministic OS model: select the lowest free ephemeral port. A port becomes
// eligible again immediately after close, reproducing the observed CI reuse.
function allocator({ bindFailureAt, closeFailureAt } = {}) {
    const used = new Set(), servers = [], events = [];
    const bindError = Object.assign(new Error('controlled bind failure'), { code: 'EADDRINUSE' });
    const closeError = new Error('controlled close failure');
    return { used, servers, events, bindError, closeError, createServer() {
        const index = servers.length;
        const server = new EventEmitter();
        servers.push(server); server.closes = 0;
        server.listen = (requested, host) => {
            assert.equal(requested, 0); assert.equal(host, '127.0.0.1');
            if (index === bindFailureAt) { queueMicrotask(() => server.emit('error', bindError)); return server; }
            let port = 40000;
            while (used.has(port)) port++;
            server.port = port; used.add(port); events.push(`bound:${port}`);
            queueMicrotask(() => server.emit('listening'));
            return server;
        };
        server.address = () => ({ port: server.port });
        server.close = callback => {
            server.closes++;
            used.delete(server.port); events.push(`close:${index}`);
            const error = index === closeFailureAt ? closeError : server.port === undefined
                ? Object.assign(new Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' }) : undefined;
            queueMicrotask(() => callback(error));
        };
        return server;
    } };
}

test('ENVOY ephemeral port reuse is prevented by holding every listener and admin reservation', async () => {
    const old = allocator(), reused = [];
    for (let index = 0; index < 4; index++) {
        const server = old.createServer();
        server.listen(0, '127.0.0.1'); await once(server, 'listening');
        reused.push(server.address().port);
        await new Promise(resolve => server.close(resolve));
    }
    assert.deepEqual(reused, [40000, 40000, 40000, 40000], 'the previous allocate-and-close policy deterministically collides');
    const model = allocator(), reservation = await reserveEnvoyPorts(model.createServer);
    assert.deepEqual(reservation.ports, { native: 40000, replacement: 40001, workerd: 40002, admin: 40003 });
    assert.deepEqual([...model.used], Object.values(reservation.ports));
    assert.deepEqual(model.events, ['bound:40000', 'bound:40001', 'bound:40002', 'bound:40003']);
    await Promise.all([reservation.release(), reservation.release()]);
    assert.equal(model.used.size, 0);
    assert.deepEqual(model.servers.map(server => server.closes), [1, 1, 1, 1]);
});

test('ENVOY real loopback ports remain exclusive until release and can then be rebound', async () => {
    const reservation = await reserveEnvoyPorts();
    const listeners = [];
    try {
        assert.equal(new Set(Object.values(reservation.ports)).size, 4);
        for (const port of Object.values(reservation.ports)) {
            const competing = net.createServer();
            const failed = once(competing, 'error');
            competing.listen(port, '127.0.0.1');
            assert.equal((await failed)[0].code, 'EADDRINUSE');
            await new Promise(resolve => competing.close(resolve));
        }
        await reservation.release();
        for (const port of Object.values(reservation.ports)) {
            const listener = net.createServer(); listeners.push(listener);
            listener.listen(port, '127.0.0.1'); await once(listener, 'listening');
            assert.equal(listener.address().port, port);
        }
    } finally {
        await reservation.release();
        await Promise.all(listeners.map(server => new Promise(resolve => server.close(resolve))));
    }
});

test('ENVOY a later bind failure releases previous reservations and the failed socket', async () => {
    const model = allocator({ bindFailureAt: 2 });
    await assert.rejects(reserveEnvoyPorts(model.createServer), error => error === model.bindError);
    assert.equal(model.used.size, 0);
    assert.deepEqual(model.servers.map(server => server.closes), [1, 1, 1]);
});

test('ENVOY cleanup attempts every close and preserves the original bind error as its cause', async () => {
    const model = allocator({ bindFailureAt: 3, closeFailureAt: 0 });
    await assert.rejects(reserveEnvoyPorts(model.createServer), error => {
        assert.equal(error.cause, model.bindError);
        assert.equal(error.errors[0], model.bindError);
        assert.deepEqual(error.errors[1].errors, [model.closeError]);
        return true;
    });
    assert.deepEqual(model.servers.map(server => server.closes), [1, 1, 1, 1]);
    assert.equal(model.used.size, 0);
});
