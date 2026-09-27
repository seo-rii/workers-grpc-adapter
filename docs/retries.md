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
credential-generation failures, cancellation and expired deadlines are not retried.
A server UNAUTHENTICATED or PERMISSION_DENIED status can be replayed only when
explicitly included in `retryableStatusCodes`; this differs from a local credential
generator rejecting before Fetch.

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

## Shared retry throttling

An optional transport-wide budget limits retries during sustained endpoint failures:

```js
const transport = createWorkersGrpcTransport({
  retryPolicy: {
    methods: ['/example.Reader/Get'], maxAttempts: 3,
    initialBackoffMs: 100, maxBackoffMs: 2_000,
    retryableStatusCodes: [grpc.status.UNAVAILABLE],
  },
  retryThrottling: { maxTokens: 10, tokenRatio: 0.1 },
});
console.log(transport.retryUsage('reader.example'));
// { tokens, maxTokens, tokenRatio, retriesAllowed, suppressedRetries }
```

Each transport snapshot owns independent state for each logical authority and
resolved origin. Clients sharing that snapshot share the budget; separate
factories, logical services and gateway configurations do not. State lives as
long as the snapshot, so closing and recreating a client does not reset it.
SDK retries create new calls against this same budget when they use that transport.

The first attempt always remains eligible. Each validated retryable server status
for a configured unary method subtracts one token, including its last attempt or
a negative-pushback response. Fetch exceptions subtract only when Fetch-error
replay is enabled. Local credential, protocol, cancellation and deadline failures
do not subtract tokens. A successful transport RPC, including an unlisted or
streaming method, restores `tokenRatio`, capped at `maxTokens`.

Additional attempts stop when tokens are at or below half the maximum. The
adapter returns the last status, without an extra queue or a synthetic error.
The budget is rechecked after backoff and immediately before Fetch, since another
call may consume it during authentication or compression. An already-started
Fetch is never canceled by budget changes. A prepared retry may therefore end
without Fetch; the observer emits `retry-throttled` referencing the prior failed
attempt, and diagnostics increment `suppressedRetries` once for that call.

`maxTokens` is an integer from 1 to 1000. `tokenRatio` is finite, between 0.001 and
1000, and truncated to three decimal places. Integer milli-tokens keep threshold
comparisons stable. Throttling requires an explicit retry policy and is disabled
by default. The model follows [gRPC retry throttling](https://github.com/grpc/proposal/blob/master/A6-client-retries.md#throttling-retry-attempts-and-hedged-rpcs),
but this adapter still uses its explicit method policy and Fetch commitment rules;
it does not implement native service-config retries or hedging.
