# Limitations and compatibility status

This is an experimental, client-only prototype. The package remains `private: true`. Passing local tests does not establish a complete grpc-js replacement or production readiness.

## Remaining release gates

- Sustained production traffic, resource budgets, quotas and recovery. Finite direct and gateway Google SDK deployment results are recorded separately in the [GCP probe](gcp-cloud-probe.md); those runs do not establish long-running reliability.
- Live service-account OAuth/JWT refresh, issuer/STS/IAM behavior for federation and impersonation, IAM and quota errors, and automatic ADC discovery.
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

The pinned build profile supports SDK imports during startup and bundled dynamic imports during the first request. It generates Datastore's well-known `Struct` codecs at build time, including the codecs used to decode query explain metrics. Arbitrary SDK versions, unknown protobuf schemas and unbundled dynamic module loading remain outside this profile.

The profile also selects Workers' native Fetch for the pinned Gaxios default transport. Without this transformation, its Node fallback can lose response headers and fail to parse OAuth token responses in workerd. Explicit caller-supplied fetch implementations keep precedence. Local workerd tests exercise real OAuth/JWT refresh and exchange, credential isolation, cancellation/deadlines during refresh and recovery after rejection; they use controlled token endpoints and do not establish live Google authentication behavior.

URL-sourced external-account credentials, chained service-account impersonation and standalone `Impersonated` clients run through the pinned Google auth libraries in workerd. Tests cover text/JSON subject-token responses, STS/IAM request contents, cache reuse and forced expiry, isolated identities, denial recovery and late completion after cancellation/deadlines. The Secret Manager SDK also creates its GoogleAuth client directly from explicit external-account credential JSON. Subject tokens and endpoint responses are synthetic: real IdP trust, Google IAM permissions, AWS/Azure/executable/file credential sources and ADC environment/file/metadata discovery remain unverified. Concurrent exchange coalescing is checked for external-account clients, not standalone impersonation.

Google SDK clients can use different per-instance transport configurations in one Worker. `gaxOptions()` passes the configuration through each client's channel options, so GAX's shared service-constructor cache cannot select another client's mode or gateway. Local workerd tests cover all three pinned SDKs, multiple gateway destinations, ordinary default clients, different cache initialization orders and repeated invocations. These controlled local tests do not add a new deployed-cloud certification.

Controlled Commit-response-loss tests apply a mutation, withhold the response and reach a deadline. A later SDK Rollback does not prove that a committed write was undone. Controlled workerd shared tests buffer finite responses; the resilience gate checks cancellation of interrupted loopback responses.

Repeated local workerd fault waves verify concurrent calls, slow streams, deadlines, cancellation, message limits, client reuse and adapter-visible resource cleanup in both modes. The loopback server observes interrupted response closure before runtime disposal. These are finite regression tests, not sustained traffic, total memory measurements or production recovery certification.

Official Firestore 1.22.0 Native and Datastore modes run through real Envoy locally. These tests cover the explicitly asserted data, query, stream and error behavior. Emulator results do not establish production IAM, composite-index requirements, quotas or transaction concurrency. Secret Manager still uses a controlled server. The emulator-only synthetic owner header is injected by local Envoy and is not authentication evidence.

Controlled Secret Manager tests cover pagination, async-iterator early exit, binary and empty secret-version payloads, callback/Promise results and remote errors. The pinned SDK returns `dataCrc32c` without validating it; consumers must verify payload integrity themselves. The fixture checks a deliberately incorrect checksum at the consumer boundary. It does not read production secret versions or establish live Secret Manager behavior.

## Unsupported features

Client streaming, bidirectional RPCs, server APIs, Firestore Listen/Watch, compression, custom certificate authorities, inline TLS client certificates, connection pools, keepalive, load balancing, adapter retries, remote health checks, channelz and arbitrary resolver schemes are unsupported. `waitForReady()` cannot report a ready connection. Parent-call propagation and `WriteThrough` are also unsupported.

Preconfigured Workers mTLS and HTTP service bindings can be selected using the transport's `fetcher` option. Local workerd tests verify actual service-binding dispatch, receiver preservation and client isolation. They do not verify an mTLS handshake or deployed binding/conversion behavior; see [Fetchers](fetcher.md).

## Intentional differences

- Per-message transport ceilings default to 32 MiB. A channel limit of `-1` does not remove them.
- Transport lookahead is one message; upstream Readable buffering and Fetch allocations are additional memory.
- `getPeer()` returns the logical URL rather than a remote IP. `getAuthContext()` returns null, and the channelz reference is an unregistered placeholder.
- Invocation-transformed arguments and interceptor-modified method definitions reach the transport. Vendor patches record these upstream differences.
- User callback exceptions are rethrown in a microtask. Complete upstream exception-timing equivalence is unverified.
- HTTPS credentials use Fetch TLS. Modern Google header providers and the pinned grpc-js legacy `getRequestMetadata(url, callback)` form are supported; this does not imply compatibility with every historical auth library.

## Datastore query streams

Datastore `runQueryStream()` chains unary `RunQuery` pages. In the pinned SDK, `destroy()` stops entity delivery but can continue requesting later pages. This also occurs with native grpc-js. Use the SDK's `end()` method to stop pagination:

```js
const stream = datastore.runQueryStream(query, { gaxOptions: { timeout: 5_000 } });
stream.on('error', handleError);
stream.on('data', entity => {
  if (!consume(entity)) stream.end();
});
```

`end()` prevents new pages after the current one. Neither `end()` nor `destroy()` exposes cancellation of a unary page already in flight; its deadline still matters, and SDK `info` events may arrive afterward. Controlled native/Node-adapter/workerd comparisons verify complete pagination, stopping on the first entity, stopping while a second page is held, and successful reuse. Official emulator coverage remains limited to a single page for early destruction. These tests do not claim that stopping this SDK stream cancels native HTTP/2 or releases an in-flight RPC immediately.
