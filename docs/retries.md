# Explicit retry policies

Retries are disabled by default. An adapter call then makes at most one Fetch.
For unary methods that are safe to repeat, configure an explicit policy:

```js
const transport = createWorkersGrpcTransport({
  retryPolicy: {
    methods: ['/example.Reader/Get'],
    maxAttempts: 3,
    initialBackoffMs: 100,
    maxBackoffMs: 2_000,
    backoffMultiplier: 2,
    retryableStatusCodes: [grpc.status.UNAVAILABLE],
  },
});
```

The method list is exact; there are no wildcards or automatic assumptions about
idempotency. `maxAttempts` includes the initial request and is limited to 2–10.
Backoff values are milliseconds, positive integers up to 300,000. Delays include
20% jitter and never exceed `maxBackoffMs`. Valid server `grpc-retry-pushback-ms`
values override the delay; negative, malformed or excessive pushback stops retries.

Only unary calls can retry, and only before a response message is delivered.
Initial metadata for an eligible call is held until the first response message or
the final attempt. Failed-attempt metadata is not emitted to the caller. This is
an explicit adapter replay policy, not native grpc-js transparent retry or its
HTTP/2 response-header commitment semantics. Protocol errors, malformed responses,
authentication failures, cancellation and expired deadlines are not retried.

Fetch exceptions are not retried unless `retryOnFetchError: true` is also set.
An exception or lost response can hide a write that already committed; enabling
this option requires application-level replay safety. A listed server error code
does not by itself prove that the server performed no side effects.

Each attempt uses the same logical deadline, fresh credential metadata and a new
request body. Later attempts send `grpc-previous-rpc-attempts`. Cancellation and
channel closure stop the backoff and prevent another credential exchange or Fetch.
Retries remain on the selected mode, endpoint and Fetcher; there is no failover.

SDK/GAX retries are separate calls and can multiply this policy's attempts. Keep
one retry owner where possible. `grpc.enable_retries` and native service-config
retry policies remain unsupported; setting this adapter policy is the explicit
opt-in. Server-streaming, client-streaming and bidirectional calls are not replayed.
