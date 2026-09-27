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
multi-hour listeners, network reconnection and resume tokens, gateway load
balancing, or all Firestore Watch messages.

The separate `npm run test:modern-firestore-watch` gate now repeats all eight
Listen cases against the official emulator using Firestore 9.2.0 and the exact
`google-modern-v1` graph. Its native, Node-adapter and workerd results match; see
[modern SDKs](modern-sdk.md). Keep the experimental scope explicit when
evaluating a production workload.
