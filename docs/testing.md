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
| `npm run test:fuzz` | Fixed framing corpus and shrinking property tests for framing and call lifecycle | Console, including seed/path and counterexample on failure |
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
| `node scripts/test-secret-manager-extended.cjs` | Native/adapter/workerd Secret Manager pagination, binary payloads, checksum handling and errors | `verification/secret-manager-extended.json` |
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

The extended Secret Manager gate runs the same business source under native grpc-js, the Node adapter and both workerd modes against a controlled native service. It verifies manual Promise/callback pagination, automatic pagination, async iteration and early iterator exit using exact page-token and RPC counts. AccessSecretVersion cases preserve binary bytes, including a 64 KiB callback payload and an empty value. CRC32C checks include known vectors and a deliberately corrupted checksum: the SDK resolves that response, while the consumer rejects its integrity. Payloads are synthesized in memory and never included in reports or error diagnostics. This is local RPC compatibility evidence, not a Secret Manager emulator or live secret access.

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

### Reproducible property fuzzing

`test/wire-fuzz.test.cjs` retains the fixed regression corpus. Additional `*-property.test.cjs` files use the pinned development dependency [fast-check](https://fast-check.dev/docs/configuration/). These are generated, property-based tests with shrinking, not coverage-guided native fuzzing. They run automatically in `npm test`, `npm run verify`, and the existing GitHub Actions workflow.

The framing properties compare bounded arbitrary and mutated byte streams against an independent whole-buffer protocol oracle. They also vary empty chunks, fragmentation, byte offsets, early consumer exit and errors, checking frame preservation and reader cleanup. Lifecycle properties vary controlled asynchronous events in both transport modes and check single terminal delivery, routing isolation and resource cleanup. They use synthetic local responses, not cloud services.

The default is 200 cases per property with seed `1470698469` (`0x57a913e5`), including explicit boundary examples where supplied. Inputs and action lists have explicit size bounds. Each property has a 120-second test timeout; exceeding it fails the run. Increase the run count and vary the seed for a longer local campaign:

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

Save a confirmed failure as a focused regression test before fixing it. A passing campaign establishes only the tested properties and generated inputs; it does not certify all protocol behavior or Cloudflare's beta translator.

Benchmarks report local p50/p95 latency, cold require, bundle size, observed buffering and process memory for large/small/slow/concurrent cases. They do not establish ownership of Fetch allocator bytes or deployed Worker performance. Production budgets remain unset.

Workerd tests exercise static SDK imports, constructors, protobuf encoding/decoding/reflection, authentication headers, first RPCs and later invocations. The lazy SDK gate additionally starts with no SDK modules initialized, imports all three inside the first request, and repeats on a warm request with different credentials. It checks six RPCs, including Datastore explain metrics decoded through the separate `Struct` schema with nested objects, lists, nulls, strings, numbers and booleans. Negative controls reject missing build presets and mismatched profile/schema hashes. The preset does not manually patch installed node_modules or provide a generic require shim. Both new SDK gates are required by `verify` and CI.

The controlled shared workerd bridge buffers finite responses. The Worker SDK harness verifies client-visible cancellation; the resilience gate additionally observes interrupted loopback responses closing before disposal. Reports identify Wrangler, Miniflare, workerd and compatibility-date versions; local workerd is not a deployed Cloudflare account test.

## Evidence rules

`verification/report.json` aggregates subprocess results. The deliberately disabled live preflight remains blocked. Required local cases cannot be promoted from blocked or not-run to passed. Reports retain `releaseEligible: false`, and the original 189-case catalog stays separate from test-runner totals and supplemental scenarios.

The checked-in `compatibility/test-evidence.json` maps IDs to exact TAP names or report cases. Generated `verification/evidence.json` distinguishes covered, partial and unimplemented cases. A passed partial test remains partial.

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
