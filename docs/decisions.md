# Design decisions

These records explain the current prototype. They do not mark every requirement in the historical v0.3 design as complete.

## D-001: Reuse the pinned upstream client core

The initial custom facade was replaced with the client, factory, interceptor, Metadata and call surfaces from the npm artifact `@grpc/grpc-js@1.14.0`. Original source, checksums, npm integrity, commit and reproducible patches remain in `vendor/`.

The lower bridge replaces the native channel with the Workers transport while preserving final method/options/credentials and absent deadlines. Patches explicitly record the use of invocation-transformed arguments and interceptor-modified method definitions.

## D-002: Share one CommonJS implementation with ESM

Thin ESM wrappers re-export the CommonJS objects so GAX and ESM consumers share Metadata, credentials and configuration identity. Node mixed-module imports are tested through the actual tarball. Arbitrary Workers bundler identity remains a separate verification task.

## D-003: Use Fetch without a runtime transport dependency

The runtime uses binary gRPC-Web, Fetch, ReadableStream, AbortController and the supported Node builtins available in Workers. It does not implement native HTTP/2 inside a Worker. Tests control globals where needed; there is no public arbitrary Fetch-injection API.

## D-004: Enforce explicit transport limits

The adapter applies message ceilings, header/trailer budgets, exact gateway mappings, redirect rejection and HTTPS. The HTTP exception is limited to explicit, credential-free literal-loopback tests. Unsupported options fail explicitly. Adapter retries, compression, custom TLS, client/bidirectional streaming, native connection readiness and server behavior are outside the implementation.

## D-005: Preserve stream messages before terminal errors

Destroying a readable with an error can discard a buffered final message before consumers observe it. The client surface follows upstream 1.14.0 terminal behavior instead. Regression and native differential tests compare representative successful, failed and empty streams. Full upstream event equivalence remains a broader gate.

## D-006: Keep evidence layers distinct

Controlled HTTP/2 tests use real sockets and trailers but purpose-built local services and bridges. Tarball alias tests use real npm with both synthetic negative controls and the two pinned real SDK/GAX graphs, including independent clean installs and offline inspection. Package resolution, SDK runtime behavior, Envoy, emulator and deployed-cloud evidence remain separate layers; passing one does not imply the others passed.

## D-007: Disable live execution by default

`npm run verify` forces live Google execution off. A separate fixture requires explicit project, credentials and live/write opt-ins. The test Worker is a protected test tool rather than a general application service. Reports omit original request/response payloads and credential material.

## D-008: Preserve upstream licensing

Original adapter code uses MIT. Files derived from grpc-js retain their Apache-2.0 notices and license. The package includes `vendor/LICENSE`, `vendor/NOTICE`, `vendor/UPSTREAM.json` and patches.

## D-009: Compare real SDKs with a native baseline

Pinned Datastore, Firestore and Secret Manager packages run against controlled local native gRPC services. Consumers compare shared source hashes, business assertions, RPC methods/statuses and binary gRPC-Web observations. Live IAM, quotas and production transaction behavior require independent execution.

## D-010: Generate Workers protobuf code at build time

The Node-only `/build` preset accepts only matching installed dependencies and schema hashes. It prepares code needed by static SDK imports and lazy protobuf codecs without changing installed node_modules or global protobuf prototypes. TypeScript and esbuild are build-time peers, not transport runtime dependencies.

## D-011: Use official emulators for database semantics

The local gate runs the official Firestore emulator in Native and Datastore modes through real Envoy. Identical business modules execute in native grpc-js, the Node adapter and two workerd invocations. This adds actual database behavior, query, mutation and error evidence while keeping live projects and credentials out of the default gate.

The harness retains explicit emulator limits, records process cleanup and observes gRPC status at Envoy's upstream router. A synthetic owner header exists only on the local Firestore emulator route. These tests do not replace live authentication or production concurrency checks.

## D-012: Keep planned coverage separate from passing test counts

The original 189-case catalog remains unchanged. Each mapping identifies a concrete test or report case and preserves missing invariants as partial coverage. Supplemental scenarios stay outside that denominator. Verification snapshots inputs and rejects stale sources, locks, artifacts, profiles, reports and process receipts. Generated outputs are published as CI artifacts rather than checked-in evidence of a later source revision.
