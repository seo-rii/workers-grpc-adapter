# Modern Google SDK profile

`google-modern-v1` is a separate, exact build profile for the following locked dependency graph. The existing `google-static-v1` profile and its golden fixtures remain available.

| Package | Version |
| --- | --- |
| `@google-cloud/datastore` | 11.1.0 |
| `@google-cloud/datastore-api` | 0.3.0 |
| `@google-cloud/firestore` | 9.2.0 |
| `@google-cloud/firestore-api` | 0.2.0 |
| `@google-cloud/secret-manager` | 7.1.0 |
| Root `google-gax` | 6.7.0 |
| Firestore API's nested `google-gax` | 5.0.8 |
| `protobufjs` | 7.6.6 |
| `gaxios` | 7.3.1 |

These SDK versions require Node 22 or newer for the build and local Node consumers. The fixtures pin official Google auth 11.1.0 and override the nested 10.5.0 dependency with 10.9.1, matching the existing fixture's strict declaration compatibility choice. Package locks preserve exact dependency versions and integrity values; this profile does not accept arbitrary versions within upstream semver ranges.

Select the profile explicitly in your existing esbuild integration:

```js
const { createGoogleWorkerBuild } = require('@grpc/grpc-js/build');

const preset = createGoogleWorkerBuild({
  projectRoot: '/absolute/path/to/your/pinned-consumer',
  outdir: '/absolute/path/to/your/build/preset',
  profile: 'google-modern-v1',
  typescript: require('typescript'),
});

// Supply preset.plugin in your esbuild plugins list, then apply Wrangler's
// nodejs_compat bundling as in the existing Google Worker build instructions.
```

The consumer's dependency layout must match the profile. The preset validates package identities, source bytes, protobuf schemas and code-generator inputs before generating a registry. Unknown profiles, a legacy graph selected with the modern profile, changed versions and changed schema bytes fail the build. The default profile remains `google-static-v1`.

This SDK generation splits GAPIC clients into `datastore-api` and `firestore-api` packages. Their schemas and generated client sources have distinct profile entries. The build still uses static protobuf codecs and Workers' native Fetch for the pinned Gaxios transport; it does not patch installed packages or global protobuf prototypes.

Datastore 11 explicitly calls protobuf `setup()` while initializing its legacy key codec. The modern profile preserves the schema lookups and uses the already generated codecs, avoiding a second code-generation step during a Worker request. It also converts the static writer's byte array to a Buffer before the SDK's base64 helper. Exact source hashes and AST checks guard these version-specific replacements; the legacy profile's transformations are unchanged. Tests compare the encoded-key digest against the native SDK and require a successful round trip.

Firestore 9.2 also supplies `grpc-node.flow_control_window: 262144` and `grpc.use_local_subchannel_pool: 1` unconditionally. The adapter accepts these exact values as compatibility hints. Fetch owns its connections and flow control, so these options do not change transport behavior; other values remain rejected. Message and transport byte ceilings continue to apply independently.

## Local verification

`node scripts/test-modern-sdk.cjs` compares the separately installed `fixtures/modern` adapter graph against `fixtures/modern-native` with native grpc-js 1.14.0. Both fixtures compile the same real SDK consumer under strict Node16, NodeNext and Bundler resolution, using ESM and CommonJS sources and `skipLibCheck: false`.

The runtime gate executes identical business-source bytes against the existing controlled native gRPC service. It covers Datastore entity write/read/query/delete and legacy key encoding, Firestore document write/read/query/delete, and Secret Manager metadata success plus missing/permission errors. Node adapter calls and both workerd transport modes must match native method/status traces and business assertions. Worker requests carry credentials through the actual pinned Google auth and GAX code, with all outbound I/O redirected to the local service.

The controlled service uses synthetic data and established protobuf request/response fields. It is not a Google emulator or live API test, and its finite responses do not establish production transaction, quota or performance behavior. The controlled-service gate does not expand support to other SDK versions, arbitrary schemas, every newly added method, or live Cloudflare conversion. The separate Listen emulator gate below covers the modern graph; broader authentication and lifecycle gates continue to use the legacy golden graph.

## Firestore Listen/Watch

`node scripts/test-modern-firestore-watch.cjs` exercises Firestore 9.2.0 document and query `onSnapshot` through real Envoy to the official local Firestore emulator. It enables `experimentalRequestStreaming: true` with `mode: 'grpc-web'` and uses `google-modern-v1` for the Worker build. Automatic Cloudflare conversion remains outside this gate.

The test executes the exact same business-source bytes as the Firestore 8.3.0 Watch gate, copied into the native and adapter fixture graphs. The Worker build redirects only those business imports to `fixtures/modern`; its input manifest must contain the modern Firestore and Firestore API packages and no legacy Google dependencies. Source hashes, exact SDK versions, native method counts and callback results prevent an accidental comparison against a different dependency graph.

The eight cases compare native grpc-js, the Node adapter and two calls to the same workerd instance. They cover an initially absent document, creation, updates, deletion, query ordering and filtering, added/modified/removed changes, unsubscribe after an acknowledged write, and listener reuse. The harness requires Listen responses before the streaming request finishes, no polling substitute, deleted fixture documents, terminated clients and released forwarding streams. Anonymous emulator credentials and a loopback-only outbound guard keep the test independent of ambient Google credentials.

Results are written separately to `verification/modern-firestore-watch.json`. This local coverage does not establish live IAM, index behavior, quotas, deployed Worker lifetime, multi-hour listener operation, or reconnect/resume-token recovery. See [Firestore Watch](firestore-watch.md) and [request streaming](request-streaming.md) for the transport boundary and lifecycle requirements.
