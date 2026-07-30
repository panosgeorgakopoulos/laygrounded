import { describe, expect, test } from "bun:test";
import {
  estimateMean,
  estimatePercentile,
  estimateProbability,
  mean,
  percentile,
  stdDev,
  summarize,
  type TrialOutcome,
} from "@/lib/risk/aggregate";
import { makeRng } from "@/lib/risk/prng";
import { standardNormal } from "@/lib/risk/distributions";

describe("percentile", () => {
  test("interpolates between order statistics", () => {
    expect(percentile([0, 10, 20, 30, 40], 0.5)).toBe(20);
    expect(percentile([0, 10], 0.9)).toBe(9);
    expect(percentile([], 0.9)).toBe(0);
    expect(percentile([5], 0.5)).toBe(5);
  });
});

describe("mean and stdDev", () => {
  test("match hand-computed values", () => {
    expect(mean([2, 4, 6])).toBe(4);
    // Sample sd (n−1) of [2,4,6] is 2.
    expect(stdDev([2, 4, 6])).toBeCloseTo(2, 10);
    expect(stdDev([7])).toBe(0);
    expect(mean([])).toBe(0);
  });
});

describe("estimateMean", () => {
  test("recovers a known mean with a shrinking interval", () => {
    // Normal(100, 15): the SE of the mean over n draws is 15/sqrt(n).
    const rng = makeRng("mean-est");
    const xs = Array.from({ length: 10_000 }, () => 100 + 15 * standardNormal(rng.next()));
    const est = estimateMean(xs);

    expect(est.value).toBeCloseTo(100, 0);
    expect(est.standardError).toBeCloseTo(15 / Math.sqrt(10_000), 1);
    expect(est.ci95[0]).toBeLessThan(100);
    expect(est.ci95[1]).toBeGreaterThan(100);
  });

  test("is safe on empty and single-value input", () => {
    expect(estimateMean([]).value).toBe(0);
    expect(estimateMean([42]).standardError).toBe(0);
  });
});

describe("estimateProbability", () => {
  test("matches the analytic standard error of a proportion", () => {
    const est = estimateProbability(250, 1000);
    expect(est.value).toBe(0.25);
    expect(est.standardError).toBeCloseTo(Math.sqrt((0.25 * 0.75) / 1000), 10);
  });

  test("clamps the interval to [0, 1]", () => {
    const certain = estimateProbability(1000, 1000);
    expect(certain.ci95[1]).toBeLessThanOrEqual(1);
    const never = estimateProbability(0, 1000);
    expect(never.ci95[0]).toBeGreaterThanOrEqual(0);
  });

  test("no trials is zero, not NaN", () => {
    expect(estimateProbability(0, 0).value).toBe(0);
  });
});

describe("estimatePercentile", () => {
  test("recovers known quantiles of a normal sample", () => {
    const rng = makeRng("pct-est");
    const xs = Array.from({ length: 20_000 }, () => 100 + 15 * standardNormal(rng.next())).sort(
      (a, b) => a - b
    );
    // Normal(100,15): P90 ≈ 100 + 1.2816×15 ≈ 119.2
    expect(estimatePercentile(xs, 0.9).value).toBeCloseTo(119.2, 0);
    expect(estimatePercentile(xs, 0.5).value).toBeCloseTo(100, 0);
  });

  test("the interval brackets the truth and tightens with n", () => {
    const draw = (n: number) => {
      const rng = makeRng(`pct-${n}`);
      return Array.from({ length: n }, () => 100 + 15 * standardNormal(rng.next())).sort(
        (a, b) => a - b
      );
    };
    const truth = 100 + 1.2815515655446004 * 15;

    const small = estimatePercentile(draw(1000), 0.9);
    const large = estimatePercentile(draw(20000), 0.9);

    expect(small.ci95[0]).toBeLessThanOrEqual(truth);
    expect(small.ci95[1]).toBeGreaterThanOrEqual(truth);
    const width = (e: typeof small) => e.ci95[1] - e.ci95[0];
    expect(width(large)).toBeLessThan(width(small));
  });

  test("works on a heavily zero-inflated, skewed sample", () => {
    // The real shape of demurrage outcomes: mostly zero, occasionally huge.
    // A normal-theory interval would be nonsense here; the order-statistic
    // one must still bracket sensibly.
    const xs = [...Array(900).fill(0), ...Array(100).fill(0).map((_, i) => 1000 * (i + 1))].sort(
      (a, b) => a - b
    );
    const p95 = estimatePercentile(xs, 0.95);
    expect(p95.value).toBeGreaterThan(0);
    expect(p95.ci95[0]).toBeLessThanOrEqual(p95.value);
    expect(p95.ci95[1]).toBeGreaterThanOrEqual(p95.value);
  });

  test("degenerate samples do not throw", () => {
    expect(estimatePercentile([], 0.9).value).toBe(0);
    expect(estimatePercentile([5], 0.9).value).toBe(5);
  });
});

describe("summarize", () => {
  const outcome = (net: number, kind: "ensemble" | "climatology" = "ensemble"): TrialOutcome => ({
    net,
    demurrageAmount: net > 0 ? net : 0,
    despatchAmount: net < 0 ? -net : 0,
    usedHours: 80,
    waitingHours: 6,
    stoppageHours: 4,
    trajectoryKind: kind,
  });

  test("separates expected from conditional exposure", () => {
    // 9 trials at zero, 1 at 100k: expected 10k, conditional 100k. Reporting
    // only the first would hide what it costs when it actually happens.
    const outcomes = [...Array(9).fill(0).map(() => outcome(0)), outcome(100_000)];
    const d = summarize(outcomes);

    expect(d.demurrageProbability.value).toBeCloseTo(0.1, 10);
    expect(d.expectedExposure.value).toBeCloseTo(10_000, 6);
    expect(d.conditionalExposure.value).toBeCloseTo(100_000, 6);
  });

  test("records the realised trajectory mix", () => {
    const d = summarize([
      outcome(0, "ensemble"),
      outcome(0, "ensemble"),
      outcome(0, "climatology"),
    ]);
    expect(d.trajectoryMix).toEqual({ ensemble: 2, climatology: 1 });
  });

  test("reports best and worst cases", () => {
    const d = summarize([outcome(-5000), outcome(0), outcome(90_000)]);
    expect(d.bestCase).toBe(-5000);
    expect(d.worstCase).toBe(90_000);
  });

  test("the histogram covers every trial exactly once", () => {
    const rng = makeRng("hist");
    const outcomes = Array.from({ length: 5000 }, () =>
      outcome(Math.round(Math.max(0, 40_000 + 30_000 * standardNormal(rng.next()))))
    );
    const d = summarize(outcomes);
    expect(d.histogram.reduce((a, b) => a + b.count, 0)).toBe(5000);
  });

  test("an all-identical sample collapses to one bin without dividing by zero", () => {
    const d = summarize(Array.from({ length: 10 }, () => outcome(0)));
    expect(d.histogram.length).toBe(1);
    expect(d.histogram[0].count).toBe(10);
    expect(d.demurrageProbability.value).toBe(0);
  });
});
