# Pinned grpc-js client core

The pristine TypeScript files in [`client/`](./client/) were extracted from the npm
`@grpc/grpc-js@1.14.0` tarball. Its SHA-512 integrity was checked before extraction.
[`UPSTREAM.json`](./UPSTREAM.json) records the registry tarball, integrity, git commit, Apache license,
and each original, patch, and resulting source file's SHA-256. The original npm
package has no NOTICE; our attribution records that fact.

The repository's [`src/`](../src/) directory contains the buildable client-only fork.
[`patches/`](./patches/) contains unified diffs from each original to its
corresponding source file. Run from the repository root to verify byte-for-byte
patch reproduction:

```sh
node vendor/verify.cjs
```

`node vendor/verify.cjs --apply` regenerates the fork's source files from the
originals and patches. Updating the upstream pin requires a fresh tarball,
integrity verification, source review, patch regeneration and the regression,
differential and declaration tests included in `npm run verify`.

The patch boundary follows P-01 through P-06 of the
[design specification](../docs/spec/v0.3.md):

- Client creates the branded Workers Channel and rejects foreign channel overrides.
  `waitForReady` reports the explicitly unsupported connection concept.
- The bottom interceptor receives the final method definition and options after
  transformers and client/call interceptors. It removes consumed interceptor keys
  and keeps an omitted deadline distinct from explicit Infinity. Call credentials
  are composed once by WorkersCall before authentication.
- Factory, metadata, interceptor state machines, typed stream surfaces, error
  stacks, and StatusBuilder retain upstream implementations. Metadata adds only
  a transport iterator and substitutes the default error logger to avoid native
  process/environment tracing initialization.
- HTTP/2 and TLS references are type-only. The unsupported server parent type is
  opaque; native channel, resolver, retry, server and transport code is excluded.
  Transport credentials are implemented separately in
  [`src/credentials.ts`](../src/credentials.ts).
- Root exports the supported client API. Server constructors remain explicit
  unsupported stubs. Generated service names, unsafe-name skipping, Metadata map
  shape, stream buffering and destroy behavior follow grpc-js 1.14.0.

Two focused corrections are deliberate differences from the pinned native core:
Client sends the argument returned by `callInvocationTransformer`, and the bottom
interceptor honors a replacement `method_definition` from the final interceptor.
Both are required by this adapter's existing documented transformation contract.
Unsupported HTTP/2 connectivity, client streaming, bidi streaming, call parent
propagation and unsupported write flags remain transport limitations. Observer exception
scheduling is still owned by WorkersCall; upstream source reuse does not imply a
complete native-event or full Google SDK compatibility certification.
