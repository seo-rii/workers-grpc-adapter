# Roadmap

Status: `0.0.0-prototype.1`, September 27, 2026. This is an experimental client
transport, not a certified replacement for all of `@grpc/grpc-js`.

The project implements the client-side unary and server-streaming surface over
binary gRPC-Web and Fetch, with opt-in client/bidirectional streaming through an
explicit gateway and a separate Fetch server for all four RPC shapes.
Its current scope is the pinned SDK and runtime
combinations exercised by the test suite. Runtime support and remaining
differences are documented in [Limitations](docs/limitations.md).

## Implemented and locally verified

- [x] Build TypeScript into CommonJS, ESM and declaration entry points without
  external runtime dependencies.
- [x] Reuse the `@grpc/grpc-js@1.14.0` client, factory, metadata and interceptor
  code with a small transport boundary. Preserve upstream sources, licenses,
  patches, npm integrity and file hashes under `vendor/`.
- [x] Implement binary framing and trailers, metadata, endpoint mapping,
  deadlines, cancellation, message limits, and one Fetch request per Call by default.
  Explicit bounded unary retry policies can opt into multiple attempts.
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

- [x] Compare deferred Lookup rounds, mixed found/missing results, callback/Promise
  get overloads, partial errors, bounded retries and deadlines against native grpc-js.
- [ ] Complete the remaining batch/error combinations beyond this controlled matrix.
- [ ] Extend SDK stream tests to remaining remote-error, event-order and
  internal cleanup contracts. Controlled multi-page tests now distinguish
  `end()` stopping later pages from `destroy()` stopping only entity delivery.
  These SDK readables do not expose cancellation of an in-flight unary page.
- [ ] Broaden callback/Promise overload and GAX-option coverage beyond the
  pinned dependency graph. Allocation and reservation of IDs are already tested.
- [x] Compare successful commit/query/rollback, read-only rejection, ABORTED,
  HTTP/2 resets before and after mutation application, generated-v1 Commit
  deadlines and crossed transaction IDs in both pinned SDK profiles across
  native grpc-js and both Node/workerd modes. Check same-client recovery and
  adapter resources before client close.
- [ ] Complete remaining transaction and retry contracts beyond that controlled
  matrix, including distinct credential providers for crossed transactions.
  The public generated-v1 and high-level Transaction.commit() promises have no
  cancellation handle. Explicit Commit cancellation remains unverified by this
  matrix. Emulator tests additionally exercise duplicate inserts, missing
  updates and failed-commit atomicity; production conflicts remain a separate gate.

### Firestore

- [x] Compare BatchGetDocuments and RunQuery failures before and after partial
  results in both pinned SDK profiles. Check permanent errors, transient retries,
  outstanding-document and cursor/read-time requests, stream event order,
  same-client recovery and resources before client termination.
- [ ] Broaden transaction contention and retry cases beyond controlled local
  faults and the emulator's simplified locking behavior.
- [ ] Complete method/version-specific compatibility evidence for experimental
  gateway Listen and other bidirectional methods. Require actual streaming
  emulator evidence; do not substitute REST or polling. Cloudflare automatic
  request streaming requires separate platform verification.

### Secret Manager and additional SDKs

- [x] Compare manual/automatic/async-iterator pagination, early iterator exit,
  callback/Promise binary secret-version access and remote errors across native,
  adapter and workerd. Use synthetic payloads with no secret contents in reports.
- [x] Check consumer CRC32C handling, including empty bytes and a corrupted
  checksum returned successfully by the SDK. The SDK does not validate it.
- [x] Compare `GetSecret`, `ListSecrets` and `AccessSecretVersion` method errors,
  callback/Promise failure shapes, repeated text/binary trailers, routing metadata
  and same-client recovery. Compare second-page errors through manual, automatic
  and async pagination with exact RPC and adapter-attempt accounting.
- [ ] Verify additional Secret Manager methods and live IAM/quota behavior
  separately; controlled responses cover the three methods above.
- [ ] Add further SDKs only after inspecting their required exports, options,
  schemas and runtime behavior. Do not infer universal Google Cloud support.

### Resource and API contracts

- [ ] Finish the remaining original catalog cases and finer grpc-js contracts.
- [x] Close all 11 configuration cases, all seven type cases and 15 public API
  cases with exact execution evidence. Retain `API-011` as partial for the
  independently reproduced native unary duplicate-response difference. See
  [Public client contracts](docs/local-contracts.md).
- [x] Measure both exact Google SDK profiles in actual workerd isolates: bundle
  size, startup, first/authenticated/warm RPCs, refresh coalescing, concurrent slow
  compressed streams and sampled heap/backing storage under local CI ceilings.
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

## Limitation implementation follow-up

- [x] Add isolated trusted Fetchers, including preconfigured Workers mTLS bindings.
- [x] Implement bounded identity/gzip/deflate message compression and independent
  decoded/wire limits, with native and workerd verification.
- [x] Add explicit bounded unary retry policies and standard remote health APIs.
- [x] Add a separate Fetch server API for all four RPC shapes, with lazy request
  streams, handler-kind types and two-Worker service-binding lifecycle checks.
- [x] Add shared endpoint retry throttling with recovery and observable decisions.
- [x] Decode bounded structured status details through an optional entry point,
  preserving the original RPC status and isolating custom decoder failures.
- [x] Declare SDK package/source/schema pins, transformation rules, capabilities
  and required checks; diagnose drift and bind cache identity to transformer bytes.
- [x] Support a second exact modern Google SDK dependency graph with strict types,
  native comparisons, static codec guards and cold/warm workerd tests.
- [x] Verify experimental gateway request streaming, cancellation and bounded
  upload lifecycle through real Envoy/workerd, including seeded operation races.
- [x] Verify pinned Firestore 8.3.0 and 9.2.0 document/query Listen through the official
  emulator: native, Node adapter and repeated workerd invocations, actual
  bidirectional responses, unsubscribe, reuse and cleanup.
- [x] Propagate parent deadlines/cancellation, including real native server parents
  and Fetch handler forwarding in workerd.
- [x] Close streaming uploads after a validated terminal status without skipping
  response EOF checks; verify bounded Firestore 8.3.0 and 9.2.0 resume/reset recovery.
- [x] Preserve terminal Listen errors before EOF in both pinned Worker build
  profiles; compare raw SDK behavior and verify transient/clean-EOF recovery.
- [ ] Separately validate newly added behavior in deployed Workers, including TLS
  handshakes and edge conversion; historical cloud receipts do not certify it.
- [ ] Keep custom Fetch TLS roots, native HTTP/2 servers, physical pooling and
  connection readiness outside this transport's supported architecture.

## Local integration and fuzz gates

- [x] Exercise installed client/server APIs in separate service-bound Workers,
  including both modes, cold/warm requests, codecs, isolation and bounded cleanup.
- [x] Generate adversarial protocol responses in workerd with an independent peer,
  shrinking, exact replay and a successful reuse call after every sample.
- [x] Add server compression/framing/limit/cancellation properties and preserve the
  iterator-after-abort failure as a deterministic regression.
- [x] Require multiple fixed seeds in normal CI and retain actual completion counts
  and failed counterexamples; run a larger nightly/manual campaign separately.
