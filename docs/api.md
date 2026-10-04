# API reference

This document describes the current prototype, not the complete v0.3 design. Generated `dist/*.d.ts` declarations provide the exact signatures after `npm run build`. Examples using `@grpc/grpc-js` assume that name resolves to this adapter through the consumer's dependency configuration.

The optional `/sdk` entry exposes `cancellableCall()` and
`cancellableQueryStream()` for operation-scoped SDK cancellation. See
[SDK cancellation](sdk-cancellation.md) for Promise handles, `AbortSignal`, query
iterator cleanup, option conflicts and the distinction between cancellation and
rollback.

## Client exports

The root exports `Client`, `Channel`, `Metadata`, `ChannelCredentials`, `CallCredentials`, `credentials`, `status`, `connectivityState`, `compressionAlgorithms`, `propagate`, `makeGenericClientConstructor`, `makeClientConstructor`, `loadPackageDefinition`, `closeClient`, `getClientChannel` and `waitForClientReady`.

`Client.makeUnaryRequest()` supports callback-only, metadata, options, and metadata-plus-options overloads. `makeServerStreamRequest()` returns a Node Readable. `makeClientStreamRequest()` and `makeBidiStreamRequest()` return Writable/Duplex call surfaces. By default they terminate asynchronously with `UNIMPLEMENTED` before authentication or network work; explicit experimental gateway request streaming enables uploads as described below.

Client interceptors, interceptor providers, `InterceptingCall`, `ListenerBuilder`, `RequesterBuilder` and `StatusBuilder` are available. Supplying both interceptors and providers for the same call is a configuration error. `Server` and `ServerCredentials` exist only to reject native server use explicitly; `waitForClientReady` and `Client.waitForReady` report unsupported readiness asynchronously. The [export and declaration contract](exports.md) classifies every pinned native and adapter root name as supported within scope, import-only, type-only, or unsupported, and documents signature differences and explicit subpaths. Matching names do not imply full native API parity.

## Metadata

`Metadata` provides `set`, `add`, `remove`, `get`, `getMap`, `clone`, `merge`, `getOptions` and `setOptions`. Binary `-bin` entries use Buffer values; other values use printable ASCII strings. Transport serialization preserves repeated entries rather than flattening them through `getMap()`.

`waitForReady: true` and `corked: true` are unsupported call options. Idempotency and cacheability hints are stored but do not enable adapter retries or caching. Duplicate authorization, CR/LF injection and transport-owned headers are rejected.

## Global configuration

Import configuration from the `/config` subpath before constructing clients. Both modes use binary gRPC-Web at the adapter's Fetch boundary, with request settings selected by mode:

| Mode | `Content-Type` and `Accept` | Fetch `cf.grpcWeb` |
|---|---|---|
| `cloudflare` | `application/grpc-web` | `convert` |
| `grpc-web` | `application/grpc-web+proto` | `passthrough` |

Both binary response content types are accepted. The protobuf framing is the same in either mode.

### Cloudflare automatic outgoing conversion

`cloudflare` is the default mode. It sends to the logical service's HTTPS origin without an endpoint map:

```ts
import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'cloudflare',
  defaultTimeoutMs: 30_000,
});

const client = new Client('datastore.googleapis.com:443', credentials.createSsl());
```

For example, `/google.datastore.v1.Datastore/Lookup` targets `https://datastore.googleapis.com/google.datastore.v1.Datastore/Lookup`. The example constructs the transport client; a real RPC also needs its method codecs and service credentials.

Enable Node compatibility in the deployed Worker's Wrangler configuration:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

The adapter explicitly sets Cloudflare's [per-request `cf.grpcWeb` control](https://github.com/cloudflare/workerd/blob/f4ebbae6562718e53afbc3bba0f882266bd89529/types/defines/cf.d.ts) to `convert`, so it does not require the Worker-wide `auto_grpc_convert` flag. It sends bare `application/grpc-web` to avoid the tested Google endpoints' `+proto` incompatibility. Local workerd cannot exercise the edge proxy conversion; see the [conversion diagnosis](cloudflare-conversion.md) for deployed evidence and the original failure analysis.

### Explicit gRPC-Web gateway

`grpc-web` selects an explicit trusted gateway and requires an endpoint map. The adapter sets `cf.grpcWeb: 'passthrough'`, so gRPC-Web requests reach the gateway unchanged even when the Worker's compatibility flags enable automatic conversion:

```ts
import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'grpc-web',
  endpoints: {
    'datastore.googleapis.com': 'https://gateway.example.test',
  },
  defaultTimeoutMs: 30_000,
});

const client = new Client('datastore.googleapis.com:443', credentials.createSsl());
```

