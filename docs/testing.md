# Testing and evidence

The full local gate runs real SDK packages, native grpc-js comparisons, workerd, Envoy and official database emulators. It requires Linux x64 for the pinned Envoy and Java distributions, plus Node.js 22 or later and npm. Dependency and toolchain downloads require network access; the verification scenarios do not call live Google services.

## Run the local gate

Use a current Node.js 22 or later with **npm 11.4.1**, then run these commands from the repository root. `package.json` pins the package manager; CI installs it explicitly because the npm 10 bundled with Node 22 does not reproduce the fixture's scoped auth override.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run fixtures:install
node fixtures/envoy/download.cjs
npm run emulators:install
npm run verify
```

`fixtures:install` packs the current source, updates the fixture locks' local tarball integrity and runs `npm ci` for the Google, native and Worker fixtures. Run it again after changing packaged files, including the README, API guide or limitations guide. Use a consistent build umask: archive entry modes affect tarball integrity even when file contents match.

`verify` forces live and write opt-ins off. It creates local test records only in controlled services or disposable emulators. Build outputs, tarballs, verification reports and generated compatibility reports are ignored by Git. GitHub Actions runs the local gate and uploads `local-verification-node22-<run_id>-<attempt>`. That artifact contains `wga-local-receipts.tar.gz` with verification reports, generated compatibility reports and process logs/exit receipts. Download it from the corresponding run to inspect results.

Other platforms can run applicable core/type/SDK commands, but those results do not satisfy the complete Linux toolchain gate.

## Run the smaller test suite

The unit and regression suite still needs the installed SDK fixtures: evidence tests exercise the actual pinned build profile. It does not require the Envoy or emulator downloads.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run fixtures:install
npm test
```

## Commands and outputs

Individual commands assume their required fixtures and build outputs are prepared. `npm test` builds first; `npm run test:local` uses the existing build. `verify` is the command that collects the unit-test TAP output and writes the aggregate report.

