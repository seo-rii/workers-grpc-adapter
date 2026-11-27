# Resource limits

`resourceLimits` adds opt-in limits shared by the clients of one transport. Per-message ceilings still apply independently. Start with limits suited to the application's payloads and measure its actual Worker memory use; the byte budget does not bound the whole isolate heap.

```ts
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import type { WorkersGrpcResourceLimits } from '@grpc/grpc-js/config';

const resourceLimits: WorkersGrpcResourceLimits = {
  maxConcurrentCalls: 8,
  maxQueuedCalls: 16,
  maxBufferedBytes: 16 * 1024 * 1024,
  readableHighWaterMark: 1,
};
const transport = createWorkersGrpcTransport({
  defaultTimeoutMs: 10_000,
  resourceLimits,
});

// Pass transport.grpcOptions() or transport.gaxOptions(...) to each client.
console.log(transport.resourceUsage());
```

The numbers above are examples, not workload recommendations or platform connection limits. The same settings are accepted by `configureWorkersGrpc()`.

| Limit | Default | Validation and behavior |
| --- | --- | --- |
| `maxConcurrentCalls` | Unset: no admission limit | Positive safe integer; limits admitted logical RPCs across channels using this snapshot |
| `maxQueuedCalls` | `0` when concurrency is limited | Nonnegative safe integer; requires `maxConcurrentCalls`; excess calls fail with `RESOURCE_EXHAUSTED` / `WGA_CALL_QUEUE_FULL` |
| `maxBufferedBytes` | Unset: no aggregate byte ceiling | Positive safe integer, at most 2,147,483,647; failed reservations report `RESOURCE_EXHAUSTED` / `WGA_BUFFER_BUDGET` |
| `readableHighWaterMark` | Node's existing object-mode default | Positive safe integer; sets the readable queue's object count for raw server-streaming and bidirectional calls |

The configuration is copied and frozen. All channels created from one factory's `grpcOptions()` or `gaxOptions()` share its budget, including different service targets. Separate factories remain independent even when their settings match. Globally configured channels share the global snapshot's budget. Reuse the factory when the application needs a common limit; creating a factory for every request creates separate budgets.

When a `callInvocationTransformer` selects a different adapter channel, the adapter-created stream uses that channel's `readableHighWaterMark`. A replacement stream supplied by the transformer keeps its own queue settings.

## Admission and cancellation

Waiting calls enter a FIFO queue before outgoing interceptor startup, authentication, serialization, and Fetch. The whole-call deadline and parent cancellation remain active while waiting. Cancellation and channel close remove waiting calls, prevent later startup, and preserve one final result. Interceptor constructors still execute synchronously while the call is constructed.

Supplying `maxConcurrentCalls` makes outgoing startup asynchronous even when a slot is immediately available. Omitting it preserves synchronous requester startup. A slot counts the whole admitted logical call, including adapter retry backoff. An SDK retry creates a new call and obtains its own admission. Slots count logical calls, not sockets, responses awaiting headers, or Cloudflare connection allowances.

The absolute deadline is checked again when admission completes and before each queued outgoing operation. An expired call returns its slot without starting another interceptor or serialization operation, even if the deadline timer has not run yet. Work already executing synchronously cannot be interrupted.

With `maxConcurrentCalls`, each call snapshots its supplied metadata before admission: headers and binary values, metadata options, and opaque key assignments. Reusing or editing the caller's `Metadata` while a call waits cannot replace that call's authorization or interceptor context. Outgoing interceptors receive the call's own snapshot and can rewrite it normally. Opaque values retain their application-defined object identity; the adapter does not clone arbitrary objects stored with `setOpaque()`.

