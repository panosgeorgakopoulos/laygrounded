/// <reference types="bun-types" />
// Run with: bun test src/lib/compliance/ets.test.ts

import { describe, it, expect } from "bun:test";
import { computeEtsEstimate } from "./ets";
import { classifyScore } from "./sanctions";

describe("computeEtsEstimate", () => {
  it("computes CO2 and EUA cost from delay hours", () => {
    // 48h delay = 2 days × 4 t/day × 3.114 = 24.912 tCO2 × €80 = €1,992.96
    const e = computeEtsEstimate({
      delayHours: 48,
      fuelTonnesPerDay: 4,
      co2PerTonneFuel: 3.114,
      euaPriceEur: 80,
      coveragePct: 1,
    });
    expect(e.co2Tonnes).toBe(24.912);
    expect(e.estimatedCostEur).toBe(1992.96);
  });

  it("applies partial coverage and clamps negative delay", () => {
    const half = computeEtsEstimate({
      delayHours: 24,
      fuelTonnesPerDay: 4,
      co2PerTonneFuel: 3.114,
      euaPriceEur: 100,
      coveragePct: 0.5,
    });
    expect(half.estimatedCostEur).toBe(622.8);

    const none = computeEtsEstimate({ delayHours: -5, euaPriceEur: 100 });
    expect(none.co2Tonnes).toBe(0);
    expect(none.estimatedCostEur).toBe(0);
  });
});

describe("sanctions verdict banding", () => {
  it("maps scores to verdicts with a deliberate review band", () => {
    expect(classifyScore(0.95, false)).toBe("match");
    expect(classifyScore(0.4, true)).toBe("match"); // API's own decision wins
    expect(classifyScore(0.6, false)).toBe("possible_match");
    expect(classifyScore(0.2, false)).toBe("clear");
  });
});
