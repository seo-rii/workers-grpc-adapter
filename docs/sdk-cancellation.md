# Scoped SDK cancellation and deadlines

The optional `@grpc/grpc-js/sdk` entry adds cancellation and total operation deadlines to SDK operations that forward GAX call options to this adapter. It imports no Google SDK. It does not change shared clients, SDK prototypes, or the ordinary promise and stream APIs. Use it with the supported adapter SDK profiles; this is not a native grpc-js parent-call compatibility promise.

## Promise calls and Commit

`cancellableCall(start, { gaxOptions?, signal?, deadline? })` returns `{ promise, cancel }`. The factory receives a fresh GAX options object. Forward that object to the SDK method, including when initialization is asynchronous:

```ts
import { cancellableCall } from '@grpc/grpc-js/sdk';

// transaction is a Datastore Transaction with mutations already queued.
const commit = cancellableCall(gaxOptions => transaction.commit(gaxOptions), {
  gaxOptions: { timeout: 10_000 },
  signal: controller.signal,
  deadline: Date.now() + 10_000,
});
const result = await commit.promise;
// Another task can call commit.cancel() while the promise is pending.
```

The same helper works with generated unary calls, for example a factory that calls `datastoreClient.commit(request, gaxOptions)`. The promise retains the SDK's full tuple/result type. A factory that throws synchronously becomes a rejected promise; an SDK rejection is preserved unchanged.

Cancellation settles the wrapper once with gRPC `CANCELLED` (code `1`), details `Cancelled by SDK helper`, and empty `Metadata`. It cancels scoped adapter calls already waiting in interceptors, authentication, queue admission or Fetch. The scoped parent remains cancelled so lazy SDK startup and later retries using the supplied options cannot begin another Fetch after cancellation. If the SDK returns a promise with a public `cancel()` hook, that hook is called once as well. Otherwise already scheduled SDK initialization or retry bookkeeping can still run locally until it observes the cancelled adapter call. Factory failure also cancels any child RPCs it already started, preserving the original failure for the caller.

A pre-aborted signal skips the factory entirely. Completion that the wrapper has already observed wins over later cancellation. A promise that has resolved internally but whose fulfillment callback has not run can still lose a race to cancellation. Caller abort reasons, tokens, metadata and request payloads are not added to cancellation errors. Signal listeners are detached at completion.

**Cancelling Commit never rolls back a write.** A server may have accepted the mutation before cancellation, even if the caller receives `CANCELLED`. Check application state or use the service's supported transaction and idempotency mechanisms before deciding whether to retry. This helper does not turn an SDK transaction retry loop or arbitrary application callback into an atomic cancellable transaction.

The pinned high-level Datastore `Transaction.commit()` can automatically call `rollback()` after a Commit error. That SDK cleanup call does not forward the Commit's GAX options, so it is outside the cancellation and deadline scope and can start a separate RPC after the helper settles. The helper leaves this cleanup behavior intact. A Rollback cannot undo a Commit the server already accepted. Generated `DatastoreClient.commit()` has no such high-level cleanup path.

## One total operation budget

`deadline` accepts an absolute Unix time in milliseconds or a `Date`. Convert a request's remaining budget to an absolute deadline once at the boundary, then pass the same deadline to each helper in that request. A `Date` is snapshotted when the helper starts; changing the original object cannot extend the budget. Omitted deadlines and `Infinity` add no operation limit. Invalid values, including an invalid `Date`, `NaN` or negative infinity, throw `WGA_SDK_DEADLINE` before SDK work starts.

For example, if a request has 500 milliseconds left, use `deadline: Date.now() + 500`. After 300 milliseconds of SDK initialization, only 200 milliseconds remain for queue admission, authentication, transport, retry backoff and later query pages. Every adapter RPC using the supplied GAX options inherits that same absolute deadline. An earlier SDK/per-call deadline or adapter default still wins; the helper never extends one. GAX `timeout` and `retry` values are preserved. A per-RPC GAX timeout alone can restart for each page or SDK retry and does not express this total budget.

