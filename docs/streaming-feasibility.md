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

The early-error result is a remaining operational limitation. Native HTTP/2
receives status 7 while its writer is open. Envoy also returns and completes an
HTTP 200 response carrying `grpc-status: 7`, with an empty body. The Node
forwarder flushes and completes this response before the two-second observation
window expires. Workerd's Fetch promise in this Miniflare route nevertheless
remains pending until the request writer is closed; it then returns the same
status 7. Thus the observed delay occurs at the Fetch/Miniflare boundary, not
while Envoy is preparing a response. This test does not distinguish a deployed
Workers behavior from a Miniflare forwarding constraint.

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
