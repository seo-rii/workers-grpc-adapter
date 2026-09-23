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
| `npm run test:types` | Adapter consumers in strict Node16/NodeNext/Bundler modes | `verification/types.json` |
| `npm run test:sdk:types` | Real SDK declarations compared with the native baseline | `compatibility/google-types.json` |
| `npm run test:sdk:local` | Shared native/adapter SDK behavior against controlled servers | `compatibility/google-local.json` |
| `npm run test:differential` | Callback, metadata, status and stream events against native grpc-js | `verification/native-differential.json` |
| `npm run test:envoy` | Real Envoy gRPC-Web → native grpc-js, including cancellation/deadlines | `verification/envoy.json` |
| `npm run test:auth` | Real OAuth2Client and JWT logic over injected token/RPC transports | `verification/google-auth.json` |
| `npm run test:contract` | Root/deep CJS/ESM identity and transport import boundaries | `compatibility/exports-contract.json` |
| `npm run test:pack` | Actual tarball, alias negative control, root override and npm ci | `verification/packaging.json` |
| `npm run test:workers` | Static alias import and basic RPC in workerd | `verification/workers.json` |
| `npm run test:workers:sdk` | SDK bootstrap, protobuf preset and workerd RPCs | `verification/workers-sdk.json` |
| `npm run test:workers:shared` | Identical native/workerd business modules and controlled faults | `verification/workers-shared.json` |
| `npm run test:emulators` | Official Native/Datastore emulators with native, Node adapter and workerd consumers | `verification/google-emulators.json` |
| `npm run test:emulators:lifecycle` | Startup/running signal handling and repeated stop cleanup | `verification/emulator-lifecycle.json` |
| `npm run test:evidence` | Current source, lock, artifact, process receipt and case-evidence consistency | `verification/evidence.json` |
| `npm run test:benchmark` | Optional local Node latency, buffering and concurrency measurements | `verification/benchmark.json` |
| `npm run test:google` | Separate live opt-in path; blocked by default | `verification/google-preflight.json`, then `verification/google-live.json` if executed |

`node vendor/verify.cjs` validates upstream and patched source hashes and reproduces the patches. `test:evidence` checks an existing completed verification run; `verify` creates the evidence file. The benchmark and live runner are not required live executions in the local gate.

## Native SDK comparisons

`fixtures/native` installs grpc-js 1.14.0, while `fixtures/google` installs the replacement. Doctor reports record the dependency graph and integrity. The consumers execute identical shared business bytes and compare their hashes, RPC methods/statuses and binary gRPC-Web content types.

Controlled cases cover Datastore/Firestore CRUD, query, transaction and read-stream behavior; missing Firestore documents; unsupported Listen; and Secret Manager success, permission and missing-resource errors. Fault cases include Datastore `ABORTED`, an applied Commit whose response is withheld until a deadline, and a Firestore conflict followed by exactly one SDK transaction retry. Follow-up reads distinguish a failed response from a write that never happened.

SDK declarations are checked in strict ESM and CJS Node16/NodeNext/Bundler modes with `skipLibCheck: false`. Both fixtures replace auth 10.5.0 with official 10.9.1 while retaining auth 11.1.0. Their auth versions and integrity must match.

Authentication tests use real OAuth2Client/JWT/Gaxios logic with controlled transports. They check token refresh, concurrency, credential isolation, cancellation, JWT signatures, exchange claims and reuse. They do not contact Google's token endpoint or establish live OAuth/IAM behavior.

## Official database emulators

The harness starts pinned Firestore 1.22.0/Java 21 processes in Native and Datastore modes on independent loopback ports. Real Envoy 1.39.1 translates each gRPC-Web request. Every registered suite runs under native grpc-js, the Node adapter and two workerd invocations, using the same shared files.

The report compares business assertions, source SHA-256 values and method/status counts. Each adapter Fetch must have a corresponding upstream arrival. Envoy's router **upstream access log** records status because the downstream gRPC-Web filter consumes trailers. Logs record RPC paths and status, not document or token payloads.

Firestore's emulator BatchWrite path needs emulator owner authorization. Local Envoy injects synthetic `Bearer owner` only toward Firestore. Clients use neither real credentials nor ADC and do not send credentials over plaintext. The workerd host bridge adjusts HTTP framing headers while forwarding protobuf bytes and the streaming response.

Datastore scenarios cover data types, namespace/ancestor keys, batch/missing lookup, callback/Promise shapes, query cursors/projection, aggregation, ID allocation/reservation, rollback, read streams and early destruction. Firestore scenarios cover data types, getAll/field masks, query cursors, aggregation, transforms, rollback and BulkWriter. Both exercise `ALREADY_EXISTS`, `NOT_FOUND` and failed-write atomicity; Firestore also checks stale-precondition `FAILED_PRECONDITION`.

The SDK stream-destruction case fits in a single unary query page. It checks subsequent delivery and client usability, not multi-page suppression or internal adapter resource release. See [limitations](limitations.md).

Emulators use memory and temporary working directories. The launcher records restricted logs, PIDs and exit receipts. Lifecycle tests check SIGINT/SIGTERM propagation, Java process exit, working-directory removal and idempotent stop. Only download caches are retained. [Google documents emulator differences](https://docs.cloud.google.com/firestore/native/docs/emulator), including transactions, indexes and limits; passing these scenarios does not certify production behavior.

## Protocol, resources and Workers

Protocol tests include frame flags, deterministic message/chunk splits, every truncation position in fixed vectors, base64 forms and budgets. Native differential tests compare selected callback/metadata/status/data/error/end behavior. Real Envoy tests are distinct from the hand-built controlled bridge.

Benchmarks report local p50/p95 latency, cold require, bundle size, observed buffering and process memory for large/small/slow/concurrent cases. They do not establish ownership of Fetch allocator bytes or deployed Worker performance. Production budgets remain unset.

Workerd tests exercise static SDK imports, constructors, protobuf encoding/decoding/reflection, authentication headers, first RPCs and later invocations. Negative controls reject missing build presets and mismatched profile/schema hashes. The preset does not manually patch installed node_modules or provide a generic require shim.

The controlled shared workerd bridge buffers finite responses. Incremental cancellation evidence comes from the separate Worker SDK harness. Reports identify Wrangler, Miniflare, workerd and compatibility-date versions; local workerd is not a deployed Cloudflare account test.

## Evidence rules

`verification/report.json` aggregates subprocess results. The deliberately disabled live preflight remains blocked. Required local cases cannot be promoted from blocked or not-run to passed. Reports retain `releaseEligible: false`, and the original 189-case catalog stays separate from test-runner totals and supplemental scenarios.

The checked-in `compatibility/test-evidence.json` maps IDs to exact TAP names or report cases. Generated `verification/evidence.json` distinguishes covered, partial and unimplemented cases. A passed partial test remains partial.

`verify` snapshots inputs before execution and checks current sources, installed runtime bytes, tarball integrity, locked dependencies, SDK candidates, build profiles, report contents and external process receipts afterward. `npm run test:evidence` rejects stale evidence. After input changes, prepare affected fixtures and rerun the complete gate. Downloaded CI reports describe that CI run; checking external process receipts requires the original runner's local log files.
