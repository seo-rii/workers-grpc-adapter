# Call and attempt observations

The optional `observer` configuration receives small, immutable events for a logical RPC and its transport attempts. It works with either transport mode, global configuration, and `createWorkersGrpcTransport()`. Observation is disabled by default and adds no OpenTelemetry dependency or remote exporter.

```ts
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';
import type { WorkersGrpcObserver } from '@grpc/grpc-js/config';

const observer: WorkersGrpcObserver = event => {
  if (event.type === 'call-end') {
    console.log({
      kind: 'rpc',
      id: event.logicalCallId,
      status: event.statusCode,
      durationMs: event.elapsedMs,
      queueMs: event.queueMs,
      attempts: event.attemptCount,
      fetches: event.fetchCount,
    });
  } else if (event.type === 'attempt-end') {
    console.log({
      kind: 'rpc-attempt',
      id: event.logicalCallId,
      attempt: event.attempt,
      status: event.statusCode,
      durationMs: event.durationMs,
      authMs: event.authDurationMs,
      sentBytes: event.sentBytes,
      receivedBytes: event.receivedBytes,
    });
  }
};

const transport = createWorkersGrpcTransport({
  defaultTimeoutMs: 10_000,
  resourceLimits: { maxConcurrentCalls: 8, maxQueuedCalls: 16 },
  observer,
});
// Pass transport.grpcOptions() to a grpc-js client, or transport.gaxOptions(...)
// to a supported Google SDK client, as shown in the API reference.
```

`configureWorkersGrpc({ observer, ... })` accepts the same callback. The snapshot retains that function reference. Reapplying global configuration requires the same observer function, as well as the same other settings; replacing it follows the usual configuration-lock rules. `WorkersGrpcObserver`, `WorkersGrpcEvent`, and `WorkersGrpcTraffic` are exported types from `/config` and `/adapter`. There is no separate observer constructor or runtime API to import from the root grpc module.

## Events and identifiers

Every event has `type`, `logicalCallId`, and `elapsedMs`. The identifier is unique across transport factories sharing one loaded adapter implementation. It is a module-local sequence, not a globally unique trace ID; separate isolates, process restarts, or independently loaded adapter copies can reuse it. Use application-owned trace context when joining records across those boundaries.

An adapter retry stays under the same `logicalCallId` and increments the attempt number, starting at `1`. An SDK retry creates a new logical call and a new identifier. Observations do not automatically join those SDK calls into a higher-level operation.

| Event | Additional fields and meaning |
|---|---|
| `call-start` | Logical RPC lifecycle begins, before admission and outgoing interceptor startup. |
| `call-admitted` | `queueMs`: elapsed admission wait; outgoing interceptors can now run. |
| `attempt-start` | `attempt`: preparation of this transport attempt begins. |
| `auth-end` | `attempt`, `durationMs`, `statusCode`: authentication completed, failed, or was interrupted by local termination. |
| `fetch-start` | `attempt`: the adapter invokes its configured Fetch implementation. |
| `response-headers` | `attempt`: Fetch returned a Response to the adapter; this does not imply successful gRPC status. |
| `first-message` | `attempt`: the first response message was decoded, before protobuf deserialization, response interceptors, or user delivery. |
| `attempt-end` | `attempt`, `durationMs`, `authDurationMs`, `fetchStarted`, `statusCode`, and the traffic counters below. |
| `retry-scheduled` | `attempt`, `delayMs`, `statusCode`: a retry was scheduled after the numbered attempt ended with this status. The next attempt would be `attempt + 1`; cancellation or deadline expiry can prevent it from starting. |
| `call-end` | `attemptCount`, `fetchCount`, `queueMs`, `statusCode`, and traffic counters summed across the call's attempts. |

Pre-attempt failures, including admission rejection, a queued deadline, or an interceptor failure, can produce `call-end` with zero attempts and Fetches. Authentication failure can end an attempt without `fetch-start`. A queued call that terminates before admission has no `call-admitted` event, but its `call-end.queueMs` includes the time spent waiting. Events for response headers and messages are absent if those stages are never reached.

An attempt's status describes its transport result. A logical call can remain in an asynchronous response interceptor after the transport finishes, so its final status and duration can differ. `call-end` records the final local RPC outcome once; it does not wait for a held interceptor continuation or an uncooperative Fetch to settle.

## Durations and counters

Times use the monotonic performance clock in milliseconds. They are captured at the corresponding state transition, before the event's callback is queued. `elapsedMs` is measured from logical call construction. `attempt-end.durationMs` is measured from that attempt's start, and `authDurationMs` from attempt start until authentication ends. When termination interrupts pending authentication, the authentication duration ends at local termination and does not measure any later credential-provider work.

`queueMs` measures admission waiting before outgoing interceptors. It excludes interceptor work, authentication, Fetch time, and retry backoff. A call's elapsed duration covers those stages once the logical call exists; SDK initialization before call construction remains outside it.

| Counter | Measurement |
|---|---|
| `sentBytes` | Unary framed request bytes handed to Fetch, or streaming request frame bytes actually pulled from the upload body. Includes frame headers and uses compressed payload size when compression is enabled. It is not a network acknowledgement. |
| `receivedBytes` | Raw response body chunks read by the frame parser. Includes frame headers, trailer frames and malformed input that was read before failure. Excludes HTTP headers and HTTP/TLS envelopes. |
| `responseMessages` | Complete, decoded response messages observed before waiting for Readable demand, protobuf deserialization or user delivery. A subsequent deserialization or interceptor failure does not undo the count. |
| `responseMessageBytes` | Sum of those messages' decoded payload lengths, after decompression. Excludes frame headers and trailers; it does not measure JavaScript object or total heap size. |
| `attemptCount` | Transport attempts begun, including ones that terminate during authentication before Fetch. |
| `fetchCount` | Fetch invocations begun, including ones that throw or reject. |

These counters stop at local terminal state. Late work from a canceled Fetch, credential provider, or remote server is not retroactively included. Byte counters are cumulative observations; `resourceUsage().bufferedBytes` instead reports currently held adapter buffer reservations. Neither represents total isolate memory. See [Resource limits](resources.md) for ownership and release behavior.

## Delivery and privacy

Callbacks run in queued microtasks and their return values are never awaited. A thrown exception or rejected returned Promise is swallowed, so instrumentation failures cannot replace an RPC result or stop cleanup. A slow synchronous callback still blocks the event loop, and repeated slow callbacks can delay other work. Keep callbacks short and bound any application-owned export queue.

Events contain only identifiers, event kinds, numeric status codes, timings and counters. They omit method names, targets, request or response metadata, credentials, payloads, exception text and gRPC status details. The adapter does not send records anywhere. Application logging, trace labels and exporter configuration remain under the application's control.

The observer offers no durable delivery or export guarantee. It does not retain a Workers invocation for asynchronous exporting. If an application forwards events to its telemetry system, it must manage that work's lifetime and capacity itself. `call-end` proves local termination, not that every buffer has been released or a remote handler has stopped; use resource diagnostics and backend evidence for those separate questions.
