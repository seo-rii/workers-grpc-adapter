# Original catalog evidence review

Reviewed on 2026-10-03 against the implementation, test sources and completed
local reports. The initial reconciliation connected existing evidence. The
subsequent packaging work adds executable installation, identity, offline-doctor,
complete SDK bundle checks, reviewed export/declaration contracts, and addressable
literal-table TAP cases.

The unchanged [original catalog](../compatibility/test-catalog.json) contains
189 requirements. The [reviewed mapping](../compatibility/test-evidence.json)
records an exact source/report reference and any remaining gap for every ID.
`npm run verify` validates those references against its own current execution.

| Coverage | Before review | After reconciliation | After packaging | After lifecycle | After flow control | After wire checks | After SDK accounting | After mutations/emulators | Meaning |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Covered | 41 | 58 | 70 | 88 | 94 | 112 | 123 | 135 | Execution satisfies the original case. |
| Partial | 112 | 118 | 108 | 90 | 84 | 66 | 56 | 45 | Related execution exists, but named conditions remain. |
| No accepted current execution reference | 36 | 13 | 11 | 11 | 11 | 11 | 10 | 9 | Stored as `unimplemented`; this is an evidence classification, not a runtime feature inventory. |

Packaging work satisfies twelve additional cases and connects seven existing
HTTP fallback tests to individual execution references. Lifecycle work adds
seventeen completed call cases and the full HTTP fallback matrix. Flow-control
work satisfies six additional cases, wire checks satisfy eighteen, and SDK read
accounting and credential isolation satisfy eleven. Mutation contracts and
emulator accounting satisfy twelve more. The remaining 54 unsatisfied cases cannot be translated into a percentage of implementation work:
a missing assertion, an SDK behavior difference and a cloud release gate have
very different costs. `releaseEligible` remains `false`.

## Packaging work executed

Both pinned real SDK graphs now install the actual tarball through a temporary
registry using the npm alias and root `$ref` override. Each graph is installed
again by `npm ci` in a separate empty directory, preserving package locations,
versions, integrity, lock bytes and application/GAX runtime identity. The real
alias-only negative control retains native grpc-js; doctor rejects it and records
the failing consumers. Its native archive and runtime bytes are independently
checked, using a separate cache from the synthetic negative control.

Standalone consumers verify all packed exports, assets, license/notice files and
type entry points. ESM/CommonJS examples compile in all three resolution modes
with the pinned compiler and Node typings installed inside the consumer; no
workspace type roots or symlinks supply missing declarations. Unsupported deep
imports fail explicitly. Same-version and different-version duplicate tarballs
produce separate classes, which doctor now diagnoses. On the two real SDK graphs,
doctor also passes with credential environment variables absent and network,
authentication, credential reads and dependency execution blocked; all counters
remain zero.

Both complete three-SDK Workers inspect package provenance and executable imports
at the SDK-preset and final Wrangler stages before executing the same JavaScript
in workerd. Native gRPC/HTTP2 dependencies fail the gate; erased type-only imports
and legitimate authentication networking are distinguished. This is a static
import/provenance check of the pinned pipeline, not arbitrary dynamic-loader
analysis.

The [export and declaration contract](exports.md) completes `PKG-013`. Its policy
reviews all 123 names in the native/adapter root declaration union: 24 supported
within scope, three import-only failures, 56 type-only names, and 40 unsupported
native names. Public signatures and their declaration dependencies are
snapshotted alongside all seven declaration-bearing subpaths. The default gate
rejects changes until the snapshot is deliberately reviewed and refreshed.

Consumer inventories scan 32 source files across four installed SDK fixtures.
They retain 32 unresolved namespace-access records, including dynamic use or
namespace escape, rather than claiming exhaustive member analysis. Native API
parity remains false; matching signatures and classified differences do not
establish identical transport behavior. All fourteen packaging catalog cases
now have accepted execution evidence.

## Lifecycle work executed

The same 45 controlled scenarios run in each of Node/workerd and the two
transport modes: 180 recorded scenarios covering 1,388 calls. Authentication
and half-close ordering, cancel before listener installation, queued write
acknowledgements, pending Fetch/read failures, EOF/cancel ordering, channel close,
independent calls and reentrant listeners have explicit traces and owner counts.
Each runtime/mode executes 100 success, 100 error and 100 cancellation calls,
with real timers and pending write callbacks observed before each wave settles.
Both unhandled-rejection monitors must detect their separate positive control.