| Command | Coverage | Generated output |
|---|---|---|
| `npm test` | Protocol, API, authentication, lifecycle, interceptors, deterministic fuzz and negative controls | Console; `verify` records `verification/tests.tap` |
| `npm run test:api:contracts` | Original public API cases in installed Node/workerd clients, with native error and ordering comparisons | `verification/api-contracts.json` |
| `npm run test:workerd:integration` | Two real Workers using the public client/server APIs through a service binding; 72 cases and 96 RPCs | `verification/workerd-integration.json` |
| `npm run test:workerd:lifecycle` | Installed client/server APIs in two real Workers; 39 interceptor, termination, metadata, resource, configuration and deadline cases with 70 logical RPCs | `verification/workerd-lifecycle.json` |
| `npm run test:workerd:observer` | Logical call/attempt timing, privacy, traffic and callback isolation in workerd | `verification/workerd-observer.json` |
| `npm run test:workerd:server-streaming` | Lazy server uploads, duplex demand, EOF/error/cancel/deadline and two-Worker service-binding cleanup | `verification/workerd-server-streaming.json` |
| `npm run test:workerd:transport-extensions` | Shared retry-budget depletion/recovery/isolation and structured error decoding in both modes | `verification/workerd-transport-extensions.json` |
| `npm run test:benchmark:sdk` | Two pinned profiles × four actual SDK Worker graphs: bundle/startup/first/authenticated/warm RPC, concurrent slow streams, compression and sampled V8 heap | `verification/sdk-benchmark.json` |
| `npm run test:workerd:fuzz` | Independent hostile Worker peer; generated and fixed malformed responses, compression, fragments, cleanup and channel reuse | `verification/workerd-fuzz.json` |
| `npm run test:fuzz:ci` | Required two-seed Node/workerd campaign: 1,000 / 150 executions per property | `verification/fuzz-campaign-ci.json` |
| `npm run test:fuzz:extended` | Four-seed campaign: 5,000 / 750 executions per Node/workerd property | `verification/fuzz-campaign-extended.json` |
| `npm run test:fuzz` | Fixed framing corpus and shrinking property tests for framing and call lifecycle | `verification/fuzz-node.json` and `.log`, including seed/path and counterexample on failure |
| `npm run test:types` | Adapter consumers in strict Node16/NodeNext/Bundler modes | `verification/types.json` |
| `npm run test:sdk:types` | Real SDK declarations compared with the native baseline | `compatibility/google-types.json` |
| `npm run test:sdk:local` | Shared native/adapter SDK behavior against controlled servers | `compatibility/google-local.json` |
| `npm run test:differential` | Callback, metadata, status and stream events against native grpc-js | `verification/native-differential.json` |
| `npm run test:envoy` | Real Envoy gRPC-Web → native grpc-js, including cancellation/deadlines | `verification/envoy.json` |
| `npm run test:auth` | Real OAuth2Client and JWT logic over injected token/RPC transports | `verification/google-auth.json` |
| `npm run test:firestore-watch-errors` | Both pinned SDKs: raw permission-error baseline, corrected Worker error delivery, transient/EOF resume and client reuse | `verification/firestore-watch-errors.json` |
| `npm run test:modern-firestore-recovery` | Firestore 9.2.0 resume tokens, disconnects, resets, filters, removals and target denial | `verification/modern-firestore-recovery.json` |
| `npm run test:datastore-lookup` | Native/adapter/workerd deferred Lookup, get overloads, partial errors, retries and per-RPC deadlines | `verification/datastore-lookup.json` |
| `npm run test:contract` | Root/deep CJS/ESM identity and transport import boundaries | `compatibility/exports-contract.json` |
| `npm run test:pack` | Actual tarball, alias negative control, root override and npm ci | `verification/packaging.json` |
| `npm run test:workers` | Unary and server-streaming RPCs in both transport modes in workerd | `verification/workers.json` |
| `npm run test:workers:sdk` | SDK bootstrap, protobuf preset and workerd RPCs | `verification/workers-sdk.json` |
| `node scripts/test-gax-mode-isolation.cjs` | Three real SDKs sharing GAX caches across default, direct and two gateway configurations in workerd | `verification/workers-gax-modes.json` |
| `node scripts/test-workers-lazy-sdk.cjs` | Cold/warm request-time SDK imports and Datastore nested Struct explain metrics | `verification/workers-lazy-sdk.json` |
| `node scripts/test-workers-auth.cjs` | Actual workerd Fetch token exchange, refresh, isolation, failure recovery and JWT signatures | `verification/workers-auth.json` |
| `node scripts/test-workers-federated-auth.cjs` | Controlled URL-sourced federation, token exchange and service-account impersonation in workerd | `verification/workers-federated-auth.json` |
| `node scripts/test-workers-legacy-auth.cjs` | Legacy Google callback credentials, native compatibility and workerd termination behavior | `verification/workers-legacy-auth.json` |
| `node scripts/test-workers-fetcher.cjs` | Actual workerd service bindings, per-client Fetcher isolation and default Fetch | `verification/workers-fetcher.json` |
| `node scripts/test-workers-compression.cjs` | Identity/deflate/gzip messages, mixed frames, decoded limits and cancellation against a Node zlib peer | `verification/workers-compression.json` |
| `npm run test:secret-manager` | Native/adapter/workerd Secret Manager pagination, method errors, metadata, recovery and payload checksum handling | `verification/secret-manager-extended.json` |
| `npm run test:firestore-read-errors` | Both pinned Firestore profiles: intermediate read failures, SDK retry requests, events and cleanup in native/Node/workerd | `verification/firestore-read-errors.json` |
| `npm run test:datastore-transactions` | Both pinned Datastore profiles: transaction requests, rollback, failures, interrupted Commit outcomes and cleanup in native/Node/workerd | `verification/datastore-transactions.json` |
| `node scripts/test-datastore-pagination.cjs` | Native/adapter/workerd query pagination, `end()` versus `destroy()`, pending-page behavior and reuse | `verification/datastore-pagination.json` |
| `node scripts/test-workers-resilience.cjs` | Repeated concurrent failures, slow streams and recovery in both workerd modes | `verification/workers-resilience.json` |
| `node scripts/test-google-worker-build.cjs` | Actual live entry, Wrangler custom build and guarded requests with outbound denied | Console; `verify` records `verification/google-worker-build.log` |
| `npm run test:workers:shared` | Identical native/workerd business modules and controlled faults | `verification/workers-shared.json` |
| `npm run test:emulators` | Official Native/Datastore emulators with native, Node adapter and workerd consumers | `verification/google-emulators.json` |
| `npm run test:emulators:lifecycle` | Startup/running signal handling and repeated stop cleanup | `verification/emulator-lifecycle.json` |
| `npm run test:evidence` | Current source, lock, artifact, process receipt and case-evidence consistency | `verification/evidence.json` |
| `npm run test:benchmark` | Optional local Node latency, buffering and concurrency measurements | `verification/benchmark.json` |
| `npm run test:google` | Separate live opt-in path; blocked by default | `verification/google-preflight.json`, then `verification/google-live.json` if executed |

`node vendor/verify.cjs` validates upstream and patched source hashes and reproduces the patches. `test:evidence` checks an existing completed verification run; `verify` creates the evidence file. The benchmark and live runner are not required live executions in the local gate.

The [temporary Cloudflare probe](cloud-probe.md) is a separate explicit deployment command. It is never invoked by `verify` or CI, and records deployed evidence in `verification/cloud-probe.json` without changing the local report's cloud-certification flags.

The [temporary GCP integration test](gcp-cloud-probe.md) adds private Cloud Run upstreams and isolated live Google databases. Its local bundle/guard checks (`node scripts/test-gcp-probe.cjs`), authenticated readiness retry checks (`node scripts/test-gcp-readiness.cjs`) and cleanup failure simulations (`node scripts/test-gcp-cleanup.cjs`) run in `verify`; provisioning and live calls remain separate opt-in work.

