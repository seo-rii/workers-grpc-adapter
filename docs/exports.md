# Export and declaration contract

The root API is a scoped client replacement derived from `@grpc/grpc-js` 1.14.0
sources and compared against the pinned native 1.14.5 package.
It does not provide every native export, and matching function declarations do
not establish identical transport behavior. The reviewed
[export policy](https://github.com/seo-rii/workers-grpc-adapter/blob/main/compatibility/export-policy.json)
classifies the complete union of native and adapter root declaration names. The
tracked
[public declaration snapshot](https://github.com/seo-rii/workers-grpc-adapter/blob/main/compatibility/public-api.snapshot.json)
records the reviewed declarations and consumer imports. Running the contract gate
also generates `compatibility/exports-contract.json` locally as a verification
artifact; that report is not checked into Git.

There are 95 native root declaration names and 83 adapter names: 55 common,
40 native-only, and 28 adapter-only, for 123 reviewed names. The adapter has
27 runtime root exports and 56 type-only root exports. These are inventory
counts, not a compatibility percentage or a count of implemented features.

| Grade | Meaning | Root names |
| --- | --- | --- |
| S | Supported within the entry's explicit runtime and signature scope. | 24 |
| I | Importable placeholder whose supported entry operation fails explicitly. | 3 |
| T | Type-only declaration; its presence does not promise a runtime implementation. | 56 |
| U | Native name is absent from the adapter root, including unsupported native types. | 40 |

Each policy row contains its own behavioral scope and signature notes. An `S`
class can have unsupported native methods, documented below and in its row.
For example, `Client` supports RPC methods but not connection readiness. A `T`
call-surface type describes values returned by supported client methods; it is
not an importable constructor. `ChannelInterface` is explicitly exported with
`export type`, even though its alias target is the runtime `Channel` class.

## Supported root runtime surface

| Exports | Supported scope and limits |
| --- | --- |
| `Client` | Callback/stream methods over Fetch, client interceptors, close, and logical channel access. Unary and server streaming are enabled normally; client/bidi streaming require the explicit experimental gateway option. |
| `Channel` | Logical target, routing, credentials, active calls, and close. No native socket, physical connection pool, or readiness state machine. |
| `Metadata` | Native mutation, repetition, clone/merge, options, opaque values, and header conversion helpers, with adapter transport validation. |
| `ChannelCredentials`, `CallCredentials`, `credentials` | Fetch HTTPS, controlled credential-free localhost tests, metadata factories and composition. Certificate/socket APIs are restricted or absent as detailed below. |
| `InterceptingCall`, `InterceptorConfigurationError`, `ListenerBuilder`, `RequesterBuilder` | Client interceptor signatures with patched asynchronous ordering and terminal cleanup. |
| `StatusBuilder` | Fluent creation of partial status objects without inventing missing fields. |
| `makeClientConstructor`, `makeGenericClientConstructor`, `loadPackageDefinition` | Generated client methods, original-name aliases, service metadata, and preloaded protobuf definition trees. |
| `closeClient`, `getClientChannel` | Client helpers preserving the owned channel's identity. |
| `status`, `connectivityState`, `compressionAlgorithms`, `propagate` | Pinned native enum names, numeric values, and reverse mappings. Exported constants do not enable unsupported native behavior. |
| `HealthClient`, `HealthWatch`, `HealthServingStatus` | Adapter application-health extensions for grpc.health.v1 Check/Watch. These are not native channel health checks. |
| `WorkersGrpcConfigurationError` | Adapter configuration failure with a string diagnostic code; distinct from numeric gRPC `ServiceError`. |

## Deliberate declaration and behavior differences

The vendored `Client` preserves four unary and client-stream overloads and two
server-stream and bidi overloads, including `Buffer` codecs, optional
metadata/options, nullable callback errors, and typed call surfaces. Its nested
channel and credential types refer to adapter implementations. Request streaming
returns an asynchronous `UNIMPLEMENTED` result by default; enable it only through
the [gateway request-streaming configuration](https://github.com/seo-rii/workers-grpc-adapter/blob/main/docs/request-streaming.md). The recorded
duplicate-unary-response difference remains: this adapter rejects the second
message with status 12, while the pinned native comparison reaches deadline 4.
See [client compatibility contracts](local-contracts.md).

`Channel` constructor options and `getConnectivityState`'s boolean are optional
in the adapter declaration. Connectivity reports only `IDLE` or `SHUTDOWN`;
`watchConnectivityState` fails asynchronously. `getChannelzRef` returns an
unregistered sentinel. Native five-argument `createCall` is replaced by
`createCall(): never`, which throws `WGA_METHOD_CONTEXT_REQUIRED`. The declared
`createCallForMethod`, `createCallLifetime`, `getReadQueueLimit`, and
`activeCallCount` methods are adapter bridges and diagnostics. They are not
native extension points. `ChannelInterface` is a type alias to this concrete
class, including its private identity, rather than the native structural
interface. Channel overrides must be actual adapter channels.

`ChannelOptions` exposes a narrower named option set and an `unknown` index
signature. Runtime validation still rejects unsupported keys and values. Native
retries and channelz can only be disabled; exact pinned SDK reconnect, flow
window, and subchannel-pool defaults are accepted as inert hints. Authority
options cannot redirect a call. Adapter retry settings belong to `/config`, not
native `ServiceConfig` or `RetryPolicy` types.

`CallOptions.parent` is `ParentCall | null`, replacing the native union of server
call types with a structural deadline/cancellation contract usable by the Fetch
server context. The `propagate` numeric map is preserved; legacy Census bits do
not implement tracing or statistics context propagation. `getPeer()` identifies
the logical service, and Fetch calls return `null` from `getAuthContext()`.

Both credential classes are concrete with private constructors, rather than
the extensible native abstract classes. Their `_equals` methods are absent.
`ChannelCredentials` also omits `_createSecureConnector` and
`createFromSecureContext`; the latter is absent from `credentials` too.
`createSsl` keeps the certificate argument positions but accepts only omitted
or null arguments. Its `verifyOptions` is typed `unknown`; every non-null value
fails with `WGA_UNSUPPORTED_TLS`. Preconfigured binding mTLS uses the separate
[Fetcher configuration](https://github.com/seo-rii/workers-grpc-adapter/blob/main/docs/fetcher.md).

Google credential conversion is available through
`credentials.createFromGoogleCredential`; the native static
`CallCredentials.createFromGoogleCredential` is absent. Adapter
`GoogleCredential` accepts modern `Headers`, synchronous header results, or
Promises, and `LegacyGoogleCredential` preserves the callback form. The native
root `OAuth2Client` alias is absent. `credentials.combineCallCredentials` also
accepts zero inputs and returns empty credentials, whereas the native signature
requires the first credential.

`Metadata.entries()` is an adapter addition preserving repeated values during
transport iteration. Declared HTTP/2 header helpers do not load a native
transport. `MetadataOptions` preserves native booleans, but sending
`waitForReady: true` or `corked: true` fails; idempotency/cacheability hints do not
enable retries or caching. `InterceptingCall.disposePending()` and optional
`InterceptingCallInterface.disposePending()` are adapter cleanup additions.

## Import-only failures

| Export | Explicit failure contract |
| --- | --- |
| `Server` | `new Server(...unknown[])` throws `WGA_SERVER_UNSUPPORTED`. Native bind/start/service/shutdown methods are absent. |
| `ServerCredentials` | `createInsecure(): never` and `createSsl(...unknown[]): never` throw `WGA_SERVER_UNSUPPORTED`. Unlike the native abstract class, its implicit zero-argument constructor creates only an inert placeholder, without native credential methods or TLS functionality. |
| `waitForClientReady` | Preserves the client/deadline/callback signature and asynchronously returns an error with code `UNIMPLEMENTED` and message `WGA_CONNECTIVITY_UNSUPPORTED`, without starting network work. |

`Client.waitForReady` has the same failure behavior. Neither helper reports
success or estimates remote availability from a Fetch call. The separate
[`/server` entry](server.md) implements Fetch handlers for all four RPC shapes;
it does not make these native server placeholders usable.

## Type-only and absent names

The policy enumerates every type name separately, including callback optionality,
the `Buffer` codec boundary, stream intersections, mapped service definitions,
and interceptor continuation shapes. Common client types retain the corresponding
native shapes within the channel, credentials, parent, and option restrictions
above. Adapter-only type exports include health contracts, `ParentCall`, Google
credential forms, individual interceptor callbacks, `PackageDefinition`,
`ServiceClient`, `ClientMethodDefinition`, `AuthContext`, and `UnaryCallback`.

The adapter also retains the root type export `InterceptingCallInterface` from
its original client API. Native grpc-js 1.14.5 no longer exports that name from
the root, while its public `NextCall` still returns the same downstream
interface. Shared consumers use `ReturnType<NextCall>` to obtain that interface
without relying on the removed native root export. The adapter export remains
available, including its optional cleanup hook.

All 40 native-only names are graded `U`; an unavailable native type is not
relabeled `T` merely because it would disappear from emitted JavaScript.

| Absent family | Root names |
| --- | --- |
| Native server calls and handlers | `ConnectionInjector`, `ServerOptions`, `KeyCertPair`, `ServerUnaryCall`, `ServerReadableStream`, `ServerWritableStream`, `ServerDuplexStream`, `ServerErrorResponse`, `sendUnaryData`, `handleUnaryCall`, `handleClientStreamingCall`, `handleServerStreamingCall`, `handleBidiStreamingCall`, `UntypedHandleCall`, `UntypedServiceImplementation` |
| Native server interceptors and metrics | `ServerListener`, `FullServerListener`, `ServerListenerBuilder`, `Responder`, `FullResponder`, `ResponderBuilder`, `ServerInterceptingCallInterface`, `ServerInterceptingCall`, `ServerInterceptor`, `ServerMetricRecorder` |
| Native service configuration and TLS types | `ServiceConfig`, `MethodConfig`, `LoadBalancingConfig`, `RetryPolicy`, `VerifyOptions`, `OAuth2Client` |
| Native administration and transport extensions | `getChannelzHandlers`, `getChannelzServiceDefinition`, `addAdminServicesToServer`, `experimental` |
| Legacy loading and logging | `load`, `loadObject`, `logVerbosity`, `setLogger`, `setLogVerbosity` |

## Explicit package subpaths

| Entry | Contract |
| --- | --- |
| `/config` | Global configuration and adapter resource, observer, retry, and Fetcher types. |
| `/adapter` | Per-instance transport factory and isolated shared budgets. |
| `/server` | Typed Fetch gRPC-Web handlers, lazy request streams, context, and explicit server errors. |
| `/status-details` | Bounded optional rich-status decoding that preserves the original status object. |
| `/sdk` | Scoped Promise cancellation and Datastore query-stream cleanup; optional helpers that preserve shared-client isolation and do not roll back accepted writes. |
| `/build` | Node-only exact-profile SDK build plugin and diagnostics; excluded from Worker runtime imports. |
| `/build/src/client`, `/build/src/client.js` | Explicit aliases of the same client module, preserving root constructor/helper identity. Also expose `callErrorFromStatus` and the type-only `SurfaceCall`; readiness still fails as described above. |
| `/package.json` | Package metadata. |

Other upstream deep paths are not exported. These eight declaration-bearing
subpaths are also snapshotted; adding an extension does not claim native root
parity. Mixed ESM/CommonJS imports share implementation and configuration
identity.

## Reviewing changes

`npm run test:contract` derives the inventory from the installed pinned native
package and the built adapter declarations. It checks the reviewed policy,
declaration snapshot, runtime names, and CommonJS/ESM identity. Both root names
and declared public subpaths are covered. The source snapshot records signatures
instead of treating matching export names as proof that signatures match.

The gate also inventories imports in the four installed SDK consumer fixtures.
Named imports, literal namespace member access, and type-only references are
recorded separately. Dynamic member access and namespaces passed to other code
remain explicit unresolved uses; the scanner does not claim exhaustive static
resolution of every possible runtime access. Executable SDK and type checks
remain necessary for those boundaries.

A declaration change requires reviewing its exact signature and behavioral
scope and updating the policy when necessary. To refresh a reviewed snapshot:

```sh
npm run build
node scripts/test-contract.cjs --update
git diff -- compatibility/public-api.snapshot.json compatibility/export-policy.json
npm run test:contract
```

Inspect the snapshot and policy diff before accepting it. The default
`npm run test:contract` compares the existing snapshot and never accepts drift
by rewriting it. This gate detects API drift; it does not replace overload type
checks, runtime compatibility tests, workerd verification, or deployed evidence.
