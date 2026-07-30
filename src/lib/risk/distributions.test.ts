import { describe, expect, test } from "bun:test";
import { makeRng } from "@/lib/risk/prng";
import {
  pickIndex,
  sampleEmpirical,
  sampleLognormal,
  sampleTriangular,
  standardNormal,
} from "@/lib/risk/distributions";

// Each sampler is checked against a CLOSED-FORM property of the distribution it
// claims to draw from, not against a recorded snapshot of its own output. A
// snapshot test would pass just as happily on a sampler that draws the wrong
// distribution consistently.

const rng = () => makeRng("distributions-test");

describe("sampleTriangular", () => {
  test("mean converges to the analytic (min+mode+max)/3", () => {
    const r = rng();
    const [min, mode, max] = [-12, 0, 48];
    const n = 200_000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleTriangular(min, mode, max, r.next());
    expect(sum / n).toBeCloseTo((min + mode + max) / 3, 0);
  });

  test("variance converges to the analytic form", () => {
    const r = rng();
    const [a, c, b] = [0, 10, 30]; // min, mode, max
    const expected = (a * a + b * b + c * c - a * b - a * c - b * c) / 18;
    const n = 200_000;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) xs.push(sampleTriangular(a, c, b, r.next()));
    const m = xs.reduce((x, y) => x + y, 0) / n;
    const v = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / n;
    expect(v).toBeCloseTo(expected, 0);
  });

  test("stays inside its bounds — an unbounded ETA error would escape the window", () => {
    const r = rng();
    for (let i = 0; i < 20_000; i++) {
      const x = sampleTriangular(-12, 0, 48, r.next());
      expect(x).toBeGreaterThanOrEqual(-12);
      expect(x).toBeLessThanOrEqual(48);
    }
  });

  test("a degenerate range collapses to a point", () => {
    expect(sampleTriangular(5, 5, 5, 0.3)).toBe(5);
  });
});

describe("standardNormal", () => {
  test("reproduces known quantiles of the normal CDF", () => {
    expect(standardNormal(0.5)).toBeCloseTo(0, 6);
    expect(standardNormal(0.975)).toBeCloseTo(1.959964, 4);
    expect(standardNormal(0.025)).toBeCloseTo(-1.959964, 4);
    expect(standardNormal(0.99)).toBeCloseTo(2.326348, 4);
    expect(standardNormal(0.001)).toBeCloseTo(-3.090232, 3);
  });

  test("is antisymmetric, so 1-u is the reflected draw", () => {
    // This is what makes antithetic pairing meaningful for normal draws.
    for (const u of [0.1, 0.3, 0.42, 0.87, 0.99]) {
      expect(standardNormal(1 - u)).toBeCloseTo(-standardNormal(u), 6);
    }
  });

  test("mean 0 and variance 1 over many draws", () => {
    const r = rng();
    const n = 100_000;
    const xs = Array.from({ length: n }, () => standardNormal(r.next()));
    const m = xs.reduce((a, b) => a + b, 0) / n;
    const v = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / n;
    expect(m).toBeCloseTo(0, 2);
    expect(v).toBeCloseTo(1, 1);
  });

  test("does not return infinities at the open ends", () => {
    expect(Number.isFinite(standardNormal(0))).toBe(true);
    expect(Number.isFinite(standardNormal(1))).toBe(true);
  });
});

describe("sampleLognormal", () => {
  test("the median parameter really is the median", () => {
    const r = rng();
    const median = 14;
    const xs = Array.from({ length: 50_000 }, () => sampleLognormal(median, 0.9, r.next())).sort(
      (a, b) => a - b
    );
    expect(xs[Math.floor(xs.length / 2)]).toBeCloseTo(median, 0);
  });

  test("is right-skewed — mean above median, as a port queue is", () => {
    const r = rng();
    const xs = Array.from({ length: 50_000 }, () => sampleLognormal(14, 0.9, r.next()));
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sorted = [...xs].sort((a, b) => a - b);
    expect(mean).toBeGreaterThan(sorted[Math.floor(sorted.length / 2)]);
  });

  test("never negative", () => {
    const r = rng();
    for (let i = 0; i < 10_000; i++) expect(sampleLognormal(14, 1.2, r.next())).toBeGreaterThan(0);
  });
});

describe("sampleEmpirical", () => {
  const observed = [0, 1, 2, 6, 8, 12, 30, 96];

  test("spans exactly the observed range and invents no tail", () => {
    expect(sampleEmpirical(observed, 0)).toBe(0);
    expect(sampleEmpirical(observed, 0.999999)).toBeLessThanOrEqual(96);
    const r = rng();
    for (let i = 0; i < 10_000; i++) {
      const x = sampleEmpirical(observed, r.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(96);
    }
  });

  test("recovers the shape it was given", () => {
    // Draws from a known empirical set should reproduce its median.
    const r = rng();
    const xs = Array.from({ length: 40_000 }, () => sampleEmpirical(observed, r.next())).sort(
      (a, b) => a - b
    );
    const median = xs[Math.floor(xs.length / 2)];
    expect(median).toBeGreaterThan(5);
    expect(median).toBeLessThan(10);
  });

  test("preserves a heavy tail rather than smoothing it away", () => {
    // The whole reason for an ECDF over a fitted lognormal: the rare four-day
    // wait must survive, because it is what generates demurrage.
    const r = rng();
    const xs = Array.from({ length: 40_000 }, () => sampleEmpirical(observed, r.next()));
    expect(xs.filter((x) => x > 30).length).toBeGreaterThan(0);
  });

  test("degenerate inputs are safe", () => {
    expect(sampleEmpirical([], 0.5)).toBe(0);
    expect(sampleEmpirical([7], 0.5)).toBe(7);
  });
});

describe("pickIndex", () => {
  test("covers every index and stays in range", () => {
    const r = rng();
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const idx = pickIndex(30, r.next());
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(30);
      seen.add(idx);
    }
    expect(seen.size).toBe(30);
  });

  test("u just below 1 stays in range", () => {
    expect(pickIndex(30, 0.9999999999)).toBe(29);
  });

  test("an empty pool returns -1 rather than 0", () => {
    expect(pickIndex(0, 0.5)).toBe(-1);
  });
});
