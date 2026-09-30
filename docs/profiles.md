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
| `packages` | Exact installed paths, package names, versions and `package.json` SHA256 hashes |
| `files` | Exact source SHA256 hashes and enabled transform rules with expected match counts |
| `schemas` | Exact protobuf JSON, proto or well-known schema input hashes |
| `codegenInputs` | Exact protobuf generator implementation hashes |
| `loaderOptions` | Supported loader configuration |
| `capabilities` | Features this profile is intended to support |
| `requiredChecks` | Repository commands required when changing the profile |

Rules select guarded transformations: static `Root.fromJSON`, Datastore
`Struct` and legacy key loads, static legacy setup, Buffer base64 conversion,
Gaxios native Fetch defaults, Firestore Listen completion ordering, and bundled
directory constants. Expected counts are enforced per rule and file. Updating
a source hash alone cannot authorize a different AST shape or match count.
Existing transform behavior and profile revisions remain unchanged by this
manifest-format update.

Capabilities and required commands are declarations, not evidence of completed
validation. Refer to the CI run and its reports for executed results. Package
manifest hashes strengthen the existing exact package version checks; only
listed source/schema/codegen files are content-pinned, not every file in every
transitive package. The import-graph doctor separately checks replacement
resolution throughout the installed dependency closure.

## Generated artifact identity

`createGoogleWorkerBuild(...).manifest()` exposes `cacheKey`, `inputSha256` and
`transformer` alongside the original audit fields. The registry key includes:

- The complete profile manifest hash, including rules and loader options.
- Transformer semantic version **and the SHA256 of its implementation bytes**.
- The supplied TypeScript compiler's version.
- All validated package-manifest, source, schema and code-generator hashes.

Identical inputs generate the same registry identity regardless of output
directory. Changes to any of those inputs select another registry namespace,
including a transformer edit whose author forgot to increment its version.
The preset still validates inputs and generates its registry on each invocation;
it does not trust or load a persistent artifact cache. Applications may use the
identity as one component of their own cache key. A complete Worker bundle also
needs application files, bundler options/version and other dependency inputs in
its key. Absolute output paths in transformed imports are not a relocatable
bundle cache contract.

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
