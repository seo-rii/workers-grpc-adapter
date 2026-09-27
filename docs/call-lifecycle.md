# Call and stream lifetime

The adapter treats a raw gRPC stream's Node lifetime as part of its RPC lifetime. Destroying a stream releases the adapter's request and response resources and cancels an unfinished RPC. This is an intentional adapter extension: the pinned native grpc-js 1.14.0 stream surface does not forward `destroy()` or an async iterator's early return to RPC cancellation.

| Consumer action | RPC outcome | Node stream behavior |
| --- | --- | --- |
| `stream.cancel()` | `CANCELLED`, if still active | Existing gRPC callback/error and status delivery |
| `stream.destroy()` | `CANCELLED`, if still active | Closes without introducing a second stream error |
| `stream.destroy(error)` | `CANCELLED`, if still active | Preserves the supplied Node error |
| `for await (...) { break; }` | `CANCELLED`, if still active | Node's iterator destroys the stream; the adapter does not add a second gRPC error |
| Normal readable EOF | Original final status | Automatic destruction does not cancel the completed RPC |
| Writable `.end()` / `finish` | Call remains active until its response | Half-closes the upload; does not cancel the response |

A final gRPC status is delivered once. The client-streaming callback also remains the RPC result channel when its Writable is destroyed. Pending and queued write callbacks settle once, including when an asynchronous outgoing interceptor has retained the active write; a late continuation cannot settle that write callback again.

Explicit destruction closes the local stream promptly. It does not prove that a remote server has already released its application handler. In particular, HTTP service bindings can delay remote cancellation observation until the forwarded deadline; see [limitations](limitations.md). Set finite deadlines when remote resource lifetime must be bounded.

`test/stream-destroy.test.cjs` covers Readable, Writable and Duplex destruction, iterator early return, normal EOF, upload half-close, pending writes, and destruction while credentials or outgoing interceptors are waiting. Tests also assert adapter timer/buffer cleanup and a subsequent successful call on the same client.
