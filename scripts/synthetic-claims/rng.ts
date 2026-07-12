// Deterministic PRNG for the synthetic claim generator (mulberry32).
// Every case is fully reproducible from (corpus seed, case index).

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  // Uniform float in [0, 1).
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Uniform integer in [min, max] inclusive.
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  // Derive an independent child generator (for retry attempts) without
  // disturbing this generator's sequence.
  child(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0);
  }
}
