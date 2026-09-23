# Roadmap

Status: `0.0.0-prototype.1`, September 23, 2026. This is an experimental client
transport, not a certified replacement for all of `@grpc/grpc-js`.

The project implements the client-side unary and server-streaming surface over
binary gRPC-Web and Fetch. Its current scope is the pinned SDK and runtime
combinations exercised by the test suite. Runtime support and remaining
differences are documented in [Limitations](docs/limitations.md).

## Implemented and locally verified

- [x] Build TypeScript into CommonJS, ESM and declaration entry points without
  external runtime dependencies.
- [x] Reuse the `@grpc/grpc-js@1.14.0` client, factory, metadata and interceptor
  code with a small transport boundary. Preserve upstream sources, licenses,
  patches, npm integrity and file hashes under `vendor/`.
- [x] Implement binary framing and trailers, metadata, endpoint mapping,
  deadlines, cancellation, message limits, and one Fetch request per Call.
- [x] Support direct service routing for Cloudflare automatic translation
  (`cloudflare`, the default) and explicit gRPC-Web gateway fallback (`grpc-web`).
  Verify both modes with unary and server-streaming calls in local workerd;
  deployed private-beta translation remains a separate cloud gate below.
- [x] Install pinned Datastore, Firestore and Secret Manager SDKs in isolated
  native and replacement fixtures. Verify alias/override resolution and clean
  `npm ci` reproduction.
- [x] Check adapter declarations and actual SDK consumers with strict
  Node16, NodeNext and Bundler resolution in ESM and CommonJS. Apply the same
  narrow `google-auth-library@10.5.0` to `10.9.1` override to both SDK fixtures;
  retain Secret Manager's separate `11.1.0` dependency.
- [x] Compare native grpc-js with the adapter using controlled servers and real
  Envoy, including non-OK trailers, deadlines, cancellation and stream events.
- [x] Exercise actual Google auth libraries against local test transports:
  OAuth token refresh, failures, concurrent requests, credentials isolation,
  cancellation, and temporary service-account JWT signing and exchange.
- [x] Bundle the pinned Google SDKs with the version/hash-checked build preset
  and run static imports, protobuf initialization, auth and RPCs in workerd.
- [x] Run identical shared business modules in native Node, replacement Node
  and workerd. Compare consumed source hashes, assertions and RPC/status counts.
- [x] Run the official Firestore emulator in Native and Datastore modes through
  real Envoy. Cover data types, CRUD, queries, pagination, aggregation,
  transactions, rollback, SDK streams, BulkWriter, remote error codes and
  failed-write atomicity.
- [x] Verify emulator startup, normal shutdown, SIGINT, SIGTERM and repeated
  cleanup without cloud credentials or persistent database state.
- [x] Run deterministic framing fuzz cases, lifecycle stress checks and a local
  performance measurement harness.
- [x] Map the original 189 planned cases to named execution evidence, keeping
  complete, partial and unimplemented cases distinct. Detect drift in sources,
  locks, installed code, artifacts, profiles and generated reports.

The full local gate covers core tests and 80 official-emulator scenario
executions (20 scenarios in four execution groups). Execution counts and results
are recorded in `verification/report.json`; they do not mean all 189 original
specification cases are satisfied.
GitHub Actions reruns the gates and publishes reports as workflow artifacts.
See [Testing](docs/testing.md) for the commands and report inventory.

## Remaining local compatibility work

### Datastore

- [ ] Add deferred lookup results and the remaining batch/error combinations.
- [ ] Extend SDK stream tests to remote errors, multiple pages and all relevant
  event-order and internal cleanup contracts. Current emulator tests cover
  normal data/info/end, found/missing entities, early destroy and subsequent
  client use. These SDK readables wrap unary query pages; they do not establish
  HTTP/2 stream cancellation.
- [ ] Broaden callback/Promise overload and GAX-option coverage beyond the
  pinned dependency graph. Allocation and reservation of IDs are already tested.
- [ ] Complete the retry and transaction error matrix. Controlled tests already
  exercise ABORTED and a committed write whose response is lost; emulator tests
  exercise duplicate inserts, missing updates and failed-commit atomicity.

### Firestore

- [ ] Extend BatchGetDocuments and RunQuery coverage to remaining intermediate
  stream failures and event variants.
- [ ] Broaden transaction contention and retry cases beyond controlled local
  faults and the emulator's simplified locking behavior.
- [ ] Complete method/version-specific compatibility evidence. Keep Listen and
  other bidirectional methods explicitly unsupported; do not substitute REST
  or polling for those methods.

### Secret Manager and additional SDKs

- [ ] Add pagination and the remaining metadata/error cases. Controlled local
  tests already cover reads, NOT_FOUND and PERMISSION_DENIED.
- [ ] Test accessSecretVersion with assertions that never log secret payloads.
- [ ] Add further SDKs only after inspecting their required exports, options,
  schemas and runtime behavior. Do not infer universal Google Cloud support.

### Resource and API contracts

- [ ] Finish the remaining original catalog cases and finer grpc-js contracts.
- [ ] Measure exact adapter-owned bytes, parser CPU, cold initialization,
  bundle size and p50/p95 latency under large, fragmented, slow and concurrent
  workloads. Define numerical budgets from reproducible measurements.
- [ ] Extend authentication coverage to legacy callbacks, WIF, impersonation
  and ADC combinations that are not currently certified.

## Cloud and release gates

These require a separately authorized test environment. Normal CI stays local.

- [ ] Verify outbound gRPC translation availability on the target Cloudflare
  account and run deployed unary, streaming, non-OK, deadline and cancel tests.
- [ ] Prepare a dedicated Google Cloud project with least-privilege credentials,
  enabled APIs, databases and bounded quotas.
- [ ] Run live Datastore, Firestore and Secret Manager tests through a protected
  Worker endpoint with fixed suites and explicit write opt-in.
- [ ] Record and recover incomplete cleanup safely. A canceled client request
  does not prove that a server-side write was canceled.
- [ ] Validate production IAM, token renewal, database constraints and
  performance separately from emulator behavior.
- [ ] Complete dependency, security, license and release-allowlist review before
  removing `private: true` or choosing a published npm version.

Generated reports must continue to state `releaseEligible: false` until the
release gates are met. See the [original specification](docs/spec/v0.3.md)
(Korean, historical), [case catalog](compatibility/test-catalog.json) and
[case mappings](compatibility/test-evidence.json) for the detailed requirements.
