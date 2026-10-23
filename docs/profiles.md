# Exact SDK build profiles

The Node-only `@grpc/grpc-js/build` entry supports `google-static-v1` and
`google-modern-v1`. Profiles are reviewed manifests, not version ranges. The
build rejects changed packages, source files, schemas and transform anchors.
The adapter's runtime does not import TypeScript or these manifests.

## Inspect an installed project

From this repository:

```sh
npm run doctor
node scripts/doctor.cjs fixtures/modern --profile=google-modern-v1
node scripts/doctor.cjs /path/to/project /tmp/doctor.json --profile=google-static-v1
```

The default command checks the original fixture's import graph and build
profile. When supplying a project path, select a profile explicitly to add
build-profile checks to the existing dependency graph check. A failing report
exits with code `2`. The JSON `buildProfile.diagnostics` array identifies each
mismatched package name/version/hash, source, schema, code generator or transform
rule, with `path`, `expected` and `actual` values. Invalid or duplicated rule
names and changed AST shapes/counts are reported separately. Hash mismatches
stop AST checking: the tool does not execute or transform untrusted drifted
inputs to infer compatibility.

The dependency-graph report separately includes `identity` and `diagnostics`.
`identity.installations` lists canonical physical adapter paths, versions and
`resolvedBy` consumers/specifiers, including the application's own-name and
`@grpc/grpc-js` alias resolutions. Two copies fail with
`WGA_DUPLICATE_ADAPTER_INSTALLATIONS`, even when every SDK resolves the correct
package name and version: independently loaded copies can have different
`Metadata`, client and credential constructors and separate configuration state.
The graph fingerprint includes these identity records. A symlink to the same
physical directory counts once under normal Node resolution. Custom loader or
`--preserve-symlinks` behavior requires separate runtime verification.

The graph check is offline and does not execute inspected SDK, auth or adapter
modules. Its diagnosis identifies a physical-installation risk; it does not
instantiate or compare constructors. The optional profile transformation check
loads hash-checked local protobuf code-generation dependencies and the supplied
TypeScript compiler. Neither check validates credentials, contacts Google or
establishes live compatibility.

Installed consumers can use the same checks without this repository's CLI:

```js
const ts = require('typescript');
const { inspectGoogleWorkerProfile } = require('@grpc/grpc-js/build');

const report = inspectGoogleWorkerProfile({
  projectRoot: process.cwd(),
  profile: 'google-static-v1',
  typescript: ts,
});
if (!report.passed) console.error(report.diagnostics);
```

Providing TypeScript checks every declared transformation, including source
files that a particular application's bundle does not import. Omitting it
performs package/file checks and reports `transformationsChecked: false`.
AST checking generates a registry in a temporary directory and removes it on
completion; it never rewrites installed dependencies. `passed` describes the
reported check scope. It does not mean that the profile's integration tests or
live services were tested by doctor. Unknown profile IDs throw
`WGA_UNSUPPORTED_DEPENDENCY`.

## Manifest contents

The versioned JSON files in [`src/build/profiles`](../src/build/profiles) declare:

| Field | Contract |
| --- | --- |
| `schemaVersion`, `transformerVersion` | Recognized manifest format and required transformer semantics |
| `id`, `revision` | Reviewed SDK graph and transform revision |
| `packages` | Dependency role paths, optional `resolveFrom` importer role, exact package names, versions and `package.json` SHA256 hashes |
| `files` | Exact source SHA256 hashes and enabled transform rules with expected match counts |
| `schemas` | Exact protobuf JSON, proto or well-known schema input hashes |
| `codegenInputs` | Exact protobuf generator entry, bootstrap and implementation hashes |
| `loaderOptions` | Supported loader configuration |
| `capabilities` | Features this profile is intended to support |
| `requiredChecks` | Repository commands required when changing the profile |

Rules select guarded transformations: static `Root.fromJSON`, Datastore
`Struct` and legacy key loads, static legacy setup, Buffer base64 conversion,
Gaxios native Fetch defaults, Firestore Listen completion ordering, bundled
directory constants, and GAX package metadata resolution. Expected counts are
enforced per rule and file. Updating a source hash alone cannot authorize a
different AST shape or match count.

