# Google SDK test guide

The fixtures exercise real Google Node SDK packages with the adapter installed as `@grpc/grpc-js`. Local controlled servers, official emulators and opt-in live tests are separate execution paths. Shared business functions keep ordinary SDK imports, constructors and method calls unchanged.

## Pinned packages

| Package | Version |
|---|---|
| `@google-cloud/datastore` | `10.1.0` |
| `@google-cloud/firestore` | `8.3.0` |
| `@google-cloud/secret-manager` | `7.1.0` |
| Native `@grpc/grpc-js` baseline | `1.14.0` |

`fixtures/google/package-lock.json` and `fixtures/native/package-lock.json` lock the adapter and native dependency graphs. `npm run fixtures:install` packs the current source, updates local tarball integrity and installs the isolated Google, native and Worker fixtures with `npm ci`.

A consumer's root override must replace every grpc-js path used by its SDKs. `npm run doctor` checks SDK dependency closures, GAX locations and root/deep import resolution and prints its report. Fixture installation saves the graph in `compatibility/google-graph.json`. The fixtures override only `google-auth-library@10.5.0` with the official `10.9.1` artifact to resolve a Node16 declaration conflict. The graph's auth `11.1.0` remains unchanged. Native and adapter consumers must have matching auth versions and integrity and pass strict ESM/CJS declaration checks.

## Shared scenarios

Business functions live in `fixtures/google/shared/`. The live registry is [fixtures/google/suites.mjs](../fixtures/google/suites.mjs):

| Suite | Operations |
|---|---|
| `datastore-crud` | Save, lookup, query, delete and cleanup |
| `datastore-transaction` | Initialize, begin, read, save, commit and verify |
| `firestore-crud` | Set, read, query, delete and terminate |
| `firestore-transaction` | Initialize, run a transaction, verify and clean up |
| `secret-manager-read` | Read secret metadata and close the client |

`npm run test:sdk:local` compares native grpc-js and adapter consumers against controlled local services. It also covers read streams, early destruction, missing documents, unsupported Listen, Secret Manager errors and transaction faults. `npm run test:workers:shared` runs the shared modules in workerd. Local-only faults are registered in `shared/controlled-suites.mjs`; they are not sent to a live project.

## Official emulators

After the fixture installation in [testing](testing.md), run:

```sh
node fixtures/envoy/download.cjs
npm run emulators:install
npm run test:emulators
npm run test:emulators:lifecycle
```

The launcher starts the pinned official Firestore emulator in separate Native and Datastore modes. Real Envoy translates gRPC-Web to their native gRPC endpoints. `shared/emulator-suites.mjs` registers the original CRUD/transaction functions and additional data-model, query, aggregation, rollback, error, BulkWriter and SDK stream scenarios.

Every suite runs with native grpc-js, the Node adapter and two separate workerd invocations. The harness compares the exact shared source bytes, business assertions, upstream method/status counts and adapter Fetch arrivals. Emulator RPC responses are not mocked. Reports are written to `verification/google-emulators.json` and `verification/emulator-lifecycle.json` and included in CI evidence artifacts. See the [emulator fixture guide](../fixtures/emulators/README.md) for toolchain and process details.

These tests provide local behavior evidence. They do not establish live IAM, quotas, index requirements or production transaction concurrency. Secret Manager has no official emulator in this harness.

## Adding a scenario

1. Add a shared function that imports the real SDK and returns an array of successful check names. Keep user data and secret payloads out of that array.
2. For writes, call `requireWrites(context)` before doing work. Use `context.runId` and a dedicated namespace or collection to isolate records.
3. Use `withCleanup()` or `try/finally` to remove only records created by the case. Preserve both the original error and any cleanup error.
4. Register it in the appropriate live, controlled or emulator registry. Keep controlled fault scenarios out of the live registry.
5. When adding a live SDK or suite, update `scripts/google-test.cjs` package selection and the dependency/doctor checks.
6. Execute identical shared file bytes in native and adapter consumers and record their SHA-256 hashes. Extend the corresponding harness and exact evidence mapping.

The Datastore cases include scalar and batch lookup, namespaces, ancestor keys, integer wrappers, bytes, dates, geopoints, cursors, projection, aggregation, allocated/reserved IDs, rollback and SDK read streams. Deferred lookup, additional limits and production behavior remain gaps.

Firestore cases include BatchGetDocuments, RunQuery, RunAggregationQuery, field transforms, data types, rollback and unary BatchWrite through BulkWriter. Listen/Watch remains unsupported. Additional transaction concurrency and service limits need separate evidence.

Secret Manager currently covers metadata reads and controlled permission/not-found errors. If adding `accessSecretVersion`, compare payloads only inside assertions; do not put them in HTTP responses, snapshots or logs.

## Opt-in live configuration

The [environment example](../fixtures/google/.env.example) documents variables; it is not loaded automatically. Supply them through the process environment or Worker bindings. The harness does not write credentials to reports.

