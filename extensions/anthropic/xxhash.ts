// XXHash64, following the reference algorithm. BigInt keeps the 64-bit arithmetic
// exact in Node and Bun; no native or npm dependency is needed.
const MASK = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;
const u64 = (n: bigint) => n & MASK;
const rotate = (n: bigint, bits: bigint) => u64((n << bits) | (n >> (64n - bits)));
const round = (acc: bigint, input: bigint) => u64(rotate(u64(acc + input * P2), 31n) * P1);
const merge = (acc: bigint, value: bigint) => u64((acc ^ round(0n, value)) * P1 + P4);

export function xxhash64(bytes: Uint8Array, seed = 0n): bigint {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let hash: bigint;
  if (bytes.length >= 32) {
    let v1 = u64(seed + P1 + P2);
    let v2 = u64(seed + P2);
    let v3 = u64(seed);
    let v4 = u64(seed - P1);
    while (offset <= bytes.length - 32) {
      v1 = round(v1, view.getBigUint64(offset, true));
      v2 = round(v2, view.getBigUint64(offset + 8, true));
      v3 = round(v3, view.getBigUint64(offset + 16, true));
      v4 = round(v4, view.getBigUint64(offset + 24, true));
      offset += 32;
    }
    hash = u64(rotate(v1, 1n) + rotate(v2, 7n) + rotate(v3, 12n) + rotate(v4, 18n));
    for (const value of [v1, v2, v3, v4]) hash = merge(hash, value);
  } else {
    hash = u64(seed + P5);
  }
  hash = u64(hash + BigInt(bytes.length));
  while (offset <= bytes.length - 8) {
    hash ^= round(0n, view.getBigUint64(offset, true));
    hash = u64(rotate(hash, 27n) * P1 + P4);
    offset += 8;
  }
  if (offset <= bytes.length - 4) {
    hash ^= BigInt(view.getUint32(offset, true)) * P1;
    hash = u64(rotate(u64(hash), 23n) * P2 + P3);
    offset += 4;
  }
  while (offset < bytes.length) {
    hash ^= BigInt(bytes[offset++]) * P5;
    hash = u64(rotate(u64(hash), 11n) * P1);
  }
  hash ^= hash >> 33n;
  hash = u64(hash * P2);
  hash ^= hash >> 29n;
  hash = u64(hash * P3);
  return u64(hash ^ (hash >> 32n));
}
