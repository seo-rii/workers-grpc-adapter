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
| Startup and readiness | Host monotonic time from constructing a fresh Miniflare runtime through a successful Worker `ready` response, including module evaluation. This includes local process/orchestration costs. |
| First unauthenticated RPC | A fresh SDK client executes its real public API with an auth callback that emits no authorization header; the local peer verifies its absence. Includes client construction and SDK initialization. |
| First authenticated RPC | A separate fresh SDK client in the same, already loaded isolate executes its public API using `OAuth2Client` and a cached synthetic access token. Includes client construction; module loading is already warm. |
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

## Memory measurement

The harness attaches to the inspector target for the **SDK Worker isolate**,
not Miniflare's host Node process or an internal proxy Worker. It requires the
actual [Chrome DevTools Protocol `Runtime.getHeapUsage` result](https://chromedevtools.github.io/devtools-protocol/v8/Runtime/#method-getHeapUsage):

- `usedSize` and `totalSize`: used and allocated JavaScript heap bytes.
- `embedderHeapUsedSize`: the embedder's garbage-collected heap.
- `backingStorageSize`: backing storage for ArrayBuffers and external strings.

Samples are taken after startup and each workload, while all Firestore consumers
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

The report retains all timing samples, nearest-rank summaries, heap samples,
RPC and refresh receipts, resource cleanup, SDK/runtime versions, installed raw
SDK/adapter/build input hashes, profile input/cache hashes, bundle hashes, and
source/lockfile hashes. Validation recomputes
summary statistics and requires all eight graphs and their workloads. The main evidence
check binds those hashes to the files used in verification. Focused tests reject
missing phases, synthesized summaries, wrong inspector targets, unrefreshed
authorization, dropped compression, incomplete cleanup, and relaxed budgets.

Two cold samples and eight warm samples per graph are enough to catch gross
local regressions, not to estimate a reliable production p95. The report keeps
the sample count next to every percentile so that distinction remains visible.

`npm run test:benchmark` remains the separate Node adapter microbenchmark. Its
`require()` timing and root-entry bundle size do not replace these SDK/workerd
measurements. Neither benchmark establishes deployed cold start, network
latency, Google IAM/quota behavior, authentication against a real issuer,
Cloudflare's automatic gRPC conversion, or long-running reliability.
