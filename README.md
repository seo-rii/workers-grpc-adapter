# workers-grpc-adapter

An experimental `@grpc/grpc-js` client adapter for Cloudflare Workers. It carries unary and server-streaming RPCs over binary gRPC-Web using `fetch()` while retaining the upstream client, metadata, interceptor, and stream APIs. Explicit gateway mode also offers experimental client/bidirectional streaming and verified Firestore listeners.

**Prototype: `0.0.0-prototype.1`. Unpublished on npm, with `private: true`.** Local tests exercise real Google SDKs and official emulators; separate temporary deployments also verify authenticated Google APIs using Cloudflare automatic conversion and an explicit gateway. These tests do not establish complete grpc-js compatibility or production readiness.

## Quick start

The full local suite requires **Linux x64, a current Node.js 22 or later, and npm 11.4.1**. The package manager is pinned in `package.json`; npm 10 does not reproduce the fixture's scoped auth override. Check `npm --version` before setup and select npm 11.4.1 using your preferred toolchain manager. CI installs that version on its disposable runner.

Run these commands from a checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run fixtures:install
node fixtures/envoy/download.cjs
npm run emulators:install
npm run verify
```

The setup downloads pinned npm dependencies, Envoy, the official Firestore emulator, and a local Java runtime. It needs network access during setup, but no Google Cloud or Cloudflare credentials. The emulator toolchain stays in project-local caches; it does not change your system Java or gcloud configuration.

`fixtures:install` builds and packs the current source, updates the fixture lockfiles to match that tarball, and installs both the replacement and native grpc-js baselines. Repeat it after changing files included in the package. `verify` disables live Google tests and cloud write opt-ins; its database writes target loopback emulators using synthetic `demo-` projects.

For a smaller first check, run the first two setup commands followed by `npm test`; Envoy and the emulators are not needed for that check. See [Contributing](CONTRIBUTING.md) for focused checks and [Testing](docs/testing.md) for the full verification model. Generated reports are available in the `local-verification-node22-*` artifact of a [GitHub Actions run](https://github.com/seo-rii/workers-grpc-adapter/actions), or under `verification/` after a local run.

## How it works

```text
Google SDK or grpc-js client
  → upstream client / metadata / interceptors
  → adapter channel and call lifecycle
  → binary gRPC-Web over fetch()
    ├─ cloudflare (default): service origin → Cloudflare conversion → native gRPC
    └─ grpc-web: mapped gateway origin → gateway conversion → native gRPC
```

The client-side core is derived from `@grpc/grpc-js@1.14.0`. The adapter replaces its native HTTP/2 transport with per-call request handling, framing, deadlines, cancellation, and response streaming. CJS and ESM entry points share the same implementation and configuration. See [Architecture](docs/architecture.md) and the [API reference](docs/api.md).

The adapter implements both routing modes. In `cloudflare` mode it addresses the service directly and sets `cf.grpcWeb: 'convert'` on each Fetch to request Cloudflare's outgoing gRPC-Web-to-gRPC conversion. It uses binary `application/grpc-web` for compatibility with the tested Google endpoints. No Worker-wide `auto_grpc_convert` flag is required.

In `grpc-web` mode it addresses a trusted gateway from an explicit endpoint map, sends `application/grpc-web+proto`, and sets `cf.grpcWeb: 'passthrough'` so requests reach the gateway unchanged even if the deployment enables automatic conversion. Local Envoy and emulator integrations exercise this gateway path. Both modes send binary gRPC-Web from the Worker. The adapter does not probe capabilities, replay a failed call through the other mode, or use GAX's REST fallback. See the [conversion diagnosis](docs/cloudflare-conversion.md) for the original failures and the evidence behind these settings.

## Using the local package

The fixture installs the adapter under the `@grpc/grpc-js` dependency name and overrides transitive copies. This is the configuration in [fixtures/google/package.json](fixtures/google/package.json):

```json
{
  "dependencies": {
    "@grpc/grpc-js": "file:../../artifacts/workers-grpc-adapter-0.0.0-prototype.1.tgz"
  },
  "overrides": {
    "@grpc/grpc-js": "$@grpc/grpc-js",
    "google-auth-library@10.5.0": "10.9.1"
  }
}
```

The tarball path is relative to that fixture; adjust it for another consumer. There is no published npm installation command yet. Use `npm run doctor` to check the fixture's dependency graph. The scoped auth override resolves a declaration compatibility issue while preserving Secret Manager's separate auth version.

Choose one mode before constructing clients. Enable Node compatibility in your Wrangler configuration; the adapter selects conversion per request:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"]
}
```

