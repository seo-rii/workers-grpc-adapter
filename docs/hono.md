# Hono with an installed Google SDK prebundle

The [Hono fixture](../fixtures/hono) exercises an actual installed application,
including middleware, parameterized routes and its exported Fetch handler. It
uses Hono 4.13.13, pnpm 10.30.0, TypeScript 5.8.3, esbuild 0.28.2 and the exact
`google-static-v1` SDK profile. It uses neither source aliases nor a framework
specific SDK transform.

The [wrapper](../fixtures/hono/build/google-workers.mjs) explicitly exports
`Datastore`, `OAuth2Client`, `createWorkersGrpcTransport` and `cancellableCall`.
The installed adapter's Node-only prebundle helper validates the SDK/profile
hashes and AST anchors, transforms the actual loaded files and bundles one
owned SDK/adapter runtime. The application imports only that generated public
entry. Its matching ESM declarations are checked with strict NodeNext
resolution and `skipLibCheck: false`.

The profile validates all its declared packages even when this application
uses only Datastore. Firestore and Secret Manager are build dependencies here;
this fixture makes no assertion about their RPC support. The compatible
CommonJS `supports-color` optional peer is installed explicitly so the artifact
has no unresolved package require. `long` and `undici-types` are explicit build
dependencies for upstream declarations that otherwise assume hoisting.

The [production builder](../fixtures/hono/build/worker.mjs) combines the generated
prebundle and the installed Hono package into a Worker. Its only external
imports are audited Node builtins supplied by `nodejs_compat`; a finite native
module map cannot resolve another SDK or adapter package. The build records its
actual inputs and output digest. Workerd runs with startup eval disabled, so a
profile/build inspection is separate from the actual runtime check.

From a checkout with Node 22.17+, OpenSSL, the existing worker fixture tooling
installed and pnpm 10.30.0:

```sh
npm run fixtures:install
npm run test:hono:prebundle
```

The runner packs the current built adapter, copies the fixture into a clean
temporary workspace and runs a frozen, isolated pnpm installation. Only that
temporary lock's local adapter tarball integrity is refreshed for the current
development build. Registry versions/integrities and SDK/profile checks remain
pinned. The report records source/executed lock hashes, archive integrity,
physical adapter installation and actual transform coverage.

Miniflare/workerd are host tooling loaded from the existing worker fixture;
they do not supply the adapter, Hono or SDK under test. Those packages come from
the new isolated install. `WGA_TEST_TMPDIR` and `WGA_PNPM_STORE_DIR` can select an
existing scratch disk and pnpm store. The temporary install is removed after
the run. Every long child phase writes an owner-only `~/logs` log and status
receipt; `WGA_TEST_LOG_DIR` can select a private directory on another disk.
Errors include only a bounded tail read after the child exits.

The [application](../fixtures/hono/src/app.mts) constructs a transport and SDK
client for each request and injects a synthetic cached token only at runtime.
The build receives no credentials. Middleware checks a separate runtime-only
control value and records its before/route/after order. The bounded control
receipts retain data snapshots, never clients, streams, credentials or signals.

The local workerd test verifies:

- Health/unknown/unauthorized routing produces no RPCs, while Hono middleware
  and route parameters reach the real handler.
- Real protobuf Commit, Lookup, RunQuery and BeginTransaction messages preserve
  the `Datastore.KEY` symbol, ancestor keys, an integer ID above JavaScript's
  safe integer range and a transaction receipt.
- An injected permission denial retains status code 7 and trailing metadata.
- An HTTP client disconnects from an active response stream while a valid
  partial protobuf Lookup frame is held. This aborts `context.req.raw.signal`
  and cancels the SDK Lookup. Idle resources and actual backend reader
  cancellation are acknowledged before generated clients close. A following
  healthy request proves request state isolation.
- Exact RPC counts, disabled SDK/adapter retries and idle adapter resources are
  checked before the Worker is disposed. Runtime token/control values are
  absent from generated build artifacts.

Incoming cancellation requires Cloudflare's
[`enable_request_signal` compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests),
which this fixture sets explicitly. The app forwards that signal through
`cancellableCall` and every SDK GAX option. A bounded `waitUntil()` allows its
cleanup receipt to finish after disconnection; this is not durable background
execution and cannot undo a mutation accepted by a service.

This cancellation check connects to the user Worker's native HTTP socket, with
response heartbeats so local workerd observes the disconnected client. It does
not certify cancellation through Miniflare's older compatibility-date front
proxy. The peer slowly emits one valid partial gRPC-Web protobuf frame; a
separate read-only acknowledgment observes its reader cancellation without
causing it. Both heartbeat/drip timers and the host reader lock are released.
The backend is a real loopback HTTPS server. The runner creates an ephemeral
certificate/key in its private scratch directory. The transport's Fetch binding
uses Workerd's native network, allows only `127.0.0.1` and trusts only that
fixture certificate; TLS verification stays enabled. Global outbound Fetch
requests are rejected. A premature `ServerResponse.close` cancels the
held peer reader; the acknowledgment requires both events. Miniflare's Node
callback service bridge is not used for this cancellation assertion.

Results are written to `verification/hono-prebundle.json`. The peer decodes real
SDK protobuf bytes and models only these cases. This is local installed-build,
framework and controlled-wire evidence, not live Google authentication, an
official emulator, a browser/SSR test, production load evidence or deployed
Cloudflare conversion. The runner never deploys or contacts Google. See the
official [Hono application API](https://hono.dev/docs/api/hono) and
[Cloudflare Workers guide](https://hono.dev/docs/getting-started/cloudflare-workers)
for the framework's Fetch handler and middleware contracts.