The helper also keeps one local timer, covering lazy initialization, SDK backoff, a stalled factory promise and a query stream that nobody reads. An already expired deadline skips the factory. Expiry rejects the promise or destroys the query wrapper with gRPC `DEADLINE_EXCEEDED` (code `4`), details `Deadline exceeded by SDK helper`, and empty `Metadata`. It cancels the scoped parent, stops the helper-owned source, and calls a public SDK promise `cancel()` hook once if available. Pending child calls receive parent cancellation; later calls using those options cannot start Fetch. SDK initialization and cleanup that ignore the supplied options can still run locally. JavaScript timers cannot interrupt synchronous code or guarantee server-side cancellation.

The first observed terminal outcome wins. A pre-aborted signal produces `CANCELLED`, including when its deadline is already expired. Explicit cancellation before expiry also keeps code `1`. SDK service errors and trailing metadata observed before local expiry pass through unchanged. Local deadline errors have no server trailers; use ordinary SDK result/metadata handling for RPC outcomes. Timers and signal listeners are removed on every terminal path. A helper deadline describes when local waiting ends, not whether a timed-out Commit was accepted; verify the service's result before retrying a mutation.

The helper adds no retry loop and cannot deduplicate retries owned by several layers. Assign one retry owner for each operation. When the adapter owns retries, disable the SDK's retry loop where its API supports `gaxOptions: { retry: null }`; when the SDK owns retries, leave the adapter retry policy disabled. Reuse the same absolute deadline across application retries. Reads and explicitly idempotent writes can use a bounded retry policy; ordinary mutations and partially delivered streams need service-specific outcome or resume handling. An expired operation must not be retried with a freshly calculated budget.

## Datastore query streams

`cancellableQueryStream<T>(start, { gaxOptions?, signal?, deadline?, highWaterMark? })` returns a typed object-mode Node `Readable`. The factory must return a readable with `end()`, as the pinned Datastore `runQueryStream()` does:

```ts
import { cancellableQueryStream } from '@grpc/grpc-js/sdk';

const rows = cancellableQueryStream<{ name: string }>(
  gaxOptions => datastore.runQueryStream(query, { gaxOptions }),
  { signal: controller.signal, deadline: Date.now() + 10_000, highWaterMark: 1 },
);
for await (const row of rows) {
  console.log(row.name);
  if (row.name === 'wanted') break;
}
```

Destroying the wrapper or breaking its default async iterator cancels its scoped adapter calls and synchronously calls the SDK source's `end()` and `destroy()`. The `end()` call matters: the pinned Datastore paging loop does not treat `destroy()` alone as pagination EOF. This sequence stops later page requests and cancels a pending page RPC. It cannot retract a request started before the cancellation barrier.

An `AbortSignal` produces the same `CANCELLED` error as the promise helper; local deadline expiry produces code `4`. Rows already yielded remain partial results if the stream subsequently fails. Plain `destroy()` retains Node's no-error behavior; `destroy(error)` preserves the provided error. Default iterator break uses Node's ordinary destruction behavior. Calling `iterator({ destroyOnReturn: false })` explicitly opts out of break cancellation; destroy the stream yourself when finished.

Normal source EOF commits success and closes the helper-owned source without cancelling its parent. Errors during source cleanup after that EOF are handled without replacing the successful outcome. Before EOF, source destruction ends the wrapper and cancels its parent on the next tick, independently of `_destroy` completion or `emitClose`. A source's initial error or a synchronous cleanup error is preserved; otherwise the wrapper reports `WGA_SDK_STREAM_CLOSED`. Asynchronous cleanup errors after that decision are handled without replacing it. This lets cleanup await a cancelled scoped RPC without making local termination wait for cleanup. The wrapper forwards `info`, `metadata` and `status` events while active without inventing status events. It does not expose the source's writable interface. Stop and discard the source exclusively through the wrapper. Cleanup temporarily observes only that source's `_destroy` callback, restoring its original method when cleanup completes and removing source and signal listeners.

