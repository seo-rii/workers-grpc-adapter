# Public client compatibility contracts

The original catalog separates a passing test from complete evidence for a
requirement. This guide describes the local public API, configuration and type
contracts. The checked-in [case mapping](../compatibility/test-evidence.json)
records the coverage decision for each ID; the generated
`verification/evidence.json` verifies its concrete execution references.

Local verification covers all 11 configuration cases, seven type cases and 15 of the
16 API cases. `API-011` retains a concrete native divergence below. Across the
unchanged 189-case catalog, current coverage totals are maintained in the
evidence reconciliation below. The mapping retains the legacy `unimplemented`
label for cases without accepted current execution references; that label does
not mean a runtime feature is absent. Coverage counts describe requirements,
not test totals. See
the [evidence reconciliation](https://github.com/seo-rii/workers-grpc-adapter/blob/main/docs/evidence-review.md)
for the remaining conditions and the distinction from dated deployment evidence.

## Runtime API

`npm run test:api:contracts` exercises the installed adapter in Node and workerd.
The same scenarios run through both transport modes. Controlled responses keep
the request bytes, metadata, callback, status and cleanup assertions reproducible.
Selected scenarios also use the pinned native grpc-js implementation against a
real local HTTP/2 peer.

| Catalog cases | Required observations |
| --- | --- |
| `API-001`–`API-004` | Direct and factory clients, subclassing, generated aliases and real proto-loader package/message/enum descriptors. |
| `API-005`–`API-007` | Rewritten request bytes and metadata, a changed finite deadline, and transformer/interceptor order compared with native grpc-js. |
| `API-008`–`API-011` | Serialization, deserialization and unary response cardinality errors; callback and status are recorded separately. |
| `API-012`–`API-015` | Default-disabled request streams, connection readiness and native server stubs reject explicitly without authentication or Fetch. |
| `API-016` | A user callback exception remains an application exception after transport completion and resource cleanup. |

The default-disabled streaming cases do not contradict the opt-in gateway
[request-streaming API](request-streaming.md) or the separate
[Fetch server](server.md). Local workerd exercises adapter routing and protocol
handling; it does not emulate Cloudflare's deployed edge translator.

The callback-exception scenario observes the real uncaught application error:
Node runs it in a separate child process and workerd exposes it through the
runtime inspector. Transport completion and cleanup occur first. A throwing
callback can interrupt the following public `status` event; the test records
that separately from the successful transport observer result.

`API-011` remains partial. With two response messages followed by OK trailers,
the pinned native grpc-js 1.14.5 unary client delivers only the first message
internally and reaches its deadline (`DEADLINE_EXCEEDED`, 4). The adapter rejects
the extra message immediately (`UNIMPLEMENTED`, 12). The independent HTTP/2 peer
also has a successful one-message control, and a raw consuming probe verifies
both response frames, OK trailers and stream completion. This is a recorded
cardinality difference, not evidence for the original catalog's native-parity
expectation. The adapter retains its bounded rejection behavior as an explicit
versioned [behavior decision](../compatibility/behavior-decisions.json).
Waiting for the pinned native deadline would retain a malformed RPC indefinitely
when callers omit a deadline; the adapter does not reproduce that behavior.

## Call lifetime and asynchronous ownership

`npm run test:call:lifecycle` executes the same controlled-clock, credential,
Fetch and reader schedules in Node and an installed-package workerd bundle,
through both transport modes. It records each low-level write callback and
terminal result, rejects messages after termination, and checks resources before
closing the client or disposing the runtime. Each runtime and mode also runs
exactly 100 successful, 100 failed and 100 cancelled calls. The unhandled-rejection
monitor must detect a separate deliberate rejection before its zero-error
results are accepted.

The internal `WorkersCall.executionDiagnostics()` complements `diagnostics()`:

| Counter | Ownership measured |
| --- | --- |
| `activePumps` | Active transport execution, including pending Fetch and response-reader work; at most one per call. |
| `pendingWriteCallbacks` | Supplied write callbacks not yet invoked, including callbacks queued in microtasks. |
| `pendingMessages`, `pendingMessageBytes` | The single decoded message waiting for delivery demand. |
| `parserAssemblies`, `parserAssemblyBytes` | The current frame assembly, including its header and encoded payload allocations. A yielded frame remains owned until the iterator advances. |
| `runtimeChunkBytes` | The complete Fetch chunk currently retained by the decoder, including its already-consumed prefix. |

These counts are not reset merely because local status has been delivered. A
custom Fetcher ignoring abort or a fault-injected reader can still own buffers
and an active pump; tests explicitly settle that operation and then require
zero ownership. Parser bytes exclude decompression scratch, deserialized objects,
and runtime heap overhead. The existing resource budget covers its reserved
buffers separately; overlapping counters must not be summed as heap usage.

EOF arrival and terminal commitment are separate events. Closing a response
stream queues parser work; a synchronous cancel can win before that work commits
OK. The suite records both same-turn EOF/cancel orders and the control where OK
has already committed before cancellation. It also distinguishes a real late
underlying-source rejection from a deliberately wrapped reader whose exposed
read promise rejects after cancellation. These are controlled lifecycle tests,
not evidence for deployed cancellation propagation.

`LIFE-015` now satisfies the original catalog: an invalid `Date`, `NaN` or
negative infinity produces asynchronous `INVALID_ARGUMENT / WGA_INVALID_DEADLINE`
before authentication or Fetch. Finite past deadlines remain `DEADLINE_EXCEEDED`;
positive infinity remains the explicit no-deadline sentinel. The native control
still records pinned grpc-js 1.14.5 throwing `RangeError` synchronously for an
invalid Date. Satisfying the adapter's input-error contract does not claim native
exception parity.

## Flow control and public queues

`npm run test:flow:control` runs 32 adapter scenarios using the installed package
in Node and workerd, through both transport modes. A pinned native grpc-js
client provides eight corresponding observations. Five public streaming cases
and the many-frame case use an actual native grpc-js loopback server. A
demand-driven HTTP/2 bridge preserves its message bytes and remote status.
Cloudflare mode uses this local peer; it does not test the deployed translator.

The suite verifies delayed consumption of 128 messages, an explicit pause after
eight messages with no data events during the pause, cancellation with an occupied
public queue and pending transport message, and eight messages followed by
`UNAVAILABLE` without replay. A 513-message stream delivers 33,619,968 payload
bytes, exceeding the default 32 MiB transport message ceiling. Each message is
64 KiB and the adapter's configured buffer budget is 1 MiB. Every payload byte
and sequence number is checked without retaining the whole response.

The public queue is configured to one object. Pending decoded messages and
parser assemblies stay at most one, and their actual occupied states are
checked before cancellation. Runtime chunks are measured separately. In the
many-frame case the fixture deliberately coalesces a bounded native response
into one chunk containing 128 frames; it does not claim native HTTP/2 or Fetch
naturally preserves that boundary. Adapter ownership is checked before closing
clients or disposing workerd, and peer sessions are accounted for separately.

Public stream `status` and the draining of an existing Readable queue are
separate events. Both native grpc-js and the adapter can deliver already queued
data after status, including a non-OK status. Likewise, `cancel()` while paused
can retain previously queued objects until the application reads or discards
them. The suite records these objects separately from released RPC buffers.
Local workerd service bindings may also allow the backend to finish producing
after client cancellation; a locally cleaned-up call does not certify backend
cancellation propagation.

Six of the seven `FLOW-*` catalog cases are covered. `FLOW-006` retains the
native unary cardinality difference described above: exactly one `startRead()`
allows the adapter to consume trailers or reject a second message promptly,
while pinned native waits for its deadline in the duplicate-message case.
An independent HTTP/2 consuming control verifies both frames and OK trailers.

## Wire boundaries and allocation measurement

`npm run test:wire:catalog` executes 1,476 public calls using the installed
adapter: 369 vectors in each Node/workerd and transport-mode combination. The
peer supplies independently encoded bytes through a controlled Fetcher. This
checks local framing and routing, not native HTTP/2 or the deployed Cloudflare
translator. Reports record exact message lengths and SHA-256 digests, initial
and trailing metadata, callbacks, terminal events, input demand and ownership
before client close. Large metadata values are summarized in the report only
after their full values have been checked.

The matrix includes every split inside a five-byte header, bytewise and seeded
chunks, 128 coalesced messages, all reserved flags, truncated input and invalid
trailer order. Twenty-four receive-cap scenarios exercise limit minus one,
exactly the limit and limit plus one across default, explicit, zero and GAX `-1`
settings. Exactly 32 MiB is accepted where configured; oversized declarations
and `0xffffffff` are rejected from the header. Large peer payloads are generated
incrementally rather than retained as another complete fixture buffer.

Another 286 Node-only internal-parser scenarios instrument actual
`Buffer.allocUnsafe`, `Buffer.prototype.set` and `Buffer.concat` calls. Positive
controls must observe allocation/copy/concat activity; restoration also runs
after injected read failure. Rejected length declarations allocate only the
five-byte header and never request the separately offered payload. At three
bytewise payload sizes, copied bytes equal input bytes and concat calls stay
zero. Coalesced and fragmented representations preserve the same frame bytes.
These counters describe the measured parser operations, not deserialized object
sizes, all allocator APIs, total JS heap or workerd heap usage.

Metadata checks include repeated request values, comma-combined padded/unpadded
binary fields, exact `grpc-status-details-bin`, percent-encoded Korean details,
malformed escapes, all HTTP fallback codes and HTML/JSON/text-mode rejection.
Request, header and trailer boundary fixtures count the final encoded fields
including controls; 65,536 bytes pass and the next byte fails. An overbudget
request has no Fetch attempt. Headers-only errors preserve custom metadata in
the initial event and terminal status; this is the adapter's observed event
classification, without claiming native event parity.

Two original requirements remain partial, with explicit current behavior
decisions: `WIRE-013` is superseded by supported gzip/deflate compression with
bounded decompression and rejection of malformed or unsupported encodings;
`WIRE-016` retains `UNKNOWN / WGA_MISSING_GRPC_STATUS` as the canonical diagnostic.
The older name in the original catalog is not an alias. These decisions preserve
existing adapter behavior and do not turn either historical requirement into a
passing native-parity claim. `WIRE-023` now rejects malformed padding, including `AQI==`,
in both headers and trailers while retaining valid padded and unpadded values.
The pinned native decoder's more permissive result remains recorded separately.

## Configuration

`test/config-catalog.test.cjs` gives each `CFG-001`–`CFG-011` requirement its own
named test. Tests that depend on untouched global configuration use isolated
processes. Rejected configuration must preserve the previous state, including
before and after the first successful Channel construction. Nonempty endpoint
maps test canonical ordering and ownership of input and returned snapshots.

Channel-option tests cover the registered allowlist, unsupported native features,
actual pinned GAX defaults and foreign channel overrides. Unsupported metadata
options must fail without starting authentication or a data request. These checks
do not add native channel readiness, pooling or service-config support.

## Types

`npm run test:types` checks adapter declarations; `npm run test:sdk:types` checks
the installed native and replacement Google SDK graphs. Both use strict checking
with `skipLibCheck: false`. Node16, NodeNext and Bundler resolution include ESM
and CommonJS consumers.

The catalog requires all unary/readable overloads, root and deep imports, the
SDK Promise tuple/Key/Transaction/Query contracts, invalid configuration examples,
and server type-only imports that disappear from emitted JavaScript. Type checks
do not establish runtime SDK support or support for native server operations.
The mapping retains any remaining gap rather than inferring complete coverage
from a successful compiler exit.

The pinned native EventEmitter surface permits broad fallback listener
signatures. Message and error listener examples therefore use explicit response
and `ServiceError` annotations; a successful overload check does not imply that
every event callback is inferred narrowly or that arbitrary event names are
rejected. The replacement preserves this upstream boundary.

## Evidence and scope

The normal `npm run verify` pipeline and GitHub CI require these checks. Reports
are tied to the tested source, installed package and dependency graph. A missing
runtime, skipped case, changed assertion or stale report cannot replace a
successful execution.

The runtime suite executes 124 case rows, 148 adapter calls and 124 Fetch attempts
in Node/workerd, plus six native scenarios and the independent HTTP/2 control.
The type report contains six compiler configurations and 27 case rows across
both module forms. Actual generated proto descriptors/codecs, client declarations
and type-only emitted modules are retained under `verification/api-contracts/`
and `verification/type-contracts/`, hashed by the evidence checker and included
in the CI artifact archive.

These contracts cover the explicitly exercised local client surface. The full
189-case catalog, other SDK versions, live provider trust/IAM, deployed
Cloudflare behavior and long-running operation have independent requirements.
`releaseEligible` remains `false`.
