# Binary gRPC-Web Fetch handlers

`@grpc/grpc-js/server` exports `createGrpcWebHandler` for unary, server-streaming, client-streaming and bidirectional RPCs handled by a Worker. It returns an asynchronous `(Request) => Response` handler. This is a separate Fetch API; the package's root `Server` and `ServerCredentials` remain unsupported native grpc-js socket APIs.

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

Each service-definition entry uses the existing `ServerMethodDefinition` shape: `path`, `requestStream`, `responseStream`, `requestDeserialize` and `responseSerialize`. Full generated method definitions also work. Handler keys must exactly match definition keys. Registration snapshots definitions and handlers, rejects unsafe keys and duplicate paths, and supports all four combinations of request/response streaming. It dispatches only registered paths.

The handler accepts `POST` with binary `application/grpc-web` or `application/grpc-web+proto`. For non-streaming requests, it reads and validates exactly one message before deserialization and application invocation. Missing or extra messages are rejected. A request-streaming handler instead receives a lazy `AsyncIterable<Request>` and may accept zero or more messages. Each iterator read validates and deserializes one frame. Request trailer frames, truncated framing and malformed compression are rejected when consumed. Native `application/grpc`, gRPC-Web text, CORS preflight and native listening sockets are outside this API. Authentication and authorization belong in the surrounding Worker or application handler.

## Request streaming and handler types

```ts
const definition = {
  upload: {
    path: '/example.Upload/Collect', requestStream: true, responseStream: false,
    requestDeserialize: decodeChunk, responseSerialize: encodeSummary,
  },
  exchange: {
    path: '/example.Upload/Exchange', requestStream: true, responseStream: true,
    requestDeserialize: decodeChunk, responseSerialize: encodeChunk,
  },
} as const;

const handle = createGrpcWebHandler(definition, {
  async upload(requests, context) {
    let totalBytes = 0;
    for await (const chunk of requests) totalBytes += chunk.data.byteLength;
    return { totalBytes };
  },
  async *exchange(requests, context) {
    for await (const chunk of requests) yield chunk;
  },
});
```

Preserve literal streaming flags with `as const`, or pass an inline definition.
Registration then checks the request shape and response kind: unary and
client-streaming handlers return one response; server-streaming and bidi
handlers return an `AsyncIterable<Response>`. Either may return a promise of
that result. The exported `GrpcWebUnaryHandler`, `GrpcWebServerStreamingHandler`,
`GrpcWebClientStreamingHandler` and `GrpcWebBidiStreamingHandler` types are
available for separately declared handlers. Existing definitions whose flags
have widened to `boolean` retain the legacy handler typing and runtime kind
checks; preserve literal flags to obtain the stronger checks.

The request iterable is one single-consumer cursor, not a replayable collection.
Overlapping `next()` calls fail with `INTERNAL` / `WGA_SERVER_REQUEST_CONCURRENT_READ`.
There is no eager read before the handler asks for input. Each subsequent read
follows application demand, although the Fetch runtime may provide several
frames in one chunk and may buffer independently. Breaking a request loop
cancels the unread upload and permits a normal response. Completing a response
also cancels remaining upload input; the adapter does not drain or validate
bytes the handler chose not to consume. A consumed protocol/deserialization
failure remains terminal even if application code catches its iterator error.

For bidi handlers, a response can arrive before input EOF and before the next
request message. Request EOF closes only the input direction; the handler can
continue emitting responses. A deadline, observed caller abort or response
cancellation interrupts both directions. An early successful response cancels
unread input without changing its successful status or aborting the context.
Application work still needs to observe `context.signal` for exceptional
termination, and must stop its own detached work after normal completion.

The adapter client requires explicit `grpc-web` mode and
`experimentalRequestStreaming: true` for client/bidi calls. The Fetch server
accepts these framed uploads directly, including through a Worker service
binding. This does not enable browser gRPC-Web request streaming or Cloudflare
automatic conversion for client/bidi RPCs; see [request streaming](request-streaming.md).

## Context and errors

Every application handler receives its decoded request and a context containing:

