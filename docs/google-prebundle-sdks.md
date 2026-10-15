# Installed Firestore and Secret Manager prebundles

Run `npm run test:prebundle:sdks` after installing the root and Worker tooling
dependencies. This gate checks an SDK prebundle without a SvelteKit application.
Its consumer imports only the generated package through its installed package
name. The [prebundle guide](google-prebundle.md) describes the public build API.

The gate uses these exact [profile](profiles.md) graphs:

| Profile | Firestore | Secret Manager | Evidence |
| --- | --- | --- | --- |
| `google-static-v1` | `8.3.0` | `7.1.0` | Installed prebundle, local workerd, controlled protobuf peer |
| `google-modern-v1` | `9.2.0` | `7.1.0` | Installed prebundle, local workerd, controlled protobuf peer |

For each profile, the runner builds and packs the current adapter, verifies
original locked registry archives against their integrity, and performs a fresh
offline npm installation into an isolated directory. A cache miss downloads only
the archive at its locked npm registry URL and verifies its integrity before
installation. It preserves the scoped auth override. The additional optional
`supports-color@8.1.1` and `has-flag@4.0.0` dependencies have exact archive pins in
the fixture; they close an optional CommonJS dependency in the runtime artifact.
The SDK graph itself comes from the corresponding committed fixture lockfile.
The two physical installations are used sequentially and removed afterwards.

The installed adapter's build helper generates a static wrapper containing both
SDKs, OAuth client construction, the transport factory, and the cancellation
helper. The manifest must report actual imported SDK transforms, complete
transform coverage, and exactly one owned adapter runtime. The runner compares
installed files with the packed archives, then packs the generated package and
installs it into a second consumer that has no original SDK or adapter dependency.
Before removing the build graph, a strict NodeNext type check with `noEmit` and
`skipLibCheck: false` checks the generated declarations for both SDKs, Timestamp,
transport/auth construction, and the cancellation helper against installed types.
The graphs contain distinct auth majors with nominal `AnyAuthClient` types.
The declaration consumer checks OAuth separately from the SDK constructors; it
does not claim one root OAuth class is assignable to every SDK's auth type.
A separate negative compilation must reject root OAuth `10.9.1` into Secret
Manager's auth `11.1.0` type on the static profile, and root OAuth `11.1.0` into
the public Firestore `v1.FirestoreClient` GAPIC's auth `10.9.1` type on the modern
profile. High-level Firestore `Settings` accepts opaque options through an index
signature; that constructor does not enforce the nominal auth contract. The receipt explicitly
records `typedSharedOAuthInjection: false`: that shared typed-constructor path
for the GAPIC clients is unsupported for these exact graphs. Runtime JavaScript token injection
through both SDKs is checked separately by the workerd cases. A typed auth
factory or a reviewed graph change needs separate implementation and evidence.
The final bundler graph must contain that installed artifact, without source
aliases or another Google transform. Wrangler performs a local dry run and
Miniflare executes its result in workerd. There is no deployment.

The same checks run in gateway mode and direct Cloudflare mode:

| Case | Required observation |
| --- | --- |
| Firestore document write/read/query | `Commit`, `BatchGetDocuments`, `RunQuery`; exact int64, nanosecond Timestamp, bytes, and write timestamp |
| Firestore query stream failure | One delivered document, code `7`, exactly one error and close, no end or late events, successful read on the same client |
| Secret Manager access | Exact synthetic binary payload and CRC32C verified inside the consumer; only byte length and verification booleans leave the consumer |
| Secret Manager list | Two real paginated `ListSecrets` RPCs with ordered results |
| Secret Manager denied/unavailable | Codes `7` and `14`, Unicode details, repeated text/binary trailing metadata, one rejection, one RPC |
| Request signal cancellation | A synthetic Request's AbortSignal reaches `cancellableCall()` after the RPC and local response reader have started; code `1`, local reader cancellation, and same-client recovery |

Adapter retries are left disabled. Secret Manager calls pass `retry: null`, and
Firestore's read GAX method configuration has no retry codes. High-level
Firestore writes supply their own retry options, so this gate preserves that SDK
behavior and tests Commit only on success. The Firestore partial stream uses
permanent code `7`; this gate does not exercise or disable the SDK's separate
cursor-resumption behavior for transient stream failures. Exact RPC, attempt,
and Fetch counts prevent hidden retry amplification in these cases.
Adapter resources and the workerd-owned response readers must be idle before
clients close. A test fetcher wraps the real workerd Fetch response to observe
reader cancellation and lock release. Miniflare's Node peer is released through
a separate control request after local cancellation is observed; this does not
prove cancellation of a deployed backend generator. Its readers must be released
before the next case and before workerd disposal. All withheld peer gates are
released on failure, and workerd disposal has its own timeout. A following
request executes in the same isolate after cancellation. Cancellation stops
available I/O; it does not establish whether a remote write was committed.

Credentials are runtime-only synthetic bindings. The wrapper and artifacts must
not contain the test token. Raw Secret Manager payloads, their hashes, tokens,
and SDK exception objects are excluded from reports and fixture responses.
Independent CRC32C known vectors anchor the shared synthetic checksum helper.

The receipt is `verification/google-prebundle-sdks.json`; its profile manifests,
final artifacts, and bundler graphs are under
`verification/google-prebundle-sdks/`. A successful receipt contains 28 workerd
cases and 48 SDK RPCs across both profiles and modes. Phase logs and exit status
files are recorded separately with private permissions.

This is installed-package, build, wire, and local workerd evidence. The
controlled peer decodes real protobuf requests and encodes bounded responses;
it is not an official Google emulator. Direct mode checks Fetch conversion
intent and controlled gRPC-Web wire behavior. Automatic Cloudflare-to-Google
conversion, live authentication, Google IAM, provider behavior, and deployed
Workers remain unverified here. Other Firestore or Secret Manager RPCs, other
SDK versions, transaction recovery, transient stream resumption, and complete
application integration require their own evidence. See
[Google test guidance](google-tests.md) for the separate live-service boundary.
