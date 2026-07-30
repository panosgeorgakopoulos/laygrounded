import { describe, expect, test } from "bun:test";
import {
  ENSEMBLE_HORIZON_HOURS,
  FULL_SKILL_HOURS,
  ensembleWeight,
  horizonMode,
  leadTimeHours,
} from "@/lib/risk/horizon";

describe("ensembleWeight", () => {
  test("is fully ensemble inside the skill window", () => {
    expect(ensembleWeight(0)).toBe(1);
    expect(ensembleWeight(24)).toBe(1);
    expect(ensembleWeight(FULL_SKILL_HOURS)).toBe(1);
    // An ETA already past still uses the forecast rather than going negative.
    expect(ensembleWeight(-48)).toBe(1);
  });

  test("is fully climatology beyond the ensemble horizon", () => {
    expect(ensembleWeight(ENSEMBLE_HORIZON_HOURS)).toBe(0);
    expect(ensembleWeight(ENSEMBLE_HORIZON_HOURS + 500)).toBe(0);
  });

  test("decreases monotonically across the blend", () => {
    let previous = 1;
    for (let h = FULL_SKILL_HOURS; h <= ENSEMBLE_HORIZON_HOURS; h += 4) {
      const w = ensembleWeight(h);
      expect(w).toBeLessThanOrEqual(previous + 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      previous = w;
    }
  });

  test("is continuous — no cliff a charterer would notice", () => {
    // The failure this guards against: a vessel's published P90 jumping
    // overnight because it crossed an arbitrary boundary. Step size 0.1h, so
    // any true discontinuity shows up as a large jump.
    let maxJump = 0;
    for (let h = 0; h <= ENSEMBLE_HORIZON_HOURS + 24; h += 0.1) {
      maxJump = Math.max(maxJump, Math.abs(ensembleWeight(h) - ensembleWeight(h - 0.1)));
    }
    expect(maxJump).toBeLessThan(0.002);
  });

  test("has zero slope at both ends, so the blend eases in and out", () => {
    const slope = (h: number) => (ensembleWeight(h + 0.05) - ensembleWeight(h - 0.05)) / 0.1;
    expect(Math.abs(slope(FULL_SKILL_HOURS + 0.1))).toBeLessThan(0.001);
    expect(Math.abs(slope(ENSEMBLE_HORIZON_HOURS - 0.1))).toBeLessThan(0.001);
  });

  test("is exactly half way through the blend at the midpoint", () => {
    const mid = (FULL_SKILL_HOURS + ENSEMBLE_HORIZON_HOURS) / 2;
    expect(ensembleWeight(mid)).toBeCloseTo(0.5, 10);
  });
});

describe("horizonMode", () => {
  test("names the three regimes", () => {
    expect(horizonMode(48)).toBe("ensemble");
    expect(horizonMode(240)).toBe("blended");
    expect(horizonMode(700)).toBe("climatology");
  });
});

describe("leadTimeHours", () => {
  test("measures forward from now to ETA", () => {
    expect(
      leadTimeHours("2026-08-01T00:00:00.000Z", "2026-08-04T00:00:00.000Z")
    ).toBeCloseTo(72, 6);
  });

  test("is negative once the ETA has passed", () => {
    expect(
      leadTimeHours("2026-08-05T00:00:00.000Z", "2026-08-04T00:00:00.000Z")
    ).toBeCloseTo(-24, 6);
  });
});
