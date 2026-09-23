# API reference

This document describes the current prototype, not the complete v0.3 design. Generated `dist/*.d.ts` declarations provide the exact signatures after `npm run build`. Examples using `@grpc/grpc-js` assume that name resolves to this adapter through the consumer's dependency configuration.

## Client exports

The root exports `Client`, `Channel`, `Metadata`, `ChannelCredentials`, `CallCredentials`, `credentials`, `status`, `connectivityState`, `compressionAlgorithms`, `propagate`, `makeGenericClientConstructor`, `makeClientConstructor`, `loadPackageDefinition`, `closeClient`, `getClientChannel` and `waitForClientReady`.

`Client.makeUnaryRequest()` supports callback-only, metadata, options, and metadata-plus-options overloads. `makeServerStreamRequest()` returns a Node Readable. `makeClientStreamRequest()` and `makeBidiStreamRequest()` return their call surfaces and then terminate with `UNIMPLEMENTED` without starting authentication or network work.

Client interceptors, interceptor providers, `InterceptingCall`, `ListenerBuilder`, `RequesterBuilder` and `StatusBuilder` are available. Supplying both interceptors and providers for the same call is a configuration error. `Server` and `ServerCredentials` exist only to reject server use explicitly. The generated `compatibility/exports-contract.json` report records root export differences from upstream.

## Metadata

`Metadata` provides `set`, `add`, `remove`, `get`, `getMap`, `clone`, `merge`, `getOptions` and `setOptions`. Binary `-bin` entries use Buffer values; other values use printable ASCII strings. Transport serialization preserves repeated entries rather than flattening them through `getMap()`.

`waitForReady: true` and `corked: true` are unsupported call options. Idempotency and cacheability hints are stored but do not enable adapter retries or caching. Duplicate authorization, CR/LF injection and transport-owned headers are rejected.

## Global configuration

Import configuration from the `/config` subpath before constructing clients. Choose one of the following modes; both use binary `application/grpc-web+proto` requests and responses at the adapter's Fetch boundary.

### Cloudflare automatic outgoing conversion

`cloudflare` is the default mode. It sends to the logical service's HTTPS origin without an endpoint map:

```ts
import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'cloudflare',
  defaultTimeoutMs: 30_000,
});

const client = new Client('datastore.googleapis.com:443', credentials.createSsl());
```

For example, `/google.datastore.v1.Datastore/Lookup` targets `https://datastore.googleapis.com/google.datastore.v1.Datastore/Lookup`. The example constructs the transport client; a real RPC also needs its method codecs and service credentials.

