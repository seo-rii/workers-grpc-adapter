# SvelteKit with an installed SDK prebundle

The [pnpm fixture](../fixtures/sveltekit) demonstrates an installed adapter
tarball, the exact `google-static-v1` dependency graph, a server-only prebundle,
SvelteKit development and production SSR, and a local workerd request. There
are no repository source aliases or application-specific ORM dependencies.

The build path is:

```text
pnpm frozen install
  → exact profile + source/hash/AST validation
  → SDK and one owned adapter runtime in an explicit prebundle
  → @wga-fixture/google-workers workspace package
  → $lib/server/google-workers.js
  → SvelteKit production SSR
  → @sveltejs/adapter-cloudflare output
  → Wrangler local dry-run bundle
  → local workerd
```

## Build a server-only wrapper

The fixture's [wrapper source](../fixtures/sveltekit/build/google-workers.mjs)
exports `Datastore`, `OAuth2Client`, `createWorkersGrpcTransport` and
`cancellableCall`. Its declaration file explicitly reexports the same API from
the pinned installed dependencies. Applications should choose their own small
public surface and matching declarations.

The [build script](../fixtures/sveltekit/build/prebundle.mjs) calls the installed
`@grpc/grpc-js/build` entry with its installed esbuild and TypeScript instances:

```js
await buildGoogleWorkerPrebundle({
  projectRoot,
  outdir: freshTemporaryDirectory,
  entryPoint: `${projectRoot}/build/google-workers.mjs`,
  declarationFile: `${projectRoot}/build/google-workers.d.ts`,
  exports: ['Datastore', 'OAuth2Client', 'createWorkersGrpcTransport', 'cancellableCall'],
  profile: 'google-static-v1',
  esbuild,
  typescript,
});
```

The build script generates into a fresh directory, then replaces only a
recognized, unchanged previous artifact in
`packages/google-workers/generated`. The tracked workspace package exposes its
explicit ESM, CommonJS and matching declaration entries. Routes import that
package through a thin `$lib/server/google-workers.js` facade so [SvelteKit
enforces its server-only import
boundary](https://svelte.dev/docs/kit/server-only-modules).

Vite's `ssr.external: ['@wga-fixture/google-workers']` makes development SSR load
the linked package through Node. Importing its CommonJS closure as source code
under `./src/lib` fails in Vite's ESM module runner. Production SSR keeps the same
package reference until Wrangler bundles it into the Worker. Explicit
`workerd`/`worker` package export conditions precede the browser blocker.
Do not import the original SDK from routes or add the esbuild preset to Vite's
`plugins` array. This example does not implement a Vite plugin.

The wrapper owns both the SDK and adapter configuration. Construct transports
through its `createWorkersGrpcTransport`, then pass their `gaxOptions` to its
`Datastore`. Configuring another adapter installation outside this closure
does not configure these clients. Credentials and per-request cancellation
belong to runtime calls; the prebundle takes no credentials.

The fixture disables GAX retries and leaves adapter retries disabled. Its
request AbortSignal reaches each SDK call through `cancellableCall` and the
forwarded GAX options. That propagation cannot undo an accepted mutation. A
Commit failure still requires application-level outcome reconciliation.

The current profile validates every declared SDK even when the wrapper exports
only Datastore. Firestore and Secret Manager are therefore build-time fixture
dependencies. Their presence in the profile does not establish application or
provider support. The artifact manifest separately records validated inputs,
actually applied transformations, adapter ownership and emitted hashes.
The fixture also pins the compatible CommonJS `supports-color` optional peer
used by `debug`; its implementation is bundled so the artifact retains no
unresolved package require.
The isolated install explicitly declares `long` and `undici-types` as build
dependencies because the upstream SDK declarations reference them without
declaring direct dependencies. This allows strict type checking without
hoisting or type stubs.

## Reproduce the installed integration

From a checkout with Node 22.17+ and pnpm 10.30.0:

```sh
npm ci
npm run build
node scripts/test-sveltekit-prebundle.cjs
```

For a filesystem with limited temporary space, choose an existing scratch disk
and an optional reusable pnpm store:

```sh
WGA_TEST_TMPDIR=/path/to/scratch \
WGA_PNPM_STORE_DIR=/path/to/pnpm-store \
node scripts/test-sveltekit-prebundle.cjs
```

The runner packs the current built adapter, copies the fixture into a clean
temporary workspace and installs it with `pnpm install --frozen-lockfile`.
All registry versions and integrity values come from the committed lock. Only
the temporary lock's local adapter archive integrity is replaced with the
SHA512 of the newly packed build. The report records the original and executed
lock hashes, tarball integrity and installed adapter package hash. This does
not alter any SDK pin or disable profile validation.

The fixture pins SvelteKit 2.70.3, Svelte 5.57.2, Vite 7.3.7,
adapter-cloudflare 7.2.9, TypeScript 5.8.3 and esbuild 0.28.2. The supported
TypeScript 5 compiler is deliberate; this test makes no TypeScript 6 or
SvelteKit 3 support claim. The pnpm isolated linker and disabled hoisting expose
the SDKs' physical `.pnpm` paths. Version and graph updates require reviewing
both the lock and the SDK profile.

The runner writes `verification/sveltekit-prebundle.json` and removes the
temporary install. The report lists child process IDs and private `~/logs`
log/status paths. Long phases write logs from process start; failures include
only a bounded tail read after the child exits. Its checks cover:

- One actual Vite development request and a production Cloudflare adapter build
  consuming the same prebundle bytes.
- The generated ESM declaration entry with the pinned TypeScript compiler,
  strict NodeNext resolution and `skipLibCheck: false`.
- A negative control that imports the generated server package into a browser
  component and requires SvelteKit's build to reject it.
- Cold and warm production requests with real SDK protobuf Commit, Lookup,
  RunQuery and BeginTransaction calls, a transaction receipt, the `Datastore.KEY`
  symbol, ancestor keys and an integer ID above JavaScript's safe integer range.
- An injected `PERMISSION_DENIED` status and trailing metadata, followed by a
  successful request; exact RPC counts and idle adapter resources in every case.
- Runtime-only synthetic token injection; no SDK, token or credential boundary
  markers in browser files, including source maps, and no compiled token in SSR
  output.

The controlled gRPC-Web peer decodes actual SDK wire messages with the pinned
protobuf schema. It implements only these fixture cases. This is local
installed-build and wire evidence, not a Google emulator, live authentication
test, live Cloudflare translation test, production deployment, load benchmark,
or proof of an application's complete dependency graph. Use the separate
[Google SDK test guides](google-tests.md) for those evidence layers.

The [Cloudflare adapter's documented
output](https://svelte.dev/docs/kit/adapter-cloudflare) is exercised locally.
The fixture has `workers_dev: false`. The runner invokes only
`wrangler deploy --dry-run` to assemble a local production bundle; it never
deploys, changes infrastructure or reads cloud credentials.