The [automatic-conversion diagnosis](cloudflare-conversion.md) adds opt-in flag and content-type comparisons. `verify` runs only their local contracts (`scripts/test-gcp-conversion-probe.cjs` and `scripts/test-google-conversion-wire.cjs`), with outbound requests intercepted. It does not deploy their Workers or call Google.

## Native SDK comparisons

`fixtures/native` installs grpc-js 1.14.0, while `fixtures/google` installs the replacement. Doctor reports record the dependency graph and integrity. The consumers execute identical shared business bytes and compare their hashes, RPC methods/statuses and binary gRPC-Web content types.

Controlled cases cover Datastore/Firestore CRUD, query, transaction and read-stream behavior; missing Firestore documents; unsupported Listen; and Secret Manager success, permission and missing-resource errors. Fault cases include Datastore `ABORTED`, an applied Commit whose response is withheld until a deadline, and a Firestore conflict followed by exactly one SDK transaction retry. Follow-up reads distinguish a failed response from a write that never happened.

SDK declarations are checked in strict ESM and CJS Node16/NodeNext/Bundler modes with `skipLibCheck: false`. Both fixtures replace auth 10.5.0 with official 10.9.1 while retaining auth 11.1.0. Their auth versions and integrity must match.

Authentication tests use real OAuth2Client/JWT/Gaxios logic with controlled transports. They check token refresh, concurrency, credential isolation, cancellation, JWT signatures, exchange claims and reuse. They do not contact Google's token endpoint or establish live OAuth/IAM behavior.

The workerd authentication gate runs ordinary OAuth2Client and JWT constructors through Gaxios and Workers Fetch, with only the outbound service intercepted. It checks cached credentials, expired-token refresh, concurrent refresh coalescing, distinct identities, denied-refresh recovery, cancellation/deadlines during refresh, and Secret Manager SDK calls. A generated ephemeral RSA key signs JWT assertions; the host verifies signatures and claims. No key, assertion or token is written to the report. These scenarios cover real library and runtime integration, while Google's token service and IAM remain outside this local gate.

The federated-auth gate executes both pinned auth versions in both modes. It retrieves text/JSON subject tokens from a controlled URL, verifies actual STS form fields, optionally exchanges the result through IAM `generateAccessToken`, and checks the credential reaching the RPC. Standalone impersonation additionally checks delegates and source-token isolation. Cache reuse, forced expiry, reverse-order identity completion, denied STS/IAM responses and cancellation/deadlines all have exact request-count assertions. Four Secret Manager cases use credential JSON directly, allowing the SDK to construct GoogleAuth. Synthetic tokens do not prove actual issuer validation or IAM authorization; no ADC files, environment discovery or metadata server are used.

Legacy callback tests compare header handling and first-settlement behavior against pinned native grpc-js. Separate workerd runs cover both modes and cold/warm invocations, modern-method precedence, invalid headers, synchronous/asynchronous callbacks, duplicate completion, cancellation and deadlines. After late callbacks, tests require no additional RPC and no active adapter calls. Strict declaration checks include valid modern/legacy providers and invalid legacy shapes in all three resolution modes.

The extended Secret Manager gate runs the same business source under native grpc-js
and both transport modes in Node and workerd against a controlled native service.
It verifies manual Promise/callback pagination, automatic pagination, async
iteration and early iterator exit using exact page-token and RPC counts.
`GetSecret`, `ListSecrets` and `AccessSecretVersion` failures preserve their
method-specific status, Unicode details and repeated text/binary trailers.
Second-page errors test what each pagination API delivers before failing and
require no third-page request. A successful request on the same client follows
each error. Retries are explicitly disabled so each SDK RPC must correspond to
one adapter attempt and one backend arrival.

The matrix has 40 scenarios in five runtime/mode combinations: 200 case rows,
445 native service arrivals and 356 adapter Fetch attempts. All four adapter
combinations send synthetic OAuth metadata through ordinary GAX credentials;
the native oracle uses explicit insecure loopback credentials and contributes
no OAuth-composition claim. Each request checks resource routing, quota-project
and SDK client metadata at the native service.

