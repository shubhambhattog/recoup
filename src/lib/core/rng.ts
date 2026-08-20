// Deterministic, seeded PRNG. Every batch run is reproducible: clone the repo,
// run with the same seed, get the exact same money numbers. We never call
// Math.random() anywhere in the engine or simulator — reproducibility is a
// correctness property here, not a nicety.

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number;
  /** True with probability pTrue. */
  bool(pTrue: number): boolean;
  /** Uniform pick from a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick from [item, weight] pairs (weights need not sum to 1). */
  weighted<T>(items: readonly (readonly [T, number])[]): T;
  /** Normal sample (Box–Muller). */
  gaussian(mean: number, stddev: number): number;
  /** A fresh independent stream, deterministically derived from this one. */
  fork(salt: number): Rng;
}

// mulberry32 — small, fast, good enough for simulation.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    bool: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted: (items) => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r <= 0) return item;
      }
      return items[items.length - 1][0];
    },
    gaussian: (mean, stddev) => {
      const u1 = Math.max(next(), 1e-9);
      const u2 = next();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return mean + z * stddev;
    },
    fork: (salt) => makeRng((seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0),
  };
  return rng;
}