Modern profile revision 3 pins `google-gax@6.7.0`'s metadata resolver. Its reviewed
nested try/catch first reads a missing `build/package.json`, then the package
root. The guarded transform redirects the first read to that same root, allowing
esbuild to include the pinned version without retaining an unresolved runtime
`require`. It checks both assignments, catch blocks and the absence of the
alternate metadata file. Imported metadata resolvers require a transformation
receipt in the final build audit. Source, AST or package-layout drift still
fails the build. The focused regression verifies static bundling and metadata
fallback precedence; it does not establish Google service or authentication
support.

Capabilities and required commands are declarations, not evidence of completed
validation. Refer to the CI run and its reports for executed results. Package
manifest hashes strengthen the existing exact package version checks; only
listed source/schema/codegen files are content-pinned, not every file in every
transitive package. The import-graph doctor separately checks replacement
resolution throughout the installed dependency closure.

Static profile revision 6 and modern profile revision 4 also pin the protobuf
entry and bootstrap files. Before loading any generator, every schema's
importer-resolved `protobufjs` entry must identify the same physical installation
as a declared, hash-checked protobuf role. An additional SDK-local installation
fails with `WGA_SOURCE_IDENTITY`, including equal-version/equal-byte copies;
symlinks to the inspected installation remain valid. Hash-only inspection
performs this identity check without executing a generator. Build startup and
completion repeat it. These revisions keep the existing dependency versions.

Registry generation runs in a fresh Node subprocess. It compiles the captured,
hash-checked protobuf JavaScript instead of reusing modules previously loaded by
the build application's `require()`. Replacing an installed generator at the
same path therefore cannot reuse its earlier executable code. Generation leaves
the application's module cache and protobuf objects intact, and does not inherit
environment variables or Node preload settings. This is a Node build step;
generated Worker codecs still need no runtime code generation. JSON and `.proto`
schemas also use the captured, hash-checked bytes, so a temporary file change
during generation cannot change their codecs. The current profiles' `.proto`
inputs have no imports. Ordinary, public and weak imports are rejected with
`WGA_SCHEMA_MISMATCH` before publication; supporting imports would require a
profile that captures and verifies their complete closure. File validation runs
again after generation before the registry is published.

## Generated artifact identity

`createGoogleWorkerBuild(...).manifest()` exposes `cacheKey`, `inputSha256` and
`transformer` alongside the original audit fields. The registry key includes:

- The complete profile manifest hash, including rules and loader options.
- Transformer semantic version **and the SHA256 of its implementation bytes**.
- The supplied TypeScript compiler's version.
- All validated package-manifest, source, schema and code-generator hashes.
- The mapping from each schema to its validated generator role and entry.

Identical inputs generate the same registry identity regardless of output
directory. Changes to any of those inputs select another registry namespace,
including a transformer edit whose author forgot to increment its version.
The preset still validates inputs and generates its registry on each invocation;
it does not trust or load a persistent artifact cache. Applications may use the
identity as one component of their own cache key. A complete Worker bundle also
needs application files, bundler options/version and other dependency inputs in
its key. Absolute output paths in transformed imports are not a relocatable
bundle cache contract.

Generated registries use content-addressed filenames inside `outdir`. Distinct
profiles or build identities can share that directory without replacing each
other's registry. Identical inputs reuse an existing file after checking its
hash. Treat the returned `registryFile` as an opaque path rather than constructing
its filename. Clean old registries only after the presets that reference them
are no longer in use.

The preset checks registry bytes during preparation, at build startup, when
loading the generated module, and at final verification. A missing or changed
registry fails with `WGA_REGISTRY_INTEGRITY`; it is never silently regenerated
behind a prepared preset. Another plugin bypassing the registry's loader also
fails verification. The generated-module check does not increase the profile
target counts in `transformCoverage`.

## Add or revise a profile

1. Install a deliberate SDK graph in an isolated fixture and lock its dependencies.
2. Add an allowed profile ID and type declaration when introducing a new profile.
   Record its exact package, source, schema and code-generator inputs.
3. Declare each required transform and expected match count. Implement a guarded
   transformer rule only if the existing rules cannot express the change. Increment
   the transformer version when semantics change and the profile revision when
   that profile's behavior changes.
4. Declare capabilities and required checks. Add a minimal regression for each
   new source shape or runtime behavior, then run the declared commands and the
   repository verification suite against the installed package.
