# Architecture

The adapter preserves a selected grpc-js client surface while replacing its native transport with binary gRPC-Web over Fetch. It is a prototype; see [limitations](limitations.md) for the compatibility boundary.

## Request path

```mermaid
flowchart TD
    SDK[SDK or generated client] --> Alias["@grpc/grpc-js alias and root override"]
    Alias --> Client[Vendored client, factory, interceptors and Metadata]
    Client --> Channel[Workers Channel]
    Channel --> Call[Call lifecycle and authentication]
    Call --> Wire[Binary gRPC-Web framing]
    Wire --> Fetch[Fetch]
    Fetch -->|"cloudflare: service HTTPS origin"| Cloudflare[Cloudflare automatic outgoing conversion]
    Fetch -->|"grpc-web: mapped HTTPS origin"| Gateway[Explicit trusted gRPC-Web gateway]
    Cloudflare --> Server[Native gRPC service]
    Gateway --> Server
```

Both configuration modes share the same binary gRPC-Web encoder, decoder, credentials, and call lifecycle. The routing decision changes the Fetch origin: `cloudflare` uses the logical target directly and `grpc-web` resolves it through `endpoints`. The RPC method path is unchanged. Authentication identifies the logical service in either mode.

`cloudflare` is the default and accepts no endpoint map. It sets `cf.grpcWeb: 'convert'` on each Fetch and sends binary `application/grpc-web` in both `Content-Type` and `Accept`. These request settings enable edge translation without a Worker-wide `auto_grpc_convert` flag and avoid the tested Google endpoints' `+proto` incompatibility. See the [deployment configuration](api.md#cloudflare-automatic-outgoing-conversion) and [conversion diagnosis](cloudflare-conversion.md).

`grpc-web` requires explicit trusted gateway mappings and rejects unmapped targets. It sends binary `application/grpc-web+proto` with `cf.grpcWeb: 'passthrough'`, overriding any deployment-wide conversion default so that the mapped gateway receives gRPC-Web. It is the selected gateway alternative when direct Cloudflare conversion is unavailable. Neither mode performs capability probing, automatic failover, or replay through another origin, and neither uses GAX's REST fallback. An SDK retry creates a new adapter call under its configured mode.

