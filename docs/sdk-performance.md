# Google SDK Worker performance baseline

`npm run test:benchmark:sdk` builds and executes the installed Datastore, Firestore,
Secret Manager, and combined SDK entry graphs for **both supported profiles** in
local **workerd**. It writes
`verification/sdk-benchmark.json` and fails when coverage, cleanup, evidence, or
the checked-in regression ceilings are missing or exceeded. `npm run verify`
and GitHub's local verification job run the same command.

Install the pinned fixtures first with `npm run fixtures:install`. The benchmark
executes `google-static-v1` against `fixtures/google` and `google-modern-v1`
against `fixtures/modern`. All RPC and OAuth endpoints are synthetic local peers. No Google or
Cloudflare account, deployment, or credential is required.

Canonical entry and runtime fixtures are copied byte-for-byte into a disposable
`.wga-build` directory inside each selected fixture. This keeps Node package
resolution in that fixture's actual dependency graph; there is no cross-profile
alias. The selected profile validates its own package and schema hashes before
bundling. Copied inputs and generated temporary directories are removed even on
failure. Raw SDK inputs, adapter/build implementation, and the selected profile
have separate per-graph hashes in the report.

## SDK bundle transport inspection

The existing `npm run test:workers:sdk` and `node scripts/test-modern-sdk.cjs`
gates inspect the complete three-SDK Worker for their respective profiles before
executing that same final JavaScript in workerd. Their `bundleInspection` records
in `verification/workers-sdk.json` and `verification/modern-sdk.json` contain:

- Included input package names and versions, resolved from the installed package
  manifests. An adapter installed under `@grpc/grpc-js` remains identifiable as
  `workers-grpc-adapter`; native grpc-js under another alias is rejected.
- External import edges from both the SDK preset's esbuild metafile and the
  final Wrangler dry-run metafile, with hashes for both stages.
- An AST inventory of literal executable imports, exports, dynamic imports and
  CommonJS/esbuild require calls in the emitted JavaScript, bound to its hash.

Bundled native `@grpc/grpc-js`/`grpc` packages and external native gRPC or `http2`
imports fail the gate. Unit negative controls cover the package provenance,
both metadata edge locations and final JavaScript independently. Type-only
imports erased by compilation, comments and documentation strings do not count
as runtime dependencies. Auth and proxy dependencies may retain `http`, `https`,
`net` and `tls`; the report lists those separately rather than claiming that the
entire SDK graph has no Node networking imports.

This inspection covers included package provenance and static executable import
specifiers in the pinned build pipeline. It does not resolve arbitrary computed
module names. Runtime SDK calls and the existing exact profile checks remain
separate requirements.

## What is measured

| Measurement | Actual work performed |
| --- | --- |
| Bundle bytes / gzip bytes | The final minified Worker bundle, including the SDK, exact protobuf build preset, adapter, and Wrangler compatibility bridge. Node compatibility builtins remain provided by workerd. |
| Startup and bootstrap readiness | Host monotonic time from constructing a fresh Miniflare runtime through a successful lightweight `ready` response. Includes process/orchestration, parsing the bundled script, and compatibility setup. SDK module evaluation is deferred. |
| SDK graph import | A separate host-timed request invokes bundled dynamic imports of the SDK constructors, auth library, adapter, and benchmark runtime. The graph loads once per fresh isolate; no SDK client has been constructed at the end of this phase. There is no module download. |
| Client construction | Separate host-timed requests construct the unauthenticated and authenticated SDK clients, synthetic OAuth credentials, and adapter transport. The anonymous clients close before the authenticated clients are constructed. |
| SDK initialization | Separate host-timed requests initialize the generated clients that the subsequent public API calls use. Pinned fixture-only internal paths are required for high-level Datastore and Firestore; see below. No service RPC or token exchange is allowed in this phase. |
| First unauthenticated RPC | The fresh, explicitly initialized SDK client executes its real public API with an auth callback that emits no authorization header; the local peer verifies its absence. Construction and generated-client initialization were measured separately. |
| First authenticated RPC | A separate fresh, explicitly initialized SDK client in the same, already loaded isolate executes its public API using `OAuth2Client` and a cached synthetic access token. SDK module loading is already warm. |
| First message | For every RPC, the adapter's actual `first-message` observer event triggers a separate local control Fetch. The host measures probe arrival from that phase's dispatch, preserving the raw event and actual `logicalCallId`. This includes probe scheduling and I/O overhead. It is separate from full RPC/SDK result completion. |
| Warm RPC | Four further requests reuse that authenticated SDK client. |
| Compressed RPC | The peer sends gzip-compressed protobuf messages; the adapter decompresses and the SDK deserializes/verifies the result. |
| OAuth refresh RPC | An expired access token makes the real Google auth library exchange a synthetic refresh token with the local OAuth endpoint. The peer verifies the newly issued access token. |
| Concurrent workload | Four calls share admission and an expired OAuth credential. The token exchange is held briefly so the auth library can coalesce refreshes. Exactly one exchange is required. Firestore graphs consume four gzip query streams slowly. |

