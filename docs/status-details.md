# Structured gRPC status details

The optional `@grpc/grpc-js/status-details` entry exports `decodeGrpcStatusDetails()`.
It reads one binary `grpc-status-details-bin` value as the standard
[google.rpc.Status envelope](https://github.com/googleapis/googleapis/blob/master/google/rpc/status.proto).
It adds no protobuf runtime to the client root entry.

```ts
import { decodeGrpcStatusDetails } from '@grpc/grpc-js/status-details';

const result = decodeGrpcStatusDetails(error, {
  maxBytes: 65_536,
  maxDetails: 64,
  // Optional exact type URL -> synchronous application decoder:
  decoders: { 'type.googleapis.com/example.Detail': bytes => ExampleDetail.decode(bytes) },
});
// result.status is always the original error/status object.
if (result.details) {
  for (const detail of result.details.details) {
    console.log(detail.typeUrl, detail.decoded);
  }
}
```

The returned envelope contains `code`, `message` and an array of `Any` entries
with `typeUrl` and an owned `Buffer` copy in `value`. Unknown types remain opaque;
there is no automatic type fetching or code loading. Registered decoders receive
another copy, so they cannot mutate the retained raw detail. Decoder exceptions,
thenable failures and asynchronous return values produce `decoder-failed` on that
entry; decoding remains synchronous. Envelope validation precedes all callbacks.

An absent value, duplicate values, malformed protobuf/UTF-8, an exceeded limit,
or an envelope code differing from the original RPC code yields a `diagnostic`
and no decoded envelope. The original object's identity, code, message and
metadata are preserved. Envelope objects and arrays are readonly/frozen; the
owned byte buffers remain mutable by their recipient.

Defaults are 64 KiB encoded bytes and 64 details. Limits may be explicitly set up
to 4 MiB and 1024 details; invalid option values throw `TypeError`. Unknown protobuf
fields are skipped, including matched groups with depth limited to 32. Individual
detail decoders remain application code: their CPU, allocations and schema
semantics are outside the envelope parser's limits.

These optional fields can contain sensitive application data. The adapter's
observer never reads or exports them. Applications decide which decoded values,
if any, to log, and must not replace the original RPC status with a rich payload.
