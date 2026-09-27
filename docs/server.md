# Binary gRPC-Web Fetch handlers

`@grpc/grpc-js/server` exports `createGrpcWebHandler` for unary and server-streaming RPCs handled by a Worker. It returns an asynchronous `(Request) => Response` handler. This is a separate Fetch API; the package's root `Server` and `ServerCredentials` remain unsupported native grpc-js socket APIs.

```js
import { createGrpcWebHandler } from '@grpc/grpc-js/server';

const handleRpc = createGrpcWebHandler(serviceDefinition, {
  echo(request, context) {
    return request;
  },
  async *updates(request, context) {
    for await (const update of readUpdates(request, context.signal)) {
      yield update;
    }
  },
});

export default {
  fetch(request) {
    return handleRpc(request);
  },
};
```

Each service-definition entry uses the existing `ServerMethodDefinition` shape: `path`, `requestStream`, `responseStream`, `requestDeserialize` and `responseSerialize`. Full generated method definitions also work. Handler keys must exactly match definition keys. Registration snapshots definitions and handlers, rejects unsafe keys and duplicate paths, and rejects client-streaming or bidirectional methods. It dispatches only registered paths.

The handler accepts `POST` with binary `application/grpc-web` or `application/grpc-web+proto`. It reads and validates exactly one request message before invoking application code. Missing messages, extra messages, request trailer frames, truncated framing and malformed compression are rejected. Native `application/grpc`, gRPC-Web text, CORS preflight and native listening sockets are outside this API. Authentication and authorization belong in the surrounding Worker or application handler.

## Context and errors

Every application handler receives its decoded request and a context containing:

- `method`: registered full RPC path.
- `metadata`: decoded request metadata, including binary values.
- `signal`: aborted when the caller disconnects, the deadline expires or the response is cancelled.
- `deadline`: absolute epoch milliseconds, or `Infinity`.
- `sendMetadata(metadata)`: merges initial metadata before response headers are committed.
- `setTrailer(metadata)`: replaces application trailing metadata before completion.

Use the package's `Metadata` class for outgoing metadata. Reserved protocol headers and status keys cannot be supplied through it. Binary values use `-bin` keys. For an async generator, set initial metadata before its first yield; later initial-metadata changes fail. Trailing metadata may be set from normal generator completion.

Throw `new GrpcWebServerError(status.PERMISSION_DENIED, 'Public explanation', metadata)` to deliberately return an application status and public details. The optional metadata is merged with context trailers. All other handler or iterator exceptions become `INTERNAL` with `WGA_SERVER_HANDLER`; raw exception messages, payloads and credentials are not copied into responses. Serialization and framing failures likewise use fixed diagnostics.

## Resource bounds

Options are `maxReceiveMessageBytes`, `maxSendMessageBytes`, `maxWireMessageBytes`, `compression` and `defaultTimeoutMs`. Decoded request and response limits default to 4 MiB; the wire limit defaults to 32 MiB and also caps decoded limits. Frame headers add five bytes. Metadata and trailer blocks are bounded separately. Configure smaller limits for your service's payloads and memory budget.

Identity, deflate and gzip request messages are accepted. The optional response `compression` uses the existing enum values `0`, `1` and `2`. The configured codec is used only if the caller advertises it in `grpc-accept-encoding`; otherwise responses use identity. Codecs and bounded decompression are shared with the client transport. See [compression](compression.md).

`grpc-timeout` accepts the standard one-to-eight-digit `H`, `M`, `S`, `m`, `u` and `n` forms. Extreme values are clamped safely. `defaultTimeoutMs` applies when no timeout header is present. Completed calls remove their deadline timers and request-abort listeners.

Server streams retain at most one application item ahead of consumer demand. The response reader controls further iteration. Cancelling it aborts the context and invokes the iterator's `return()` when available. Pending handlers and iterator operations are raced against cancellation and deadlines; late failures remain handled. Application code must cooperate with `context.signal` to stop its own I/O or side effects. The adapter cannot forcibly interrupt an unresolved application promise or synchronous computation, and `return()` cannot bypass an async generator that ignores cancellation while awaiting work.

The local suite compares responses against a pinned native grpc-js server, runs both client modes against this handler inside workerd, and sends independently framed native-codec requests through Miniflare's incoming Fetch boundary. These checks do not establish deployment routing, inbound Cloudflare automatic conversion, IAM, production load or full native grpc-js server equivalence.
