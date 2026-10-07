# Limitations and compatibility status

This is an experimental prototype. The package remains `private: true`. Passing local tests does not establish a complete grpc-js replacement or production readiness.

## Remaining release gates

- Sustained production traffic, resource budgets, quotas and recovery. Finite direct and gateway Google SDK deployment results are recorded separately in the [GCP probe](gcp-cloud-probe.md); those runs do not establish long-running reliability.
- Live service-account OAuth/JWT refresh, issuer/STS/IAM behavior for federation and impersonation, IAM and quota errors, and automatic ADC discovery.
- Production transaction conflicts and uncertain Commit outcomes under real network failures.
- All 189 original planned cases, full public grpc-js API and exception-timing equivalence, and production performance budgets.

The [public client contract suite](local-contracts.md) closes the configuration
and type cases and 15 public API cases against their stated local requirements.
Unary duplicate-response parity (`API-011`) remains partial: the pinned native
client reaches its deadline after the first message, while the adapter promptly
rejects the extra message. The suite retains both traces and an independent
HTTP/2 control instead of claiming equivalent cardinality behavior.

The checked-in `compatibility/test-evidence.json` maps each original case to reviewed evidence. A verification run produces `verification/evidence.json`, distinguishing full, partial and missing coverage. Local test counts and supplemental scenarios do not increase the original catalog's denominator. See [testing](testing.md) for reports and CI artifacts.

## Transport modes and verification

Both `cloudflare` and `grpc-web` modes are implemented. They send binary gRPC-Web from the Worker; neither provides raw HTTP/2 gRPC inside the Worker.

- `cloudflare` is the default. It sends directly to the logical service's HTTPS origin using binary `application/grpc-web` and explicitly requests conversion with `cf.grpcWeb: 'convert'`. No Worker-wide `auto_grpc_convert` flag is required. Conversion runs at Cloudflare's edge proxy, outside local workerd.
- `grpc-web` requires a map from logical service authorities to trusted gateway origins. It sends `application/grpc-web+proto` with `cf.grpcWeb: 'passthrough'`, preserving gRPC-Web even when a Worker-wide flag enables conversion. Local Envoy and official emulator integrations verify this gateway path. A native gRPC endpoint without a translation layer does not accept the adapter's wire protocol.

