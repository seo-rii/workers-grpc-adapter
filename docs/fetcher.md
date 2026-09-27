# Custom Fetchers and Worker bindings

The optional `fetcher` configuration selects the Fetch implementation for a transport's RPCs. It accepts an object with `fetch(input, init): Promise<Response>`, including a Cloudflare HTTP service binding or mTLS certificate binding. Without it, calls use the runtime's global Fetch.

Create the transport inside the Worker handler where its bindings are available. For an existing gRPC-Web gateway reached through an mTLS binding:

```js
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

// Inside fetch(request, env), using an already configured certificate binding.
const transport = createWorkersGrpcTransport({
  mode: 'grpc-web',
  endpoints: {
    'api.example.com': 'https://grpc-gateway.example.com',
  },
  fetcher: env.GATEWAY_CERTIFICATE,
});

const client = new YourGeneratedClient(
  'api.example.com',
  transport.channelCredentials,
  transport.grpcOptions(),
);
// Invoke your generated methods and close the client when its work is complete.
```

Cloudflare's [mTLS binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/) presents the configured client certificate for its Fetch requests. The adapter does not load certificate files or implement a TLS handshake. Provision the binding separately; passing certificate buffers to `credentials.createSsl()` remains unsupported.

For a Worker implementing a gRPC-Web gateway, use its [HTTP service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) as `fetcher: env.GRPC_GATEWAY`. Keep an explicit HTTPS endpoint mapping: the URL still identifies the requested origin and RPC path, even when the binding directs the request to another Worker. The receiving Worker must understand binary gRPC-Web and return its framed status trailers. A service binding alone does not convert a gRPC-Web body to native HTTP/2 gRPC.

Google SDKs use the same transport with `transport.gaxOptions({ projectId, authClient })`. Each new channel carries its own configuration, so a cached GAX service constructor cannot select another client's binding. `WorkersGrpcFetcher` is exported as a type from `@grpc/grpc-js/config`.

## Isolation and request contract

Validation snapshots the selected `fetch` method and retains its original receiver. Reassigning the configuration's `fetcher` or replacing `binding.fetch` does not change an existing transport. The original binding is neither modified nor frozen; its internal state remains owned by the binding. Global configuration equality compares both the binding and captured method identities, so a different binding cannot bypass the configuration lock.

The custom Fetcher receives the validated destination, RPC headers and binary body, `redirect: 'manual'`, the call's AbortSignal, and the mode's `cf.grpcWeb` setting. It must honor those inputs, return a standard Fetch Response, and avoid hidden retries or redirects. A rejected binding call does not fall back to global Fetch. Cancellation/deadlines abort the supplied signal; a response that arrives afterward is cancelled without reopening the RPC.

The existing HTTPS, explicit gateway mapping and credential rules still apply. Plaintext is limited to explicitly enabled literal-loopback tests, which cannot carry channel credentials. Authentication uses the logical gRPC service URL, and the selected Fetcher sees the resulting request credentials; choose a trusted binding. This option affects RPC transport only. Google auth token acquisition continues to use its own configured HTTP transport.

## Verification scope

`node --test test/fetcher.test.cjs` checks receiver preservation, immutable selection, global locking, per-client/GAX-token isolation, logical auth audiences, routing restrictions, rejection, cancellation and late-response cleanup.

`node scripts/test-workers-fetcher.cjs` runs two actual local workerd service bindings and global Fetch side by side in both modes, over cold and warm handler invocations. It checks 20 RPCs, including 12 binding calls, exact destinations, framed bodies, credential isolation and the GAX channel-token path. This gate uses direct adapter clients rather than real Google SDK constructors.

These tests do not perform an mTLS handshake or validate deployed service routing. Certificate acceptance and the combination of an mTLS binding with Cloudflare automatic gRPC conversion require separate deployment testing. The local service-binding receivers implement a controlled gRPC-Web response and do not emulate Cloudflare's edge converter.
