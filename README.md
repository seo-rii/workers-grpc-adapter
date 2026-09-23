# workers-grpc-adapter

An experimental `@grpc/grpc-js` client adapter for Cloudflare Workers. It carries unary and server-streaming RPCs over binary gRPC-Web using `fetch()` while retaining the upstream client, metadata, interceptor, and stream APIs.

**Prototype: `0.0.0-prototype.1`. Unpublished on npm, with `private: true`.** Local tests exercise real Google SDKs and official emulators. They do not establish complete grpc-js compatibility, live Google Cloud support, or production Cloudflare support.

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

The adapter implements both routing modes. In `cloudflare` mode it addresses the service directly and relies on Cloudflare's private-beta outgoing gRPC-Web-to-gRPC conversion. Cloudflare describes automatic conversion using ordinary `fetch()` without a special conversion flag. Your account must have that capability enabled; selecting this mode does not enable it. See [Cloudflare's announcement](https://blog.cloudflare.com/grpc-workers/).

In `grpc-web` mode it addresses a trusted gateway from an explicit endpoint map. This is the gateway alternative for environments without Cloudflare conversion and is the path exercised by the local Envoy and emulator integrations. Both modes send binary gRPC-Web from the Worker. The adapter does not probe capabilities, replay a failed call through the other mode, or use GAX's REST fallback. The deployed Cloudflare conversion path remains unverified by this project.

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

Choose one mode before constructing clients. For a Worker with Cloudflare's outgoing conversion enabled, use the default `cloudflare` mode without an endpoint map:

```js
import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'cloudflare',
  defaultTimeoutMs: 10_000,
});

const client = new Client('service.example:443', credentials.createSsl());
```

An RPC on this client targets `https://service.example/package.Service/Method`; Cloudflare performs the outgoing conversion. Replace the example target with your native gRPC service. The adapter still encodes and reads binary gRPC-Web at its Fetch boundary.

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

The pinned Google SDK graph also needs the Node-only `@grpc/grpc-js/build` preset when bundling for Workers. It validates package and schema hashes and generates protobuf code at build time. It requires TypeScript and esbuild as development dependencies and does not patch `node_modules`. [The SDK Worker test](scripts/workers-sdk-test.cjs) is an executable build example. This preset supports its pinned dependency profile, not arbitrary SDK versions.

## What is tested

The fixtures pin Datastore **10.1.0**, Firestore **8.3.0**, and Secret Manager **7.1.0**. Checks include strict TypeScript consumers, actual tarball installation, native grpc-js comparisons, actual Envoy translation, and local workerd execution.

Shared business modules run unchanged in native Node, Node with the adapter, and workerd. The harness compares source hashes, business assertions, RPC methods, and statuses. Official Firestore emulators in Native and Datastore modes cover CRUD, queries and aggregation, data types, transactions and rollback, missing results, backend errors, and write atomicity. Additional controlled-server cases cover cancellation, transaction retries, and a commit applied before its response is lost. Secret Manager uses a controlled local server, not a Google-hosted service or official emulator.

| Command | Focus |
| --- | --- |
| `npm test` | API, framing, lifecycle, authentication, and streaming tests |
| `npm run test:sdk:types` | Real SDK declarations against native and replacement packages |
| `npm run test:sdk:local` | Shared SDK cases against a controlled native gRPC server |
| `npm run test:workers:shared` | Shared SDK cases executed in workerd |
| `npm run test:emulators` | Official database emulators across native, adapter, and workerd |
| `npm run verify` | Complete local verification, packaging, and evidence checks |

Passing cases are evidence for their stated behavior, not a claim that every planned compatibility requirement is covered. The [test catalog](compatibility/test-catalog.json) and [testing guide](docs/testing.md) describe that distinction. CI results apply to the checked commit and pinned toolchain.

## Limitations

- Client streaming, bidirectional streaming, and Firestore Listen/Watch are unsupported.
- Server APIs, custom certificate authorities, mTLS, compression, and native connection pooling are unsupported.
- The adapter does not implement native grpc-js retry or health-check behavior. It sends at most one fetch per adapter call; an SDK retry creates a separate call.
- Emulator tests do not establish production IAM, quota, index, transaction-concurrency, or deployed Cloudflare behavior.
- The Workers build profile and SDK versions are pinned. Other dependency graphs require separate work and verification.

The project remains in prototype status with `releaseEligible: false`. See [Limitations](docs/limitations.md), [Google test guidance](docs/google-tests.md), and [the implementation plan](PLAN.md) before evaluating an integration.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, changes, and pull requests. Report security concerns through the channels in [SECURITY.md](SECURITY.md); keep credentials and vulnerability details out of ordinary issues.

## License

Original adapter code is licensed under [MIT](LICENSE). Vendored grpc-js code is licensed under [Apache-2.0](vendor/LICENSE); its notices, original sources, hashes, and reproducible patches are retained in [vendor/](vendor/README.md). See [NOTICE](NOTICE) for attribution. This project is not affiliated with or endorsed by Google, Cloudflare, or the gRPC project.
