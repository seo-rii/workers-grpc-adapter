# Google SDK server prebundles

`buildGoogleWorkerPrebundle()` is a Node build step for applications whose final
bundler does not run the esbuild Google profile plugin. It creates a portable
server package containing an explicit SDK wrapper, static protobuf registry, and
one adapter/configuration runtime. This is a supported prebundle boundary, not a
Vite plugin.

Install the exact dependency graph for a [supported profile](profiles.md), the
adapter alias, and the supported TypeScript/esbuild build tools. Keep SDK major
and profile upgrades as reviewed changes to the lockfile and generated manifest.
The build checks the entire selected profile; choosing only Datastore as a
public export does not relax its input checks. A clean frozen-lockfile install
must pass those checks before regenerating an artifact.

Create a static server wrapper, for example `build/google-wrapper.mjs`:

```js
export { Datastore } from '@google-cloud/datastore';
export { OAuth2Client } from 'google-auth-library';
export { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
export { cancellableCall } from '@grpc/grpc-js/sdk';
```

Provide its explicit types in `build/google-wrapper.d.ts`:

```ts
export { Datastore } from '@google-cloud/datastore';
export { OAuth2Client } from 'google-auth-library';
export { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
export { cancellableCall } from '@grpc/grpc-js/sdk';
```

Run the build from `build/google-prebundle.cjs`:

```js
const path = require('node:path');
const { buildGoogleWorkerPrebundle } = require('@grpc/grpc-js/build');

async function main() {
  const result = await buildGoogleWorkerPrebundle({
    projectRoot: path.resolve(__dirname, '..'),
    outdir: '.generated/google-workers',
    typescript: require('typescript'),
    esbuild: require('esbuild'),
    entryPoint: 'build/google-wrapper.mjs',
    exports: ['Datastore', 'OAuth2Client', 'createWorkersGrpcTransport', 'cancellableCall'],
    declarationFile: 'build/google-wrapper.d.ts',
    packageName: '@example/google-workers',
    profile: 'google-static-v1',
  });
  console.log(result.manifestPath);
}
main().catch(error => { console.error(error.code || 'BUILD_FAILED', error.message); process.exitCode = 1; });
```

`outdir` must be absent or empty. Build into a fresh staging directory when
updating an artifact, validate it, and then replace the previous generated
directory. Failed builds leave an existing artifact untouched. The helper never
changes installed SDK files and does not execute the wrapper while building.
Generated files use mode `0644` and the package directory uses `0755`, independent
of the caller's umask, so packing the same artifact produces the same archive.

The result contains `index.cjs`, an explicit `index.mjs` facade, `index.d.ts`,
matching `index.d.mts`/`index.d.cts` declarations, `package.json`, `manifest.json`,
and a browser rejection stub. CJS and ESM imports share the same owned runtime.
Inputs that use `import.meta` fail with `WGA_PREBUNDLE_IMPORT_META`, because the
CommonJS artifact cannot preserve that ES module value. Use explicit portable
configuration instead of relying on the original module's URL after bundling.
Public export bindings must remain stable: expose constructors, factory
functions, or a `const` object whose properties hold changing state. The ESM
facade captures these exported values once; it does not emulate arbitrary live
bindings across CJS. Exported `let`/`var` bindings, local aliases of those
bindings, and detected reassignment of an exported binding, including through
bundled re-exports, fail with `WGA_PREBUNDLE_EXPORT_STABILITY`. Private variables
and properties on a stable exported object may still change.
ES modules retain their implicit strict mode inside module-specific factories;
CommonJS dependencies retain their original strict or sloppy mode. The builder
first audits the profile, captured sources, imports, and exported bindings, then
compiles those captured modules using their original package and TypeScript
configuration. The final bundle resolves only the previously audited dependency
edges, so converting an ES import does not select a different `require` export
condition. The manifest records `build.moduleStrictness: "preserved"`.
The generated package has no SDK runtime imports;
its declaration re-exports still require the corresponding exact SDK/adapter
types at type-check time. Keep those dependencies installed as build or
development dependencies. The helper checks explicit declaration value exports
against the wrapper and rejects relative import/reference paths and module
augmentation targets, because additional declaration resources are not copied.
This includes relative `/// <reference types="..." />` directives; references to
external type packages remain available. Use `export type` for
additional type-only exports. The application's ordinary TypeScript check must
verify signatures and external type dependencies.

