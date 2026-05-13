// Deterministic seeded PRNG (Mulberry32). Same seed → same sequence on every
// platform. Used everywhere we'd otherwise reach for Math.random() so the
// simulation is reproducible (and assertable) across runs.

import { assertU32 } from "./assert";

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). n must be > 0. */
  nextInt(n: number): number;
  /** -1 or +1. */
  sign(): number;
}

export function makeRng(seed: number): Rng {
  assertU32(seed >>> 0, "rng seed");
  let state = seed >>> 0;
  function raw(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next: raw,
    nextInt(n: number) {
      if (!(n > 0)) throw new Error("rng.nextInt n>0");
      return Math.floor(raw() * n);
    },
    sign() {
      return raw() < 0.5 ? -1 : 1;
    },
  };
}