Each profile's four graphs run in **two fresh isolates** each, with four warm
samples per isolate: eight graph builds and sixteen SDK Worker isolates in total.
Every successful RPC is checked against the corresponding decoded SDK result,
observer terminal, peer receipt, and zero active/queued/buffered adapter resources
after completion. SDK clients close and peer body readers release before runtime
disposal. The pinned high-level Datastore API has no public close method, so its
cached generated clients are closed by the fixture.

The individual methods are high-level `Datastore.get()`,
`Firestore.doc().get()`, and `SecretManagerServiceClient.getSecret()`. Combined
ordinary requests call all three. Firestore concurrency uses
`collection().stream()` with 64 documents of 64 KiB each and a 2 ms delay between
consumed documents. Other individual graphs issue four unary calls concurrently.

The high-level Datastore SDK has no public `initialize()` method. Its initialization
fixture calls the pinned internal `prepareGaxRequest_` path to populate the same
generated-client cache used by `get()`, then awaits that GAPIC client's
`initialize()`. Firestore's `initializeIfNeeded()` only freezes settings when the
project ID is already supplied, so the fixture additionally obtains the client
through the pinned internal `_clientPool.run()` path and awaits its GAPIC
`initialize()`. Secret Manager uses its public `initialize()`. The fixtures check
that generated stubs are absent before initialization and present afterwards.
These internal hooks are benchmark instrumentation, not application APIs. The
following RPC still uses the normal public SDK method and verifies its result.

All phase timings include dispatch and response serialization between the host
and workerd; they are not isolated CPU times and should not be added to predict a
deployed cold start. Constructor and initialization measurements include auth
and adapter setup where those operations naturally occur. The authenticated and
unauthenticated contexts share the imported module graph, but never the SDK client
objects or transport. No zero-duration placeholder stands in for unavailable SDK
initialization.

`firstMessageReceipts` retain one independently received host probe for every
actual observer call ID. `firstMessageTimingsMs` summarizes those host samples
separately from `timingsMs`, which measures phase completion. Combined-graph
phases have one probe per SDK call; their first-message sample count therefore
differs from the phase-completion count. All probes finish before the phase
response and runtime disposal. These control requests are counted separately
from service RPCs, OAuth token exchanges, and held-stream memory checkpoints.

Raw `observerEvents` also retain the adapter's call-relative `elapsedMs`, with its
distinct `workerd-performance.now` source. Workerd's clock can remain unchanged
between I/O, so these raw values may be zero; they are never substituted for host
first-message measurements. The first-message event occurs when the adapter
observes the first decoded protocol message, before the SDK necessarily delivers
its final public result. Both inspector attachment and the probe instrumentation
affect the benchmark.

## Memory measurement

