# Contributing

This is an experimental client transport adapter. Contributions should state the behavior they add or fix, the supported runtime, and the evidence that verifies it. Passing a local case does not establish full SDK or production compatibility.

## Development setup

Use Node.js 22 or later. The full Envoy and official emulator suite currently targets Linux x64. Follow the [README quick start](README.md#quick-start) to install pinned dependencies and local tools. No cloud credentials are required for that suite.

For work limited to the adapter's unit tests:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run fixtures:install
npm test
```

The unit suite includes a build-profile check against the installed SDK graph, so it also needs the fixture dependencies. Envoy and the database emulators are not needed for this smaller check.

The source lives in `src/`; `dist/` is generated. Real SDK consumers live in `fixtures/google/`, the native baseline in `fixtures/native/`, and Workers tooling in `fixtures/worker/`. Shared business scenarios live in `fixtures/google/shared/`. Read [Architecture](docs/architecture.md) before changing transport or lifecycle behavior.

## Making a change

Keep each pull request focused on one behavior. Add a regression case for a bug or new supported behavior, and choose a layer that can expose the failure: unit tests for local invariants, a native grpc-js comparison for API semantics, or a real SDK/emulator/workerd case for integration behavior.

After changing files included in the package, refresh the installed fixture copies before running integration tests:

```sh
npm run fixtures:install
```

This command builds a tarball and updates its integrity in the fixture lockfiles before installing them. Review and include those lockfile changes when the packaged bytes change. Editing `src/` alone does not update a fixture's installed package. Do not patch files in `node_modules` or add a general-purpose runtime `require` shim to make a Worker bundle pass.

Use focused checks while developing:

| Change | Relevant checks |
| --- | --- |
| Transport, metadata, or lifecycle | `npm test`, `npm run test:differential` |
| Public declarations or exports | `npm run test:types`, `npm run test:sdk:types`, `npm run test:contract` |
| Google SDK integration | `npm run test:sdk:local`, `npm run test:workers:shared` |
| Worker build preset | `npm run test:workers:sdk` |
| Database behavior | `npm run test:emulators` |
| Packaging | `npm run test:pack` |

Run `npm run verify` before submitting a code or dependency change. After package changes, run `npm run fixtures:install` first. Full verification captures fresh source, dependency, artifact, and runtime evidence; `npm run test:evidence` checks that completed evidence for drift. It is not a substitute for rerunning affected tests. See [Testing](docs/testing.md) for report interpretation and failure diagnosis.

Do not commit generated `dist/`, tarballs, `verification/` outputs, logs, installed dependencies, or downloaded tool caches. CI uploads verification reports as run artifacts. Include command results and any remaining limitations in the pull request instead of checking in machine-specific reports.

## Dependencies and vendored code

- Preserve exact fixture dependency versions and lockfiles. Run the native and replacement SDK checks when changing the dependency graph.
- Keep the scoped `google-auth-library@10.5.0` to `10.9.1` override aligned in the Google and native fixtures. Do not replace it with a global override: another SDK uses a separate auth version.
- The Workers build profile validates exact package and schema hashes. A dependency update may require an intentional profile update and corresponding positive and negative tests; do not bypass those checks.
- For vendored grpc-js changes, retain upstream copyright and license notices, update provenance and reproducible patches, and follow [vendor/README.md](vendor/README.md).
- Toolchain updates must update their pinned version, source, size, and checksum together and pass the relevant local checks.

## Pull requests and issues

Describe the failing or missing behavior, the resulting behavior, and the commands you ran. Mention whether a change affects supported APIs, runtime assumptions, or the pinned dependency profile. Update the API or limitations documentation when that contract changes.

Issue reports should include a minimal reproduction, Node/runtime and SDK versions, and redacted output. Do not attach credentials, access tokens, customer data, or unreviewed environment dumps. Follow [SECURITY.md](SECURITY.md) for suspected vulnerabilities.

## Release status

There is no published npm release or automated deployment process. `private: true` is intentional and must remain set during prototype development. `npm pack` is used for local installation tests; it does not publish a package.

A release requires a separate maintainer decision, a defined support scope, and evidence for that scope. Passing local CI does not authorize npm publication, enable live cloud tests, or certify a deployed Workers integration. See [Limitations](docs/limitations.md) and [Google test guidance](docs/google-tests.md) for the checks that local CI cannot provide.
