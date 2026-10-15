'use strict';
// Synthetic bytes are compared in memory; the test never records their value.
function syntheticPayload(size) {
  return Uint8Array.from({ length: size }, (_, index) => (index * 73 + (index >>> 8) * 19 + 17) & 255);
}
function crc32c(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
module.exports = { syntheticPayload, crc32c };
