import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export function frame(value, flag = 0) {
  const bytes = Buffer.from(value), result = Buffer.alloc(5 + bytes.length);
  result[0] = flag; result.writeUInt32BE(bytes.length, 1); bytes.copy(result, 5); return result;
}
export function trailer(text = 'grpc-status: 0\r\n') { return frame(Buffer.from(text), 128); }
export function summary(bytes) { return { length: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }; }
export function repeatedSummary(length, fill) {
  const hash = createHash('sha256'), chunk = Buffer.alloc(Math.min(length, 65536), fill);
  for (let offset = 0; offset < length; offset += chunk.length) hash.update(chunk.subarray(0, Math.min(chunk.length, length - offset)));
  return { length, sha256: hash.digest('hex') };
}
export function* chunksOf(bytes, sizes) {
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    yield bytes.subarray(offset, offset + size); offset += size;
  }
  if (offset < bytes.length) yield bytes.subarray(offset);
}
