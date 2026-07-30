// Seeded pseudo-randomness for the pre-arrival risk engine.
//
// A risk figure that cannot be reproduced is not evidence, and this product's
// whole position is that its numbers can be re-derived by someone who does not
// trust us. So the simulation never touches `Math.random()`: every uniform
// comes from a generator seeded by a string that is stored alongside the
// result. Handed the same seed and the same inputs, a counterparty gets the
// same distribution months later.
//
// xoshiro128** over cyrb128 seeding. Both are integer-only and defined purely
// in terms of `Math.imul`, `<<`, `>>>` and `^`, so the sequence is identical on
// every JS engine — the same reason the engine pins its timezone table rather
// than trusting the host's ICU.
//
// NOT for cryptography. This picks weather trajectories, not keys.
//
// Pure.

/** Four 32-bit words of state, derived from an arbitrary seed string. */
export type PrngState = [number, number, number, number];

/**
 * cyrb128: string → 128 bits of well-mixed state.
 *
 * Seeding matters more than it looks. Naively splatting a small integer across
 * the state gives xoshiro a near-zero start, and it emits visibly poor output
 * for thousands of draws before recovering. Avalanching first means seed "1"
 * and seed "2" produce unrelated streams, which is what lets a caller use a
 * human-meaningful seed (a voyage reference) without weakening the sequence.
 */
export function seedState(seed: string): PrngState {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;

  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }

  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);

  const state: PrngState = [
    (h1 ^ h2 ^ h3 ^ h4) >>> 0,
    (h2 ^ h1) >>> 0,
    (h3 ^ h1) >>> 0,
    (h4 ^ h1) >>> 0,
  ];

  // An all-zero state is xoshiro's one fixed point: it would emit zeros
  // forever. Unreachable for any real seed, but the cost of being sure is one
  // comparison and the cost of being wrong is a silently constant "simulation".
  if (state[0] === 0 && state[1] === 0 && state[2] === 0 && state[3] === 0) {
    return [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0x85a308d3];
  }
  return state;
}

export interface Rng {
  /** Next uniform in [0, 1). */
  next(): number;
  /** Current state, for checkpointing a stream in tests. */
  state(): PrngState;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** xoshiro128** — 2^128 period, passes BigCrush, four words of state. */
export function makeRng(seed: string | PrngState): Rng {
  const s = typeof seed === "string" ? seedState(seed) : ([...seed] as PrngState);

  return {
    next(): number {
      const result = Math.imul(rotl(Math.imul(s[1], 5), 7), 9) >>> 0;
      const t = (s[1] << 9) >>> 0;

      s[2] ^= s[0];
      s[3] ^= s[1];
      s[1] ^= s[2];
      s[0] ^= s[3];
      s[2] ^= t;
      s[3] = rotl(s[3], 11);

      s[0] >>>= 0;
      s[1] >>>= 0;
      s[2] >>>= 0;
      s[3] >>>= 0;

      // Divide by 2^32 rather than masking to 53 bits: the result is exactly
      // representable and lands in [0, 1), never 1.
      return result / 4294967296;
    },
    state: () => [...s] as PrngState,
  };
}
