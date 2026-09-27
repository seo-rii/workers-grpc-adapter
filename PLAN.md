# Roadmap

Status: `0.0.0-prototype.1`, September 27, 2026. This is an experimental client
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
  Verify both modes with unary and server-streaming calls in local workerd.
  Finite deployed conversion and Google SDK results are recorded separately;
  local workerd does not emulate Cloudflare's edge translator.
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
- [x] Support bundled first-request dynamic SDK imports and same-isolate
  GAX clients with independent modes, gateway origins and credentials.
- [x] Use native Workers Fetch for the pinned Gaxios default, preserving explicit
  overrides. Verify real OAuth/JWT refresh and exchange in both pinned auth versions.
- [x] Support the pinned legacy Google callback credential contract, with native
  comparisons, strict types and workerd cancellation/deadline checks.
- [x] Exercise URL-sourced federation and standalone/chained impersonation in
  workerd, including SDK credential JSON, renewal and denied-exchange recovery.
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
- [x] Add bounded property fuzzing with counterexample shrinking and seed/path
  replay for protocol parsing and asynchronous call lifecycle in both modes.
- [x] Repeat concurrent fault/recovery waves in workerd, checking channel/call
  cleanup, slow-consumer buffering and loopback response closure before disposal.
- [x] Compare multi-page Datastore queries and `end()`/`destroy()` behavior
  against native grpc-js, including a pending page and subsequent client reuse.
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
- [ ] Extend SDK stream tests to remaining remote-error, event-order and
  internal cleanup contracts. Controlled multi-page tests now distinguish
  `end()` stopping later pages from `destroy()` stopping only entity delivery.
  These SDK readables do not expose cancellation of an in-flight unary page.
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

- [x] Compare manual/automatic/async-iterator pagination, early iterator exit,
  callback/Promise binary secret-version access and remote errors across native,
  adapter and workerd. Use synthetic payloads with no secret contents in reports.
- [x] Check consumer CRC32C handling, including empty bytes and a corrupted
  checksum returned successfully by the SDK. The SDK does not validate it.
- [ ] Complete the remaining metadata and method-specific error combinations.
- [ ] Add further SDKs only after inspecting their required exports, options,
  schemas and runtime behavior. Do not infer universal Google Cloud support.

### Resource and API contracts

- [ ] Finish the remaining original catalog cases and finer grpc-js contracts.
- [ ] Measure exact adapter-owned bytes, parser CPU, cold initialization,
  bundle size and p50/p95 latency under large, fragmented, slow and concurrent
  workloads. Define numerical budgets from reproducible measurements.
- [ ] Extend authentication beyond the tested URL external-account and
  impersonation combinations to file/executable/AWS/Azure sources and automatic
  ADC discovery. Live provider trust and IAM authorization remain cloud gates.

## Cloud and release gates

These require a separately authorized test environment. Normal CI stays local.

- [x] Verify per-request Cloudflare conversion and explicit gateway paths with
  deployed unary, streaming and non-OK calls. See the corrected 2026-09-26 probe;
  historical deployment results do not certify later changes automatically.
- [ ] Extend deployed checks to controlled deadline/cancellation faults and
  prolonged traffic, quotas and recovery.
- [ ] Prepare a dedicated Google Cloud project with least-privilege credentials,
  enabled APIs, databases and bounded quotas.
- [x] Run finite live Datastore/Firestore CRUD and transaction suites plus
  Secret Manager metadata GetSecret through protected temporary Workers in both
  modes, with explicit write opt-in and all created resources deleted.
- [x] Record resource ownership and incomplete cleanup, and verify cleanup
  failure behavior locally. Name-based Cloudflare mutations remain non-atomic;
  a canceled client request does not prove a server-side write was canceled.
- [ ] Validate production IAM, token renewal, database constraints and
  performance separately from emulator behavior.
- [ ] Complete dependency, security, license and release-allowlist review before
  removing `private: true` or choosing a published npm version.

Generated reports must continue to state `releaseEligible: false` until the
release gates are met. See the [original specification](docs/spec/v0.3.md)
(Korean, historical), [case catalog](compatibility/test-catalog.json) and
[case mappings](compatibility/test-evidence.json) for the detailed requirements.
