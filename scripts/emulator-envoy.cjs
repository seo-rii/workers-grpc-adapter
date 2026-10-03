'use strict';
// Real Envoy translation; this fixture never parses or synthesizes RPC bodies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const pin = require('../fixtures/envoy/binary.json');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Keep every socket bound until the complete configuration is ready. Closing
// each ephemeral listener immediately lets the OS return the same port again.
async function reserveEnvoyPorts(createServer = () => net.createServer()) {
    const servers = [], ports = {};
    let releasing;
    const release = () => releasing ||= (async () => {
        const outcomes = await Promise.allSettled(servers.map(server => new Promise((resolve, reject) => {
            server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
        })));
        const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
        if (failures.length) throw new AggregateError(failures, 'Envoy port reservation cleanup failed');
    })();
    try {
        for (const name of ['native', 'replacement', 'workerd', 'admin']) {
            const server = createServer();
            servers.push(server);
            server.listen(0, '127.0.0.1');
            await once(server, 'listening');
            ports[name] = server.address().port;
        }
        return { ports, release };
    } catch (error) {
        try { await release(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Envoy port reservation and cleanup failed', { cause: error }); }
        throw error;
    }
}
async function startEmulatorEnvoy(emulators) {
    const binary = process.env.WGA_ENVOY_BINARY || path.join(root, 'fixtures/envoy/.cache', `envoy-${pin.version}`);
    if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== pin.sha256) throw new Error('Pinned Envoy hash mismatch');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wga-emulator-envoy-'));
    const logDir = path.join(os.homedir(), 'logs');
    fs.mkdirSync(logDir, { mode: 0o700, recursive: true });
    const stem = path.join(logDir, `wga-emulator-envoy-${Date.now()}-${process.pid}`);
    const log = stem + '.log', accessLog = stem + '.access.jsonl', exitFile = stem + '.exit.json';
    let fd, child, completion, exit, stopping, metadata, reservations;
    async function stop() {
        if (stopping) return stopping;
        stopping = (async () => {
            if (child) {
                if (!exit) child.kill('SIGTERM');
                await Promise.race([completion, pause(3000)]);
                if (!exit) child.kill('SIGKILL');
                metadata.exit = await completion;
            }
            try { await reservations?.release(); }
            finally {
                if (fd !== undefined) fs.closeSync(fd);
                fs.rmSync(scratch, { recursive: true, force: true });
            }
            return metadata;
        })();
        return stopping;
    }
    try {
        fd = fs.openSync(log, 'wx', 0o600);
        fs.closeSync(fs.openSync(accessLog, 'wx', 0o600));
        reservations = await reserveEnvoyPorts();
        const { ports } = reservations;
        const address = port => ({ socket_address: { address: '127.0.0.1', port_value: port } });
        const config = {
            admin: { address: address(ports.admin) },
            static_resources: {
                listeners: ['native', 'replacement', 'workerd'].map(runtime => ({
                    name: runtime, address: address(ports[runtime]),
                    filter_chains: [{ filters: [{ name: 'envoy.filters.network.http_connection_manager', typed_config: {
                        '@type': 'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                        stat_prefix: runtime, codec_type: 'AUTO', stream_idle_timeout: '0s',
                        route_config: { name: runtime, virtual_hosts: [{ name: 'emulators', domains: ['*'], routes: [
                            { match: { prefix: '/google.datastore.v1.Datastore/' }, route: { cluster: 'datastore', timeout: '0s' } },
                            { match: { prefix: '/google.firestore.v1.Firestore/' }, route: { cluster: 'firestore', timeout: '0s' }, request_headers_to_add: [{ header: { key: 'authorization', value: 'Bearer owner' }, append_action: 'OVERWRITE_IF_EXISTS_OR_ADD' }] },
                        ] }] },
                        access_log: [{ name: 'envoy.access_loggers.file', typed_config: {
                            '@type': 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog', path: accessLog,
                            log_format: { json_format: { runtime, invocation: '%REQ(X-WGA-INVOCATION)%', method: '%REQ(:PATH)%', logicalCallId: '%REQ(X-WGA-SDK-CALL-ID)%', suite: '%REQ(X-WGA-SUITE)%', grpcStatus: '%GRPC_STATUS(NUMBER)%', httpStatus: '%RESPONSE_CODE%', upstream: '%UPSTREAM_CLUSTER%', flags: '%RESPONSE_FLAGS%' } },
                        } }],
                        http_filters: [
                            { name: 'envoy.filters.http.grpc_web', typed_config: { '@type': 'type.googleapis.com/envoy.extensions.filters.http.grpc_web.v3.GrpcWeb' } },
                            { name: 'envoy.filters.http.router', typed_config: { '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router' } },
                        ],
                    } }] }],
                })),
                clusters: ['datastore', 'firestore'].map(name => ({
                    name, connect_timeout: '2s', type: 'STATIC',
                    typed_extension_protocol_options: { 'envoy.extensions.upstreams.http.v3.HttpProtocolOptions': {
                        '@type': 'type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions', explicit_http_config: { http2_protocol_options: {} },
                    } },
                    load_assignment: { cluster_name: name, endpoints: [{ lb_endpoints: [{ endpoint: { address: address(emulators[name].port) } }] }] },
                })),
            },
        };
        const configFile = path.join(scratch, 'envoy.json');
        for (const listener of config.static_resources.listeners) {
            const manager = listener.filter_chains[0].filters[0].typed_config;
            // The grpc_web filter consumes downstream trailers. Observe the real
            // upstream attempt at the router, before that representation changes.
            manager.http_filters[1].typed_config.upstream_log = manager.access_log;
            delete manager.access_log;
        }
        fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
        // Envoy must bind these addresses itself. Keep the handoff window small;
        // an unrelated process can still race after release and before its bind.
        await reservations.release();
        child = spawn(binary, ['-c', configFile, '--concurrency', '1', '--disable-hot-restart', '--log-level', 'warning'], { stdio: ['ignore', fd, fd] });
        completion = new Promise(resolve => {
            const finish = result => { if (exit) return; exit = result; fs.writeFileSync(exitFile, JSON.stringify(result) + '\n', { mode: 0o600 }); resolve(result); };
            child.once('exit', (code, signal) => finish({ code, signal }));
            child.once('error', error => finish({ code: null, signal: null, error: error.message }));
        });
        metadata = { version: pin.version, sha256: pin.sha256, pid: child.pid, log, accessLog, exitFile, ports, observationPoint: 'router-upstream-access-log', firestoreSyntheticOwnerInjected: true };
        const deadline = Date.now() + 10000;
        while (true) {
            if (exit) throw new Error(`Envoy exited before readiness: ${log}`);
            try { if ((await fetch(`http://127.0.0.1:${ports.admin}/ready`, { signal: AbortSignal.timeout(300) })).ok) break; } catch {}
            if (Date.now() > deadline) throw new Error(`Envoy readiness timeout: ${log}`);
            await pause(50);
        }
        return { ports, metadata, stop, readAccess() {
            if (!exit) throw new Error('Read process logs only after Envoy has exited');
            const stat = fs.statSync(accessLog);
            if (stat.size > 8 * 1024 * 1024) throw new Error('Emulator access log exceeded fixture bound');
            return fs.readFileSync(accessLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        } };
    } catch (error) {
        try { await stop(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Envoy initialization and cleanup failed', { cause: error }); }
        throw error;
    }
}
module.exports = { startEmulatorEnvoy, reserveEnvoyPorts };
