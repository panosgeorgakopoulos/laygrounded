/// <reference types="bun-types" />
// Run with: bun test src/lib/compliance/ets.test.ts

import { describe, it, expect } from "bun:test";
import { computeEtsEstimate, etsPhaseInFactor, etsChargeableShare } from "./ets";
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

describe("EU ETS phase-in factor", () => {
  it("rises 40% → 70% → 100% and is zero before 2024", () => {
    expect(etsPhaseInFactor(2023)).toBe(0);
    expect(etsPhaseInFactor(2024)).toBe(0.4);
    expect(etsPhaseInFactor(2025)).toBe(0.7);
    expect(etsPhaseInFactor(2026)).toBe(1);
    expect(etsPhaseInFactor(2030)).toBe(1);
  });
});

describe("EU ETS chargeable share (at-berth)", () => {
  it("non-EEA port is entirely out of scope — no liability", () => {
    const s = etsChargeableShare({ eeaPort: false, year: 2026 });
    expect(s.share).toBe(0);
    expect(s.scopeCertain).toBe(true);
  });

  it("EEA port is fully in scope, scaled only by the year's phase-in", () => {
    expect(etsChargeableShare({ eeaPort: true, year: 2026 }).share).toBe(1);
    expect(etsChargeableShare({ eeaPort: true, year: 2025 }).share).toBe(0.7);
  });

  it("unknown EEA status shows potential exposure but flags it uncertain", () => {
    const s = etsChargeableShare({ eeaPort: null, year: 2026 });
    expect(s.share).toBe(1);
    expect(s.scopeCertain).toBe(false);
  });

  it("a non-EEA berth zeroes the EUA cost while the CO2 stays real", () => {
    const share = etsChargeableShare({ eeaPort: false, year: 2026 }).share;
    const e = computeEtsEstimate({ delayHours: 48, coveragePct: share });
    expect(e.co2Tonnes).toBeGreaterThan(0); // the delay still emitted CO2
    expect(e.estimatedCostEur).toBe(0); // but there is no EU ETS liability
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
