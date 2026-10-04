# Scoped SDK cancellation

The optional `@grpc/grpc-js/sdk` entry adds cancellation to SDK operations that forward GAX call options to this adapter. It imports no Google SDK. It does not change shared clients, SDK prototypes, or the ordinary promise and stream APIs. Use it with the supported adapter SDK profiles; this is not a native grpc-js parent-call compatibility promise.

## Promise calls and Commit

`cancellableCall(start, { gaxOptions?, signal? })` returns `{ promise, cancel }`. The factory receives a fresh GAX options object. Forward that object to the SDK method, including when initialization is asynchronous:

```ts
import { cancellableCall } from '@grpc/grpc-js/sdk';

// transaction is a Datastore Transaction with mutations already queued.
const commit = cancellableCall(gaxOptions => transaction.commit(gaxOptions), {
  gaxOptions: { timeout: 10_000 },
  signal: controller.signal,
});
const result = await commit.promise;
// Another task can call commit.cancel() while the promise is pending.
```

The same helper works with generated unary calls, for example a factory that calls `datastoreClient.commit(request, gaxOptions)`. The promise retains the SDK's full tuple/result type. A factory that throws synchronously becomes a rejected promise; an SDK rejection is preserved unchanged.

Cancellation settles the wrapper once with gRPC `CANCELLED` (code `1`), details `Cancelled by SDK helper`, and empty `Metadata`. It cancels scoped adapter calls already waiting in interceptors, authentication, queue admission or Fetch. The scoped parent remains cancelled so lazy SDK startup and later retries using the supplied options cannot begin another Fetch after cancellation. If the SDK returns a promise with a public `cancel()` hook, that hook is called once as well. Otherwise already scheduled SDK initialization or retry bookkeeping can still run locally until it observes the cancelled adapter call. Factory failure also cancels any child RPCs it already started, preserving the original failure for the caller.

A pre-aborted signal skips the factory entirely. Completion that the wrapper has already observed wins over later cancellation. A promise that has resolved internally but whose fulfillment callback has not run can still lose a race to cancellation. Caller abort reasons, tokens, metadata and request payloads are not added to cancellation errors. Signal listeners are detached at completion.

**Cancelling Commit never rolls back a write.** A server may have accepted the mutation before cancellation, even if the caller receives `CANCELLED`. Check application state or use the service's supported transaction and idempotency mechanisms before deciding whether to retry. This helper does not turn an SDK transaction retry loop or arbitrary application callback into an atomic cancellable transaction.

The pinned high-level Datastore `Transaction.commit()` can automatically call `rollback()` after a Commit error. That SDK cleanup call does not forward the Commit's GAX options, so it is outside the cancellation scope and can start a separate RPC after cancellation. The helper leaves this cleanup behavior intact. A Rollback cannot undo a Commit the server already accepted. Generated `DatastoreClient.commit()` has no such high-level cleanup path.

## Datastore query streams

`cancellableQueryStream<T>(start, { gaxOptions?, signal?, highWaterMark? })` returns a typed object-mode Node `Readable`. The factory must return a readable with `end()`, as the pinned Datastore `runQueryStream()` does:

```ts
import { cancellableQueryStream } from '@grpc/grpc-js/sdk';

const rows = cancellableQueryStream<{ name: string }>(
  gaxOptions => datastore.runQueryStream(query, { gaxOptions }),
  { signal: controller.signal, highWaterMark: 1 },
);
for await (const row of rows) {
  console.log(row.name);
  if (row.name === 'wanted') break;
}
```

Destroying the wrapper or breaking its default async iterator cancels its scoped adapter calls and synchronously calls the SDK source's `end()` and `destroy()`. The `end()` call matters: the pinned Datastore paging loop does not treat `destroy()` alone as pagination EOF. This sequence stops later page requests and cancels a pending page RPC. It cannot retract a request started before the cancellation barrier.

An `AbortSignal` produces the same `CANCELLED` error as the promise helper. Plain `destroy()` retains Node's no-error behavior; `destroy(error)` preserves the provided error. Default iterator break uses Node's ordinary destruction behavior. Calling `iterator({ destroyOnReturn: false })` explicitly opts out of break cancellation; destroy the stream yourself when finished.

Normal source EOF commits success and closes the helper-owned source without cancelling its parent. Errors during source cleanup after that EOF are handled without replacing the successful outcome. Before EOF, source errors are forwarded; source closure before EOF produces `WGA_SDK_STREAM_CLOSED`. The wrapper forwards `info`, `metadata` and `status` events while active without inventing status events. It does not expose the source's writable interface. Stop and discard the source exclusively through the wrapper. Cleanup temporarily observes only that source's `_destroy` callback, restoring its original method when cleanup completes; this also removes listeners for sources configured with `emitClose: false`.

The wrapper queue defaults to one object; `highWaterMark` accepts integers from 1 through 1024. Pause/resume propagates readable demand, but the pinned Datastore page splitter does not honor all source backpressure. SDK-decoded pages, source queues and page prefetch are outside this wrapper limit. This option is not a whole-query or isolate memory budget. An unused stream should be destroyed, or bounded by the SDK's configured timeout and an application signal.

## GAX options and scope

Each helper installs a private, non-plain parent object at `otherArgs.options.parent`, with cancellation propagation enabled. This object preserves identity through the pinned Datastore SDK's deep option copying. Only the GAX object, its `otherArgs`, and the nested call-options container are copied; unrelated option values and metadata are preserved. A caller-supplied `parent` or `propagate_flags` in that nested container is rejected with `WGA_SDK_PARENT_CONFLICT`, including explicitly supplied `undefined` or `null`. Compose a different outer scope explicitly instead of silently losing an existing parent.

The factory must pass the supplied options through to every SDK operation it starts, and return the complete operation's promise or query source. Using an SDK method that discards those options cannot provide underlying RPC cancellation. This API does not apply to arbitrary Firestore high-level methods, REST fallbacks, native grpc-js transports, or SDK versions outside the tested profiles.

Cancellation belongs only to one helper invocation. Concurrent operations on the same client keep their own scopes; cancelling a helper never closes the client or cancels unrelated calls. The helper propagates no deadline of its own: keep SDK timeouts configured for operations that are not explicitly cancelled.

## Verification

`test/sdk-cancellation.test.cjs` covers pre-abort, startup and settlement races, pending/late RPC cancellation, option preservation, scope isolation, ordinary EOF, destroy, iterator break, source errors, bounded wrapper buffering and listener cleanup. `test/types-sdk-cancellation.cts` checks promise tuple inference, typed iteration and invalid factory/options in the packed declaration gate. The installed SDK integration gate exercises actual pinned SDK startup, pagination and Commit behavior in Node and workerd; its receipt distinguishes cancellation of local waiting from any server-side mutation outcome.