5. Review doctor output and the generated build manifest. Publish measured
   results with their runtime and profile; do not broaden support based only on
   matching package versions.

## Importer paths and package managers

A profile path identifies a reviewed dependency role. `resolveFrom` identifies
another declared package role whose Node dependency resolution selects that
package; a role without it resolves from the application root. Inspection reads
manifests through the actual importer, then canonicalizes files with `realpath`.
It never substitutes a similarly named package found elsewhere in the store.
This supports npm hoisting, pnpm's isolated store and linked workspace packages
without weakening version, content or AST checks. pnpm consumers must still
install and lock the exact reviewed graph; a compatible semver range is not a
profile.

Both the inspection report and build manifest include `resolvedPaths` with
profile `path`, `logicalPath` and canonical `physicalPath`. Hash diagnostics also
carry those paths. A second physical installation of an imported transform
target fails with `WGA_SOURCE_IDENTITY`, including equal-version/equal-byte
copies, even when its path equals a profile's symbolic role. The loader and
metafile audit always check the actual module's physical source; doctor first
resolves the symbolic role through its declared importer. A missing symbolic
path cannot substitute for a loaded file. Use the graph doctor for adapter
identity as well. Normal Node/esbuild
symlink resolution is the tested path; custom loaders and `preserveSymlinks`
can change dependency lookup and need separate validation.

Build profiles currently require TypeScript `>=5.8 <6`. An application using
another compiler can run the SDK transformation in an isolated build workspace
with TypeScript 5.8.3, then consume its JavaScript artifact. This does not claim
TypeScript 6 support or require disabling peer/profile checks.

## Inspecting transformations and proving bundle coverage

The esbuild preset enables `metafile` and audits it at the end of every successful
build. Every imported module instance of a profile target must have passed the
guarded transform in that build. Receipts distinguish its esbuild namespace,
absolute logical path and query/fragment suffix. A transformed instance cannot
cover an untransformed namespace, symlink alias or suffix of the same physical
file. Real paths containing literal `?` or `#` take precedence over suffix parsing.
Another plugin swallowing `onLoad`, an unverified physical source, or
dependency-link drift fails the build. Rebuilds clear all target and module
receipts. Package/source/schema/codegen checks run again before completion.

Use a separate prepared preset for concurrent builds or esbuild contexts.
Overlapping use of one preset fails with `WGA_BUILD_CONCURRENT`, so one build
cannot borrow another build's transformation receipts. Sequential builds and
context rebuilds may reuse a preset after its previous build finishes.

`manifest().transformCoverage` reports `required`, `applied`, `unused` and
`passed`. These counts describe distinct profile targets, rather than module
instances. `required` counts targets present in the actual metafile; `applied`
counts required targets whose every module instance has a matching receipt.
One bypassed instance makes that target unapplied and `passed: false`. `unused`
counts profile targets absent from the metafile. An unused SDK or the unselected
Gaxios ESM/CJS alternative need not be bundled. Inspection
alone leaves coverage unproven. `transformationsChecked: true` means that doctor
checked the declared AST shapes, not that a consuming bundle used them.

A custom build driver can explicitly audit an esbuild result using
`preset.verifyBuild(result.metafile, absWorkingDir)`. Preserve the returned
metafile and manifest with the build receipt. A failed build must not be
deployed, even if a caller's output directory contains a previous artifact;
the prebundle driver owns artifact invalidation for its generated package.

## Doctor from an installed package

The package ships the Node-only `wga-doctor` binary. It works for both the
`workers-grpc-adapter` package name and the `@grpc/grpc-js` installation alias:

```sh
pnpm exec wga-doctor . doctor-report.json --profile=google-static-v1
# Or with npm:
npx --no-install wga-doctor . doctor-report.json --profile=google-static-v1
```

The default project is the current directory. Without `--profile`, the CLI
performs graph/physical-identity inspection only. With a profile, it resolves
the inspected project's installed TypeScript compiler and requires the supported
version; a missing compiler cannot silently turn an AST check into a hash-only
success. Repeated `--sdk=package-name` flags select specific SDK entry points.
The default selects Datastore, Firestore and Secret Manager. Exit `0` means the
reported checks passed; `2` means a failed check, missing dependency or invalid
invocation. A report filename writes the complete graph with restrictive file
permissions and prints a compact summary.

