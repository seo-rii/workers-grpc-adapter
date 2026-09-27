# Firestore listeners through an explicit gateway

Firestore's public `DocumentReference.onSnapshot()` and `Query.onSnapshot()` use
the bidirectional `google.firestore.v1.Firestore/Listen` RPC. They require the
adapter's experimental request streaming option and an explicit gRPC-Web gateway:

```js
import { Firestore } from '@google-cloud/firestore';
import { createWorkersGrpcTransport } from '@grpc/grpc-js/adapter';

const transport = createWorkersGrpcTransport({
  mode: 'grpc-web',
  endpoints: { 'firestore.googleapis.com': 'https://your-trusted-gateway.example' },
  experimentalRequestStreaming: true,
});
const firestore = new Firestore(transport.gaxOptions({
  projectId: 'your-project-id',
  // Supply your application's supported Google auth configuration here.
}));
```

Use the pinned SDK graph and static protobuf build profile. Keep each listener
inside an active Worker request lifetime, provide an error callback, and call the
returned unsubscribe function before returning the response. Then terminate the
Firestore client when its application work is complete. `onSnapshot()` itself
does not accept the adapter's per-call deadline or an `AbortSignal`; applications
must bound their listener lifetime and unsubscribe explicitly. The sample above
does not start a background listener.

Google documents the callback and unsubscribe contract in its
[DocumentReference reference](https://docs.cloud.google.com/nodejs/docs/reference/firestore/latest/firestore/documentreference#_google_cloud_firestore_DocumentReference_onSnapshot_member_1_).
The gateway must support streaming both the request and response; a proxy that
buffers the entire request prevents Listen from delivering its first snapshot.

## Local verification

Run `node scripts/test-firestore-watch.cjs` after installing the pinned fixtures,
official emulator artifacts, and Envoy binary. The script uses Firestore 8.3.0,
native grpc-js as its comparison, the packed adapter in Node, and two invocations
of a local workerd isolate. Every consumer executes the same hashed business
module. The native-only diagnostic is `--native-only`; `--source-build` compiles
the adapter into an isolated temporary directory for development. The required
installed-package check uses neither flag.

The document listener observes initial absence, creation, updates, deletion,
unsubscribe, and a new listener on the same client. The query listener observes
initial emptiness, ordered additions, an update that changes ordering, deletion,
removal by its filter, and listener reuse. Both acknowledge another write after
unsubscribe and check that callbacks remain stopped. The SDK's callbacks provide
all observed snapshots; repeated reads are never used as a listener substitute.

The harness forwards streaming bytes through Miniflare's Node HTTP boundary to
real Envoy and the official local Firestore emulator. It checks actual Listen
arrivals, responses before request completion, native-equivalent business
results, RPC method counts, and successful terminal statuses. A complete run has
eight cases, 84 emulator RPC arrivals including 16 Listen calls, and 52 checked
snapshot callbacks. Created documents are deleted and their absence
verified before each client terminates. All temporary processes and streams are
closed. Results and provenance are written to `verification/firestore-watch.json`.

## Remaining boundaries

This gate does not establish Firestore Watch support through Cloudflare's private
automatic conversion mode. Request streaming remains an explicit gateway opt-in.
The SDKs receive the Google auth library's ordinary anonymous `PassThroughClient`
to prevent ambient ADC or metadata discovery. The emulator uses a synthetic
owner credential injected only on the loopback Envoy-to-emulator hop. The gate
does not validate production IAM, security rules,
permission-denied behavior, credential refresh, or live Google services.

The bounded local cases do not establish deployed Worker lifetime guarantees,
multi-hour listeners, live network recovery, gateway load balancing, or all
Firestore Watch messages. Bounded controlled-peer recovery is covered below.

The separate `npm run test:modern-firestore-watch` gate now repeats all eight
Listen cases against the official emulator using Firestore 9.2.0 and the exact
`google-modern-v1` graph. Its native, Node-adapter and workerd results match; see
[modern SDKs](modern-sdk.md). Keep the experimental scope explicit when
evaluating a production workload.


## Bounded recovery

`npm run test:firestore-recovery` adds a controlled native gRPC peer behind real
Envoy for Firestore 8.3.0. It injects faults and protocol messages that the ordinary
emulator CRUD cases do not expose deterministically. Six scenarios run against
native grpc-js, the Node adapter and two workerd invocations: 24 cases, 36 Listen
attempts, 27 Fetch requests and 48 snapshot/error callbacks.

- UNAVAILABLE and HTTP/2 stream reset reopen Listen with the exact opaque binary
  resume token from the last consistent snapshot.
- Target RESET replaces the existing result set; an existence-filter mismatch
  reopens the query without the old resume token.
- Document removal updates query results. A target REMOVE with permission-denied
  cause reaches the public error callback and does not reconnect.
- Pending changes without a consistent snapshot boundary never appear in user
  snapshots. The test does not assert that every injected pending byte arrived
  before a network reset.

The adapter closes its upload after parsing a valid terminal gRPC status, then
continues checking the response through EOF. This releases workerd's EOF wait
and allows the SDK to start its next Listen. Extra frames, duplicate trailers,
missing EOF, deadlines and pending write callbacks have separate regression tests.
No REST/polling replacement, SDK retry bypass or synthetic resume-token handling
is added to the adapter. The SDK owns its listener state and reconnect decisions.

The same six scenarios also run with Firestore 9.2.0 through
`npm run test:modern-firestore-recovery`: another 24 cases with the modern-only
Worker bundle, native SDK graph and exact resume-token comparisons.

## Preserving terminal RPC errors

`google-static-v1` revision 4 and `google-modern-v1` revision 2 include a guarded
Firestore Listen transformation. The pinned SDKs defer their error event using
`setImmediate`, but previously piped EOF to Watch first. A permission-denied RPC
after a snapshot could therefore reconnect as UNKNOWN and lose its original error.
The native grpc-js baseline reproduces this behavior without the adapter.

For Listen only, the build now defers pipe completion until the already queued
error has been delivered. Ordinary server streams keep their original behavior.
Whole-file source hashes, an exact AST anchor and a required single replacement
reject dependency drift. Build manifests record `firestoreWatchEndDeferrals: 1`;
installed SDK files and global prototypes are not modified. Direct Node consumers
that do not use this build preset retain the original SDK behavior.

`npm run test:firestore-watch-errors` executes the same business-source bytes with
both pinned SDKs: native grpc-js, the Node adapter and two invocations of each
Worker bundle. Its 24 cases cover permission-denied RPC termination, transient
UNAVAILABLE and clean EOF after an initial snapshot, then unsubscribe and reuse
the same Firestore client. The corrected Worker must deliver the original code 7
and message exactly once without reconnecting. Raw SDK permission cases explicitly
record the upstream reconnect and terminate it with a distinct target REMOVE;
they are a diagnostic baseline, not behavioral equivalence. Transient and clean
EOF cases must reconnect with the exact opaque resume token.

This controlled-peer gate records 68 Listen attempts, 50 adapter Fetch requests
and 72 snapshot/error callbacks in `verification/firestore-watch-errors.json`.
It does not validate real IAM, every error sequence, prolonged outages or deployed
Worker lifetimes. Applications must still bound listener lifetime and unsubscribe.
