# Pinned grpc-js client core

The pristine TypeScript files in [`client/`](./client/) were extracted from the npm
`@grpc/grpc-js@1.14.0` tarball. [`UPSTREAM.json`](./UPSTREAM.json) requires the
package, version, registry URL, SHA-512 integrity, archive SHA-256 and size, Git
commit, Apache license hash, explicit NOTICE policy, and each original, patch,
and resulting source file's SHA-256. Missing or null required pins fail the check.
The pinned archive has no NOTICE or NOTICE.* member at any directory depth;
[`NOTICE`](./NOTICE) is this adapter's attribution, not an upstream notice.

Download the exact original archive and its registry provenance receipt during
setup, or use `npm run fixtures:install`, which performs this step:

```sh
node vendor/fetch-upstream.cjs
```

The setup command allows only HTTPS `registry.npmjs.org`, rejects redirects,
bounds downloads, and checks all pins before caching either file. It saves
`.cache/vendor/grpc-js-1.14.0.tgz` and a small canonical `.registry.json` receipt.
The receipt retains only package, version, gitHead, repository, license, tarball,
and integrity fields from the npm version document; its SHA-256 is pinned too.
Unrelated npm metadata does not change that receipt. Existing corrupt cache files
fail rather than being silently replaced; remove the two cache files and rerun
setup to restore them.

The repository's [`src/`](../src/) directory contains the buildable client-only fork.
[`patches/`](./patches/) contains unified diffs from each original to its
corresponding source file. Run from the repository root to verify byte-for-byte
patch reproduction after setup:

```sh
node vendor/verify.cjs
```

Verification is offline and never downloads missing inputs. It reads the actual
archive in memory with compressed/uncompressed limits, checks tar checksums and
safe regular paths, and rejects links, duplicate members and unsupported formats.
It compares LICENSE and pristine sources byte-for-byte with that archive, checks
the explicit NOTICE absence/presence policy, reproduces each patch with fuzz
disabled, and verifies every current target. If a future archive contains notices,
each notice must be pinned and copied under `upstream-notices/`.

The required gate emits `verification/vendor-provenance.json` with named checks
and the hashes of source inputs, the archive and the registry receipt. Evidence
validation repeats the actual byte and patch checks; a claimed passing JSON result
cannot replace missing inputs. This establishes reproducibility against the pinned
npm artifacts. The Git commit is the registry's pinned `gitHead`; this check does
not verify an upstream signature or reproduce the package from a Git checkout.

`node vendor/verify.cjs --apply` regenerates the fork's source files from the
originals and patches. Every archive, notice and patch check must finish before
it modifies any source, and each source replacement uses a temporary file.
Updating the upstream pin requires a fresh archive and registry receipt, source
review, patch regeneration and the regression, differential and declaration tests
included in `npm run verify`.

The patch boundary follows P-01 through P-06 of the
[design specification](../docs/spec/v0.3.md):

- Client creates the branded Workers Channel and rejects foreign channel overrides.
  `waitForReady` reports the explicitly unsupported connection concept.
- The bottom interceptor receives the final method definition and options after
  transformers and client/call interceptors. It removes consumed interceptor keys
  and keeps an omitted deadline distinct from explicit Infinity. Call credentials
  are composed once by WorkersCall before authentication.
- Factory, metadata, typed stream surfaces, error stacks, and StatusBuilder reuse
  the upstream implementations with the recorded patches. Async interceptor
  ordering and stream-destroy cancellation have explicit adapter corrections.
  Metadata adds only
  a transport iterator and substitutes the default error logger to avoid native
  process/environment tracing initialization.
- HTTP/2 and TLS references are type-only. Parent calls use the adapter's structural
  deadline/cancellation contract; native channel, resolver, retry, server and
  transport code is excluded.
  Transport credentials are implemented separately in
  [`src/credentials.ts`](../src/credentials.ts).
- Root exports the supported client API. Server constructors remain explicit
  unsupported stubs. Generated service names, unsafe-name skipping, Metadata map
  shape and base stream surfaces derive from grpc-js 1.14.0; the adapter also
  cancels unfinished RPCs on stream destruction.

Two focused corrections are deliberate differences from the pinned native core:
Client sends the argument returned by `callInvocationTransformer`, and the bottom
interceptor honors a replacement `method_definition` from the final interceptor.
Both are required by this adapter's existing documented transformation contract.
Native HTTP/2 connectivity remains unsupported. Client and bidi streaming require
the gateway transport with `experimentalRequestStreaming: true`; automatic Cloudflare
conversion remains unary/server-streaming only. Parent deadline and cancellation
propagation are supported under the adapter contract, and write flags are checked
by the transport. Observer exception scheduling is owned by WorkersCall; upstream
source reuse does not imply a
complete native-event or full Google SDK compatibility certification.