Use the default `cloudflare` mode without an endpoint map:

```js
import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'cloudflare',
  defaultTimeoutMs: 10_000,
});

const client = new Client('service.example:443', credentials.createSsl());
```

An RPC on this client targets `https://service.example/package.Service/Method` and requests outgoing conversion at Cloudflare's edge. Replace the example target with your native gRPC service. The adapter still encodes and reads binary gRPC-Web at its Fetch boundary; local workerd checks cannot exercise that edge conversion.

For an explicit gateway, select `grpc-web` and map that same logical service to the gateway origin:

```js
import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'grpc-web',
  endpoints: {
    'service.example:443': 'https://gateway.example',
  },
  defaultTimeoutMs: 10_000,
});

const client = new Client('service.example:443', credentials.createSsl());
```

Here the RPC targets `https://gateway.example/package.Service/Method`. Replace the example service and gateway with your own; an ordinary native gRPC endpoint needs a translation layer to accept this wire protocol. These are alternative configurations, not sequential calls to the configuration API. Configure once before constructing clients; a later call cannot replace it with a different configuration. See the [API reference](docs/api.md) for credentials, limits, per-client configuration, and error behavior.

The pinned Google SDK graph also needs the Node-only `@grpc/grpc-js/build` preset when bundling for Workers. It validates package and schema hashes and generates protobuf code at build time. It requires TypeScript and esbuild as development dependencies and does not patch `node_modules`. [The SDK Worker test](scripts/workers-sdk-test.cjs) is an executable build example. This preset supports its pinned dependency profile, including startup imports and bundled dynamic SDK imports during a request. Different transport instances can coexist in one Worker through `gaxOptions()`; their modes, gateway destinations and credentials remain independent of GAX's constructor cache. See [Google test guidance](docs/google-tests.md).

## What is tested

The fixtures pin Datastore **10.1.1**, Firestore **8.3.0**, and Secret Manager **7.1.0**. Checks include strict TypeScript consumers, actual tarball installation, native grpc-js comparisons, actual Envoy translation, and local workerd execution.

Shared business modules run unchanged in native Node, Node with the adapter, and workerd. The harness compares source hashes, business assertions, RPC methods, and statuses. Official Firestore emulators in Native and Datastore modes cover CRUD, queries and aggregation, data types, transactions and rollback, missing results, backend errors, and write atomicity. Additional controlled-server cases cover cancellation, transaction retries, and a commit applied before its response is lost. Local Secret Manager tests use a controlled server, not an official emulator.

Additional workerd gates exercise OAuth/JWT token refresh through native Fetch, mixed-client credentials, and repeated concurrent fault/recovery waves. The pinned build preset selects native Fetch for Gaxios's default transport while preserving explicit fetch overrides. A controlled Datastore pagination comparison verifies the SDK's `end()` behavior and records why `destroy()` alone does not stop page requests. See [testing](docs/testing.md) for the boundaries of these local checks.

Optional [SDK cancellation helpers](docs/sdk-cancellation.md) add an explicit cancel handle and `AbortSignal` to Promise calls, and connect Datastore query-stream destruction or iterator exit to pagination and the active RPC. They preserve shared-client isolation; cancellation never rolls back an accepted write.

Controlled workerd tests also cover URL-sourced federation and service-account impersonation, including renewal and SDK credential configuration. Modern Google header providers and legacy callback providers are supported. Secret Manager comparisons exercise pagination, intermediate page failures, method errors and binary AccessSecretVersion responses; the application remains responsible for checking the returned CRC32C. These tests use synthetic credentials and payloads, with no live issuer, IAM or secret access.