Internal execution diagnostics preserve active pump, queued write, pending
message, parser assembly and runtime-chunk ownership until the owner unwinds.
Logical terminal delivery cannot zero those counters prematurely. These are
adapter-visible counts, not total JS heap measurements. See the
[lifetime contract](local-contracts.md#call-lifetime-and-asynchronous-ownership)
for the exact byte categories and controlled-reader boundary.

`LIFE-001`–`LIFE-014` and `LIFE-016`–`LIFE-018` are now covered. `LIFE-015`
retains the invalid-Date error-policy difference below. `WIRE-018` now executes
all nine required HTTP mappings, including status-less 502 and 504.

## Flow-control work executed

The installed adapter runs eight scenarios in each Node/workerd and transport
mode combination, giving 32 adapter observations. The pinned native client runs
eight corresponding observations, plus an independent consuming HTTP/2 control
for malformed unary cardinality. Public streams use a native grpc-js loopback
server and a demand-driven framing bridge; all remote calls and Fetch attempts
are counted separately.

Slow consumption, pause/resume and cancellation positively occupy the public
queue, pending-message slot and parser assembly before their bounds and cleanup
are checked. The long stream delivers 513 × 64 KiB, exceeding the default 32 MiB
transport ceiling while the adapter has a 1 MiB buffer budget. A separate
128-frame response is deliberately coalesced by a bounded fixture to measure
retained runtime-chunk bytes without claiming native chunk-boundary parity.

`FLOW-001`–`FLOW-005` and `FLOW-007` are covered. `FLOW-006` records the native
duplicate-unary divergence and remains partial. Queued public messages can
drain after status in both implementations; workerd service binding cancellation
can also leave the backend producing. These are explicit boundaries in the
[flow-control contract](local-contracts.md#flow-control-and-public-queues), not
claims of total heap bounds or deployed cancellation propagation.

## Wire work executed

The installed adapter executes 369 independent response/request vectors in each
Node/workerd and transport-mode combination: 1,476 public calls. Exact header
splits, bytewise and seeded fragmentation, 128 coalesced messages, all 252 reserved
flags, truncated frames, trailer order, HTTP fallbacks, metadata and receive caps
have individually addressable observations. The 24 receive-limit variants include
zero, the default 4 MiB cap, GAX `-1`, configured transport limits and exactly
32 MiB. Large peer payloads are generated in 64 KiB pieces.

A separate Node probe records 286 parser scenarios with actual Buffer allocation,
copy and concat instrumentation. Positive controls verify the instruments and
their restoration. Oversized and unsigned-maximum headers allocate five bytes,
reject before another payload pull, and retain no parser resources. Bytewise
inputs at three sizes have linear copied bytes and no concat calls. These are
direct internal-parser measurements, not workerd allocation instrumentation or
measurements of total JS heap.

Final metadata budgets include protocol controls, base64 and percent encoding.
Every public row checks decoded bytes, callback/status cardinality and cleanup
before closing its client. All 27 wire cases now have exact local observations;
24 are covered and three retain the compatibility differences below. See the
[wire contract](local-contracts.md#wire-boundaries-and-allocation-measurement).

## Evidence that was already present

- `PKG-003/007`: real nested GAX dependency graphs and packed root/deep Client
  identity, including strict installed declaration consumers.
- `AUTH-002/004/005/010`: logical audience, synchronous/asynchronous credential
  completion, cancellation during refresh and no late data Fetch.
- `WIRE-002/011/014/015/026`: empty messages, truncated payloads, duplicate or
  post-trailer frames, and final metadata budgets including control fields.
- `BOOT-001/003/004/010`: actual static SDK imports, first request serialization,
  native response decoding and observed gRPC-Web rather than REST requests.
- `RETRY-003`, `SEC-005`: partial-stream resume without duplicate delivery and
  rejection of an unmapped authority before authentication or Fetch.

## SDK accounting work executed

Lookup executes 17 shared scenarios across native grpc-js and both Node/workerd
modes: 85 cases, 235 service RPCs and 188 actual data Fetches. Actual logical call
IDs join observer events, physical Fetches and native peer receipts. Each SDK
retry creates a distinct call with one Fetch. Timers, parser ownership, pumps,
buffers and channel registrations are idle before SDK close. Cached OAuth network
traffic is guarded separately, with an expired-token positive control blocked
before network I/O. Two project/database/namespace/ancestor combinations and both
project/database routing fields are checked in one shared execution.

`DS-006/007/008/011/022/024` and `RETRY-002` now satisfy their full cases.
This controlled Datastore 10.1.0 gate does not establish actual token renewal,
production storage behavior or deployed Cloudflare conversion.

Query pagination adds 50 cases across the same five runtimes, 310 service RPCs,
248 actual data Fetches and pre-close cleanup. Promise/callback tuple shapes,
invalid-query rejection, second-page stream errors and full public event order
have independent expected contracts. `DS-016/020/023` are covered; `DS-019` now has
controlled error evidence but still requires separate production index testing.
Bare `destroy()` continues paging in both pinned native and adapter SDK clients,
so `DS-021` retains that original expectation as an explicit unmet condition.

`TX-009` now uses distinct OAuth2Client providers, SDK clients and logical targets.
Ten crossed cases across both pinned profiles and five runtimes check 80 actual
provider invocations and peer authorization/quota receipts against transaction
IDs and keys. Native TLS authority and observed Fetch origins establish the
respective target boundaries. Temporary TLS credentials are disposed. Synthetic
cached tokens do not establish Google IAM, quota enforcement or token renewal.
The full transaction matrix remains 100 cases, 470 RPCs and 376 adapter Fetches.

The controlled mutation matrix adds 18 scenarios in five runtimes: 90 cases,
275 native peer RPCs and 220 actual adapter Fetches. It verifies exact typed
mutation payloads, batch order, the existing/missing insert/upsert/update matrix,
assigned incomplete keys, delete failures and high-level allocation. Save and
delete retain their different native tuple/callback shapes. Per-call identity
joins and pre-close resource ownership are mandatory. `DS-002/003/004/005/009/010`
are covered. High-level `reserveIds` is absent in the pinned SDK; the catalog's
available high-level API requirement is satisfied by `allocateIds`, while the
public generated-v1 reservation test stays a separate emulator observation.

Official emulators now verify every Datastore call, including cleanup RPCs.
Ten suites in native, Node replacement and two workerd invocations produce
308 Datastore RPCs. The 231 adapter calls each join one physical Fetch and one
Envoy receipt, with timers, buffers, parser ownership, pumps, callbacks and active
channel registrations checked before SDK close. All registered clients then
close. Anonymous credential/network guards remain at zero; readiness traffic is
harness setup, not a suite control request. The full Firestore/Datastore emulator
matrix passes 80 cases, with 429 Fetches and 572 upstream arrivals.

The data cases explicitly test omitted undefined object properties versus null
and missing fields, caller input preservation, equal-rank ordering across a page
boundary, empty aggregation tuple/types, incomplete-key assignment and the public
mutation success/failure matrix. `DS-012/013/014/015/017/018` are covered. This
emulator accounting uses grpc-web; controlled gates separately test both modes.
All Datastore catalog cases except production index requirements (`DS-019`) and
the native SDK destroy behavior (`DS-021`) now have complete local evidence.

Actual SDK workerd benchmarks already run, but do not separately time every
initialization phase or measure every owned buffer category. Those are narrower
remaining conditions than “not tested.”

## Coverage by area

| Area | Covered | Partial | No current reference |
| --- | ---: | ---: | ---: |
| Packaging | 14 | 0 | 0 |
| Types | 7 | 0 | 0 |
| Public API | 15 | 1 | 0 |
| Configuration | 11 | 0 | 0 |
| Authentication | 4 | 11 | 0 |
| Wire protocol | 24 | 3 | 0 |
| Call lifecycle | 17 | 1 | 0 |
| Flow control | 6 | 1 | 0 |
| SDK bootstrap | 4 | 7 | 0 |
| Datastore | 22 | 2 | 0 |
| Transactions | 8 | 1 | 0 |
| Retry | 2 | 2 | 0 |
| Security | 1 | 6 | 0 |
| Cloud | 0 | 2 | 7 |
| Performance | 0 | 5 | 0 |
| Documentation | 0 | 3 | 2 |

Flow control now includes the native comparisons and specific
large-stream/pause/ownership scenarios. The remaining unary discrepancy is
retained rather than treated as transport equivalence.

## Remaining work

The next local work units, in order, are:

1. **Performance measurement.** Refresh the separate
   transport-only benchmark within the evidence pipeline; measure import,
   construction, initialization and first-message timing independently. Sample
   heap trends in the same failure/cancel workload (`PERF-*`).
2. **Executable documentation checks.** Connect documentation examples, support
   tables, diagnostic IDs and release provenance checks to executed fixtures
   instead of relying on source hashes alone (`DOC-*`). Keep production index
   requirements (`DS-019`), native stream destruction (`DS-021`) and public Commit
   cancellation (`TX-008`) as explicit boundaries.

The nine cases without an accepted current reference are
`CLOUD-001`–`CLOUD-007`, `DOC-001` and `DOC-005`.
Their individual procedures and remaining conditions are in the mapping.
For `WIRE-018`, all nine HTTP fallback tests have individual source and TAP
references, alongside the shared Node/workerd matrix. The checker expands only bounded literal
`const` tables with direct test registrations and still requires each exact TAP
result to pass. It does not execute source or infer success for unrun cases.

## Expectations that need a compatibility decision

These cannot be closed just by adding a reference:

- `API-011`: pinned native grpc-js reaches deadline after duplicate unary
  responses; the adapter rejects immediately. See [client contracts](local-contracts.md).
- `WIRE-013`: the original blanket compressed-frame rejection predates the
  implemented gzip/deflate support. Supported compression, unsupported encoding
  and malformed flags now have distinct results. Keep the original case visible
  until its historical expectation is explicitly superseded.
- `WIRE-016`: missing status returns `UNKNOWN / WGA_MISSING_GRPC_STATUS`;
  the original catalog names `WGA_STATUS_MISSING`. The precise diagnostic is now
  exercised without claiming that the names match.
- `WIRE-023`: `AQI==` has an extra padding character but currently decodes to
  bytes `0102` in both headers and trailers. Other malformed alphabet, padding
  and trailing-bit cases reject. Complete malformed-padding rejection still
  needs a compatibility change; these two acceptance controls remain visible.
- `LIFE-015`: invalid Date returns adapter `INTERNAL`, whereas the catalog asks
  for `INVALID_ARGUMENT`. Pinned native throws `RangeError` synchronously before
  returning a call. This is an API error-policy decision, not missing execution.
- `FLOW-006`: the adapter reads trailers and rejects a duplicate unary message
  with one read demand; pinned native delivers the first internally and waits
  for deadline. The new flow suite reproduces the `API-011` cardinality
  difference with counted read demands and an independent complete-wire control.
- `DS-021`: pinned native Datastore and the adapter both continue paging after
  `runQueryStream().destroy()`; `end()` stops later pages but does not cancel a
  pending unary page. The original no-extra-page expectation is unmet.
- `TX-008`: public high-level and generated-v1 Commit promises expose no cancel
  handle in the two pinned SDKs. Deadline evidence does not prove explicit
  cancellation or undo an already applied mutation.

## Historical cloud evidence and release gates

The [2026-09-30 live probe](gcp-cloud-probe.md) at runtime commit `5e6f87c`
passed native and both deployed Worker modes, including finite SDK CRUD and
transaction suites, conversion controls and eight-resource cleanup. It used
temporary named resources inside the existing GCP project. It did not create
the dedicated test project specified by the original cloud catalog.

Normal CI does not deploy. Its evidence references require a successful command
from the current local run, so the separate historical cloud receipt is not a
current-CI reference. The cloud cases retain both that provenance boundary and
their actual missing checks: deployed cancellation, typed/cursor queries,
aggregation, explicit rollback, a denied operation under a restricted principal,
and Secret Manager version payload/list operations. A successful cleanup run is
also distinct from intentionally failing a live scenario and retaining both its
primary error and cleanup outcome.

Production IAM, quota, token renewal, transaction contention, prolonged traffic,
and dependency/security/license release review remain separate gates. Local
fuzz volume and passing emulators do not substitute for them.
