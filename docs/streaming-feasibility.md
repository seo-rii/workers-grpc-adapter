# Request streaming feasibility

A local raw-Fetch experiment shows that workerd can send multiple gRPC-Web
request frames and receive responses before the request body is closed through
our pinned Envoy gateway. This establishes a possible gateway implementation;
it does not establish support in Cloudflare's deployed automatic converter.

Run `node scripts/test-streaming-feasibility.cjs` after installing the pinned
local fixtures and Envoy binary. The report is
`verification/streaming-feasibility.json`. Exit zero means that the bounded
experiment completed and cleaned up; inspect each capability's classification.
A capability can remain blocked in a successful experiment report.

The tested route is:

```text
workerd Fetch + TransformStream
  -> streaming Node HTTP forwarder
  -> Envoy 1.39.1 grpc_web filter
  -> native grpc-js 1.14.0 client-streaming / bidirectional service
```

Both directions of the forwarder use Node stream `pipe()` and propagate
cancellation. It does not collect request or response bodies. A separate
observation endpoint waits for messages actually received by the native server.
Native HTTP/2 baselines exercise client streaming, bidirectional streaming and
an early PERMISSION_DENIED response.

| Experiment | Local result |
| --- | --- |
| First request message arrives while the producer is still open | Passed |
| Three request messages, half-close, one summary response | Passed |
| Response one received before the producer sends request two | Passed |
| 32 messages of 64 KiB with the server pausing between reads | Passed |
| Abort while the request writer remains open | Native cancellation observed |
| Early PERMISSION_DENIED before request half-close | Fetch response delayed until half-close |

Each experiment runs with binary `application/grpc-web+proto` and `cf.grpcWeb`
`passthrough`, then bare `application/grpc-web` and `convert`. Both use the same
local Envoy filter. The latter verifies the local request shape only. Miniflare
interception is not Cloudflare's deployed conversion service, and these results
must not be presented as automatic-mode request-streaming certification.

The bidirectional case is a causal check: request two is created only after
response one is read. Buffering the full request before forwarding cannot pass
that case. The slow-consumer case keeps at most one producer write outstanding;
its largest frame is 65,545 bytes. This measures the experiment's producer bound,
not the memory retained by Fetch, sockets, Envoy or the backend.

## Early-response boundary

The early-error result is a remaining operational limitation. Native HTTP/2
receives status 7 while its writer is open. Envoy also returns and completes an
HTTP 200 response carrying `grpc-status: 7`, with an empty body. The Node
forwarder flushes and completes this response before the two-second observation
window expires. Workerd's Fetch promise in this Miniflare route nevertheless
remains pending until the request writer is closed; it then returns the same
status 7.

A separate diagnostic on 2026-09-27 isolated this boundary using workerd
`1.20260921.1` and Miniflare `5.20260921.0-alpha`, without Envoy or adapter code.
It compared a direct workerd HTTP `external` service binding with a Miniflare
Node-handler binding: six response shapes, two paths and two repetitions,
**24 cases**. Both paths produced the same results:

| Completed server response | Observation while the request writer remained open |
| --- | --- |
| Empty `Content-Length: 0` with `grpc-status: 7` | Fetch resolution delayed |
| Empty chunked body with `grpc-status: 7` | Headers delivered; body EOF delayed |
| Chunked status-7 trailer frame, ended immediately or after 100 ms | Frame delivered; body EOF delayed |
| Fixed-length empty response or chunked trailer frame with `Connection: close` | Same respective delays |

Each server completed its response before request half-close. The delayed step
remained pending for a 400 ms observation window and completed after the writer
was closed. All local servers and isolates were disposed. This was a separate
diagnostic, not an additional case in the committed feasibility gate.

To reproduce the boundary, have a local Node HTTP server send one of the responses
above after receiving the first request chunk. Configure Miniflare's
`serviceBindings.GATEWAY` with either
`{ external: { address: '127.0.0.1:PORT', http: {} } }` or `{ node: handler }`
through `convertV4MiniflareOptions`. In the Worker, pass a `TransformStream`'s
readable side to `env.GATEWAY.fetch()` with `method: 'POST'` and `duplex: 'half'`,
write one chunk, and separately observe Fetch resolution and body EOF before
closing its writer.

This rules out the adapter and the Node forwarder as necessary causes in the
tested local path. It does not establish deployed Cloudflare behavior. The pinned
[workerd Fetch implementation](https://github.com/cloudflare/workerd/blob/v1.20260921.1/src/workerd/api/http.c%2B%2B#L1695)
pumps request bodies independently of response delivery, so the public API's
streaming support alone does not establish early termination behavior.

The adapter now handles the exposed-status case: after parsing a valid terminal
status from headers or a trailer frame, it closes only the upload producer and
discards pending writes. The Fetch call remains active, and the parser still
requires response EOF and rejects extra frames. A trailer without a valid status
does not trigger upload closure. Pending write callbacks are settled after the
final RPC status to preserve the server error. This removes the EOF dependency
without prematurely closing a valid ongoing RPC or skipping wire validation.

Six focused tests cover header/trailer status with clean EOF, an extra message
or a duplicate trailer; another verifies that a missing EOF still reaches the
deadline and releases a pending compressed write. The separate Firestore
recovery gate also passed 24 cases, 36 Listen calls and 27 adapter Fetch requests
across native, Node adapter and workerd runs through real Envoy. That gate uses
a controlled Firestore protocol peer, not the official emulator or a deployed
Google service.

The empty fixed-length case remains unresolved when Fetch itself does not expose
the response. There is no received status on which the adapter can act, so
explicit deadlines and cancellation remain necessary for that case.

A request-streaming implementation must keep explicit deadlines and cancellation,
release blocked producers on terminal outcomes, bound per-message data and avoid
automatic replay. A backend rejection may be delayed while a producer remains
open. Both local runs verify request cleanup before disposing the isolate, then
stop the native server and Envoy and remove the temporary configuration.

The official [gRPC-Web JavaScript client](https://github.com/grpc/grpc-web#streaming-support)
does not provide these request-streaming APIs. This experiment constructs binary
frames directly with Fetch and uses Envoy's documented
[gRPC-Web filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/grpc_web_filter).
It is separate from that client's compatibility guarantees.