| Method | Injected errors, each through Promise and callback |
| --- | --- |
| `GetSecret` | `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED` |
| `ListSecrets` | `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`, `UNAVAILABLE` |
| `AccessSecretVersion` | `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `FAILED_PRECONDITION`, `UNAVAILABLE` |

Second-page `UNAVAILABLE` is also tested with manual Promise/callback, automatic
Promise/callback and async iteration. Manual paging and async iteration retain
the two already delivered items. Automatic pagination fails without returning a
partial aggregate. Callback counts include the successful first page where
applicable, and are checked after the recovery request to catch late completion.

AccessSecretVersion cases preserve binary bytes, including a 64 KiB callback
payload and an empty value. CRC32C checks include known vectors and a deliberately
corrupted checksum: the SDK resolves that response, while the consumer rejects
its integrity. Payloads are synthesized in memory and never included in reports
or error diagnostics. This is local RPC compatibility evidence, not a Secret
Manager emulator or live secret access.

The CI evidence checker requires the complete runtime/scenario matrix, matching
native results, request/attempt counts and clean adapter resource budgets before
SDK client close and runtime disposal. It
checks hashes of the shared business source and installed dependencies. Negative
tests reject missing or duplicate cases, changed error semantics and incomplete
cleanup. These checks cover the three methods above; they do not establish live
IAM/quota behavior or compatibility for other Secret Manager methods.

## Firestore intermediate read failures

`npm run test:firestore-read-errors` runs the same read operations with Firestore
8.3.0 and 9.2.0, using native grpc-js and both adapter modes in Node and workerd.
A controlled native service injects permanent errors after partial results and
transient errors before or after results from `BatchGetDocuments` and `RunQuery`.
Actual Envoy translates local adapter traffic; the automatic mode's local route
does not emulate Cloudflare's edge conversion.

The comparisons cover `getAll()`, query `get()` and query `stream()`. Backend
receipts verify that document retries request only outstanding names and query
retries preserve the read time while advancing the cursor and reducing the
remaining limit. SDK retries create distinct adapter calls, each with one
attempt and one Fetch. Application results and stream event order are compared
with native, followed by a successful read on the same client and resource
checks before `terminate()`.

Partial-response faults wait for a fixture progress acknowledgement from the
pinned SDK's snapshot construction path. The test wrapper calls the original
implementation and preserves its result; it provides a pacing signal without
changing retry decisions. This makes the exercised schedule explicit and avoids
assuming the consumer has processed data after a fixed sleep. The scenario is
a controlled failure test, not a production consistency or contention test.

A separate query-stream `destroy()` case keeps the backend response open after
the first document. After local stream closure and a successful marker read,
the peer must still observe the original RPC. Explicit peer release then allows
resource cleanup before SDK termination. Both native and adapter consumers
exhibit this pinned SDK boundary; the test does not treat local `close` as remote
cancellation.

The gate requires 100 case executions, 260 native service RPCs, 208 adapter Fetch
attempts and 70 separate fixture control acknowledgements. Envoy receipts identify
each case, RPC method and terminal status. The independent evidence validator
rejects missing combinations, changed retry requests, incorrect event sequences,
unreleased resources and stale source/dependency identities.

## Datastore transactions and interrupted Commit responses

`npm run test:datastore-transactions` runs identical transaction operations with
Datastore 10.1.0 and 11.1.0, using native grpc-js and both adapter modes in Node
and workerd: 100 cases, 470 service RPCs, 376 adapter Fetch calls and 10 separate
control acknowledgements. A controlled native service owns the test's in-memory transaction
state. Actual Envoy translates local adapter traffic; this does not exercise
Cloudflare's deployed automatic conversion or production Datastore storage.

The scenarios cover a successful read/update/commit, a query inside a transaction,
rollback of a queued write, read-only reads and rejected writes, `ABORTED`, and
HTTP/2 stream resets before and after mutation application. A reset sends no
gRPC status or response payload. The peer records binary
transaction IDs, exact request order, mutation contents and application counts.
Successful responses retain the SDK's tuple shape and mutation results. A later
read on the same client distinguishes an unapplied write from an applied write
whose response failed.

The pinned high-level SDK sends `Rollback` after a failed `commit()`. The test
records this SDK behavior separately from the adapter's one-attempt-per-call
contract: a later Rollback is not evidence that a committed mutation was undone.
Read-only writes are queued by the SDK and rejected by the controlled service;
the gate does not claim a local read-only write prohibition.

The generated public `v1.DatastoreClient.commit()` scenario expires its deadline
after the peer has accepted and applied the mutation. It checks local
`DEADLINE_EXCEEDED`, no adapter-generated Rollback, and the persisted write.
The generated-v1 and high-level `Transaction.commit()` promises expose no
cancellation handle in either pinned SDK. The test records that API boundary;
explicit caller cancellation remains a gap in the original `TX-008` case.
The peer also enforces the request's `grpc-timeout` so an abandoned backend
operation has a bounded lifetime. A workerd service-binding call reaching its
local deadline does not establish immediate backend cancellation; client stream
reset and peer deadline cleanup are recorded separately.

The peer's local HTTP/2 close and Envoy's upstream access record are separate
observations. In the deadline race, the peer can send its response and close
with reset code 0 while Envoy records HTTP 0 with no gRPC status because the
downstream call has already ended. The validator accepts that observed pair,
as well as an observed HTTP 200/status 4 response, without inferring delivery
from the peer's close code. It still requires the caller's status 4, the applied
mutation, exact RPC/Fetch counts and complete cleanup. Deterministic validator
tests cover both Commit/recovery completion orders across both profiles and all
five runtimes; invalid status pairs, response flags and peer receipts still fail.
When report validation fails, `TX_REPORT_INVALID` now includes the validator's
fixed contract description in `validationFailure`; arbitrary exception text and
request contents are not emitted.

Two transactions also run in crossed order with distinct IDs and synthetic
identity metadata. The test checks that their requests and results stay separate.
These headers are fixture labels, not distinct authentication providers or Google
credentials; concurrent credential isolation remains outside this transaction
case. The original TX catalog retains that distinction.

The gate checks one adapter attempt and Fetch per SDK RPC and zero active calls,
queued calls and retained adapter bytes before closing the SDK clients. The
independent evidence validator checks the complete runtime/profile matrix, source
and installed dependency hashes, backend receipts and clean process shutdown.
Finite local failure injection does not establish production conflict handling,
IAM, quota behavior or long-running transaction reliability.

## Official database emulators

The harness starts pinned Firestore 1.22.0/Java 21 processes in Native and Datastore modes on independent loopback ports. Real Envoy 1.39.1 translates each gRPC-Web request. Every registered suite runs under native grpc-js, the Node adapter and two workerd invocations, using the same shared files.

The report compares business assertions, source SHA-256 values and method/status counts. Each adapter Fetch must have a corresponding upstream arrival. Envoy's router **upstream access log** records status because the downstream gRPC-Web filter consumes trailers. Logs record RPC paths and status, not document or token payloads.

Firestore's emulator BatchWrite path needs emulator owner authorization. Local Envoy injects synthetic `Bearer owner` only toward Firestore. Clients use neither real credentials nor ADC and do not send credentials over plaintext. The workerd host bridge adjusts HTTP framing headers while forwarding protobuf bytes and the streaming response.

Datastore scenarios cover data types, namespace/ancestor keys, batch/missing lookup, callback/Promise shapes, query cursors/projection, aggregation, ID allocation/reservation, rollback, read streams and early destruction. Firestore scenarios cover data types, getAll/field masks, query cursors, aggregation, transforms, rollback and BulkWriter. Both exercise `ALREADY_EXISTS`, `NOT_FOUND` and failed-write atomicity; Firestore also checks stale-precondition `FAILED_PRECONDITION`.

The emulator's stream-destruction case fits in one unary query page. A separate controlled pagination gate compares identical business code under native grpc-js, the Node adapter and both workerd modes. It observes exact request cursors, remaining limits, page counts and reuse. In the pinned Datastore SDK, `end()` suppresses subsequent pages; `destroy()` alone suppresses delivered entities but still requests later pages. Neither operation cancels an already pending unary query. The gate holds that query at the backend to verify this boundary before releasing it. See [limitations](limitations.md#datastore-query-streams).

Emulators use memory and temporary working directories. The launcher records restricted logs, PIDs and exit receipts. Lifecycle tests check SIGINT/SIGTERM propagation, Java process exit, working-directory removal and idempotent stop. Only download caches are retained. [Google documents emulator differences](https://docs.cloud.google.com/firestore/native/docs/emulator), including transactions, indexes and limits; passing these scenarios does not certify production behavior.

## Protocol, resources and Workers

Transport-mode tests check direct service routing in `cloudflare` mode and explicit gateway routing in `grpc-web` mode. They assert bare `application/grpc-web` with `cf.grpcWeb: 'convert'` for direct requests, and `application/grpc-web+proto` with `cf.grpcWeb: 'passthrough'` for gateway requests. The workerd fixture runs direct grpc-js clients with both configurations concurrently in one isolate, checking request destinations, protobuf bytes, unary results, and server-streamed messages.

The separate GAX isolation gate runs 90 calls across the three pinned SDKs: three cache initialization orders, two invocations per isolate, and five client configurations including plain clients before and after explicit transports. It verifies protobuf identity, destination, Content-Type/Accept, Google credentials and gateway-only headers. Two gateway clients in the same mode use different destinations. This guards against GAX reusing a constructor that retained another client's configuration. The gate runs in `verify` and CI with outbound requests intercepted locally.

The resilience gate repeats concurrent unary and streaming calls in both modes, on cold and warm Worker invocations. Each wave mixes successful calls, HTTP 503, permission/quota statuses, truncated frames, message-size violations, empty unary responses, slow consumers, cancellation, deadlines and channel closure, then reuses the client successfully. It requires one terminal event per call, zero active calls, cleared deadline timers and zero retained request/current-response payload bytes after each wave. Paused consumers must exercise buffering within the Readable high-water mark and one-message transport lookahead.

This gate uses Miniflare's Node handler bridge to observe unfinished HTTP responses closing before runtime disposal. The Fetch-callback bridge does not propagate cancellation to an idle host response stream, so its `cancel()` callback is not used as evidence. The measurements cover adapter-visible state and loopback disconnects; they do not measure total Fetch/parser allocation, deployed resource limits, CPU quotas or sustained production throughput.

The controlled outbound responder does not emulate Cloudflare's edge translator; `verification/workers.json` keeps `cloudflareTranslation: false`. Local assertions on Fetch options establish the adapter's request contract only. Real gateway translation is exercised separately through Envoy, including the official emulator suite; deployed conversion results remain a separate check.

Protocol tests include frame flags, deterministic message/chunk splits, every truncation position in fixed vectors, base64 forms and budgets. Native differential tests compare selected callback/metadata/status/data/error/end behavior. Real Envoy tests are distinct from the hand-built controlled bridge.

The required `test:workerd:lifecycle` gate exercises the installed package through
two separate Workers and an HTTP service binding. Its 39 cases include all four
synchronous/asynchronous interceptor startup and send combinations, both deferred
completion orders, stalled-start cancellation/default deadlines/channel closure,
late continuations, raw stream destruction/iterator exit, and successful reuse.
It also checks oversized initial/trailing metadata returns a readable gRPC error,
failed channel construction leaves global configuration available, and deterministic
clock boundaries retain the correct deadline status and timeout encoding.

The gate makes 70 logical calls and 54 binding Fetch calls. All response readers,
timers and active calls must be released before runtime disposal, including six
cancelled response readers. Backend finalization may use the RPC deadline when
an idle service binding does not promptly propagate cancellation. Two upload cases
use an independent peer to verify client/bidirectional streaming frames and EOF;
the public Fetch server still does not register request-streaming handlers. The
positive deadline-boundary case asserts the original `1m` timeout header, then
widens it to five seconds only for the separate backend echo, avoiding a test that
depends on completing cross-Worker I/O within one millisecond. Reports retain
installed runtime and fixture hashes; source builds cannot satisfy the CI gate.
Eight resource cases share admission across clients from one transport, terminate
queued calls on cancellation/deadline before Fetch, reject queue overflow, and
recover capacity. They also reject oversized outgoing buffers and compressed
responses within a shared byte budget, then reuse the same client. A gzip stream
with readable high-water mark one advances one queued message at a time while an
independent call from the same transport proceeds during held authentication.
Every resource case requires zero admitted/queued calls and adapter-owned bytes at
completion. These counters exclude arbitrary deserialized objects, platform
buffers and total isolate memory. See [resource limits](resources.md).

See [interceptor ordering](interceptors.md) and [call lifecycle](call-lifecycle.md).

### Reproducible property fuzzing

`test/wire-fuzz.test.cjs` retains the fixed regression corpus. Additional `*-property.test.cjs` files use the pinned development dependency [fast-check](https://fast-check.dev/docs/configuration/). These are generated, property-based tests with shrinking, not coverage-guided native fuzzing. They run automatically in `npm test`, `npm run verify`, and the existing GitHub Actions workflow.

The framing properties compare bounded arbitrary and mutated byte streams against an independent whole-buffer protocol oracle. They also vary empty chunks, fragmentation, byte offsets, early consumer exit and errors, checking frame preservation and reader cleanup. Lifecycle properties vary controlled asynchronous events in both transport modes and check single terminal delivery, routing isolation and resource cleanup. They use synthetic local responses, not cloud services.

Two schedule properties specifically vary interceptor metadata/message/half-close
continuations and their interaction with authentication, deadlines, parent
cancellation and channel closure. They retain transformed requests, check ordering
after each generated transition, reject duplicate terminal delivery, and verify
that late continuations cannot start Fetch after termination. The fixed ordering
regressions preserve the smallest previously failing two-message schedule.

The standalone default is 80–250 cases per property, depending on the bounded protocol or schedule test, with seed `1470698469` (`0x57a913e5`), including explicit boundary examples where supplied. Inputs and action lists have explicit size bounds. Asynchronous properties have a 120-second test timeout, and the Node fuzz subprocess has a 180-second bound; exceeding either fails the run. Increase the run count and vary the seed for a longer local campaign:

```sh
npm run test:fuzz
WGA_FUZZ_SEED=20260923 WGA_FUZZ_RUNS=2000 npm run test:fuzz
WGA_FUZZ_SEED=-314159 WGA_FUZZ_RUNS=2000 npm run test:fuzz
```

`WGA_FUZZ_SEED` accepts a signed 32-bit decimal integer; `WGA_FUZZ_RUNS` accepts 1–100000. These settings affect the new property tests, not the older fixed corpus. A failing property reports its seed, shrink path, reduced counterexample and original assertion. Keep the pinned dependency version when replaying. Select the exact failing test with `--test-name-pattern`, then supply the reported seed and path via `WGA_FUZZ_SEED` and `WGA_FUZZ_PATH`; replay stops at that counterexample without further shrinking.

```sh
# Replace the seed/path and test name with those from the failing run.
WGA_FUZZ_SEED=1470698469 WGA_FUZZ_PATH='0' npm run test:fuzz -- \
  '--test-name-pattern=^FUZZ property arbitrary and mutated wire bytes match an independent framing oracle$'
