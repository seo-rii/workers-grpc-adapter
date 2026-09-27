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

## Admission and cancellation

Waiting calls enter a FIFO queue before outgoing interceptor startup, authentication, serialization, and Fetch. The whole-call deadline and parent cancellation remain active while waiting. Cancellation and channel close remove waiting calls, prevent later startup, and preserve one final result. Interceptor constructors still execute synchronously while the call is constructed.

Supplying `maxConcurrentCalls` makes outgoing startup asynchronous even when a slot is immediately available. Omitting it preserves synchronous requester startup. A slot counts the whole admitted logical call, including adapter retry backoff. An SDK retry creates a new call and obtains its own admission. Slots count logical calls, not sockets, responses awaiting headers, or Cloudflare connection allowances.

Cancelling an admitted RPC returns its admission slot. Buffer ownership is independent: a custom Fetch implementation that ignores `AbortSignal` can retain an encoded request body until it settles. Those leases remain charged even after the local RPC has terminated, so another call may still encounter the byte budget.

## Byte ownership and diagnostics

Reservations cover adapter-managed request snapshots and framing, parser buffers, and exposed compression/decompression buffers. Allocation paths reserve before creating their accounted buffers. Encoding and parsing can temporarily need multiple copies; choose a budget larger than one message's wire size. Some borrowed or aliased buffers are conservatively charged more than once while different asynchronous owners can retain them. Counts therefore describe reservations, not a heap profiler's live-byte measurement.

The budget excludes metadata, caller-owned serialization allocations, arbitrary deserialized protobuf objects, objects retained in Node Readable queues, runtime-managed Fetch buffers, codec internals, and other application or SDK memory. A smaller readable high-water mark limits queued object count; it cannot determine an object's actual retained byte size. Honor stream backpressure and retain finite deadlines for slow consumers.

`transport.resourceUsage()` returns a fresh counts-only object, typed as `WorkersGrpcResourceUsage` from `/config` or `/adapter`:

- `activeCalls`, `queuedCalls`, `bufferedBytes`: current admitted calls, waiting calls, and buffer reservations.
- `peakActiveCalls`, `peakQueuedCalls`, `peakBufferedBytes`: highest values observed by this transport snapshot.

No target, metadata, token, or payload is included. Mutating the returned object does not change accounting. After cooperative completion, active/queued/current bytes return to zero; peak counts remain. A nonzero byte count after cancellation can represent an outstanding uncooperative Fetch owner, rather than another active logical call.

Focused tests cover FIFO/cancellation schedules, aggregate byte ownership, compression and frame reservations, channel reuse, shared grpc/GAX configuration, factory isolation, and readable queue settings. These checks do not replace deployed Worker heap measurements or sustained-load tests.
