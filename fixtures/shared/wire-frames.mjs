import { Buffer } from 'node:buffer';
import { deflateSync, gzipSync } from 'node:zlib';
import { chunksOf, frame, repeatedSummary, summary, trailer } from './wire-vectors.mjs';

const MiB = 1024 * 1024;
const proto = ['content-type', 'application/grpc-web+proto'];

// These fixtures construct the protocol independently of the adapter's codec.
// A declared oversized frame contains only its header: a passing test cannot
// accidentally rely on allocating or reading the prohibited payload first.
function header(length, flag = 0) {
  const bytes = Buffer.alloc(5);
  bytes[0] = flag;
  bytes.writeUInt32BE(length, 1);
  return bytes;
}

function* repeatedFrame(length, fill) {
  yield header(length);
  for (let remaining = length; remaining > 0;) {
    const size = Math.min(remaining, 65536);
    yield Buffer.alloc(size, fill);
    remaining -= size;
  }
  yield trailer();
}

function* randomSizes(seed) {
  let state = seed >>> 0;
  for (;;) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    yield 1 + ((state >>> 0) % 31);
  }
}

/** Independent, lazy response vectors shared by Node and workerd. */
export function* frameCases() {
  const normal = Buffer.from([0, 1, 2, 0x7f, 0x80, 0xfe, 0xff]);
  yield {
    id: 'WIRE-001', variant: 'normal-unary', kind: 'unary',
    chunks: () => [frame(normal), trailer()],
    expected: { code: 0, messages: [summary(normal)] },
  };
  yield {
    id: 'WIRE-002', variant: 'present-zero-byte-message', kind: 'unary',
    chunks: () => [frame(Buffer.alloc(0)), trailer()],
    expected: { code: 0, messages: [summary(Buffer.alloc(0))] },
  };
  yield {
    id: 'WIRE-003', variant: 'trailer-only-empty-server-stream', kind: 'stream',
    chunks: () => [trailer()], expected: { code: 0, messages: [] },
  };

  const headerSplitBytes = Buffer.concat([frame(normal), trailer()]);
  for (let split = 1; split <= 4; split++) {
    yield {
      id: 'WIRE-004', variant: `header-split-${split}`, kind: 'unary',
      chunks: () => [headerSplitBytes.subarray(0, split), headerSplitBytes.subarray(split)],
      expected: { code: 0, messages: [summary(normal)] },
    };
  }
  yield {
    id: 'WIRE-005', variant: 'every-response-byte-separate', kind: 'unary',
    chunks: () => chunksOf(headerSplitBytes, (function* () { for (;;) yield 1; })()),
    expected: { code: 0, messages: [summary(normal)] },
  };

  const ordered = Array.from({ length: 128 }, (_, index) => Buffer.from([index, index ^ 0xa5, 0xff - index]));
  const coalesced = Buffer.concat([...ordered.map(bytes => frame(bytes)), trailer()]);
  yield {
    id: 'WIRE-006', variant: '128-ordered-frames-and-trailer-in-one-chunk', kind: 'stream',
    chunks: () => [coalesced], expected: { code: 0, messages: ordered.map(summary) },
  };

  for (const seed of [1, 0x10203040, 0x5eedc0de, 0xffffffff]) {
    const payload = Buffer.from(Array.from({ length: 1023 }, (_, index) => (index * 37 + (seed >>> (index % 24))) & 0xff));
    const metadata = { 'x-vector-seed': String(seed), 'x-vector-kind': 'split' };
    const bytes = Buffer.concat([frame(payload), trailer(`grpc-status: 0\r\nx-vector-seed: ${seed}\r\nx-vector-kind: split\r\n`)]);
    yield {
      id: 'WIRE-007', variant: `seeded-payload-and-trailer-${seed}`, kind: 'unary',
      chunks: () => chunksOf(bytes, randomSizes(seed)),
      expected: { code: 0, messages: [summary(payload)], metadata },
    };
  }

  const caps = [
    { name: 'grpc-default-four-mib', limit: 4 * MiB },
    { name: 'grpc-minus-one-default-transport', limit: 32 * MiB, channelOptions: { 'grpc.max_receive_message_length': -1 } },
    { name: 'grpc-positive-65536', limit: 65536, channelOptions: { 'grpc.max_receive_message_length': 65536 } },
    { name: 'transport-minimum-over-positive-grpc', limit: 1024,
      channelOptions: { 'grpc.max_receive_message_length': 8192 }, config: { transportMaxReceiveBytes: 1024 } },
    { name: 'grpc-minus-one-custom-transport', limit: 4096,
      channelOptions: { 'grpc.max_receive_message_length': -1 }, config: { transportMaxReceiveBytes: 4096 } },
    { name: 'grpc-positive-above-four-mib', limit: 4 * MiB + 65536,
      channelOptions: { 'grpc.max_receive_message_length': 4 * MiB + 65536 } },
    { name: 'transport-minimum-over-default-grpc', limit: 2048, config: { transportMaxReceiveBytes: 2048 } },
  ];
  for (const cap of caps) {
    for (const delta of [-1, 0, 1]) {
      const length = cap.limit + delta, accepted = delta <= 0, fill = 0xa7;
      yield {
        id: 'WIRE-008', variant: `${cap.name}-${delta < 0 ? 'below' : delta === 0 ? 'at' : 'above'}-limit`, kind: 'unary',
        ...(cap.channelOptions && { channelOptions: cap.channelOptions }),
        ...(cap.config && { config: cap.config }),
        chunks: accepted ? () => repeatedFrame(length, fill) : () => [header(length)],
        expected: { code: accepted ? 0 : 8, ...(accepted ? {} : { details: 'WGA_FRAME_SIZE' }),
          messages: accepted ? [repeatedSummary(length, fill)] : [] },
      };
    }
  }
  for (const length of [0, 1]) {
    yield {
      id: 'WIRE-008', variant: `grpc-zero-limit-${length === 0 ? 'empty-accepted' : 'nonempty-rejected'}`, kind: 'unary',
      channelOptions: { 'grpc.max_receive_message_length': 0 },
      chunks: () => length === 0 ? [header(0), trailer()] : [header(length)],
      expected: { code: length === 0 ? 0 : 8, ...(length === 0 ? {} : { details: 'WGA_FRAME_SIZE' }),
        messages: length === 0 ? [repeatedSummary(0, 0)] : [] },
    };
  }
  yield {
    id: 'WIRE-008', variant: 'grpc-minus-one-crosses-four-mib-within-transport-cap', kind: 'unary',
    channelOptions: { 'grpc.max_receive_message_length': -1 },
    chunks: () => repeatedFrame(4 * MiB + 1, 0x6e),
    expected: { code: 0, messages: [repeatedSummary(4 * MiB + 1, 0x6e)] },
  };

  yield {
    id: 'WIRE-009', variant: 'uint32-maximum-header-without-payload', kind: 'unary',
    channelOptions: { 'grpc.max_receive_message_length': -1 },
    chunks: () => [header(0xffffffff)], expected: { code: 8, details: 'WGA_FRAME_SIZE', messages: [] },
  };
  for (let length = 1; length <= 4; length++) {
    yield {
      id: 'WIRE-010', variant: `truncated-header-${length}-bytes`, kind: 'unary',
      chunks: () => [header(17).subarray(0, length)], expected: { code: 13, details: 'WGA_TRUNCATED_FRAME', messages: [] },
    };
  }
  for (const [declared, supplied] of [[1024, 13], [3, 0]]) {
    yield {
      id: 'WIRE-011', variant: `payload-${supplied}-of-${declared}-bytes`, kind: 'unary',
      chunks: () => [header(declared), Buffer.alloc(supplied, 0xb9)],
      expected: { code: 13, details: 'WGA_TRUNCATED_FRAME', messages: [] },
    };
  }

  for (let flag = 0; flag <= 0xff; flag++) {
    if ([0, 1, 0x80, 0x81].includes(flag)) continue;
    yield {
      id: 'WIRE-012', variant: `reserved-flag-${flag.toString(16).padStart(2, '0')}`, kind: 'unary',
      chunks: () => [header(0, flag)], expected: { code: 13, details: 'WGA_FRAME_FLAGS', messages: [] },
    };
  }

  // The original catalog predicted UNIMPLEMENTED for compressed frames as a
  // class. Compression was subsequently implemented; preserve that historical
  // mismatch even while checking the complete current codec policy.
  const compressed = [
    { variant: 'compressed-trailer-unsupported', flag: 0x81, bytes: Buffer.alloc(0), code: 12, details: 'WGA_COMPRESSED_TRAILER' },
    { variant: 'compressed-with-identity', flag: 1, bytes: Buffer.alloc(0), code: 13, details: 'WGA_COMPRESSED_WITH_IDENTITY' },
    { variant: 'compressed-with-unsupported-snappy', flag: 1, encoding: 'snappy', bytes: Buffer.alloc(0), code: 12, details: 'WGA_COMPRESSION_ENCODING' },
    { variant: 'malformed-gzip', flag: 1, encoding: 'gzip', bytes: Buffer.from([1, 2, 3, 4]), code: 13, details: 'WGA_COMPRESSION_DATA' },
    { variant: 'malformed-deflate', flag: 1, encoding: 'deflate', bytes: Buffer.from([1, 2, 3, 4]), code: 13, details: 'WGA_COMPRESSION_DATA' },
    { variant: 'supported-gzip', flag: 1, encoding: 'gzip', bytes: gzipSync(normal), code: 0, decoded: normal },
    { variant: 'supported-deflate', flag: 1, encoding: 'deflate', bytes: deflateSync(normal), code: 0, decoded: normal },
    { variant: 'unknown-encoding-with-uncompressed-message', flag: 0, encoding: 'snappy', bytes: normal, code: 0, decoded: normal },
    { variant: 'gzip-decompressed-size-exceeds-grpc-cap', flag: 1, encoding: 'gzip', bytes: gzipSync(Buffer.alloc(33, 0x7e)),
      channelOptions: { 'grpc.max_receive_message_length': 32 }, code: 8, details: 'WGA_DECOMPRESSED_SIZE' },
  ];
  for (const entry of compressed) {
    yield {
      id: 'WIRE-013', variant: entry.variant, kind: 'unary', catalogMatch: false,
      ...(entry.encoding && { headers: [proto, ['grpc-encoding', entry.encoding]] }),
      ...(entry.channelOptions && { channelOptions: entry.channelOptions }),
      chunks: () => [frame(entry.bytes, entry.flag), trailer()],
      expected: { code: entry.code, ...(entry.details && { details: entry.details }), messages: entry.decoded ? [summary(entry.decoded)] : [] },
    };
  }
  yield {
    id: 'WIRE-013', variant: 'gzip-wire-size-exceeds-transport-cap', kind: 'unary', catalogMatch: false,
    headers: [proto, ['grpc-encoding', 'gzip']], config: { transportMaxReceiveBytes: 64 },
    chunks: () => [header(65, 1)], expected: { code: 8, details: 'WGA_FRAME_SIZE', messages: [] },
  };

  for (const separate of [false, true]) {
    yield {
      id: 'WIRE-014', variant: `duplicate-trailer-${separate ? 'separate-chunks' : 'coalesced'}`, kind: 'unary',
      chunks: () => separate ? [trailer(), trailer()] : [Buffer.concat([trailer(), trailer()])],
      expected: { code: 13, details: 'WGA_FRAME_AFTER_TRAILER', messages: [] },
    };
    yield {
      id: 'WIRE-015', variant: `data-after-trailer-${separate ? 'separate-chunks' : 'coalesced'}`, kind: 'unary',
      chunks: () => separate ? [trailer(), frame(normal)] : [Buffer.concat([trailer(), frame(normal)])],
      expected: { code: 13, details: 'WGA_FRAME_AFTER_TRAILER', messages: [] },
    };
  }
}