The corrected [2026-09-26 GCP deployment test](docs/gcp-cloud-probe.md#corrected-results-2026-09-26) passed all five Google suites with native grpc-js and both deployed Worker modes: Datastore and Firestore CRUD/transactions, plus Secret Manager metadata `GetSecret`. Automatic conversion passed without a Worker-wide conversion flag. Both modes also passed unary echo, a ten-message stream and exact error-status checks against a private native origin. These tests did not read secret payloads or validate credential refresh, sustained load, or production recovery. Live results remain separate from the local verification gates.

| Command | Focus |
| --- | --- |
| `npm test` | API, framing, lifecycle, authentication, and streaming tests |
| `npm run test:sdk:types` | Real SDK declarations against native and replacement packages |
| `npm run test:sdk:local` | Shared SDK cases against a controlled native gRPC server |
| `npm run test:workers:shared` | Shared SDK cases executed in workerd |
| `npm run test:emulators` | Official database emulators across native, adapter, and workerd |
| `npm run verify` | Complete local verification, packaging, and evidence checks |

Passing cases are evidence for their stated behavior, not a claim that every planned compatibility requirement is covered. The [test catalog](compatibility/test-catalog.json) and [testing guide](docs/testing.md) describe that distinction. CI results apply to the checked commit and pinned toolchain.

The [public client contract checks](docs/local-contracts.md) connect individual
API, configuration and type requirements to native comparisons, installed
Node/workerd execution and strict compiler results.

## Limitations

- [Client and bidirectional streaming](docs/request-streaming.md) are available experimentally in explicit gateway mode with `experimentalRequestStreaming: true`. They remain disabled by default and unsupported in automatic conversion mode. [Firestore Listen/Watch](docs/firestore-watch.md) is verified for the pinned Firestore 8.3.0 and 9.2.0 graphs against the official emulator. Bounded recovery for both versions is compared against a controlled native peer; the build presets also preserve terminal permission errors that the raw SDK can lose.
- A separate [Fetch server API](docs/server.md) supports all four RPC shapes, with lazy request streams and handler-kind types. Native grpc-js Server sockets, custom certificate authorities, inline TLS client certificates, and native connection pooling remain unsupported. Preconfigured Workers mTLS and HTTP service bindings can be selected using the [custom Fetcher](docs/fetcher.md) option; deployed TLS behavior requires separate verification.
- Identity, deflate and gzip [message compression](docs/compression.md) are supported with bounded decompression. Compressed trailers and automatic codec fallback are unsupported.
- [Parent calls](docs/parent-calls.md) propagate deadlines and cancellation, including Fetch handler forwarding.
- Explicit [Health Check/Watch](docs/health.md) provides remote probes and a reconnecting observer.
- Explicit opt-in [unary retry policies](docs/retries.md) are supported. Native grpc-js transparent retry and automatic channel health checking remain unsupported; SDK retries are separate calls.
- Optional [resource limits](docs/resources.md) provide shared call admission, bounded waiting queues, adapter-buffer budgets, smaller readable queues, and counts-only usage diagnostics. They do not measure or limit the entire Worker heap.
- Optional [observer events](docs/observability.md) report call and attempt status, timing and traffic without metadata or payloads. Adapter retries retain a logical call identifier; SDK retries create new calls.
- Optional [shared retry throttling](docs/retries.md#shared-retry-throttling) limits replay during endpoint failures. The separate [structured-status helper](docs/status-details.md) decodes bounded rich errors while preserving the original RPC result.
- [Declarative profiles](docs/profiles.md) provide precise build diagnostics and transformer-aware cache identities. [Actual SDK Worker benchmarks](docs/sdk-performance.md) measure bundle sizes, fresh startup, authenticated and warm calls, concurrent slow streams and sampled V8 heap under local CI budgets.
- Emulator tests do not establish production IAM, quota, index, transaction-concurrency, or deployed Cloudflare behavior.
- Two exact SDK graphs are supported: the original `google-static-v1` and [modern `google-modern-v1`](docs/modern-sdk.md) (Datastore 11.1.0, Firestore 9.2.0, Secret Manager 7.1.0). Other graphs require separate profiles and verification.

The project remains in prototype status with `releaseEligible: false`. See [Limitations](docs/limitations.md), [Google test guidance](docs/google-tests.md), and [the implementation plan](PLAN.md) before evaluating an integration.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, changes, and pull requests. Report security concerns through the channels in [SECURITY.md](SECURITY.md); keep credentials and vulnerability details out of ordinary issues.

## License

Original adapter code is licensed under [MIT](LICENSE). Vendored grpc-js code is licensed under [Apache-2.0](vendor/LICENSE); its notices, original sources, hashes, and reproducible patches are retained in [vendor/](vendor/README.md). See [NOTICE](NOTICE) for attribution. This project is not affiliated with or endorsed by Google, Cloudflare, or the gRPC project.