The harness attaches to the inspector target for the **SDK Worker isolate**,
not Miniflare's host Node process or an internal proxy Worker. It requires the
actual [Chrome DevTools Protocol `Runtime.getHeapUsage` result](https://chromedevtools.github.io/devtools-protocol/v8/Runtime/#method-getHeapUsage):

- `usedSize` and `totalSize`: used and allocated JavaScript heap bytes.
- `embedderHeapUsedSize`: the embedder's garbage-collected heap.
- `backingStorageSize`: backing storage for ArrayBuffers and external strings.

Samples are taken after bootstrap readiness, deferred SDK import and each workload, while all Firestore consumers
hold their first document, and after SDK close. The synthetic query peer holds
its final trailers until that checkpoint so all four calls remain active during
the sample even if the SDK prefetches documents. The reported peaks are the
maximum **observed sample** for each field. No values are estimated from payload
sizes or substituted with `process.memoryUsage()`. Missing inspector support
fails the check.

These fields do **not** establish total isolate memory, native allocations, a
Cloudflare platform limit, or the true peak between samples. They are reported
separately; the harness does not add them together as a claimed total. Garbage
collection and inspector attachment affect measurements. The inspector stays
attached during RPC timing, and no forced collection is performed.

## Regression budgets and evidence

[`fixtures/google/benchmark-budgets.json`](../fixtures/google/benchmark-budgets.json)
pins common workload dimensions and separate per-profile local smoke ceilings
for bundle size, first/warm/scenario wall time, and sampled heap/backing storage.
These are CI regression checks, not service-level objectives or production
capacity recommendations. Review budget changes alongside their measured
report; increasing a ceiling changes the test's acceptance criteria.

The separate `releaseThresholds` fields remain explicitly `null`: no release
latency policy has been approved. A successful local benchmark therefore records
`performanceCertification.status: "blocked"` with reason
`release-performance-thresholds-unset`. Strict validation rejects a report that
turns local smoke success into release performance certification. Approving
numeric thresholds, representative sample counts, and an appropriate execution
environment is a separate decision; the smoke ceilings are not silently reused
as release thresholds.

The policy evaluator accepts explicit positive finite p50/p95 ceilings for SDK
import, construction, initialization, first RPC, first message, and warm RPC.
It evaluates every graph, both authentication contexts where applicable, and all
six first-message workloads. A complete policy passes only when every measured
percentile is at or below its configured ceiling; an exceeded ceiling fails the
benchmark and records the exact graph, measurement and value. Any remaining null
ceiling keeps certification blocked, even when configured comparisons pass.
Unknown/missing fields, non-numeric or non-positive ceilings, and a p50 ceiling
larger than its p95 ceiling are rejected. Policy tests use explicitly synthetic
summaries and do not claim that those numeric test limits are approved SLOs.
The result's `local-controlled-workerd` scope remains explicit even for a fully
configured policy; the other release gates remain independent.

For orientation, the initial two-profile local run on Linux x64, Node 24.1.0 and
workerd 1.20260921.1 produced these bundle sizes. Regenerate the JSON report for the
current source and machine; these numbers are observations, not portable
latency promises.

| Profile | Entry graph | Minified bytes | Gzip bytes |
| --- | --- | ---: | ---: |
| `google-static-v1` | Datastore | 4,697,927 | 664,838 |
| `google-static-v1` | Firestore | 4,770,002 | 709,170 |
| `google-static-v1` | Secret Manager | 4,723,241 | 647,440 |
| `google-static-v1` | Combined | 7,156,540 | 1,063,202 |
| `google-modern-v1` | Datastore | 5,974,961 | 732,027 |
| `google-modern-v1` | Firestore | 7,614,994 | 966,428 |
| `google-modern-v1` | Secret Manager | 5,779,898 | 686,472 |
| `google-modern-v1` | Combined | 9,226,305 | 1,158,805 |

The modern graph requires its own size baseline; its larger generated SDK inputs
would exceed the static profile's Firestore and combined bundle ceilings. Modern
ceilings leave roughly 25% headroom over these observed sizes. Both profiles keep
the same generous timing and sampled-memory ceilings; the initial combined used
heap samples peaked at about 33 MB and 36 MB respectively, well below the 96 MiB
CI smoke ceiling. This is a sampled V8 heap comparison, not a total-memory limit.

The report retains all setup/completion/first-message timing samples, nearest-rank summaries, heap samples,
RPC and refresh receipts, resource cleanup, SDK/runtime versions, installed raw
SDK/adapter/build input hashes, profile input/cache hashes, bundle hashes, and
source/lockfile hashes. Validation recomputes
summary statistics and requires all eight graphs and their workloads. The main evidence
check binds those hashes to the files used in verification. Focused tests reject
missing phases, reused authentication contexts, incomplete generated-client
initialization, unmatched or duplicate first-message probes, synthesized
summaries, wrong inspector targets, unrefreshed authorization, dropped
compression, incomplete cleanup, and relaxed budgets.

Two cold samples and eight warm samples per graph are enough to catch gross
local regressions, not to estimate a reliable production p95. The report keeps
the sample count next to every percentile so that distinction remains visible.

`npm run test:benchmark` remains the separate Node adapter microbenchmark. Its
`require()` timing and root-entry bundle size do not replace these SDK/workerd
measurements. Neither benchmark establishes deployed cold start, network
latency, Google IAM/quota behavior, authentication against a real issuer,
Cloudflare's automatic gRPC conversion, or long-running reliability.