| Variable | Meaning |
|---|---|
| `WGA_RUN_GOOGLE_TESTS=1` | Explicit permission for live requests |
| `WGA_ALLOW_TEST_WRITES=1` | Explicit permission for test writes and cleanup |
| `WGA_GOOGLE_SUITES` | Comma-separated registered live suite IDs |
| `WGA_DATASTORE_PROJECT` | Dedicated Datastore test project |
| `WGA_FIRESTORE_PROJECT` | Dedicated Firestore test project |
| `WGA_SECRET_MANAGER_PROJECT` | Secret Manager metadata-read project |
| `WGA_GOOGLE_CREDENTIALS_JSON` | Test service account with `client_email` and `private_key` |
| `WGA_DATASTORE_DATABASE`, `WGA_FIRESTORE_DATABASE` | Optional database IDs |
| `WGA_SECRET_NAME` | Resource name such as `projects/PROJECT/secrets/NAME` |
| `WGA_TRANSPORT_MODE` | Node: `grpc-web`; Worker: `cloudflare` or `grpc-web` |
| `WGA_ENDPOINTS_JSON` | Logical authority → trusted gateway origin mappings |
| `WGA_TEST_KEY` | Worker-only bearer secret, at least 32 characters |

Datastore and Firestore accept separate project/database settings. Prepare dedicated resources, permissions, API enablement and quotas independently; the harness does not provision them. Do not assume one default database suits both modes.

Run `npm run test:google` only after configuring the intended live test environment. Without explicit opt-in it exits as blocked, with no Google API request. Its preflight report is `verification/google-preflight.json`; completed Node live scenarios write `verification/google-live.json`.

Node rejects `cloudflare` mode because its Fetch does not provide the Cloudflare translation path. A Node live test needs a trusted gRPC-Web gateway. No public gateway is supplied.

## Test Worker

[fixtures/google/worker.mjs](../fixtures/google/worker.mjs) accepts authenticated POST requests only for fixed registered suite names. Request bodies cannot override the destination, credentials or project. The checked-in configuration disables `workers_dev` and sets live/write opt-ins to zero.

Wrangler's custom build runs the pinned Google SDK preset before its Node compatibility transforms. This is required: pointing Wrangler directly at the source entry does not prepare the SDK graph for Workers. Build the actual live entry without deploying:

```sh
node fixtures/worker/node_modules/wrangler/bin/wrangler.js deploy \
  --dry-run --cwd fixtures/google --config wrangler.jsonc
node scripts/test-google-worker-build.cjs
```

Use `--cwd fixtures/google`: the custom build command resolves from that working directory. Generated files and the source/version/hash manifest are under `.wga-build/google-live/`. The focused test verifies the real entry and shared suites are bundled, then runs authenticated, unauthenticated, disabled and write-denied requests in workerd with outbound access denied. It is included in `npm run verify`.

The separate [temporary deployed probe](cloud-probe.md) exercises public protocol endpoints and SDK bootstrap with Google API calls disabled. The intended response from a correctly configured live test Worker is a suite status and check-name array.

The [temporary GCP deployment test](gcp-cloud-probe.md) uses its own protected entry and short-lived `gcloud` tokens. On 2026-09-24, all five shared Google suites passed with native grpc-js and a deployed Worker using an explicit Envoy gateway. Secret Manager coverage was metadata `GetSecret` only; no secret version or payload was accessed. Automatic-mode calls failed against both the controlled native origin and Google APIs on the tested account; the initial run did not identify the cause. These finite live observations do not establish credential refresh, other authentication flows, or production readiness, and do not change the local verification gates.

The [2026-09-26 follow-up](cloudflare-conversion.md) identified the omitted conversion setting and the Google `+proto` content-type incompatibility. The adapter now selects `cf.grpcWeb: 'convert'` and bare binary `application/grpc-web` for `cloudflare` mode; `grpc-web` uses `passthrough` and `application/grpc-web+proto`. These per-request controls remove the need for a Worker-wide conversion flag. Raw wire controls and the full SDK deployment suites remain separate evidence.

The [corrected deployment run](gcp-cloud-probe.md#corrected-results-2026-09-26) passed all five shared SDK suites in each Worker mode and in the native baseline. Both Workers used only `nodejs_compat`, with authenticated readiness verified before executing the suites. This establishes the tested direct and gateway paths with short-lived user tokens; production authentication lifecycles and recovery remain release gates.

The GCP probe keeps static SDK imports and one Worker per transport mode for a controlled deployment comparison. These are no longer requirements for the pinned adapter graph: the local mixed-mode gate runs all three SDKs with default, direct and two gateway configurations in one isolate, while the lazy-import gate initializes the SDKs during the first request. Use `gaxOptions()` for each independently configured SDK client and bundle all SDK code through the pinned build preset. The historical cloud runs do not by themselves verify these newer local capabilities.

## Interpreting failures

Missing configuration is blocked, not passed. REST fallback does not count as adapter success: Firestore uses `preferRest: false`, and applicable GAPIC clients use `fallback: false`; transport observations must confirm the RPC path.

A timeout or cancellation does not undo a server-side write. A lost Commit response may leave the outcome uncertain even if the SDK subsequently invokes Rollback. Measure SDK retries separately from Fetch attempts per adapter Call.
