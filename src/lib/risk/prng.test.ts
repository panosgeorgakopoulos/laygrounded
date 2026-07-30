import { describe, expect, test } from "bun:test";
import { makeRng, seedState } from "@/lib/risk/prng";

// The generator is the foundation of the reproducibility claim. If it drifts,
// every stored assessment silently stops replaying.

describe("seedState", () => {
  test("different seeds give unrelated states", () => {
    const a = seedState("1");
    const b = seedState("2");
    expect(a).not.toEqual(b);
    // Avalanche: a one-character change should not leave any word intact.
    expect(a.filter((w, i) => w === b[i]).length).toBe(0);
  });

  test("is stable for a given seed", () => {
    expect(seedState("MV Pacific Trader|V-001")).toEqual(seedState("MV Pacific Trader|V-001"));
  });

  test("never returns the all-zero state", () => {
    for (const seed of ["", "0", "\0", "\0\0\0\0"]) {
      expect(seedState(seed).some((w) => w !== 0)).toBe(true);
    }
  });
});

describe("makeRng", () => {
  test("same seed reproduces the same stream", () => {
    const a = makeRng("voyage-42");
    const b = makeRng("voyage-42");
    const xs = Array.from({ length: 200 }, () => a.next());
    const ys = Array.from({ length: 200 }, () => b.next());
    expect(xs).toEqual(ys);
  });

  test("different seeds diverge immediately", () => {
    const a = makeRng("voyage-42");
    const b = makeRng("voyage-43");
    expect(a.next()).not.toBe(b.next());
  });

  test("every draw lies in [0, 1)", () => {
    const rng = makeRng("bounds");
    for (let i = 0; i < 50_000; i++) {
      const u = rng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  test("is uniform to within sampling error", () => {
    // Ten equal buckets over 100k draws: each expects 10,000 with sd ≈ 94.9,
    // so ±5% is roughly 5 sd — loose enough never to flake, tight enough to
    // catch a generator that is actually skewed.
    const rng = makeRng("uniformity");
    const buckets = new Array(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rng.next() * 10)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 200);
      expect(count).toBeLessThan(n / 10 + n / 200);
    }
  });

  test("mean and variance match the uniform distribution", () => {
    const rng = makeRng("moments");
    const n = 100_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const u = rng.next();
      sum += u;
      sumSq += u * u;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    expect(mean).toBeCloseTo(0.5, 2);
    expect(variance).toBeCloseTo(1 / 12, 3);
  });

  test("shows no lag-1 autocorrelation", () => {
    // A generator whose consecutive draws correlate would make the antithetic
    // pairing meaningless and bias every trial.
    const rng = makeRng("autocorr");
    const n = 50_000;
    const xs = Array.from({ length: n }, () => rng.next());
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    let cov = 0;
    let varr = 0;
    for (let i = 0; i < n - 1; i++) cov += (xs[i] - mean) * (xs[i + 1] - mean);
    for (const x of xs) varr += (x - mean) ** 2;
    expect(Math.abs(cov / varr)).toBeLessThan(0.02);
  });

  test("resuming from a captured state continues the same stream", () => {
    const a = makeRng("resume");
    a.next();
    a.next();
    const resumed = makeRng(a.state());
    expect(resumed.next()).toBe(makeRng(a.state()).next());
  });
});
