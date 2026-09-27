# Parent-call deadlines and cancellation

Client `CallOptions.parent` accepts the `ParentCall` subset of grpc-js server calls. It propagates the parent's deadline and cancellation to the child over either adapter transport mode. Unary, server-streaming, and explicitly enabled gateway request-streaming calls use the same propagation path.

The subset is structural:

```ts
interface ParentCall {
  readonly cancelled: boolean;
  getDeadline(): Date | number;
  on(event: 'cancelled', listener: () => void): unknown;
  removeListener(event: 'cancelled', listener: () => void): unknown;
}
```

Native grpc-js `ServerUnaryCall`, `ServerReadableStream`, `ServerWritableStream`, and `ServerDuplexStream` satisfy this type. The adapter's Fetch server handler context also supplies it. This does not add native server sockets or claim the full `ServerSurfaceCall` API. An `AbortSignal` alone is not a parent call.

## Propagation flags

| `propagate_flags` | Behavior |
| --- | --- |
| omitted or `propagate.DEFAULTS` | Propagate deadline and cancellation |
| `propagate.DEADLINE` | Inherit the earlier parent deadline only |
| `propagate.CANCELLATION` | Cancel when the parent emits `cancelled` only |
| `0` | Do not inherit either property |
| `propagate.DEFAULTS & ~propagate.DEADLINE` | Keep cancellation propagation, disable inherited deadline |
| `propagate.DEFAULTS & ~propagate.CANCELLATION` | Keep deadline propagation, disable inherited cancellation |

Flags must be an unsigned 16-bit integer. Census/tracing and other bits are inert, including those present in `DEFAULTS`; they do not propagate a tracing context. The pinned native implementation likewise uses only the deadline and cancellation bits on this path.

With deadline propagation enabled, the effective absolute deadline is the minimum of the parent deadline and the child's deadline. If the child omitted its deadline, its configured `defaultTimeoutMs` applies before taking this minimum. The resulting deadline controls the logical call, credential wait, retry backoff, upload/download and the outbound `grpc-timeout` header. A later parent deadline cannot extend an explicit child deadline. The parent deadline is read once when the child starts; later changes to the parent object do not extend or reset it.

Cancellation is one-way. Cancelling or closing a child does not cancel its parent or sibling calls. A propagated cancellation finishes with `CANCELLED` and `Cancelled by parent call`, aborts Fetch, stops retries and removes the parent's listener. Every other terminal outcome also removes that listener. A parent already marked cancelled terminates a cancellation-enabled child before credential generation or Fetch; this is an additional guard beyond the pinned native implementation's event subscription.

An invalid parent shape or invalid inherited deadline produces sanitized `INTERNAL / WGA_INVALID_PARENT`. An invalid flag produces `UNIMPLEMENTED / WGA_CALL_OPTION`. No network request is issued for these failures. `parent: null` is equivalent to no parent.

## Forwarding inside a Fetch server

Pass the existing handler context as the child's parent. Forward child failures explicitly if the upstream status should be preserved:

```ts
import { Client } from '@grpc/grpc-js';
import { createGrpcWebHandler, GrpcWebServerError } from '@grpc/grpc-js/server';

// childClient is a Client configured with createWorkersGrpcTransport().
const handler = createGrpcWebHandler(serviceDefinition, {
  forward(request, context) {
    return new Promise((resolve, reject) => {
      childClient.makeUnaryRequest(
        '/example.Child/Echo', serializeRequest, deserializeResponse,
        request, { parent: context },
        (error, value) => {
          if (error) reject(new GrpcWebServerError(error.code, 'Upstream failed'));
          else resolve(value);
        },
      );
    });
  },
});
```

A caller abort, response-body cancellation, handler failure or handler deadline aborts the existing context signal and therefore cancels child calls with cancellation propagation enabled. A parent's deadline and its cancellation event can race: with both bits enabled, the child may observe `DEADLINE_EXCEEDED` or `CANCELLED`, while the parent still returns its own deadline status.

The Fetch context retains its existing lifecycle: successful response completion does not abort its signal or cancel detached child work. Await child work in the handler and provide a child deadline. Native grpc-js server calls can emit `cancelled` when their underlying HTTP/2 stream closes after a successful response; actual native parent objects retain that behavior when used with this adapter. The Fetch context's two event methods are cancellation hooks backed by `AbortSignal`, not a general EventEmitter: other event names are unsupported, and registering the identical listener twice follows EventTarget deduplication.

## Local evidence and limits

`test/parent-calls.test.cjs` covers independent flags, default masks with a bit removed, inherited timeout headers, expired/already-cancelled parents, all four client call kinds, pending credentials, retry backoff, sibling isolation, terminal listener cleanup, malformed input and synchronous subscription reentrancy. It also exercises actual Fetch handler forwarding and successful parent completion.

Run the native and workerd gate after building and installing fixtures:

```sh
node scripts/test-parent-calls.cjs
```

For an unpacked development build, add `--source-build`. The gate records `verification/parent-calls.json` and checks:

- Six strict ESM/CJS compiler configurations, with all four native server call types assignable to `ParentCall`.
- Actual pinned native grpc-js server parents, comparing native and adapter children on explicit cancellation, inherited deadline, disabled propagation and successful parent stream closure.
- Actual workerd Fetch handler forwarding in both adapter modes, cold and warm, including cancelled response readers and disabled propagation.

The workerd automatic-mode branch validates the adapter's local request shape and call lifecycle. It does not certify deployed Cloudflare conversion, production parent requests or native connection semantics. Propagation does not change the separate restrictions on automatic-mode request streaming.