The wrapper queue defaults to one object; `highWaterMark` accepts integers from 1 through 1024. Pause/resume propagates readable demand, but the pinned Datastore page splitter does not honor all source backpressure. SDK-decoded pages, source queues and page prefetch are outside this wrapper limit. This option is not a whole-query or isolate memory budget. An unused stream should be destroyed, or bounded by a helper deadline or an application signal.

## GAX options and scope

Each helper installs a private, non-plain parent object at `otherArgs.options.parent`, with cancellation propagation enabled and deadline propagation also enabled when `deadline` is supplied. This object preserves identity through the pinned Datastore SDK's deep option copying. Only the GAX object, its `otherArgs`, and the nested call-options container are copied; unrelated option values and metadata are preserved. A caller-supplied `parent` or `propagate_flags` in that nested container is rejected with `WGA_SDK_PARENT_CONFLICT`, including explicitly supplied `undefined` or `null`. Compose a different outer scope explicitly instead of silently losing an existing parent.

The factory must pass the supplied options through to every SDK operation it starts, and return the complete operation's promise or query source. Using an SDK method that discards those options cannot provide underlying RPC cancellation. This API does not apply to arbitrary Firestore high-level methods, REST fallbacks, native grpc-js transports, or SDK versions outside the tested profiles.

If a query factory returns a source whose destruction already started, the helper terminates without retaining helper listeners on that source. The outstanding `_destroy` callback cannot be observed retroactively. One shared guard each for `error` and `close` handles a late cleanup error; either event removes both guards. Repeated wrappers do not add more guards, and the guards retain no helper, parent, signal or deadline. A source with `emitClose: false` that finishes cleanup silently keeps these two source-owned guards because there is no completion event; no polling timer is added.

Cancellation and the total deadline belong only to one helper invocation. Concurrent operations on the same client keep their own scopes; cancelling or expiring a helper never closes the client or cancels unrelated calls. Reuse immutable client/transport configuration, and create a new helper for each request-owned operation; do not retain its GAX options or `AbortSignal` for later requests. Credentials, authentication token refresh and durable background work remain responsibilities of their respective client/application layers.

## Verification

`test/sdk-cancellation.test.cjs` covers pre-abort, startup and settlement races, pending/late RPC cancellation, option preservation, scope isolation, ordinary EOF, destroy, iterator break, source errors, bounded wrapper buffering and listener cleanup. Its destruction matrix crosses source/wrapper ownership, EOF before/after, `emitClose`, synchronous/asynchronous cleanup and cleanup success/failure. `test/sdk-deadline.test.cjs` uses a controlled clock and Fetch peer to check expired startup, lazy initialization, shared clients, queue admission, retry backoff, repeated RPC budget propagation, partial stream results, long timers and deadline cleanup. These deadline cases are local helper/adapter evidence, not deployed Google service evidence. `test/types-sdk-cancellation.cts` checks promise tuple inference, typed iteration and invalid factory/options in the packed declaration gate. The installed SDK integration gate exercises actual pinned SDK startup, pagination and Commit behavior in Node and workerd; its receipt distinguishes cancellation of local waiting from any server-side mutation outcome. Separate controlled-source receipts verify synchronous and asynchronous source-driven destruction without `close` using each installed helper in both runtimes.

`node scripts/test-sdk-deadline.cjs` runs 24 installed-package cases across both SDK profiles, Node/workerd and direct/gateway wire modes. Its identical SDK consumer checks a deadline during project-ID resolution, reduced timeout headers on successive real Datastore query pages, partial rows, cleanup before client close, client reuse, and a Commit whose successful response is lost locally. A controlled peer records accepted mutations, and a later Lookup verifies that local expiry did not undo them. The script is included in `npm run verify` and writes `verification/sdk-deadline.json`; it performs no Google API call, deployment or backend cancellation certification.