The same Lookup method now targets `https://gateway.example.test/google.datastore.v1.Datastore/Lookup`. Replace the example origin with a trusted gateway that performs gRPC-Web translation; it can see credentials and protobuf payloads. The client target and authentication audience remain the logical service. Unmapped targets fail with `WGA_UNMAPPED_TARGET` instead of being sent directly.

This is an explicitly selected gateway alternative, not automatic failover. A failed call is not replayed through another mode. Neither mode uses GAX's `fallback: true` REST transport.

### Settings and configuration lifetime

`configureWorkersGrpc(config)` returns a `WorkersGrpcConfigSnapshot`. `getWorkersGrpcConfig()` returns the current snapshot without locking it or starting network work.

| Setting | Default and meaning |
|---|---|
| `mode` | `cloudflare` by default: direct HTTPS target with Cloudflare conversion; `grpc-web`: explicit gateway mapping |
| `endpoints` | Required in `grpc-web` mode: logical authority → trusted HTTPS gateway origin; rejected in `cloudflare` mode |
| `defaultTimeoutMs` | Unset; if supplied, a positive safe integer in milliseconds |
| `transportMaxSendBytes` | 32 MiB per message |
| `transportMaxReceiveBytes` | 32 MiB per message |
| `resourceLimits` | Unset: no aggregate admission/byte limits; optional shared call, queue, buffer and readable-object limits described in [Resource limits](resources.md) |
| `observer` | Unset: observation disabled; an optional callback receives immutable call and attempt events described in [Observability](observability.md) |
| `retryPolicy` | Unset: exact-method unary replay is disabled; see [Retries](retries.md) |
| `retryThrottling` | Unset: optional shared endpoint token budget; requires `retryPolicy` |
| `allowInsecureLocalhost` | `false`; permits credential-free HTTP tests only for literal `127.0.0.1` or `[::1]` in `grpc-web` mode |

These message ceilings are adapter policy, not Google or Cloudflare service limits. A smaller grpc-js channel limit takes precedence. A channel limit of `-1` removes that channel restriction but retains the transport ceiling. The default channel receive limit is 4 MiB; a GAX client that explicitly supplies `-1` uses the transport ceiling.

Configuration snapshots are immutable. Reapplying the same normalized configuration is allowed. A different second configuration throws `WGA_CONFIG_ALREADY_SET`; changing it after the first globally configured Channel throws `WGA_CONFIG_LOCKED`.

Targets accept `hostname[:port]`, not URLs, resolver schemes such as `dns:///`, user information, paths, queries or fragments. Gateway values must be origins. RPC methods use `/package.Service/Method`.

## Per-instance adapter

`createWorkersGrpcTransport(config?)` from `/adapter` returns:

- `channelCredentials`: default HTTPS channel credentials.
- `grpcOptions(existing?)`: channel options bound to the instance configuration.
- `gaxOptions(existing)`: Google SDK options bound to this transport, using the shared grpc module and `fallback: false`.
- `resourceUsage()`: current and peak admitted-call, waiting-call, and adapter-buffer reservation counts shared by this transport's clients.
- `retryUsage(target)`: a frozen retry-budget snapshot for a logical endpoint, or `undefined` when throttling is disabled.

`WorkersGrpcResourceLimits` and `WorkersGrpcResourceUsage` are exported types from `/config` and `/adapter`. Resource budgets belong to configuration snapshots: clients of one factory share them, while separate factories remain independent. See [Resource limits](resources.md) for FIFO admission, cancellation, queue defaults, and the boundary between reserved bytes and whole-Worker memory.

Instance configuration does not change the global snapshot. Existing channel overrides conflict with `grpcOptions()`. Existing `grpc`, `sslCreds`, `fallback` or channel-override settings conflict with `gaxOptions()`, including GAX's prefixed override forms. Both helpers reject options already bound to a transport instead of silently rebinding them. The generated GAX options carry the transport configuration through each client's channel creation, rather than capturing it in service constructors. This allows different SDK modes and gateway mappings in the same isolate, including clients created before or after a shared GAX cache entry. Keep the generated options intact when passing them to SDK constructors. [Local workerd tests](../scripts/test-gax-mode-isolation.cjs) exercise this with all three pinned SDKs; the historical [cloud probe](gcp-cloud-probe.md) uses separate deployments for comparison.

## Call and attempt observations

Global and per-transport configuration accept `observer: WorkersGrpcObserver`. The callback receives a `WorkersGrpcEvent` union covering call admission, authentication, Fetch, the first decoded message, retries and completion. `call-end` includes the final status, elapsed time, admission wait, attempt/Fetch counts and cumulative traffic counters. `attempt-end` provides the corresponding attempt's status, timing and counters.