```

`verify` also requires `test:fuzz:ci`, which runs all 16 Node properties at 1,000
executions each for seeds `1470698469` and `20260927`: 32,000 property executions.
It runs four workerd properties at 150 executions each for the same seeds: 1,200
generated samples. Each sample executes both modes and a recovery RPC on the same
channel. Another 46 fixed protocol boundaries run per seed, making 5,168 workerd
RPCs in the CI campaign. Counts include fast-check's explicit examples where
configured; they are not coverage measurements.

The Node server properties exercise the public Fetch handler using independent
frame/trailer parsing and Node zlib. They cover compression negotiation, input
fragmentation, malformed requests rejected before handlers run, independent
receive/send limits and iterator cleanup after cancellation. A discovered abort
race now has a deterministic regression: reading a terminal trailer cannot call
`next()` after the application iterator has been disposed.

The workerd fuzzer generates bytes in Node and sends them to an independent peer
Worker through a real [HTTP service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/).
It checks unary and stream payloads/statuses, binary metadata, compressed and
mixed records, truncated/oversized frames, bad flags, missing/duplicate trailers
and frames after trailers. Generated stream cuts are checked against whole-frame
boundaries. Since service bindings can coalesce chunks, an instrumented response
wrapper also injects empty and offset views at the parser boundary. Reader locks,
body cancellation, single terminal delivery and successful channel reuse are
asserted after every case. This is local workerd with mode-shaped requests, not
the private edge conversion service.

A failed campaign retains completed counts, seed, shrink path, reduced
counterexample and reproduction command. Missing receipts, skipped/TODO properties,
timeouts and interrupted runs fail the gate. Negative controls verify the Node
runner catches skipped/TODO execution (including assertions after the property)
and can shrink and replay an injected failure.
Ambient seed/path/count overrides are cleared for the required campaign. To
replay a workerd failure, copy its reported command or specify one exact property:

```sh
WGA_WORKER_FUZZ_SEED=20260927 WGA_WORKER_FUZZ_RUNS=150 \
WGA_WORKER_FUZZ_PROPERTY=malformed-response WGA_WORKER_FUZZ_PATH='0' \
  npm run test:workerd:fuzz
