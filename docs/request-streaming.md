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
frame before EOF. Cancellation or encoding failure aborts the body. Once a valid
terminal status is parsed, the adapter instead closes the upload cleanly and
discards any pending frame. Both paths stop encoding and release retained bytes;
a late codec completion cannot enqueue a frame after termination.

Node's public Writable can separately buffer writes ahead of this transport.
Applications must honor `write()` returning false and wait for `drain` to keep
that queue bounded. The single-frame transport bound does not measure Fetch,
Envoy, kernel socket or backend buffering. Deadlines and explicit cancellation
remain necessary, including when a server rejects a call before the producer
has finished writing.

When Fetch cancels an upload after an early server response, pending writes fail
but the response still determines the RPC status. Write failures from a stopped
upload are delivered after the final RPC status, so a generic write error does
not hide the server's status. A valid `grpc-status` header or terminal trailer
causes the adapter to close its upload producer without aborting the Fetch call.
It then continues parsing through actual response EOF, rejecting extra frames or
invalid trailing data. A trailer without a valid status does not trigger this
close. If Fetch never resolves the response or its body EOF, the call's deadline
or explicit cancellation ends it.

A separate 24-case local probe with workerd `1.20260921.1` and Miniflare
`5.20260921.0-alpha` reproduced delayed rejection delivery with both direct HTTP
external bindings and Node-handler bindings. Empty fixed-length responses delayed
Fetch resolution; chunked responses exposed headers or trailer frames but delayed
EOF until request half-close. Response `Connection: close` did not remove the
delay. The adapter's terminal-status handling resolves the exposed-status EOF
case; an empty fixed-length response whose Fetch promise remains pending still
requires a deadline or explicit cancellation. The integration gate verifies
deadline cleanup for that gateway case. These local results do not establish
deployed Cloudflare behavior; see the
[boundary investigation](streaming-feasibility.md#early-response-boundary).

The [local feasibility experiment](streaming-feasibility.md) exercises raw Fetch
through the pinned Envoy gRPC-Web filter. It is evidence about that local route,
not certification of arbitrary gateways, Google streaming APIs or Cloudflare's
edge conversion service. `npm run test:request-streaming` exercises the adapter's
public Writable and Duplex APIs through that same local gateway, including
ordered frames, response-before-second-request, a slow backend, compression,
half-close, limits, errors and cleanup. This gate does not establish compatibility
with every streaming SDK or a deployed gateway's buffering and timeout policy.
