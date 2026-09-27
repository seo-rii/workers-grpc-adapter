# Service health

`HealthClient` calls the standard `grpc.health.v1.Health` service using an existing
adapter `Client`. It reuses that client's routing, channel credentials and
interceptors in either transport mode. The server must implement the health
service; this helper does not make an arbitrary Google API expose one.

```js
import { Client, HealthClient } from '@grpc/grpc-js';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const transport = createWorkersGrpcTransport({ mode: 'cloudflare' });
const client = new Client('api.example.com', transport.channelCredentials,
  transport.grpcOptions());
const health = new HealthClient(client);
const monitor = health.monitor('example.Inventory');
try {
  const state = await monitor.waitForServing({ deadline: Date.now() + 5000 });
  // The named service reported SERVING. Issue the application's RPC now.
} finally {
  monitor.close();
  client.close();
}
```

`check(service = '', options = {})` returns a promise containing `{ status }`.
An empty service name asks for overall server health. Check uses a five-second
deadline by default; `deadline` accepts an absolute timestamp or `Date`. Options
also accept `metadata`, `signal` and standard adapter call options such as call
credentials. Aborting cancels this one call. A missing service normally returns
gRPC `NOT_FOUND`. The response preserves unknown numeric enum values.

`watch(service, options)` exposes one ordinary server-streaming RPC. Install
`data`, `error` and `status` listeners and cancel it when finished. Use `monitor`
for managed retries and `waitForServing`. The managed monitor consumes the raw
stream and owns its cancellation, retry timer and pending waiters. It does not
close the underlying client.

A monitor's `getState()` returns an immutable snapshot with `phase`,
`servingStatus`, `attempt` and `lastErrorCode`. Phases are `connecting`, `serving`,
`not-serving`, `reconnecting`, `disabled` and `closed`. Only enum value `SERVING`
(1) satisfies `waitForServing`; `UNKNOWN`, `NOT_SERVING`, `SERVICE_UNKNOWN` and
unrecognized future values continue waiting. Each waiter requires its own finite
deadline and can have an independent AbortSignal. A waiter's timeout or abort
does not close the monitor or affect other waiters. `close()` rejects remaining
waiters, cancels the stream and clears backoff; it is safe to call repeatedly.

The standard Watch protocol retries every server terminal status, including OK,
except `UNIMPLEMENTED`. This includes permission and authentication failures:
callers must bound the monitor's lifetime and correct credentials when necessary.
Backoff starts at 1000 ms, multiplies by 1.6 and caps at 30000 ms, with 20% jitter.
`initialBackoffMs`, `maxBackoffMs`, `backoffMultiplier` and `backoffJitter` can
change these values. A received health message resets backoff. An optional
`attemptTimeoutMs` bounds each stream attempt; healthy streams have no timer
imposed by this helper by default, though channel timeout configuration applies.

`UNIMPLEMENTED` changes the monitor to `disabled` and stops retries. Pending and
future `waitForServing` calls reject with status 12. Applications can explicitly
choose to operate without a health gate after inspecting this state; the helper
never fabricates a SERVING report. Authentication, interceptors and channel
limits still apply to health RPCs.

Health is application state at an instant, so a successful check or wait cannot
guarantee a later RPC succeeds. Fetch does not expose a persistent HTTP/2
connection, and this API does not change `getConnectivityState`, implement
physical `waitForReady`, or automatically hold unrelated application RPCs.
Create and close monitors within a Worker request or another supported lifetime;
do not retain an open stream globally across unrelated requests.

The local gate uses a native grpc-js server with the standard proto and runs
Check/Watch, recovery, wait cancellation and cleanup in workerd for both modes.
Unit tests cover malformed and unknown protobuf fields, future enum values and
seeded decoder fuzzing. These tests do not exercise Cloudflare's deployed
conversion service or provide sustained-load certification. `Health/List` is
outside this helper's scope.

Protocol references: [gRPC health checking](https://github.com/grpc/grpc/blob/master/doc/health-checking.md)
and the [canonical service definition](https://github.com/grpc/grpc-proto/blob/master/grpc/health/v1/health.proto).