The same graph check is available through the Node API:

```js
const { inspectGoogleWorkerGraph } = require('@grpc/grpc-js/build');
const report = inspectGoogleWorkerGraph({
  projectRoot: process.cwd(),
  sdks: ['@google-cloud/datastore'],
});
if (!report.passed) console.error(report.diagnostics);
```

Add `profile` and `typescript` for optional profile/AST checks through this API.
The report records the declared package manager and hashes existing npm, pnpm,
Yarn or Bun text lockfiles. npm package-level integrity records retain their
original scope; another lockfile's presence is fingerprinted without claiming
its full lock graph was parsed. The graph check reads manifests and source
files without importing SDK, auth or adapter modules. It checks grpc-js imports
in `.js`, `.cjs`, `.mjs`, `.d.ts`, `.d.cts` and `.d.mts` files throughout each
dependency; an unresolved root or deep import fails the graph check.
Runtime files with no extension or another extension are also inspected when
selected by a static local `require`/`import` edge, a package `main`, a literal
`exports`/`imports` target, or a `bin` with a Node shebang. These edges reuse
Node's import/require resolvers and proven `createRequire` bases. JSON and native
addon targets remain data; unreferenced extensionless README/data files are not
treated as JavaScript. Computed module paths, export-pattern expansion, and
non-Node command scripts are outside this discovery pass.
Hidden runtime directories and source symlinks are included. Symlink imports
resolve from the physical source location, and repeated physical files and
directory cycles are visited once per package. Dependency `node_modules` trees
are followed through package dependencies; version-control internals are skipped.
Profile AST checks also load the installed compiler and hash-checked protobuf generators. Neither check
performs authentication or proves that a final artifact was transformed. Preserve the prebundle's separate build
coverage and artifact receipts for that evidence.

Graph inspection assumes Node's default import/require conditions. Each graph
import records `kind`: `require`, `import`, or `declaration`.
Runtime static imports, re-exports and dynamic `import()` use Node's ESM
conditions, including dynamic imports inside CommonJS files. `require()` uses
CommonJS conditions; using both forms for one specifier checks both targets.
Each check batches Node's import and CommonJS resolvers in a fresh process without
loading inspected modules. This also avoids stale CommonJS paths and package
metadata when the API re-inspects an installation after dependency changes.
Missing files and directory targets fail, even when
Node's resolver can construct their URLs. User preload scripts, loader hooks and
custom conditions are excluded; validate those environments separately.

The compiler-free source scanner recognizes literal import and re-export
specifiers, including comments between tokens, string escapes and static
template literals in `require()` or `import()`. It ignores comment/string/regex
contents, property calls, and ordinary locally bound `require` functions.
Declaration scanning distinguishes a for-in/of separator from `in` operators
and `in`/`of` strings, properties or identifiers in initializers. A later local
`require` binding, including its proven `createRequire` base, keeps its identity
through the complete declaration list. Classic for, for-in/of and for-await-of
bindings remain limited to their JavaScript scopes. Contextual `let` used as a
sloppy-script expression identifier does not introduce a declaration.
Script/CommonJS scan also ignores legacy HTML comments; known ES modules do not
use that comment goal. Physical file extensions and the nearest package scope
select the goal, including nested package scopes and source symlinks.
Line comments and hashbangs end at LF, CR, U+2028 or U+2029; escaped line
continuations in literal specifiers follow the same line-terminator rules.
A `require` initialized directly by an imported `node:module`/`module`
`createRequire` factory remains a CommonJS loader. Raw and escaped Unicode
factory identifiers, including non-BMP characters, retain that identity without
extending the scanner's alias-analysis scope. Its literal absolute path or file
URL, `import.meta.url`, and literal `new URL(..., import.meta.url)` bases
are resolved from that declared location. An unproven base is reported as
`resolution-base-unverified`; it never falls back to the source directory.
This is static module-site
inspection, not arbitrary loader-alias or computed-specifier data-flow analysis.

Declaration files retain the graph check's package-entry availability check
through CommonJS resolution and are recorded separately from runtime imports.
This check does not resolve TypeScript's `types` conditions or validate declaration
semantics. Run the application's TypeScript checks with its chosen module
resolution settings to validate those contracts.