Cloudflare's private-beta capability automatically converts outgoing gRPC-Web to native gRPC. Its published client example uses ordinary `fetch()` with manual redirect handling, with no special conversion flag. The adapter uses that request shape, but configuration cannot enable the account capability. Confirm it is enabled before using this mode against a native gRPC service. This project's local tests do not establish deployed conversion behavior. See [Cloudflare's announcement](https://blog.cloudflare.com/grpc-workers/).

### Explicit gRPC-Web gateway

`grpc-web` selects an explicit trusted gateway and requires an endpoint map:

```ts
import { Client, credentials } from '@grpc/grpc-js';
import { configureWorkersGrpc } from '@grpc/grpc-js/config';

configureWorkersGrpc({
  mode: 'grpc-web',
  endpoints: {
    'datastore.googleapis.com': 'https://gateway.example.test',
  },
  defaultTimeoutMs: 30_000,
});

const client = new Client('datastore.googleapis.com:443', credentials.createSsl());
```

The same Lookup method now targets `https://gateway.example.test/google.datastore.v1.Datastore/Lookup`. Replace the example origin with a trusted gateway that performs gRPC-Web translation; it can see credentials and protobuf payloads. The client target and authentication audience remain the logical service. Unmapped targets fail with `WGA_UNMAPPED_TARGET` instead of being sent directly.

This is an explicitly selected gateway alternative, not automatic failover. A failed call is not replayed through another mode. Neither mode uses GAX's `fallback: true` REST transport.

### Settings and configuration lifetime

`configureWorkersGrpc(config)` returns a `WorkersGrpcConfigSnapshot`. `getWorkersGrpcConfig()` returns the current snapshot without locking it or starting network work.

| Setting | Default and meaning |
|---|---|
| `mode` | `cloudflare` by default: direct HTTPS target with Cloudflare conversion; `grpc-web`: explicit gateway mapping |
| `endpoints` | Required in `grpc-web` mode: logical authority → trusted HTTPS gateway origin; rejected in `cloudflare` mode |
| `defaultTimeoutMs` | Unset; if supplied, a positive safe integer in milliseconds |
| `transportMaxSendBytes` | 32 MiB per message |
| `transportMaxReceiveBytes` | 32 MiB per message |
| `allowInsecureLocalhost` | `false`; permits credential-free HTTP tests only for literal `127.0.0.1` or `[::1]` in `grpc-web` mode |

These message ceilings are adapter policy, not Google or Cloudflare service limits. A smaller grpc-js channel limit takes precedence. A channel limit of `-1` removes that channel restriction but retains the transport ceiling. The default channel receive limit is 4 MiB; a GAX client that explicitly supplies `-1` uses the transport ceiling.

Configuration snapshots are immutable. Reapplying the same normalized configuration is allowed. A different second configuration throws `WGA_CONFIG_ALREADY_SET`; changing it after the first globally configured Channel throws `WGA_CONFIG_LOCKED`.

Targets accept `hostname[:port]`, not URLs, resolver schemes such as `dns:///`, user information, paths, queries or fragments. Gateway values must be origins. RPC methods use `/package.Service/Method`.

## Per-instance adapter

`createWorkersGrpcTransport(config?)` from `/adapter` returns:

- `channelCredentials`: default HTTPS channel credentials.
- `grpcOptions(existing?)`: channel options bound to the instance configuration.
- `gaxOptions(existing)`: a scoped grpc facade with `fallback: false`.

Instance configuration does not change the global snapshot. Existing channel overrides conflict with `grpcOptions()`. Existing `grpc`, `sslCreds` or `fallback` settings conflict with `gaxOptions()`. The GAX facade has construction tests but has not been exercised through real GAX; it is not the validated SDK installation path.

## Credentials

`credentials.createSsl()` uses Fetch TLS. Custom certificate authorities, mTLS certificates and TLS verification callbacks are unsupported. `createInsecure()` is limited by the explicit local-test routing policy; credentials cannot be sent over that route.

`createFromGoogleCredential()` accepts an object whose `getRequestHeaders()` returns headers synchronously or as a Promise. Legacy callback-only Google credential shapes are unsupported. `createEmpty()` produces empty call credentials.

Metadata generators use callbacks. The first callback wins; a rejected Promise returned by a generator is also handled. Composed credentials preserve input order. The authentication `service_url` identifies the logical service, not the gateway origin.

## Failure semantics

| Condition | gRPC status |
|---|---|
| Local cancellation | `CANCELLED` |
| Expired deadline | `DEADLINE_EXCEEDED` |
| Network failure or channel close | `UNAVAILABLE` |
| Truncated frame or invalid metadata | `INTERNAL` |
| Message or metadata budget exceeded | `RESOURCE_EXHAUSTED` |
| Unsupported RPC or message compression | `UNIMPLEMENTED` |
| HTTP 200 without gRPC status | `UNKNOWN` |
| Authentication failure | Preserves permitted explicit codes; absent codes become `UNKNOWN`, invalid control-plane codes become `INTERNAL` |

Fetch redirects use `manual` mode and are not followed. Local error details use bounded `WGA_*` diagnostics. Callback results and status events remain distinct parts of the call surface.

## Build-time SDK support

The Node-only `/build` subpath exports `createGoogleWorkerBuild({ projectRoot, outdir, profile, typescript })`. The optional profile defaults to `google-static-v1`; the installed TypeScript module is required. The returned object contains an esbuild `plugin`, a `registryFile` path and `manifest()`.

Install TypeScript and esbuild as development dependencies. Keep `/build` out of Worker runtime imports. The preset rejects mismatched dependency, source or schema hashes rather than adapting arbitrary SDK versions. The repository's `scripts/workers-sdk-test.cjs` is the executable integration example.

Native HTTP/2, arbitrary upstream deep imports, gzip, channelz, load balancing and remote connection health are unavailable. Connectivity reports only `IDLE` or `SHUTDOWN`; `waitForReady()` never reports a ready connection. Identity-encoded writes accept flags `0`, `BufferHint` (`1`), `NoCompress` (`2`) or their combination. `WriteThrough` and actual parent-call propagation are unsupported.