Local workerd checks exercise the adapter's request behavior, while Envoy and emulator tests exercise a real gateway. They do not exercise Cloudflare's edge conversion: the [official flag definition](https://github.com/cloudflare/workerd/blob/f4ebbae6562718e53afbc3bba0f882266bd89529/src/workerd/io/compatibility-date.capnp) marks it as a proxy feature with no effect in standalone workerd. Both modes are implemented in the adapter; deployed Cloudflare conversion remains a separate verification gate. See the [configuration examples](api.md#global-configuration).

The client core comes from the npm artifact `@grpc/grpc-js@1.14.0`. [UPSTREAM.json](../vendor/UPSTREAM.json) records its integrity, commit, file hashes and patches. `node vendor/verify.cjs` checks both original bytes and patch reproduction. Native channel, resolver and server implementations are excluded from the runtime graph.

## Modules

All paths below are relative to `src/`.

| Module | Responsibility |
|---|---|
| `index.ts` | Client/health exports and explicit failures for native server sockets |
| `factory.ts` | Generated constructors, package definitions and original-name aliases |
| `client.ts`, `call-surface.ts` | Upstream overloads, callbacks, streams and invocation transforms |
| `client-interceptors.ts` | Interceptor order, asynchronous listeners, serialization and final call options |
| `channel.ts` | Target/configuration/credentials, active calls and channel closure |
| `call.ts` | Authentication, Fetch attempts, deadlines, cancellation and terminal cleanup |
| `wire.ts` | Incremental frame parsing, length checks, trailers and metadata |
| `compression.ts` | Bounded identity/gzip/deflate message transforms |
| `retry.ts` | Exact-method unary replay policy and bounded backoff |
| `health.ts` | Standard remote health checks and reconnecting Watch |
| `request-stream.ts` | Experimental gateway upload body with one pending frame |
| `server.ts` | Separate Fetch-native unary/server-streaming endpoints |
| `credentials.ts` | Credential composition and Google `getRequestHeaders()` integration |
| `config-internal.ts` | Configuration validation, immutable snapshots and canonical routing |
| `config.ts` | Public configuration exports |
| `options.ts` | Supported channel options and explicit rejection rules |
| `adapter.ts` | Optional configuration scoped to a client instance |
| `build/` | Node-only SDK profile validation, protobuf code generation and Gaxios native-Fetch default selection |

## Call lifecycle

A call progresses through `start → prepare authentication/request → halfClose → fetch → consume frames → terminal`. Authentication and the request can become ready independently. Experimental gateway request streaming starts Fetch once authentication is ready and writes frames until half-close; it does not wait for the whole request. Its callback means Fetch accepted a frame, not that a socket flushed it. Once a terminal result is chosen, late authentication or Fetch completion cannot start another request.

`finishObject()` records terminal state before notifying listeners. It clears timers, request buffers and pending reader demand. By default the adapter makes at most one data Fetch attempt per Call. An explicit retry policy can replay listed unary methods before the first response message, within the same deadline. Every attempt refreshes credential metadata and obtains a new body. SDK retries still create separate Calls and may multiply the adapter policy; see [retries](retries.md).

The decoder consumes the current Fetch chunk and frame instead of assembling the whole response. The transport can read one message ahead. The upstream object-mode Readable buffer and the Fetch implementation's allocations are additional buffers, so this is not a bound on total process memory.

Long deadlines use timer intervals no greater than `2^31 − 1` milliseconds. An explicit infinite deadline is preserved rather than replaced with the configured default. This timer does not cover all SDK initialization before the Call exists.

## Module identity

`dist/*.js` contains the CommonJS implementation; `.mjs` wrappers re-export its objects. This keeps `Metadata`, credentials, `Client` and global configuration shared between Node import and require consumers. Mixed-module identity is tested through the actual tarball. A general identity guarantee across arbitrary Workers bundlers remains unverified.

GAX receives the same grpc module for every transport instance. Each client's options carry an opaque configuration reference through GAX to the adapter channel. The channel consumes it before ordinary option validation. Generated service constructors therefore remain independent of transport configuration, and GAX's constructor cache can be shared without retaining another client's routing settings.

## Errors and the upstream boundary

The transport preserves remote gRPC status and details. It does not copy arbitrary network or authentication exception text into public details. Exceptions thrown by user callbacks are rethrown in a microtask rather than converted into transport errors; complete equivalence with upstream exception timing is still unverified.

`channel.createCallForMethod()` receives the final method definition and call options. It removes already-consumed interceptor options, composes credentials once, and distinguishes an absent deadline from an explicit infinite deadline. Patches also make transformed arguments and interceptor-modified method definitions reach the transport. These differences remain recorded in `vendor/patches/`.

Local native-client comparisons produce `verification/native-differential.json`. See [testing](testing.md) for generation commands and CI artifacts.

## Platform-owned behavior

A trusted Fetcher can select a preconfigured service or mTLS binding per transport.
The adapter snapshots the method and receiver; credentials continue to identify the
logical service. Fetch owns TLS trust, physical connections, pooling and HTTP/2
flow control, so these are not exposed as native grpc-js configuration.

Health monitors operate through ordinary RPCs and do not turn Fetch into a channel
with observable READY connectivity. The separate `./server` endpoint accepts
binary gRPC-Web requests; applications supply routing and authentication.

Both SDK build profiles validate exact source/schema hashes. The modern profile
additionally preserves precompiled Datastore legacy codecs and converts their
Uint8Array output to Buffer before base64 encoding. Existing profile transforms
remain unchanged; dependency graphs require their own checked profile.
