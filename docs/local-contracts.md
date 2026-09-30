# Public client compatibility contracts

The original catalog separates a passing test from complete evidence for a
requirement. This guide describes the local public API, configuration and type
contracts. The checked-in [case mapping](../compatibility/test-evidence.json)
records the coverage decision for each ID; the generated
`verification/evidence.json` verifies its concrete execution references.

Local verification covers all 11 configuration cases, seven type cases and 15 of the
16 API cases. `API-011` retains a concrete native divergence below. Across the
unchanged 189-case catalog the reviewed mapping has 58 covered, 118 partial
and 13 without accepted current execution references. The mapping retains the
legacy `unimplemented` label for that last category; it does not mean 13 runtime
features are absent. These counts describe requirements, not test totals. See
the [evidence reconciliation](https://github.com/seo-rii/workers-grpc-adapter/blob/main/docs/evidence-review.md)
for the remaining conditions and the distinction from dated deployment evidence.

## Runtime API

`npm run test:api:contracts` exercises the installed adapter in Node and workerd.
The same scenarios run through both transport modes. Controlled responses keep
the request bytes, metadata, callback, status and cleanup assertions reproducible.
Selected scenarios also use the pinned native grpc-js implementation against a
real local HTTP/2 peer.

| Catalog cases | Required observations |
| --- | --- |
| `API-001`–`API-004` | Direct and factory clients, subclassing, generated aliases and real proto-loader package/message/enum descriptors. |
| `API-005`–`API-007` | Rewritten request bytes and metadata, a changed finite deadline, and transformer/interceptor order compared with native grpc-js. |
| `API-008`–`API-011` | Serialization, deserialization and unary response cardinality errors; callback and status are recorded separately. |
| `API-012`–`API-015` | Default-disabled request streams, connection readiness and native server stubs reject explicitly without authentication or Fetch. |
| `API-016` | A user callback exception remains an application exception after transport completion and resource cleanup. |

The default-disabled streaming cases do not contradict the opt-in gateway
[request-streaming API](request-streaming.md) or the separate
[Fetch server](server.md). Local workerd exercises adapter routing and protocol
handling; it does not emulate Cloudflare's deployed edge translator.

The callback-exception scenario observes the real uncaught application error:
Node runs it in a separate child process and workerd exposes it through the
runtime inspector. Transport completion and cleanup occur first. A throwing
callback can interrupt the following public `status` event; the test records
that separately from the successful transport observer result.

`API-011` remains partial. With two response messages followed by OK trailers,
the pinned native grpc-js 1.14.0 unary client delivers only the first message
internally and reaches its deadline (`DEADLINE_EXCEEDED`, 4). The adapter rejects
the extra message immediately (`UNIMPLEMENTED`, 12). The independent HTTP/2 peer
also has a successful one-message control, and a raw consuming probe verifies
both response frames, OK trailers and stream completion. This is a recorded
cardinality difference, not evidence for the original catalog's native-parity
expectation. The adapter retains its bounded rejection behavior.

## Configuration

`test/config-catalog.test.cjs` gives each `CFG-001`–`CFG-011` requirement its own
named test. Tests that depend on untouched global configuration use isolated
processes. Rejected configuration must preserve the previous state, including
before and after the first successful Channel construction. Nonempty endpoint
maps test canonical ordering and ownership of input and returned snapshots.

Channel-option tests cover the registered allowlist, unsupported native features,
actual pinned GAX defaults and foreign channel overrides. Unsupported metadata
options must fail without starting authentication or a data request. These checks
do not add native channel readiness, pooling or service-config support.

## Types

`npm run test:types` checks adapter declarations; `npm run test:sdk:types` checks
the installed native and replacement Google SDK graphs. Both use strict checking
with `skipLibCheck: false`. Node16, NodeNext and Bundler resolution include ESM
and CommonJS consumers.

The catalog requires all unary/readable overloads, root and deep imports, the
SDK Promise tuple/Key/Transaction/Query contracts, invalid configuration examples,
and server type-only imports that disappear from emitted JavaScript. Type checks
do not establish runtime SDK support or support for native server operations.
The mapping retains any remaining gap rather than inferring complete coverage
from a successful compiler exit.

The pinned native EventEmitter surface permits broad fallback listener
signatures. Message and error listener examples therefore use explicit response
and `ServiceError` annotations; a successful overload check does not imply that
every event callback is inferred narrowly or that arbitrary event names are
rejected. The replacement preserves this upstream boundary.

## Evidence and scope

The normal `npm run verify` pipeline and GitHub CI require these checks. Reports
are tied to the tested source, installed package and dependency graph. A missing
runtime, skipped case, changed assertion or stale report cannot replace a
successful execution.

The runtime suite executes 124 case rows, 148 adapter calls and 124 Fetch attempts
in Node/workerd, plus six native scenarios and the independent HTTP/2 control.
The type report contains six compiler configurations and 27 case rows across
both module forms. Actual generated proto descriptors/codecs, client declarations
and type-only emitted modules are retained under `verification/api-contracts/`
and `verification/type-contracts/`, hashed by the evidence checker and included
in the CI artifact archive.

These contracts cover the explicitly exercised local client surface. The full
189-case catalog, other SDK versions, live provider trust/IAM, deployed
Cloudflare behavior and long-running operation have independent requirements.
`releaseEligible` remains `false`.
