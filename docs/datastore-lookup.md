# Datastore deferred Lookup

The pinned `@google-cloud/datastore@10.1.1` supports finite deferred results
through its existing `get()` and `createReadStream()` implementations. The SDK
issues another unary `Lookup` for only the deferred keys; each round is a new
adapter call. No adapter retry policy is needed for this behavior.

The local gate compares the same business source with native grpc-js, the
installed package in Node, and local workerd in both routing modes:

```sh
npm run fixtures:install
node scripts/test-datastore-lookup.cjs
```

The result is written to `verification/datastore-lookup.json`. Seventeen scenarios
run under native grpc-js and both adapter modes in Node/workerd: 85 cases,
235 service RPCs, 188 actual data Fetches and 20 separate control requests.
The report records source hashes, exact key batches, statuses, callback and stream
events. The controlled native service enforces finite rounds and rejects
unexpected calls; all transports remain on loopback.

Test-only hooks join each actual adapter call ID to its observer events, physical
Fetch and native peer receipt. Each call has one attempt, one Fetch and one
terminal event, including each separate call created by SDK retry. Before SDK
close, the gate checks timers, buffers, parser ownership, pending callbacks,
pumps and channel registrations. These internal hooks are fixture instrumentation,
not a supported consumer API or a measurement of total JavaScript heap.

Cached OAuth credentials make zero authentication network requests. A separate
expired-token control must attempt exactly one request through the guarded auth
transporter, which blocks it before network I/O. Authentication counters are
separate from data Fetch and control traffic; this gate does not exercise token
renewal or production IAM. A strict validator checks the entire execution matrix,
and mutation tests reject missing, duplicated or inconsistent receipts.

## Verified behavior

- Mixed found, missing and deferred results across three rounds. Only deferred
  keys are reissued, including a changed key order, an ancestor, named keys and
  a numeric ID beyond JavaScript's safe integer range.
- Promise, callback and stream batch APIs; a deferred single lookup; missing
  single and batch results. Callbacks execute once.
- Binary values, timestamps, nulls, booleans and wrapped 64-bit integers.
- Two project/database/namespace/ancestor combinations in one shared business
  execution, with exact project and database components of routing metadata.
- Permanent permission errors, `UNAVAILABLE` with retry disabled, and an
  explicitly bounded SDK retry that succeeds on its third attempt. The
  adapter's own retry remains disabled.
- A found entity followed by an error in a deferred round. The stream delivers
  the entity, then one error and one close without a successful end. `get()`
  rejects instead of returning a partial array.
- A deadline in a held deferred RPC, with cancellation observed by the native
  peer. This is a local deadline test, not proof of deployed Fetch cancellation.
- `end()` on the first entity and while a deferred RPC is already pending.
  It stops subsequent deferred rounds and entity delivery. It does not cancel
  the pending unary RPC; that request is released separately in the test.
- Local empty-key and mutually exclusive read-option failures send no Lookup.
  Every scenario finishes with a successful lookup using the same SDK client.

## Consumer implications

Results follow the service's `found` order and subsequent deferred rounds. They
are **not reordered to match the input keys**. Missing keys are omitted; a
missing single lookup resolves with an undefined entity. Match entities by
`Datastore.KEY` if input order or explicit missing entries matter.

Use `wrapNumbers: true` when lossless integer property values are required.
Numeric key IDs are preserved as strings. Do not convert a large ID or wrapped
integer to a JavaScript number unless the range is known to be safe.

A GAX `timeout` bounds each unary Lookup; it does not bound an arbitrarily long
sequence of successful deferred replies. The SDK does not impose a deferred
round limit. This gate deliberately uses finite replies and exact RPC bounds;
it does not claim to solve an endlessly deferring backend. Applications that
need a cancellable overall read should retain the public stream, stop future
rounds with `end()`, and set a finite per-RPC timeout. Racing a `get()` Promise
against a timer alone does not cancel its work.

The fixture uses a controlled protocol peer, not the Datastore emulator or
production service. `STRONG`, database and routing fields are checked on the
wire; this is not evidence of actual consistency, IAM, quotas, transaction
contention, large-batch limits or Cloudflare's automatic edge conversion. The
separately pinned modern Datastore profile is not covered by this specific gate.
