# Original catalog evidence review

Reviewed on 2026-09-30 against the existing implementation, test sources and
completed local reports. This reconciliation adds evidence references and
corrects remaining conditions; it adds no runtime features or test scenarios.

The unchanged [original catalog](../compatibility/test-catalog.json) contains
189 requirements. The [reviewed mapping](../compatibility/test-evidence.json)
records an exact source/report reference and any remaining gap for every ID.
`npm run verify` validates those references against its own current execution.

| Coverage | Before review | After review | Meaning |
| --- | ---: | ---: | --- |
| Covered | 41 | 58 | Existing execution satisfies the original case. |
| Partial | 112 | 118 | Related execution exists, but named conditions remain. |
| No accepted current execution reference | 36 | 13 | Stored as `unimplemented`; this is an evidence classification, not a runtime feature inventory. |

Seventeen cases move to covered, and 22 without references gain partial evidence.
One previously unreferenced case moves directly to covered. The remaining
131 unsatisfied cases cannot be translated into a percentage of implementation
work: a missing assertion, an SDK behavior difference and a cloud release gate
have very different costs. `releaseEligible` remains `false`.

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
| Packaging | 2 | 11 | 1 |
| Types | 7 | 0 | 0 |
| Public API | 15 | 1 | 0 |
| Configuration | 11 | 0 | 0 |
| Authentication | 4 | 11 | 0 |
| Wire protocol | 5 | 21 | 1 |
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

1. **Packaging and evidence addressability.** Exercise real GAX under the same
   npm alias/override clean-install graph (`PKG-002`), lockfile installation in a
   new directory (`PKG-004`), complete packed assets (`PKG-005`) and a standalone
   consumer without workspace type roots (`PKG-014`). Test duplicate adapter
   installations and doctor identity diagnostics (`PKG-010`). Inspect executable
   imports of the full SDK Worker bundle (`PKG-011`) and run doctor with network
   and credentials explicitly unavailable (`PKG-012`). Preserve strict reference
   validation while making dynamic protocol test results individually addressable.
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

The thirteen cases without an accepted current reference are `PKG-010`,
`WIRE-018`, `DS-005`, `DS-019`, `CLOUD-001`–`CLOUD-007`, `DOC-001` and `DOC-005`.
Their individual procedures and remaining conditions are in the mapping.
For `WIRE-018`, seven existing HTTP fallback tests already pass, but their
generated TAP titles cannot be referenced by the current literal-title checker;
502 and 504 are additionally missing. No evidence policy was relaxed to hide this.

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
