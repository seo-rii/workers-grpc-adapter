'use strict';

// Pure configuration generation. This module never deploys or reads credentials.
function createEnvoyConfig({ nativeOrigin, port = 8080 } = {}) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error('A non-privileged listener port is required');
    }
    const upstreams = [
        ['secret_manager', 'secretmanager.googleapis.com', '/google.cloud.secretmanager.v1.SecretManagerService/'],
        ['firestore', 'firestore.googleapis.com', '/google.firestore.v1.Firestore/'],
        ['datastore', 'datastore.googleapis.com', '/google.datastore.v1.Datastore/'],
    ];
    if (nativeOrigin !== undefined) {
        const url = new URL(nativeOrigin);
        if (url.protocol !== 'https:' || url.port || url.username || url.password ||
            url.pathname !== '/' || url.search || url.hash || !url.hostname.endsWith('.run.app')) {
            throw new Error('Native upstream must be an HTTPS Cloud Run origin');
        }
        upstreams.push(['native_probe', url.hostname, '/grpcbin.GRPCBin/']);
    }
    const routes = upstreams.map(([name, hostname, prefix]) => ({
        match: { prefix, headers: [{ name: ':method', string_match: { exact: 'POST' } }] },
        route: { cluster: name, host_rewrite_literal: hostname, timeout: '25s' },
        ...(name === 'native_probe' ? {
            // Copy before the route-configuration-level removal below. Cloud Run
            // can transform recognized authorization headers at the gateway hop.
            request_headers_to_add: [{
                header: { key: 'authorization', value: '%REQ(x-wga-upstream-authorization)%' },
                append_action: 'OVERWRITE_IF_EXISTS_OR_ADD',
            }],
        } : {}),
    }));
    routes.push({ match: { prefix: '/' }, direct_response: { status: 404 } });
    return {
        static_resources: {
            listeners: [{
                name: 'cloud_run_h2c',
                address: { socket_address: { address: '0.0.0.0', port_value: port } },
                filter_chains: [{ filters: [{
                    name: 'envoy.filters.network.http_connection_manager',
                    typed_config: {
                        '@type': 'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                        stat_prefix: 'wga_probe',
                        codec_type: 'AUTO',
                        stream_idle_timeout: '30s',
                        request_timeout: '30s',
                        max_request_headers_kb: 32,
                        route_config: {
                            name: 'fixed_probe_routes',
                            most_specific_header_mutations_wins: false,
                            // Cloud Run has already authenticated this header. Never send it upstream.
                            request_headers_to_remove: ['x-serverless-authorization', 'x-wga-upstream-authorization', 'cookie'],
                            virtual_hosts: [{ name: 'probe', domains: ['*'], routes }],
                        },
                        http_filters: [
                            { name: 'envoy.filters.http.grpc_web', typed_config: {
                                '@type': 'type.googleapis.com/envoy.extensions.filters.http.grpc_web.v3.GrpcWeb',
                            } },
                            { name: 'envoy.filters.http.router', typed_config: {
                                '@type': 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router',
                            } },
                        ],
                    },
                }] }],
            }],
            clusters: upstreams.map(([name, hostname]) => ({
                name,
                type: 'LOGICAL_DNS',
                dns_lookup_family: 'V4_ONLY',
                connect_timeout: '5s',
                per_connection_buffer_limit_bytes: 1024 * 1024,
                circuit_breakers: { thresholds: [{ max_connections: 4, max_pending_requests: 8, max_requests: 8, max_retries: 0 }] },
                typed_extension_protocol_options: {
                    'envoy.extensions.upstreams.http.v3.HttpProtocolOptions': {
                        '@type': 'type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions',
                        explicit_http_config: { http2_protocol_options: {} },
                    },
                },
                transport_socket: {
                    name: 'envoy.transport_sockets.tls',
                    typed_config: {
                        '@type': 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext',
                        sni: hostname,
                        auto_sni_san_validation: true,
                        common_tls_context: {
                            alpn_protocols: ['h2'],
                            validation_context: { trusted_ca: { filename: '/etc/ssl/certs/ca-certificates.crt' } },
                        },
                    },
                },
                load_assignment: {
                    cluster_name: name,
                    endpoints: [{ lb_endpoints: [{ endpoint: {
                        address: { socket_address: { address: hostname, port_value: 443 } },
                    } }] }],
                },
            })),
        },
    };
}

module.exports = { createEnvoyConfig };

if (require.main === module) {
    try {
        process.stdout.write(JSON.stringify(createEnvoyConfig({ nativeOrigin: process.argv[2] }), null, 2) + '\n');
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