Local routing and framing checks do not prove Cloudflare's platform conversion or production Google service behavior. There is no automatic capability detection, route failover, or replay of a failed call through another mode. The gateway alternative must be selected explicitly before constructing a client. Neither mode switches to GAX's REST fallback. See [API configuration](api.md#global-configuration) for both examples.

## What local verification establishes

The client, factory, interceptor, Metadata and call surfaces derive from grpc-js 1.14.0. Tests check provenance, builds, selected root/deep module identities and representative native event behavior. They do not cover every upstream API interaction.

Pinned Google SDKs run against controlled local gRPC servers and official database emulators. Native grpc-js, the Node adapter and workerd use identical shared business code. Reports compare source hashes, assertions and RPC observations. Strict Node16, NodeNext and Bundler declaration checks use the pinned dependency graph, including the targeted Google auth 10.9.1 override.

The Node-only build preset supports two exact SDK/GAX/protobuf graphs: `google-static-v1` and `google-modern-v1`. The modern graph adds Datastore 11.1.0 and Firestore 9.2.0 with their extracted API packages; see [modern SDKs](modern-sdk.md). It does not infer transformations for other versions. Worker tooling is locked, including the Miniflare alpha used by the installed Wrangler; reports identify the actual versions and compatibility date.

The pinned build profile supports SDK imports during startup and bundled dynamic imports during the first request. It generates Datastore's well-known `Struct` codecs at build time, including the codecs used to decode query explain metrics. Arbitrary SDK versions, unknown protobuf schemas and unbundled dynamic module loading remain outside this profile.

The profile also selects Workers' native Fetch for the pinned Gaxios default transport. Without this transformation, its Node fallback can lose response headers and fail to parse OAuth token responses in workerd. Explicit caller-supplied fetch implementations keep precedence. Local workerd tests exercise real OAuth/JWT refresh and exchange, credential isolation, cancellation/deadlines during refresh and recovery after rejection; they use controlled token endpoints and do not establish live Google authentication behavior.

URL-sourced external-account credentials, chained service-account impersonation and standalone `Impersonated` clients run through the pinned Google auth libraries in workerd. Tests cover text/JSON subject-token responses, STS/IAM request contents, cache reuse and forced expiry, isolated identities, denial recovery and late completion after cancellation/deadlines. The Secret Manager SDK also creates its GoogleAuth client directly from explicit external-account credential JSON. Subject tokens and endpoint responses are synthetic: real IdP trust, Google IAM permissions, AWS/Azure/executable/file credential sources and ADC environment/file/metadata discovery remain unverified. Concurrent exchange coalescing is checked for external-account clients, not standalone impersonation.

Google SDK clients can use different per-instance transport configurations in one Worker. `gaxOptions()` passes the configuration through each client's channel options, so GAX's shared service-constructor cache cannot select another client's mode or gateway. Local workerd tests cover all three pinned SDKs, multiple gateway destinations, ordinary default clients, different cache initialization orders and repeated invocations. These controlled local tests do not add a new deployed-cloud certification.

Controlled Datastore transaction tests compare both pinned SDK profiles across
native grpc-js and both adapter modes in Node/workerd. They cover transaction ID
and request isolation, commit/query/rollback results, read-only rejection,
`ABORTED`, and HTTP/2 stream resets before and after mutation application.
The pinned SDK sends Rollback after high-level Commit errors; it cannot undo an
already committed write. A failed response therefore does not establish whether
the write was applied. Follow-up reads in the controlled fixture distinguish
those outcomes without treating this as production recovery evidence.

The public `v1.DatastoreClient.commit()` and high-level `Transaction.commit()`
promises expose no cancellation handle in the pinned SDKs. The generated-v1
case verifies deadline expiry after mutation application; it does not establish
explicit caller cancellation. Its peer enforces `grpc-timeout`; local deadline
completion through a workerd service binding does not prove immediate backend
cancellation. The crossed-transaction case now checks distinct OAuth2Client
providers, SDK clients and logical targets, with actual authorization/quota
metadata matched to transaction IDs and keys. Tokens are synthetic and cached;
this establishes local credential-provider isolation, not real Google IAM,
quota enforcement or token renewal. See
[transaction tests](testing.md#datastore-transactions-and-interrupted-commit-responses)
for these coverage boundaries.

Earlier shared Commit-response-loss tests withhold a response until its deadline.
Those controlled workerd shared tests buffer finite responses; the resilience
gate checks cancellation of interrupted loopback responses.

Repeated local workerd fault waves verify concurrent calls, slow streams, deadlines, cancellation, message limits, client reuse and adapter-visible resource cleanup in both modes. The loopback server observes interrupted response closure before runtime disposal. These are finite regression tests, not sustained traffic, total memory measurements or production recovery certification.

Official Firestore 1.22.0 Native and Datastore modes run through real Envoy locally. These tests cover the explicitly asserted data, query, stream and error behavior. Emulator results do not establish production IAM, composite-index requirements, quotas or transaction concurrency. Secret Manager still uses a controlled server. The emulator-only synthetic owner header is injected by local Envoy and is not authentication evidence.

Controlled [Datastore Lookup tests](datastore-lookup.md) cover mixed found/missing/deferred rounds, get overloads, partial stream errors, bounded explicit SDK retries and per-RPC deadlines. Successful deferred rounds can continue beyond one RPC timeout; ending an SDK read stream stops later rounds but does not cancel an already pending unary Lookup. These checks use the pinned Datastore 10.1.1 graph and a controlled peer, not production Datastore storage.

Controlled Firestore read tests compare both pinned SDK profiles across native
grpc-js and both adapter modes in Node/workerd. They exercise permanent failures
after partial results and transient failures before or after results from
`BatchGetDocuments` and `RunQuery`. SDK retries are separate adapter calls; the
tests check outstanding-document lists and query cursors/read times, delivered
results, error events, recovery and resources before client termination. They
do not establish production read consistency or transaction contention.

In both pinned Firestore SDKs, destroying the public query stream stops local
delivery without canceling its underlying `RunQuery` RPC. A controlled test
holds that RPC open, completes a separate read on the same client, verifies the
original backend call is still active, then explicitly releases it and checks
cleanup. Applications must bound the RPC lifetime; local stream closure does
not establish immediate backend cancellation.

Controlled Secret Manager tests compare `GetSecret`, `ListSecrets` and
`AccessSecretVersion` across native grpc-js and both Node/workerd adapter modes.
They cover callback/Promise errors, repeated text/binary trailers, intermediate
pagination failure and reuse after failure, alongside pagination, iterator early
exit and binary/empty payloads. Retry is disabled for the error matrix; it does
not test live quota enforcement or IAM decisions. The pinned SDK returns
`dataCrc32c` without validating it; consumers must verify payload integrity
themselves. The fixture checks a deliberately incorrect checksum at the consumer
boundary. Other Secret Manager methods and production secret access require
separate verification.

## Capability boundaries after implementation

| Earlier limitation | Current support | Remaining boundary |
|---|---|---|
| Client/bidirectional streaming | Experimental explicit gateway option, bounded producer, real Envoy/workerd tests | Disabled by default; automatic edge conversion unverified; early completed errors can be delayed |
| Firestore Listen/Watch | Firestore 8.3.0 and 9.2.0 document/query listeners through the experimental gateway, official emulator/native comparison | Automatic conversion and long-lived deployed listeners unverified; bounded recovery is checked with a controlled peer |
| Server APIs | Separate Fetch handlers for all four RPC shapes, lazy request streams and handler-kind types | Native grpc-js HTTP/2 sockets and server lifecycle APIs are outside this architecture |
| mTLS | Preconfigured Workers binding through isolated Fetcher | Actual certificate exchange and deployed binding behavior require live verification |
| Custom CA / inline certificates | No Fetch trust-store or per-call PEM API | Requires a different transport or platform capability |
| Compression | Identity, deflate and gzip with decoded/wire bounds | Compressed trailers and cross-call codec negotiation cache are unsupported |
| Retries | Exact-method unary policies, bounded attempts, fresh credentials, pushback and shared endpoint throttling | No native HTTP/2 transparent retry or service-config policy equivalence |
| Health checks | Standard Check/Watch and reconnecting service monitor | Does not expose connection READY or automatically gate unrelated calls |
| Connection pooling | Platform Fetch controls connections | Native pooling, keepalive and HTTP/2 flow-control tuning are not exposed |
| SDK dependency graph | Original and modern exact profiles | Arbitrary versions still need deliberate profile work and verification |
| Emulator coverage | Real protocol and SDK behavior for asserted cases | IAM, quota, index enforcement, production contention and deployed edge behavior need independent live evidence |

These boundaries distinguish implemented features, experimental routing, missing
platform controls and verification obligations. A passing local suite does not
convert a production-only verification obligation into a solved feature.

## Unsupported features

Cloudflare automatic-mode request streaming, native grpc-js Server sockets, custom certificate authorities, inline TLS client certificates, connection pools, keepalive, load balancing, native transparent retries, automatic channel health gating, channelz and arbitrary resolver schemes are unsupported. `waitForReady()` cannot report a ready connection. `WriteThrough` is also unsupported. [Parent-call deadline and cancellation propagation](parent-calls.md) is supported in both modes, including forwarding from a Fetch handler context; this does not add native server lifecycle semantics.

Identity, deflate and gzip message codecs are implemented and compared with native grpc-js and workerd peers. Compressed trailers and cross-call peer-encoding caches remain unsupported. Configured request compression never triggers an automatic identity retry. Deployed Cloudflare conversion with compressed messages remains a separate live check; see [compression](compression.md).

Preconfigured Workers mTLS and HTTP service bindings can be selected using the transport's `fetcher` option. Local workerd tests verify actual service-binding dispatch, receiver preservation and client isolation. They do not verify an mTLS handshake or deployed binding/conversion behavior; see [Fetchers](fetcher.md).

Explicit method-scoped unary retry policies are available, with bounded attempts, fresh credentials, pushback and one logical deadline. Defaults remain one Fetch per call. SDK retries can multiply attempts; lost responses can hide committed writes. This does not implement native transparent retry or service-config retries. See [retries](retries.md).

Explicit `HealthClient.check()` and `monitor()` implement the standard remote health protocol, including Watch reconnects and `UNIMPLEMENTED` disablement. Applications can await SERVING before calls; this does not change channel READY or intercept requests automatically. See [health](health.md).

The separate `./server` entry point implements binary gRPC-Web Fetch handlers for all four RPC shapes, including lazy request decoding, bounded codecs, deadlines and cooperative cancellation. Literal method flags select handler-kind types. It does not open HTTP/2 sockets or implement the native `Server` API. Incoming edge conversion and deployment authentication remain application responsibilities. See [server](server.md).

Client-streaming and bidirectional RPCs are implemented experimentally for explicit gateway mode through `experimentalRequestStreaming: true`. Real local Envoy/workerd tests verify duplex delivery, per-message bounds, compression and cancellation. After a validated terminal status, the upload closes and response EOF is still checked. Rejection can still be delayed when Fetch has not exposed the response; deadlines/cancellation are required for bounded use. This does not certify arbitrary gateways or automatic edge conversion. See [request streaming](request-streaming.md) and [feasibility](streaming-feasibility.md).

Pinned Firestore 8.3.0 and 9.2.0 document/query `onSnapshot()` listeners are verified experimentally through the gateway with actual Listen RPCs against the official emulator. The same business code passes native, Node-adapter and workerd cases. Separate controlled-peer gates for both versions check resume-token reuse, HTTP/2 resets, target resets, filter mismatches and target denial; it is not Cloudflare automatic-mode, production authorization or long-lived deployment certification. The pinned Worker build presets also correct a Listen error/EOF ordering race: terminal permission errors reach the public error callback without reconnecting. Raw Node SDK consumers retain the upstream behavior. See [Firestore Watch](firestore-watch.md).

## Intentional differences

- Per-message transport ceilings default to 32 MiB. A channel limit of `-1` does not remove them.
- Transport lookahead is one message; upstream Readable buffering and Fetch allocations are additional memory.
- Optional [resource limits](resources.md) bound admitted/queued calls and adapter-visible buffer reservations per transport, and can reduce the Readable object queue. They do not bound total isolate memory: metadata, arbitrary protobuf objects, SDK/application state, runtime Fetch buffers and codec internals are outside the byte budget. An uncooperative Fetch retains its request-body reservation until it settles even after RPC cancellation.
- Optional [observer events](observability.md) distinguish logical calls from attempts and report local timings and cumulative traffic. They omit metadata and payloads, provide no durable export guarantee, and do not measure whole-isolate memory or prove remote completion.
- `getPeer()` returns the logical URL rather than a remote IP. `getAuthContext()` returns null, and the channelz reference is an unregistered placeholder.
- Invocation-transformed arguments and interceptor-modified method definitions reach the transport. Vendor patches record these upstream differences.
- User callback exceptions are rethrown in a microtask. Complete upstream exception-timing equivalence is unverified.

## Follow-up work from the September 2026 review

The review's request ordering, termination, metadata-budget, configuration-lock and deadline-boundary defects have regression coverage. Shared admission, buffer reservations and readable queue controls are implemented. Per-logical-call and per-attempt [observer events](observability.md) complement aggregate `resourceUsage()` diagnostics. The remaining implementation recommendations are now covered:

- [Shared retry throttling](retries.md#shared-retry-throttling) spans calls within a transport and endpoint, with recovery, isolation, diagnostics and observer events.
- [Actual SDK Worker baselines](sdk-performance.md) measure bundle size, fresh startup, first/warm/authenticated RPCs, concurrent compressed slow streams and sampled V8 heap/backing storage. Local CI ceilings detect regressions; sampled heap is not peak total isolate memory or a production capacity guarantee.
- [Declarative SDK profiles](profiles.md) include exact package/schema/source hashes, transform rules, capabilities, required checks, detailed diagnostics and transformer/input-aware generation identities.
- [Fetch-server request streaming and handler-kind types](server.md) cover lazy input, early termination and independent directions, including finite two-Worker service-binding checks.
- [Optional structured-status decoding](status-details.md) preserves original RPC status on absent, malformed, oversized or mismatched rich errors.

The production release gates above remain verification obligations. These local
implementations and finite tests do not establish IAM, quotas, live certificate
exchange, automatic edge request streaming or sustained production reliability.

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

The optional [SDK cancellation helpers](sdk-cancellation.md) address this boundary
for adapter users. `cancellableQueryStream()` stops pagination and cancels its
scoped RPC on destruction, iterator exit or abort. `cancellableCall()` adds a
cancel handle to a wrapped Promise operation, including Commit. Unwrapped SDK
methods keep their original behavior. A wrapper queue limit covers only the
wrapper's objects; SDK-owned decoded pages and prefetch buffers remain outside
that limit. Local cancellation does not establish remote cleanup or rollback.

Two-Worker service-binding integration distinguishes a local canceled call from
backend cleanup. An idle server generator may remain pending until its RPC
deadline, and bounded cleanup can require explicit `ctx.waitUntil()` lifetime
retention in the surrounding Worker. The local tests require actual cleanup
receipts before runtime disposal; they do not claim immediate remote cancellation.
See [Fetch server lifecycle](server.md#service-binding-lifecycle-boundary).
