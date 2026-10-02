/** A deterministic random source returning floats in [0, 1). */
export type Random = () => number

/**
 * Mulberry32: a small, fast seeded PRNG. The same seed always yields the same sequence.
 * @param seed - 32-bit seed.
 * @returns the generator.
 */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