The manifest records the profile/revision and package, source, schema,
code-generator, registry, compiler, esbuild, wrapper, and artifact identities. It
also records actual transform coverage and exactly one physical adapter
installation. Source hashes and byte counts describe the original bytes captured
when loading each module, including wrappers and untransformed dependencies. For
profile transformations, these are the verified upstream bytes, while transform
coverage checks the replacement supplied to esbuild and artifact hashes identify
the bundled output. Generated registry receipts describe its generated bytes.
The module-loading and export audits use the same captured sources. Before
publishing, the helper rechecks captured source, declaration, package metadata,
and compiler configuration paths and hashes, including inherited settings and
previously absent configuration lookups. Changes between compilation stages
fail with `WGA_PREBUNDLE_INPUT_CHANGED`. Retry against a
stable source tree. Package source paths use portable package identities. Only imported
profile transform targets count as required coverage: unused SDKs are not added
to the wrapper automatically. An imported target from an unverified installation,
a missing transform, a source/hash mismatch, native grpc-js, two adapter copies,
unresolved runtime imports, or a public export mismatch fails the build.
Unknown `@google-cloud/*` service SDKs also fail closed; `@google-cloud/promisify`
is an allowed utility dependency. Every imported profiled package must belong to
an inspected physical installation, including copies that load no transform
target. The generated bundle retains third-party legal comments.
Install optional dependencies that would otherwise remain as unresolved
`require()` fallbacks, too. For example, the `debug` dependency in the Datastore
graph needs an installed `supports-color` peer for a self-contained CJS artifact;
the installed integration fixture pins `supports-color` to `8.1.1`. Missing
dependencies are reported by module specifier with `WGA_PREBUNDLE_EXTERNAL`.
Node's `module.require()`, `createRequire()`, and module loader hooks cannot
remain in the input graph, including direct aliases of those APIs. They fail
with `WGA_PREBUNDLE_DYNAMIC_IMPORT`; use explicit static imports instead.
Ordinary objects may still have a `require` method, and non-loader APIs such as
`node:module`'s `isBuiltin()` remain available. This source and artifact audit
checks module-loading boundaries; it does not sandbox arbitrary wrapper code.
The source audit also follows `await import('node:module')` (including import
options), destructuring and namespace rest bindings,
statically known computed property names, and fulfillment callbacks passed to
`.then()` on a known module import. Inline callbacks, named function callbacks
and their direct aliases retain the imported namespace identity. `Reflect.get`
on a known Node module object follows the same member checks as direct property
access. An unknown computed property on a Node module namespace is rejected
because it could select a loader. Ordinary application promises and reflective
reads on ordinary objects remain supported.

One physical adapter installation is necessary but does not alone prove one
runtime. The build also rejects different esbuild module identities for the
same adapter source, including query/hash suffix copies. Import adapter entry
points without suffixes; ordinary aliases that resolve to one module are valid.

The export audit follows CommonJS namespace re-exports as well as ES module
bindings. It rejects values that can be reassigned through `exports`, aliases,
property descriptors or mutation helpers after initialization. A stable shared
object whose fields change remains supported. Unproven namespace escapes or
getters fail with `WGA_PREBUNDLE_EXPORT_STABILITY`; expose an explicit factory
or a stable state object instead. Getters returning arbitrary object properties
are conservatively rejected, since aliases and mutation helpers can change
those properties. Getters returning a stable object binding remain supported.
Namespace copies during CommonJS initialization and getters returning a cached
CommonJS namespace are supported. Initialization helpers may follow an
unconditionally defined, non-configurable getter without a setter; the getter's
backing binding is still audited. Conditional descriptors, later namespace
replacement, and getters that construct fresh objects remain rejected.

For a complex or mutable SDK getter, the wrapper can explicitly own the value
selected during initialization instead of re-exporting the live property. The
Firestore 9 fixture uses this contract for its lazily memoized `v1` namespace:

```js
import { v1 } from '@google-cloud/firestore';
export const firestoreV1 = v1;
```

Both package formats then expose the same selected object. Later replacement
of the SDK property does not change this wrapper-owned binding; mutation of
the selected object's fields remains visible in both formats.

For SvelteKit, pack the generated directory and install its tarball as a server
dependency. Import that package from routes, hooks, or a module under the
application's `./src/lib/server` directory:

```js
import { Datastore, createWorkersGrpcTransport } from '@example/google-workers';

export function createDatastore(authClient, config) {
  const transport = createWorkersGrpcTransport(config);
  const client = new Datastore(transport.gaxOptions({
    projectId: 'example-project',
    authClient,
  }));
  return { client, transport };
}
```

Use that same generated artifact for Vite development, production SSR, and the
Workers bundle. Do not run the Google transform over it again or alias its
imports back to the original SDK. For a linked workspace package, explicitly
include its package name in Vite's `ssr.external` so development uses Node's CJS
loader; the final Workers bundler must then inline it. A direct source-directory
`index.mjs` import also imports CJS and requires the consuming bundler's explicit
CJS support. Explicit `workerd`/`worker` conditions select the runtime artifact
before the browser rejection condition. The browser condition rejects package imports
from a browser build; framework server-only import rules remain necessary for
direct file imports. A successful profile check alone does not prove that a
final app uses the prebundle: inspect the final bundler graph and test the
installed package through production SSR.

The wrapper owns adapter configuration and constructors. Configure transport
through its exported `createWorkersGrpcTransport()` and use its SDK constructors;
configuring a separate application import of `@grpc/grpc-js/config` cannot
configure the owned closure. Keep credentials, tokens, request signals, readers,
and transactions at their appropriate runtime/request boundary. The build helper
accepts no credential options, does not read authentication configuration, does
not inline environment values, and produces no source maps. Do not put literal
credentials or imports of credential files in wrapper source or declaration
files: arbitrary caller source is copied or bundled as supplied.

This build boundary does not select an authentication flow, deploy a gateway, or
establish provider compatibility. Validate each required SDK/RPC, authentication
path, and direct Cloudflare or gateway mode separately. Controlled-wire tests,
emulators, workerd, live provider tests, and a complete application integration
are different evidence levels. Redis, native modules, and unrelated Node
dependencies remain outside the adapter's compatibility promise.
