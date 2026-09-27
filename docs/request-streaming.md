# Experimental request streaming

Request streaming is an opt-in experiment for an explicitly configured gRPC-Web
gateway. The default transport continues to reject client-streaming and
bidirectional calls. Cloudflare automatic conversion is outside this experiment;
a local workerd test cannot establish deployed edge support.

```js
const transport = createWorkersGrpcTransport({
  mode: 'grpc-web',
  endpoints: { 'api.example.com:443': 'https://gateway.example.com' },
  experimentalRequestStreaming: true,
});
const client = new GeneratedClient('api.example.com:443',
  transport.channelCredentials, transport.grpcOptions());
const call = client.clientStreamingMethod({ deadline: Date.now() + 10_000 }, callback);
call.on('error', handleError);
call.write(firstMessage);
call.end(lastMessage);
```

The normal generated client-streaming and bidirectional methods provide the
Writable and Duplex APIs. The flag is rejected in `cloudflare` mode. Streaming
calls are never replayed by the adapter's unary retry policy. A custom Fetcher
must accept a streaming request body and `duplex: 'half'`.

The internal `RequestStreamBody` owns at most one pending write: either the input
being encoded or one encoded frame awaiting a Fetch body pull. Its ReadableStream
has a zero high-water mark, so the controller does not silently queue another
frame. The writable callback can complete when the downstream consumer accepts
the frame. This is not a guarantee that network bytes were flushed, that Envoy
received the frame or that the backend processed the message.

Each message is copied before asynchronous compression. Both the decoded message
limit and encoded wire limit apply per message. Gzip, deflate and the per-message
NoCompress flag use the existing message codec. Half-close waits for a pending
frame before EOF. Cancellation, terminal response or encoding failure must abort
the body, reject the pending writer and drop its retained bytes. A late codec
completion cannot enqueue a frame after termination.

Node's public Writable can separately buffer writes ahead of this transport.
Applications must honor `write()` returning false and wait for `drain` to keep
that queue bounded. The single-frame transport bound does not measure Fetch,
Envoy, kernel socket or backend buffering. Deadlines and explicit cancellation
remain necessary, including when a server rejects a call before the producer
has finished writing.

When Fetch cancels an upload after an early server response, pending writes fail
but the response still determines the RPC status. If Fetch never resolves the
response, the call's deadline or explicit cancellation ends it. In the local
workerd/Miniflare path, an early server rejection while the writer remains open
is delayed until half-close; the integration gate verifies deadline cleanup for
this case. Do not depend on immediate early rejection delivery.

The [local feasibility experiment](streaming-feasibility.md) exercises raw Fetch
through the pinned Envoy gRPC-Web filter. It is evidence about that local route,
not certification of arbitrary gateways, Google streaming APIs or Cloudflare's
edge conversion service. `npm run test:request-streaming` exercises the adapter's
public Writable and Duplex APIs through that same local gateway, including
ordered frames, response-before-second-request, a slow backend, compression,
half-close, limits, errors and cleanup. This gate does not establish compatibility
with every streaming SDK or a deployed gateway's buffering and timeout policy.