`WorkersGrpcObserver`, `WorkersGrpcEvent` and `WorkersGrpcTraffic` are exported types from `/config` and `/adapter`. Callbacks run in microtasks; returned promises are not awaited, and callback exceptions or rejections do not change RPC results. Events omit metadata, credentials, payloads, method names, targets and status details. See [Observability](observability.md) for examples, precise byte-counter semantics and delivery limits.

## Credentials

`credentials.createSsl()` uses Fetch TLS. Certificate buffers, custom certificate authorities and TLS verification callbacks are unsupported. Explicit Google environment requirements (`GOOGLE_API_USE_CLIENT_CERTIFICATE=true` or `GOOGLE_API_USE_MTLS_ENDPOINT=always`) also reject with `WGA_UNSUPPORTED_TLS`; they cannot silently enable native certificate discovery. Configure `fetcher: env.MTLS_BINDING` on the transport to use a preconfigured Workers mTLS binding; HTTP service bindings and other trusted Fetchers use the same option. The selected method and receiver are captured per transport. See [custom Fetchers](fetcher.md) for setup, isolation and verification boundaries. `createInsecure()` is limited by the explicit local-test routing policy; credentials cannot be sent over that route.

`createFromGoogleCredential()` accepts an object whose `getRequestHeaders()` returns headers synchronously or as a Promise, or the legacy `getRequestMetadata(url, callback)` form. The legacy callback receives `(error, headers)`, where `headers` is a string-valued object; an empty object is valid. The modern method takes precedence when both exist. `GoogleCredential` and `LegacyGoogleCredential` describe these two forms. `createEmpty()` produces empty call credentials.

Metadata generators use callbacks. The first callback wins; a rejected Promise returned by a generator is also handled. Composed credentials preserve input order. The authentication `service_url` identifies the logical service, not the gateway origin.

Legacy providers must invoke the callback; a returned value or fulfilled Promise cannot substitute for it. Only their own string-valued header entries are used, and invalid or missing header objects fail authentication. If both Google methods exist, a failed modern method does not fall back to the legacy provider.

The adapter delegates token acquisition to the supplied Google auth client. With the pinned Worker build preset, local tests exercise URL-sourced external-account credentials, optional service-account impersonation and standalone `Impersonated` clients. The Secret Manager SDK's explicit `credentials` JSON option also works in those controlled tests. This does not add automatic ADC discovery or configure external issuers and IAM grants. See [authentication verification](testing.md#native-sdk-comparisons) for the exact scope.

## Failure semantics

| Condition | gRPC status |
|---|---|
| Local cancellation | `CANCELLED` |
| Expired deadline | `DEADLINE_EXCEEDED` |
| Network failure or channel close | `UNAVAILABLE` |
| Truncated frame or invalid metadata | `INTERNAL` |
| Message or metadata budget exceeded | `RESOURCE_EXHAUSTED` |
| Unsupported RPC or compression algorithm | `UNIMPLEMENTED` |
| HTTP 200 without gRPC status | `UNKNOWN` |
| Authentication failure | Preserves permitted explicit codes; absent codes become `UNKNOWN`, invalid control-plane codes become `INTERNAL` |

Fetch redirects use `manual` mode and are not followed. Local error details use bounded `WGA_*` diagnostics. Callback results and status events remain distinct parts of the call surface.

## Build-time SDK support

The Node-only `/build` subpath exports `createGoogleWorkerBuild({ projectRoot, outdir, profile, typescript })`. The optional profile defaults to `google-static-v1`; the installed TypeScript module is required. The returned object contains an esbuild `plugin`, a `registryFile` path and `manifest()`.

`inspectGoogleWorkerProfile({ projectRoot, profile, typescript })` returns structured package, schema and transformation diagnostics. Profiles declare exact hashes, transform rules, capabilities and required checks. Generated registry identity includes transformer bytes/version and verified inputs; see [Profile diagnostics and cache identity](profiles.md). Actual installed SDK Worker measurements are described in [SDK performance](sdk-performance.md).

Install TypeScript and esbuild as development dependencies. Keep `/build` out of Worker runtime imports. The preset rejects mismatched dependency, source or schema hashes rather than adapting arbitrary SDK versions. It also precompiles Datastore's `google/protobuf/struct.proto` path so bundled SDK modules can initialize during the first request without runtime code generation. The repository's `scripts/workers-sdk-test.cjs` and `scripts/test-workers-lazy-sdk.cjs` are executable startup and lazy-import examples.

