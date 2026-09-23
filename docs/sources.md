# Sources and provenance

These references explain the design and verification boundaries. External documentation can change; installed package versions and artifact checksums come from the repository's pins rather than a moving branch or a claim about the latest release.

## Official references

| Topic | Reference | Use in this project |
|---|---|---|
| Workers gRPC translation | [Cloudflare announcement](https://blog.cloudflare.com/grpc-workers/) | Outbound gRPC-Web translation design; account enablement and deployed execution remain unverified |
| Workers Node compatibility | [Runtime documentation](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) | Builtin/runtime background; fixture configuration and actual workerd reports define the tested setup |
| npm aliases and root overrides | [npm package.json reference](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/) | Consumer dependency replacement and root-level override behavior |
| grpc-js client behavior | [Client source at 1.14.0](https://github.com/grpc/grpc-node/blob/%40grpc%2Fgrpc-js%401.14.0/packages/grpc-js/src/client.ts) | Vendored client surface and native comparison baseline |
| Binary gRPC-Web | [Protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md) | Message/trailer framing and protocol boundaries |
| Native gRPC | [HTTP/2 protocol specification](https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md) | Metadata, timeout and status semantics used by native interop tests |
| HTTP status fallback | [HTTP-to-gRPC status mapping](https://github.com/grpc/grpc/blob/master/doc/http-grpc-status-mapping.md) | Fallback only when a gRPC status is absent |
| Firestore emulator | [Google Cloud documentation](https://docs.cloud.google.com/firestore/native/docs/emulator) | Local service behavior and differences from production |

## Repository pins

- [vendor/UPSTREAM.json](../vendor/UPSTREAM.json) records grpc-js 1.14.0 npm integrity, commit `3dd281b00fd54ad8f811e941c1d9acc0785c3182`, original and patched source hashes, and patch hashes. `node vendor/verify.cjs` reproduces the patches.
- [compatibility/candidates.json](../compatibility/candidates.json) records the installed Datastore 10.1.0, Firestore 8.3.0 and Secret Manager 7.1.0 artifacts, npm integrity and source references.
- Fixture `package-lock.json` files pin the complete adapter/native/Worker dependency graphs. Generated `compatibility/google-graph.json` and `compatibility/google-native-graph.json` report their actual resolution.
- [fixtures/envoy/binary.json](../fixtures/envoy/binary.json) pins the Envoy release and SHA-256.
- [fixtures/emulators/toolchain.json](../fixtures/emulators/toolchain.json) pins the official Firestore emulator and Java distribution, including download URLs, size, checksum and provenance.
- [src/build/profiles/google-static-v1.json](../src/build/profiles/google-static-v1.json) pins the SDK/GAX/protobuf inputs and schemas supported by the build preset.

Source review, artifact installation and executed compatibility tests are separate evidence. A package manifest or protocol document alone does not demonstrate that the adapter passed an SDK test.

The [historical v0.3 specification](spec/v0.3.md) is retained in Korean. Its [189-case catalog](../compatibility/test-catalog.json) records planned requirements. Current implementation boundaries are in [limitations](limitations.md); [testing](testing.md) explains how to produce reports and locate CI artifacts.
