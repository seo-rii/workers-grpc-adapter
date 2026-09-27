# Client interceptor ordering

The adapter retains the grpc-js interceptor surface. An interceptor may defer its
`start`, `sendMessage`, or `halfClose` continuation, but outgoing operations still
reach the next call in this order:

1. `start` with the final metadata and listener.
2. Each transformed request, in submission order.
3. At most one `halfClose`, after all preceding request transformations complete.

A message that finishes transformation while metadata is pending retains the
**transformed** value. Multiple pending transformations may complete in either
order; completion order does not change transmission order. Forwarding a message
releases its queue entry before invoking downstream code, so a synchronous write
callback can safely submit another message or request half-close.

Repeated calls to the same continuation are ignored. Repeated `halfClose()`
requests are also ignored. Once half-close is requested, a new send is rejected
with `WGA_WRITE_AFTER_HALF_CLOSE` (`INTERNAL`): `sendMessageWithContext` delivers
that error to its callback when present, and otherwise throws synchronously.
Previously submitted messages can still finish transformation and drain before
half-close reaches the transport.

These rules apply at every `InterceptingCall` in an interceptor chain. They do
not make it safe for application interceptors to retain payloads or callbacks
indefinitely. The adapter cannot release memory retained by application code.

## Regression tests

Build and run the focused state-machine and public-client tests:

```sh
npm run build
node --test test/interceptor-ordering.test.cjs test/interceptor-property.test.cjs
```

The fixed regressions cover all four synchronous/asynchronous startup and
message-transformation combinations, reversed completion order, reentrant write
callbacks, repeated continuations, and sends after half-close. Public unary,
client-streaming, and bidirectional calls also check the actual serialized request
and successful cleanup for each timing combination.

The generated schedule property changes the order and repetition of metadata,
message, and half-close continuations. It checks the ordering and exactly-once
invariants after every transition, then completes outstanding continuations to
verify progress. The original implementation failed with seed `1470698469`, path
`0:0:1:0`, shrinking to an empty generated prefix and two pending messages. That
minimal schedule is preserved as a fixed regression.

The property participates in the regular multi-seed fuzz campaign and supports
an exact selected-property replay:

```sh
WGA_FUZZ_SEED=1470698469 WGA_FUZZ_RUNS=5000 npm run test:fuzz -- \
  '--test-name-pattern=^PROPERTY INTERCEPTOR generated continuation schedules preserve messages and close exactly once$'
```

For a new failure, also set `WGA_FUZZ_PATH` to the path emitted by fast-check. Paths
refer to a particular property definition; the fixed regression preserves the
old failure even if the generator changes later.

`src/client-interceptors.ts` remains a patched vendored source. Its checked-in
patch and `vendor/UPSTREAM.json` hashes must reproduce the implementation through
`node vendor/verify.cjs`; upstream source files remain unchanged.

## Logical completion

The logical RPC owns its deadline and parent cancellation outside the interceptor chain. Default timeouts are anchored when the call is created, before interceptor construction and asynchronous startup. Final interceptor call options still select the explicit deadline. The call remains active until the final listener receives its status, including time spent in asynchronous response interceptors.

Cancellation, channel closure and deadlines complete the local callback/status once even when a requester withholds `next()`. Late startup, message and response continuations cannot restart Fetch or deliver another result. Outstanding write callbacks are settled on termination. Cancellation requesters are notified, but cannot veto local cleanup by withholding their continuation or throwing. Finite deadlines remain necessary when an interceptor intentionally never completes and the caller does not cancel.

Incoming status waits for both metadata and message transformations to finish. Duplicate continuations cannot repeat delivery, and termination clears adapter-owned incoming and outgoing queues. References held by application interceptor code remain the application's responsibility. Custom `InterceptingCall.sendMessage()` overrides still run, including overrides that supply message flags.

`test/call-lifetime.test.cjs` and `test/call-lifetime-property.test.cjs` verify stalled startup/status delivery and generated completion/cancellation schedules in both transport modes.