Profile revision 3 selects `globalThis.fetch` as the pinned Gaxios transport's default inside the Worker bundle, allowing normal OAuth2Client/JWT token responses to be parsed using Workers' response headers. Gaxios's per-request and per-client `fetchImplementation` overrides retain their original precedence. The build records the transformation in its manifest; it does not mutate installed dependencies, global Fetch, or credential providers. See `scripts/test-workers-auth.cjs` for token-refresh and JWT exchange examples using synthetic credentials.

Native HTTP/2, arbitrary upstream deep imports, channelz, load balancing and remote connection health are unavailable. Connectivity reports only `IDLE` or `SHUTDOWN`; `waitForReady()` never reports a ready connection. Writes accept flags `0`, `BufferHint` (`1`), `NoCompress` (`2`) or their combination. `WriteThrough` is unsupported. `CallOptions.parent` accepts the exported structural `ParentCall` type; deadline and cancellation propagation follow `propagate_flags`. The Fetch server context can be passed directly as a parent. See [parent calls](parent-calls.md).

Message compression supports identity, deflate and gzip through `grpc.default_compression_algorithm`; identity remains the default. `NoCompress` bypasses the codec for an individual message. Decoded message limits and encoded transport ceilings are enforced independently. See [compression](compression.md) for negotiation, cancellation and native/workerd verification.

## Explicit unary retry policy

`retryPolicy` is an optional global or per-transport setting. It requires an exact
unary method list, bounded `maxAttempts`, `initialBackoffMs`, `maxBackoffMs`, and
`retryableStatusCodes`. Fetch exceptions additionally require `retryOnFetchError`.
The adapter never replays a call after receiving a message. See [retries](retries.md)
for commitment semantics, credential refresh, pushback and SDK retry interactions.

`retryThrottling: { maxTokens, tokenRatio }` optionally shares an overload budget
between a transport's clients for the same logical endpoint. Failed eligible
attempts reduce tokens, successful RPCs restore them, and first attempts remain
allowed. `retryUsage(target)` and `retry-throttled` observer events expose local
decisions. Separate transport factories keep independent budgets.

## Optional structured errors

`@grpc/grpc-js/status-details` exports `decodeGrpcStatusDetails(statusOrError, options?)`.
It decodes bounded `google.rpc.Status` envelopes and optionally invokes exact-URL
detail decoders. Missing, malformed or mismatched rich status preserves the
original object and code. See [Structured status details](status-details.md).

## Application health

The root module exports `HealthClient`, `HealthWatch` and `HealthServingStatus`.
Wrap an existing `Client` to reuse its transport and credentials. `check()` is a
bounded unary probe; `monitor()` reconnects Watch and exposes `waitForServing()`.
Close monitors within the Worker lifetime. See [health](health.md).

## Fetch server endpoint

`@grpc/grpc-js/server` exports `createGrpcWebHandler` and `GrpcWebServerError`.
Handlers consume ordinary method definitions and expose a `Request` → `Response`
endpoint for binary gRPC-Web unary, server-streaming, client-streaming and bidi methods.
Request-streaming handlers receive a lazy `AsyncIterable`; literal method flags
select narrower request/response handler types. The root native
`Server` and `ServerCredentials` stubs still reject construction. See [server](server.md).

## Additional SDK build profile

`createGoogleWorkerBuild({ projectRoot, outdir, typescript, profile: 'google-modern-v1' })`
selects the separate exact Datastore 11.1.0 / Firestore 9.2.0 / Secret Manager 7.1.0
graph. The default remains `google-static-v1`. Source/schema hashes are enforced
for either profile. See [modern SDKs](modern-sdk.md) for its pinned auth versions and
the two Firestore native defaults accepted as inert Fetch hints.

## Experimental gateway request streaming

`experimentalRequestStreaming: true` is accepted only with `mode: 'grpc-web'`.
It activates ordinary generated client-streaming and bidirectional Writable/Duplex
methods. The default remains disabled. Each message retains its own size/codec
limits; half-close ends the Fetch body, and no streaming call is retried. Honor
Writable backpressure and supply a deadline. See [request streaming](request-streaming.md)
for early server rejection behavior and the tested gateway boundary.

Firestore 8.3.0 and 9.2.0 `DocumentReference.onSnapshot()` and `Query.onSnapshot()` are
verified through the experimental gateway path. SDK listener lifetime is owned
by the application: install an error callback, unsubscribe before leaving the
Worker lifetime, then terminate the client. See [Firestore listeners](firestore-watch.md).

The `google-static-v1` revision 4 and `google-modern-v1` revision 2 presets also
preserve Firestore Listen terminal errors before EOF reaches Watch. This guarded
build transformation changes only Listen stream completion and records
`firestoreWatchEndDeferrals: 1` in its manifest. Direct Node SDK consumers without
the preset retain upstream event ordering. See [Firestore Watch](firestore-watch.md)
for the exact scope and regression evidence.