Cancelling an admitted RPC returns its admission slot. Buffer ownership is independent: a custom Fetch implementation that ignores `AbortSignal` can retain an encoded request body until it settles. Those leases remain charged even after the local RPC has terminated, so another call may still encounter the byte budget. For a call with a finite deadline, they stay charged at most until one second after that deadline; see [calls that outlive their request](#calls-that-outlive-their-request).

Compression and decompression can also retain their input after local cancellation and even after the codec stream reports itself closed. Their reservations remain charged until the native input operation completes or reports a codec failure, with the same one-second-after-deadline bound. Public cancellation does not wait for this work; a burst of canceled compressed requests still shares the same byte budget.

## Calls that outlive their request

A Worker can return its Response while an RPC it started is still running. Pinned SDKs do this on their own. Firestore `runTransaction()` sends its Rollback in the background after the update function or Commit fails. A Firestore query's `get()` resolves when the `RunQuery` stream reports `done`, before the RPC's final trailer arrives. Datastore's automatic Rollback after a failed `Transaction.commit()` can also start after a [`cancellableCall()`](sdk-cancellation.md#promise-calls-and-commit) has settled.

When a request ends, workerd cancels that request context's outstanding Fetch at the network layer. It also drops the context's timers and promise continuations, including continuations resolved later from another request. The adapter observes no abort, stream error or deadline for the cancelled RPC, and its own deadline timer never runs. Because clients and transports are shared across requests, such a call would otherwise stay admitted, with its buffers charged, until the channel closed. With `maxConcurrentCalls`, a few of them could hold every slot, so later calls would fail with `WGA_CALL_QUEUE_FULL` or wait for their own deadline.

The adapter therefore treats a call as detached when it is still unfinished one second after its deadline: its deadline timer could not run. The next admission or `resourceUsage()` on the same transport budget ends it with `DEADLINE_EXCEEDED` / `WGA_DEADLINE`. That releases its admission slot, channel registration and parent or cancellation-scope listener. It also releases buffer reservations whose suspended owner can never release them, including those of an uncooperative Fetch. The status reaches the call's original listeners in the request that triggered the expiry. Any continuation that resumes the ended request is cancelled by workerd, which logs a warning about cross-request promise resolution. A call that already has a terminal status keeps it; expiry then only releases the reservations it still holds.

Until that point, a stranded call still counts against both limits. The pinned Firestore client uses 60-second Rollback and 300-second RunQuery deadlines; Datastore calls default to 60 seconds. A call without any deadline (no SDK timeout, no `defaultTimeoutMs`, or an explicit `Infinity`) cannot be detected and remains until its channel closes. SDK state outside the adapter is not repaired. For example, the Firestore client pool releases an operation in a promise continuation of the ended request, so `Firestore.terminate()` can keep waiting for it.

Let SDK background RPCs finish instead of being cancelled by keeping the request alive, with a bound, until the transport is idle:

```ts
// After building the Response; transport is the shared createWorkersGrpcTransport() result.
ctx.waitUntil((async () => {
  const end = Date.now() + 5_000;
  while (Date.now() < end && transport.resourceUsage().activeCalls > 0) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
})());
```

`activeCalls` counts every request using the transport, so concurrent requests can extend this wait up to its bound. `waitUntil()` lifetime is limited by the platform and is not durable background execution. A Rollback that is still cancelled can leave its transaction's locks held until the server expires that transaction.

## Byte ownership and diagnostics

Reservations cover adapter-managed request snapshots and framing, parser buffers, and exposed compression/decompression buffers. Allocation paths reserve before creating their accounted buffers. Encoding and parsing can temporarily need multiple copies; choose a budget larger than one message's wire size. Some borrowed or aliased buffers are conservatively charged more than once while different asynchronous owners can retain them. Counts therefore describe reservations, not a heap profiler's live-byte measurement.

The budget excludes metadata, caller-owned serialization allocations, arbitrary deserialized protobuf objects, objects retained in Node Readable queues, runtime-managed Fetch buffers, codec internals, and other application or SDK memory. A smaller readable high-water mark limits queued object count; it cannot determine an object's actual retained byte size. Honor stream backpressure and retain finite deadlines for slow consumers.

`transport.resourceUsage()` returns a fresh counts-only object, typed as `WorkersGrpcResourceUsage` from `/config` or `/adapter`:

- `activeCalls`, `queuedCalls`, `bufferedBytes`: current admitted calls, waiting calls, and buffer reservations.
- `peakActiveCalls`, `peakQueuedCalls`, `peakBufferedBytes`: highest values observed by this transport snapshot.

No target, metadata, token, or payload is included. Mutating the returned object does not change accounting. After cooperative completion, active/queued/current bytes return to zero; peak counts remain. A nonzero byte count after cancellation can represent an outstanding uncooperative Fetch owner, rather than another active logical call.

Focused tests cover FIFO/cancellation schedules, aggregate byte ownership, compression and frame reservations, channel reuse, shared grpc/GAX configuration, factory isolation, and readable queue settings. `test/detached-call-expiry.test.cjs` withholds timer delivery and Fetch settlement to model an ended request, including admission recovery, queued calls, channel close and calls without a deadline. `npm run test:workerd:detached-calls` checks the same behavior in workerd against a loopback peer, which records that workerd cancelled each stranded request. These checks do not replace deployed Worker heap measurements or sustained-load tests.
