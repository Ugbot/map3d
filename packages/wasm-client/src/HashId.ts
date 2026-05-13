// FNV-1a 32-bit string hash.
//
// Used to map feed string ids (ICAO24 for aircraft, MMSI for vessels —
// up to 16 ASCII bytes from the wire) onto the u32 remote_id slot the C
// bridge accepts. Tiger style: pure function, bounded, no allocation.
//
// Collision policy is "last write wins" at the bridge layer — this hash is
// only used to keep the bridge ABI numeric. The chance of two simultaneously
// live feeds colliding in 2^32 over an N≤10k working set is ~N^2 / 2^33,
// which is ~1.2e-5 at N=10000. Acceptable for v1; revisit with an explicit
// id table if collisions appear in practice.

import { assert } from "@map3d/data-core";

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

/** FNV-1a over the raw UTF-16 code units of `s`. The wire only ever puts
 *  ASCII bytes in the id field (we read with TextDecoder("ascii")), so each
 *  code unit fits in one byte; we still mask to be defensive. */
export function fnv1a32(s: string): number {
  assert(typeof s === "string", "fnv1a32: not a string");
  let h = FNV_OFFSET_BASIS_32 >>> 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    h ^= s.charCodeAt(i) & 0xff;
    // Multiply mod 2^32 — use Math.imul for correctness on 32-bit overflow.
    h = Math.imul(h, FNV_PRIME_32) >>> 0;
  }
  // Reserve 0 as "no id" — bridge treats 0 as a valid u32, but downstream
  // dedupe code is cleaner if 0 never appears. Bump to 1 on the off chance.
  return h === 0 ? 1 : h;
}
