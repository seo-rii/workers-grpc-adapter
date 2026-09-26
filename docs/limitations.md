# Limitations and compatibility status

This is an experimental, client-only prototype. The package remains `private: true`. Passing local tests does not establish a complete grpc-js replacement or production readiness.

## Remaining release gates

- Production validation of direct Google SDK calls after the conversion and content-type correction. The [conversion diagnosis](cloudflare-conversion.md) explains the wire-level evidence; finite Google SDK deployment results are recorded separately in the [GCP probe](gcp-cloud-probe.md).
- Live service-account OAuth/JWT refresh, IAM and quota errors, workload identity federation, impersonation and ADC.
- Production transaction conflicts and uncertain Commit outcomes under real network failures.
- All 189 original planned cases, full public grpc-js API and exception-timing equivalence, and production performance budgets.

The checked-in `compatibility/test-evidence.json` maps each original case to reviewed evidence. A verification run produces `verification/evidence.json`, distinguishing full, partial and missing coverage. Local test counts and supplemental scenarios do not increase the original catalog's denominator. See [testing](testing.md) for reports and CI artifacts.

## Transport modes and verification

Both `cloudflare` and `grpc-web` modes are implemented. They send binary gRPC-Web from the Worker; neither provides raw HTTP/2 gRPC inside the Worker.

- `cloudflare` is the default. It sends directly to the logical service's HTTPS origin using binary `application/grpc-web` and explicitly requests conversion with `cf.grpcWeb: 'convert'`. No Worker-wide `auto_grpc_convert` flag is required. Conversion runs at Cloudflare's edge proxy, outside local workerd.
- `grpc-web` requires a map from logical service authorities to trusted gateway origins. It sends `application/grpc-web+proto` with `cf.grpcWeb: 'passthrough'`, preserving gRPC-Web even when a Worker-wide flag enables conversion. Local Envoy and official emulator integrations verify this gateway path. A native gRPC endpoint without a translation layer does not accept the adapter's wire protocol.

Local routing and framing checks do not prove Cloudflare's platform conversion or production Google service behavior. There is no automatic capability detection, route failover, or replay of a failed call through another mode. The gateway alternative must be selected explicitly before constructing a client. Neither mode switches to GAX's REST fallback. See [API configuration](api.md#global-configuration) for both examples.

## What local verification establishes

The client, factory, interceptor, Metadata and call surfaces derive from grpc-js 1.14.0. Tests check provenance, builds, selected root/deep module identities and representative native event behavior. They do not cover every upstream API interaction.

Pinned Google SDKs run against controlled local gRPC servers and official database emulators. Native grpc-js, the Node adapter and workerd use identical shared business code. Reports compare source hashes, assertions and RPC observations. Strict Node16, NodeNext and Bundler declaration checks use the pinned dependency graph, including the targeted Google auth 10.9.1 override.

The Node-only build preset supports the pinned SDK/GAX/protobuf sources and schemas. It does not infer transformations for other versions. Worker tooling is locked, including the Miniflare alpha used by the installed Wrangler; reports identify the actual versions and compatibility date.

Import the pinned SDK modules during Worker initialization: lazy Datastore initialization during a request can trigger a prohibited protobuf `eval`. GAX also caches service constructors by schema across per-instance facades. Different Google SDK transport modes therefore require separate Workers; the adapter's direct-client mode-isolation tests do not establish GAX isolation.

Controlled Commit-response-loss tests apply a mutation, withhold the response and reach a deadline. A later SDK Rollback does not prove that a committed write was undone. Controlled workerd shared tests buffer finite responses; separate Worker SDK tests cover incremental transport cancellation.

Official Firestore 1.22.0 Native and Datastore modes run through real Envoy locally. These tests cover the explicitly asserted data, query, stream and error behavior. Emulator results do not establish production IAM, composite-index requirements, quotas or transaction concurrency. Secret Manager still uses a controlled server. The emulator-only synthetic owner header is injected by local Envoy and is not authentication evidence.

## Unsupported features

Client streaming, bidirectional RPCs, server APIs, Firestore Listen/Watch, compression, custom certificate authorities, mTLS, connection pools, keepalive, load balancing, adapter retries, remote health checks, channelz and arbitrary resolver schemes are unsupported. `waitForReady()` cannot report a ready connection. Parent-call propagation and `WriteThrough` are also unsupported.

## Intentional differences

- Per-message transport ceilings default to 32 MiB. A channel limit of `-1` does not remove them.
- Transport lookahead is one message; upstream Readable buffering and Fetch allocations are additional memory.
- `getPeer()` returns the logical URL rather than a remote IP. `getAuthContext()` returns null, and the channelz reference is an unregistered placeholder.
- Invocation-transformed arguments and interceptor-modified method definitions reach the transport. Vendor patches record these upstream differences.
- User callback exceptions are rethrown in a microtask. Complete upstream exception-timing equivalence is unverified.
- HTTPS credentials use Fetch TLS. Legacy callback-only Google credential shapes are unsupported.

Datastore's emulator stream-destruction case uses one unary query page. It verifies that later entities are not delivered and that the client remains usable. It does not prove multi-page suppression, HTTP/2 stream cancellation or internal timer/pump cleanup; native SDK info events may still arrive after destruction.
