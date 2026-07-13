import { describe, expect, test } from "bun:test";
import {
  computeRiskExposure,
  MIN_SAMPLE_VOYAGES,
  percentile,
  OracleVoyageStat,
} from "./pricing";

function stat(overrides: Partial<OracleVoyageStat> = {}): OracleVoyageStat {
  return {
    month: 7,
    weatherDelayHours: 0,
    usedHours: 72,
    allowedHours: 72,
    excessHours: 0,
    verified: true,
    ...overrides,
  };
}

describe("percentile", () => {
  const cases: Array<{ name: string; values: number[]; p: number; expected: number }> = [
    { name: "empty array returns 0", values: [], p: 0.9, expected: 0 },
    { name: "single element for any p", values: [42], p: 0.13, expected: 42 },
    { name: "exact index (median of odd count)", values: [1, 2, 3], p: 0.5, expected: 2 },
    { name: "interpolates between elements", values: [10, 20], p: 0.25, expected: 12.5 },
    { name: "p clamped above 1 returns max", values: [1, 5, 9], p: 1.7, expected: 9 },
    { name: "p clamped below 0 returns min", values: [1, 5, 9], p: -0.5, expected: 1 },
    {
      name: "p90 of four values interpolates at index 2.7",
      values: [0, 8000, 28000, 48000],
      p: 0.9,
      expected: 42000, // 28000 + 0.7 × (48000 − 28000)
    },
  ];
  for (const c of cases) {
    test(c.name, () => {
      expect(percentile(c.values, c.p)).toBeCloseTo(c.expected, 10);
    });
  }
});

describe("computeRiskExposure", () => {
  test("throws INSUFFICIENT_DATA below the sample floor", () => {
    const stats = Array.from({ length: MIN_SAMPLE_VOYAGES - 1 }, () => stat());
    expect(() =>
      computeRiskExposure(stats, { laytimeAllowedHours: 72, demurrageRatePerDay: 24000 })
    ).toThrow("INSUFFICIENT_DATA");
  });

  // Hand-computed fixture: used hours [60, 80, 100, 120] against a 72h
  // allowance at 24,000/day → exposures [0, 8000, 28000, 48000].
  const fixture: OracleVoyageStat[] = [
    stat({ usedHours: 60, weatherDelayHours: 0, verified: true }),
    stat({ usedHours: 80, weatherDelayHours: 12, verified: true }),
    stat({ usedHours: 100, weatherDelayHours: 24, verified: false }),
    stat({ usedHours: 120, weatherDelayHours: 12, verified: true }),
  ];
  const input = { laytimeAllowedHours: 72, demurrageRatePerDay: 24000 };

  test("prices the hypothetical excess per voyage (hand-computed)", () => {
    const r = computeRiskExposure(fixture, input);
    expect(r.sampleSize).toBe(4);
    expect(r.demurrageProbability).toBeCloseTo(0.75, 10);
    expect(r.verifiedShare).toBeCloseTo(0.75, 10);
    expect(r.meanExposure).toBeCloseTo(21000, 10);
    expect(r.medianExposure).toBeCloseTo(18000, 10);
    expect(r.p90Exposure).toBeCloseTo(42000, 10);
    expect(r.worstExposure).toBeCloseTo(48000, 10);
    expect(r.meanWeatherDelayHours).toBeCloseTo(12, 10);
    expect(r.meanUsedHours).toBeCloseTo(90, 10);
    expect(r.assessment).toContain("3 of 4 historical voyages");
  });

  test("a more generous allowance is monotonically cheaper", () => {
    const allowances = [48, 72, 96, 120, 144];
    let prev = Infinity;
    for (const laytimeAllowedHours of allowances) {
      const r = computeRiskExposure(fixture, { ...input, laytimeAllowedHours });
      expect(r.meanExposure).toBeLessThanOrEqual(prev);
      prev = r.meanExposure;
    }
  });

  test("allowance above every observed voyage yields zero exposure everywhere", () => {
    const r = computeRiskExposure(fixture, { ...input, laytimeAllowedHours: 200 });
    expect(r.demurrageProbability).toBe(0);
    expect(r.meanExposure).toBe(0);
    expect(r.medianExposure).toBe(0);
    expect(r.p90Exposure).toBe(0);
    expect(r.worstExposure).toBe(0);
    expect(r.assessment).toContain("none of the 4 historical voyages");
  });

  test("exposure scales linearly with the demurrage rate", () => {
    const single = computeRiskExposure(fixture, { ...input, demurrageRatePerDay: 12000 });
    const double = computeRiskExposure(fixture, { ...input, demurrageRatePerDay: 24000 });
    expect(double.meanExposure).toBeCloseTo(single.meanExposure * 2, 6);
    expect(double.worstExposure).toBeCloseTo(single.worstExposure * 2, 6);
  });
});
