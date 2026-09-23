# Real Envoy interop fixture

This fixture runs the adapter through the official Envoy `grpc_web` filter into a
pinned native `@grpc/grpc-js@1.14.0` server. Envoy performs all HTTP/1 gRPC-Web to
HTTP/2 gRPC translation. There is no handwritten translation bridge in this test.

Run from the repository root:

```sh
npm run build
node fixtures/envoy/download.cjs
node scripts/envoy-test.cjs
```

The native fixture dependencies must already be installed (`fixtures/native`).
The downloader accepts only Linux x64, saves the binary under ignored `.cache/`,
and checks its exact size and SHA-256 from the pinned official release metadata.
No system installation, Docker daemon or external deployment is needed.
`WGA_ENVOY_BINARY` can select another local copy of the same pinned binary; its
SHA-256 must still match.

The YAML uses loopback addresses and ephemeral ports selected by the runner. The
admin readiness endpoint is loopback-only. Processes, native server connections
and temporary configuration are cleaned up after each run. Envoy stdout/stderr go
to a unique `0600` file in `~/logs`; `verification/envoy.json` records its PID,
exit code and log path. For automation, run the outer runner in the background
with its own restricted log and retained exit status as required by this workspace.

Six cases cover unary success, server stream success, unary and stream non-OK
trailers, a deadline, and cancellation after confirmed upstream arrival. The
runner verifies one fetch and one native server arrival per call, binary metadata,
callback/status/data outcomes, no active adapter calls, and upstream cancellation
for both cancellation cases. Wire evidence includes the actual downstream request
and response Content-Type, `0x80` trailer frames for completed calls, and upstream
HTTP/2 Content-Type. The last observation uses read-only access to the pinned
native server's internal `http2Servers`; it is test instrumentation only.

This is local Node + Envoy evidence. It does not certify Cloudflare outbound
translation, deployed workerd, real Google endpoints, TLS or production Envoy
policy. Performance, production configuration and release budgets are separate.

Primary references:

- [Envoy 1.39.1 release](https://github.com/envoyproxy/envoy/releases/tag/v1.39.1)
- [Official asset digest](https://api.github.com/repos/envoyproxy/envoy/releases/tags/v1.39.1)
- [Envoy grpc_web filter](https://www.envoyproxy.io/docs/envoy/v1.39.1/configuration/http/http_filters/grpc_web_filter)
- [Envoy typed HTTP protocol options](https://www.envoyproxy.io/docs/envoy/v1.39.1/api-v3/extensions/upstreams/http/v3/http_protocol_options.proto)
- [Envoy router and retry policy](https://www.envoyproxy.io/docs/envoy/v1.39.1/configuration/http/http_filters/router_filter)

The fixture configures no retry policy. The version, download URL, architecture,
size and digest are recorded in `binary.json`.