```

`test:fuzz:extended` uses four fixed seeds (the CI pair plus `-314159` and
`8675309`), 5,000 executions per Node property and 750 per workerd property.
That is 320,000 Node property executions, 12,000 generated workerd samples and
48,736 workerd RPCs including fixed boundaries and recovery calls.
It runs nightly at 18:30 UTC and when **extended_fuzz** is selected in the manual
workflow dispatch. Pushes and pull requests require the smaller campaign as
part of the full gate. CI uploads per-seed JSON reports and private process logs
on success and failure. The extended report is separate, so it cannot overwrite
the required CI campaign's evidence. Concurrency groups include the trigger event:
manual and scheduled runs cannot cancel push or pull-request checks. A newer run
for the same workflow, ref and event still cancels its older run.
Prepare the installed fixtures before any
workerd or campaign command; these commands deliberately test the packaged code.

Save a confirmed failure as a focused regression test before fixing it. A passing campaign establishes only the tested properties and generated inputs; it does not certify all protocol behavior or Cloudflare's beta translator.

Benchmarks report local p50/p95 latency, cold require, bundle size, observed buffering and process memory for large/small/slow/concurrent cases. They do not establish ownership of Fetch allocator bytes or deployed Worker performance. Production budgets remain unset.

Workerd tests exercise static SDK imports, constructors, protobuf encoding/decoding/reflection, authentication headers, first RPCs and later invocations. The lazy SDK gate additionally starts with no SDK modules initialized, imports all three inside the first request, and repeats on a warm request with different credentials. It checks six RPCs, including Datastore explain metrics decoded through the separate `Struct` schema with nested objects, lists, nulls, strings, numbers and booleans. Negative controls reject missing build presets and mismatched profile/schema hashes. The preset does not manually patch installed node_modules or provide a generic require shim. Both new SDK gates are required by `verify` and CI.

The controlled shared workerd bridge buffers finite responses. The Worker SDK harness verifies client-visible cancellation; the resilience gate additionally observes interrupted loopback responses closing before disposal. Reports identify Wrangler, Miniflare, workerd and compatibility-date versions; local workerd is not a deployed Cloudflare account test.

## Evidence rules

`verification/report.json` aggregates subprocess results. The deliberately disabled live preflight remains blocked. Required local cases cannot be promoted from blocked or not-run to passed. Reports retain `releaseEligible: false`, and the original 189-case catalog stays separate from test-runner totals and supplemental scenarios.

The checked-in `compatibility/test-evidence.json` maps IDs to exact TAP names or report cases. Generated `verification/evidence.json` distinguishes covered, partial and unimplemented cases. A passed partial test remains partial.

The [public client contract guide](local-contracts.md) explains the dedicated
API, configuration and strict-type checks. Runtime rows retain callback and
status outcomes independently; native comparison and workerd execution are
required where the original case calls for them.

`verify` snapshots inputs before execution and checks current sources, installed runtime bytes, tarball integrity, locked dependencies, SDK candidates, build profiles, report contents and external process receipts afterward. `npm run test:evidence` rejects stale evidence. After input changes, prepare affected fixtures and rerun the complete gate. Downloaded CI reports describe that CI run; checking external process receipts requires the original runner's local log files.

The explicit retry gate (`node scripts/test-workers-retries.cjs`) checks 28 local
workerd scenarios across both modes and cold/warm requests: recovery, exhaustion,
nonretryable status, partial-response commitment, refreshed auth rejection,
cancellation and deadline interruption. It observes exactly 44 RPCs and fresh
credentials per attempt. Local CF mode checks do not emulate edge conversion.

`node scripts/test-health.cjs` compares standard health protobuf responses against
native grpc-js, then exercises 18 workerd scenarios across both transport modes.
It checks reconnect, disabled Watch, deadlines, caller abort and native cancellation
before isolate disposal. Decoder unit tests add 2,500 seeded malformed inputs.

`node scripts/test-workers-server.cjs` runs 120 local client-to-Fetch-handler RPCs
across both modes, three compression codecs and cold/warm calls. Eight additional
inbound wire cases use a native protobuf byte oracle. Unit tests compare actual
grpc-js server responses and cover invalid framing, metadata, lazy iteration,
timeout cleanup and late handler completion after cancellation.

`node scripts/test-modern-sdk.cjs` verifies the additional exact modern dependency
graph with six strict compiler configurations, shared native/adapter business
code, and cold/warm workerd requests in both modes (18 scenarios, 66 RPCs). It
compares Datastore legacy-key bytes with native encoders and rejects altered
schemas, versions and profile names. The original graph retains its existing gates.

`npm run test:request-streaming` verifies 11 public adapter streaming scenarios in
workerd through real Envoy, with three native baselines. The early-rejection case
verifies deadline cleanup while documenting delayed status delivery. The separate
raw `streaming-feasibility` gate records this boundary for both mode-shaped Fetch
requests without claiming deployed conversion. Three seeded request-body properties
exercise 320 bounded operation/codec cases in addition to focused stream tests.

`node scripts/test-firestore-watch.cjs` runs identical document/query listener code
under native grpc-js, the installed adapter, and two workerd invocations. Eight
cases assert 52 callbacks and 84 official-emulator RPC arrivals, including 16 real
Listen calls. It checks unsubscribe, reuse, response delivery before upload ends,
exact native comparisons and data/process cleanup. It provides no IAM or live-edge
certification. `npm run test:modern-firestore-watch` repeats these eight cases
with Firestore 9.2.0 and the separately pinned modern profile.

The supplemental implementations retain the original catalog's denominator.
The final implementation campaign also runs every fuzz/property file with
`WGA_FUZZ_RUNS=2500` and seeds `20260927` and `-179048`; this includes request-body
operation races and codec limits. These finite campaigns are regression evidence,
not proof that every malformed input or concurrency schedule is covered.


`npm run test:firestore-recovery` checks six Firestore 8.3.0 Watch scenarios
through real Envoy with a controlled native gRPC peer: UNAVAILABLE recovery,
HTTP/2 reset, target RESET, existence-filter mismatch, document removal and
target REMOVE denial. Native, Node adapter and cold/warm workerd execute identical
business code (24 cases, 36 Listen attempts, 27 Fetch requests and 48 callbacks).
The gate checks opaque resume-token bytes, reset token clearing, native-equivalent
snapshots, response-before-upload-end, unsubscribe and stream cleanup. This peer
is not an emulator or a live Google endpoint. See [Watch recovery](firestore-watch.md#bounded-recovery).

`npm run test:parent-calls` checks native server parents, strict structural type
compatibility and actual workerd Fetch-handler forwarding in both modes. Its
report is `verification/parent-calls.json`; see [parent calls](parent-calls.md).

The separate two-Worker integration gate uses the installed public client and
`./server` APIs over an actual service binding, with cold/warm invocations, both
modes, three codecs, binary metadata, concurrent credentials, remote and partial
stream errors, cancellation/deadlines/close and unaffected peer/reuse assertions.
All 72 cases (96 RPCs) require zero client calls and zero backend iterators before
runtime disposal. A canceled client does not prove immediate cleanup of an idle
backend: this runtime completed those handlers at their RPC deadlines. The test
explicitly retains their cleanup lifetime with `ctx.waitUntil`, records immediate
and deadline-triggered cleanup separately, and does not treat forced teardown as
successful cleanup. See [Fetch server lifecycle](server.md).
