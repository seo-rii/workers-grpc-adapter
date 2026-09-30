# Original catalog evidence review

Reviewed on 2026-09-30 against the implementation, test sources and completed
local reports. The initial reconciliation connected existing evidence. The
subsequent packaging work adds executable installation, identity, offline-doctor
and complete SDK bundle checks, plus addressable literal-table TAP cases.

The unchanged [original catalog](../compatibility/test-catalog.json) contains
189 requirements. The [reviewed mapping](../compatibility/test-evidence.json)
records an exact source/report reference and any remaining gap for every ID.
`npm run verify` validates those references against its own current execution.

| Coverage | Before review | After reconciliation | After packaging work | Meaning |
| --- | ---: | ---: | ---: | --- |
| Covered | 41 | 58 | 69 | Execution satisfies the original case. |
| Partial | 112 | 118 | 109 | Related execution exists, but named conditions remain. |
| No accepted current execution reference | 36 | 13 | 11 | Stored as `unimplemented`; this is an evidence classification, not a runtime feature inventory. |

Packaging work satisfies eleven additional cases and connects seven existing
HTTP fallback tests to individual execution references. The remaining 120
unsatisfied cases cannot be translated into a percentage of implementation work:
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
analysis. The packaging catalog now has thirteen covered cases; `PKG-013` retains
its full export/signature classification gap.

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

Other newly connected evidence is deliberately partial. Deferred Datastore
Lookup and named-database routing already execute, but the older report lacks
per-logical-call Fetch accounting. Actual SDK workerd benchmarks already run,
but do not separately time every initialization phase or measure every owned
buffer category. Those are narrower remaining conditions than “not tested.”

## Coverage by area

| Area | Covered | Partial | No current reference |
| --- | ---: | ---: | ---: |
| Packaging | 13 | 1 | 0 |
| Types | 7 | 0 | 0 |
| Public API | 15 | 1 | 0 |
| Configuration | 11 | 0 | 0 |
| Authentication | 4 | 11 | 0 |
| Wire protocol | 5 | 22 | 0 |
| Call lifecycle | 0 | 18 | 0 |
| Flow control | 0 | 7 | 0 |
| SDK bootstrap | 4 | 7 | 0 |
| Datastore | 1 | 21 | 2 |
| Transactions | 7 | 2 | 0 |
| Retry | 1 | 3 | 0 |
| Security | 1 | 6 | 0 |
| Cloud | 0 | 2 | 7 |
| Performance | 0 | 5 | 0 |
| Documentation | 0 | 3 | 2 |

Lifecycle and flow control have substantial executed tests. Their original
cases also require specific schedules, runtime/native comparisons and cleanup
counters; partial coverage retains those extra conditions rather than denying
the tests that already pass.

## Remaining work

The next local work units, in order, are:

1. **Export/signature classification.** Complete the comparison between pinned
   upstream/consumer imports and all supported, intentionally unsupported and
   type-only signatures (`PKG-013`). Runtime-name inventory alone does not explain
   every signature difference. Other packaging cases now have executable evidence.
2. **Exact transport schedules and resource assertions.** Add the missing
   status-less HTTP 502/504 cases (`WIRE-018`), precise allocation/copy counters,
   deterministic auth-before-message and EOF/cancel orderings, late read
   rejection, and matching workerd/native checks. Record write completion,
   pending message and parser assembly ownership in the specific scenarios
   listed under `LIFE-*` and `FLOW-*`.
3. **SDK call accounting and combinations.** Add logical call IDs and separate
   data/auth Fetch counters to the older Datastore Lookup/pagination reports;
   cover remaining batches, overloads, query stream failures and routing fields.
   Crossed transaction IDs still need distinct credential providers (`TX-009`).
   Keep the explicit Commit cancellation limitation below visible (`TX-008`).
4. **Performance and executable documentation checks.** Refresh the separate
   transport-only benchmark within the evidence pipeline; measure import,
   construction, initialization and first-message timing independently. Sample
   heap trends in the same failure/cancel workload. Connect documentation
   examples, support tables, diagnostic IDs and release provenance checks to
   executed fixtures instead of relying on source hashes alone (`PERF-*`, `DOC-*`).

The eleven cases without an accepted current reference are `DS-005`, `DS-019`,
`CLOUD-001`–`CLOUD-007`, `DOC-001` and `DOC-005`.
Their individual procedures and remaining conditions are in the mapping.
For `WIRE-018`, seven existing HTTP fallback tests have individual source and TAP
references; 502 and 504 remain missing. The checker expands only bounded literal
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