- `method`: registered full RPC path.
- `metadata`: decoded request metadata, including binary values.
- `signal`: aborted on an observed request abort, deadline expiry or response-body cancellation. A remote disconnect is visible only when the runtime propagates it.
- `deadline`: absolute epoch milliseconds, or `Infinity`.
- `cancelled`, `getDeadline()`, `on('cancelled', listener)` and `removeListener('cancelled', listener)`: the [ParentCall](parent-calls.md) surface for forwarding deadline and cancellation to child RPCs.
- `sendMetadata(metadata)`: merges initial metadata before response headers are committed.
- `setTrailer(metadata)`: replaces application trailing metadata before completion.

Use the package's `Metadata` class for outgoing metadata. Reserved protocol headers and status keys cannot be supplied through it. Binary values use `-bin` keys. For an async generator, set initial metadata before its first yield; later initial-metadata changes fail. Trailing metadata may be set from normal generator completion.

Throw `new GrpcWebServerError(status.PERMISSION_DENIED, 'Public explanation', metadata)` to deliberately return an application status and public details. The optional metadata is merged with context trailers. All other handler or iterator exceptions become `INTERNAL` with `WGA_SERVER_HANDLER`; raw exception messages, payloads and credentials are not copied into responses. Serialization and framing failures likewise use fixed diagnostics.

## Resource bounds

Options are `maxReceiveMessageBytes`, `maxSendMessageBytes`, `maxWireMessageBytes`, `compression` and `defaultTimeoutMs`. Decoded request and response limits default to 4 MiB; the wire limit defaults to 32 MiB and also caps decoded limits. Frame headers add five bytes. Metadata and trailer blocks are bounded separately. Configure smaller limits for your service's payloads and memory budget.

Identity, deflate and gzip request messages are accepted. The optional response `compression` uses the existing enum values `0`, `1` and `2`. The configured codec is used only if the caller advertises it in `grpc-accept-encoding`; otherwise responses use identity. Codecs and bounded decompression are shared with the client transport. See [compression](compression.md).

`grpc-timeout` accepts the standard one-to-eight-digit `H`, `M`, `S`, `m`, `u` and `n` forms. Extreme values are clamped safely. `defaultTimeoutMs` applies when no timeout header is present. Completed calls remove their deadline timers and request-abort listeners.

Request streams retain the current Fetch chunk and one decoded frame; they do not collect all requests. Output streams retain at most one application item ahead of consumer demand. The response reader controls further iteration. Cancelling it aborts the context and invokes the iterator's `return()` when available. Pending handlers and iterator operations are raced against cancellation and deadlines; late failures remain handled. Application code must cooperate with `context.signal` to stop its own I/O or side effects. The adapter cannot forcibly interrupt an unresolved application promise or synchronous computation, and `return()` cannot bypass an async generator that ignores cancellation while awaiting work.

The local suite compares responses against a pinned native grpc-js server, runs both client modes against this handler inside workerd, and sends independently framed native-codec requests through Miniflare's incoming Fetch boundary. These checks do not establish deployment routing, inbound Cloudflare automatic conversion, IAM, production load or full native grpc-js server equivalence.

## Service-binding lifecycle boundary

The two-Worker integration test (`npm run test:workerd:integration`) exercises the
installed public client and this handler over an actual service binding. Local
client cancellation and channel close complete promptly, while an idle backend
generator can remain pending until its `grpc-timeout` expires. Do not infer
remote application cleanup from the client's terminal status alone.

Use finite RPC deadlines and cooperate with `context.signal`. If completion of
bounded cleanup must remain observable after the consuming request ends, retain
that application's cleanup promise with the Worker execution context's
`ctx.waitUntil()`. The adapter returns a Response; it does not own the surrounding
Worker execution context or keep arbitrary application work alive. The test uses
this explicit lifetime retention and requires cleanup before disposing workerd.
This is a local runtime boundary, not a deployed cancellation guarantee.


`npm run test:workerd:server-streaming` additionally exercises the installed
client and Fetch server with ten controlled in-Worker scenarios and four real
two-Worker service-binding scenarios: client-stream EOF, bidi response before
half-close, cancellation and deadline. It records backend input unlock and
handler cleanup before runtime disposal. The binding fixture retains the
cleanup promise through both application completion and input-reader release with
`ctx.waitUntil()` and allows the finite server deadline to
finish cleanup after local cancellation; it does not assert immediate remote
cancel propagation. The Node regressions also cover blocked directions,
unconsumed uploads, iterator break, sticky parse failures and overlapping reads.
