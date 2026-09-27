# gRPC message compression

The adapter supports `identity`, `deflate` and `gzip` for unary and server-streaming RPCs. Compression applies independently to each protobuf message. It does not use HTTP `Content-Encoding` or compress gRPC-Web trailer frames.

Select the request algorithm with the grpc-js channel option:

```js
import { Client, credentials, compressionAlgorithms } from '@grpc/grpc-js';

const client = new Client('service.example', credentials.createSsl(), {
  'grpc.default_compression_algorithm': compressionAlgorithms.gzip,
});
```

The enum values match grpc-js: `identity = 0`, `deflate = 1`, `gzip = 2`. Identity remains the default. Generated Google clients can pass the same option through `gaxOptions()`. Metadata cannot override adapter-owned encoding headers.

Requests advertise `grpc-accept-encoding: identity,deflate,gzip`; `grpc-encoding` identifies the configured request codec. The grpc-js `NoCompress` write flag preserves an individual message without compression while retaining that header, as native grpc-js does. The supported client API still accepts only one request message.

Responses select their own codec with `grpc-encoding`. A compressed frame requires gzip or deflate; a compressed frame declaring identity is malformed. Unknown encodings fail when a compressed message uses them. Plain frames remain valid under any declared encoding, matching the pinned native codec behavior. Compressed and plain messages may coexist in one response stream.

The adapter does not cache a peer's accepted encodings between RPCs and does not retry a rejected compressed request using identity. Configure a codec that the target service or gateway supports. Compression through Cloudflare's deployed conversion proxy needs separate live verification; local workerd checks do not establish that platform behavior.

## Limits and cancellation

The channel's send and receive limits apply to uncompressed protobuf bytes. The transport ceilings also bound compressed wire payloads. Each bound excludes the five-byte gRPC frame header. Compression overhead can make the encoded representation larger than its input; exceeding either applicable bound returns `RESOURCE_EXHAUSTED`.

Decompression uses a separate streaming codec for every message and checks each output chunk before retaining it. It stops when the decoded limit is exceeded. Codec output chunks are bounded to 16 KiB; the offending chunk is discarded. The implementation retains only the current wire message and its bounded decoded output, and does not start decoding the next message before the consumer requests it. Fetch buffering, stream internals and a final buffer copy are additional memory, so these ceilings are not a total Worker memory budget.

Cancellation and deadlines destroy active codecs and cancel the response reader. Invalid streams, truncated compressed content and checksum failures return fixed diagnostics without copying codec messages or payload bytes into errors. Compressed trailer frames remain unsupported and return `UNIMPLEMENTED`.

The implementation uses [Workers' `node:zlib` support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/) with the project's pinned Node compatibility configuration. The Node suite compares framing, bytes and `NoCompress` against the pinned grpc-js 1.14.0 compression filter. The workerd suite verifies both transport modes against an independent Node zlib peer, including limits, mixed frames, malformed data, cancellation and deadlines.
