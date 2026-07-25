/// <reference types="bun-types" />
// Run with: bun test src/lib/compliance/fueleu.test.ts

import { describe, it, expect } from "bun:test";
import { computeFuelEu, fuelEuLimit, fuelEuReduction } from "./fueleu";

describe("fuelEuLimit trajectory", () => {
  it("is undefined before 2025 and tracks the reduction schedule", () => {
    expect(fuelEuLimit(2024)).toBeNull();
    expect(fuelEuLimit(2025)).toBe(89.3368); // 91.16 × 0.98
    expect(fuelEuLimit(2030)).toBe(85.6904); // × 0.94
    expect(fuelEuLimit(2035)).toBe(77.9418); // × 0.855
    expect(fuelEuLimit(2040)).toBe(62.9004); // × 0.69
    expect(fuelEuLimit(2050)).toBe(18.232); // × 0.20
  });

  it("reduction steps hold across a band", () => {
    expect(fuelEuReduction(2029)).toBe(0.02);
    expect(fuelEuReduction(2030)).toBe(0.06);
    expect(fuelEuReduction(2051)).toBe(0.8);
  });
});

describe("computeFuelEu — deficit and penalty (Annex IV)", () => {
  // 1000 t HFO in 2025. Energy = 1000 × 40,500 = 40,500,000 MJ.
  // attained = 91.6; limit = 89.3368 → balance = (89.3368 − 91.6) × 40.5e6
  //          = −91,659,600 gCO2eq (deficit).
  // penalty  = |CB| / (91.6 × 41,000) × 2400 ≈ €58,574.67.
  const r = computeFuelEu({ year: 2025, fuels: [{ fuel: "HFO", tonnes: 1000 }] });

  it("attains the fuel's WtW intensity for a single fuel", () => {
    expect(r.attainedIntensity).toBe(91.6);
    expect(r.totalEnergyMJ).toBe(40_500_000);
  });

  it("runs a deficit against the 2025 limit", () => {
    expect(r.limit).toBe(89.3368);
    expect(r.compliant).toBe(false);
    expect(r.complianceBalanceGco2eq).toBe(-91_659_600);
  });

  it("prices the penalty per Annex IV", () => {
    expect(r.vlsfoEquivalentTonnes).toBeCloseTo(24.406, 2);
    expect(r.penaltyEur).toBeCloseTo(58_574.67, 1);
  });
});

describe("computeFuelEu — compliant mix banks a surplus, no penalty", () => {
  const r = computeFuelEu({ year: 2025, fuels: [{ fuel: "LNG", tonnes: 1000 }] });
  it("LNG (76.08) sits below the limit", () => {
    expect(r.compliant).toBe(true);
    expect(r.complianceBalanceGco2eq).toBeGreaterThan(0);
    expect(r.penaltyEur).toBe(0);
    expect(r.vlsfoEquivalentTonnes).toBe(0);
  });
});

describe("computeFuelEu — attained intensity is ENERGY-weighted, not mass-weighted", () => {
  // 500 t HFO (91.6, LCV 40,500) + 500 t MDO/MGO (90.6, LCV 42,700). Equal mass
  // but MDO carries more energy, so it pulls the weighted mean below the mass
  // mean of 91.1.
  const r = computeFuelEu({
    year: 2025,
    fuels: [
      { fuel: "HFO", tonnes: 500 },
      { fuel: "MDO/MGO", tonnes: 500 },
    ],
  });
  it("weights by MJ", () => {
    expect(r.attainedIntensity).toBeCloseTo(91.0868, 3);
    expect(r.totalEnergyMJ).toBe(41_600_000);
  });
});

describe("computeFuelEu — honesty about pathway-dependent fuels", () => {
  it("refuses to invent a WtW factor for methanol", () => {
    expect(() => computeFuelEu({ year: 2025, fuels: [{ fuel: "methanol", tonnes: 100 }] })).toThrow(
      /FUELEU_INTENSITY_REQUIRED/
    );
  });

  it("accepts a certified (e.g. bio-methanol) intensity and marks it supplied", () => {
    const r = computeFuelEu({
      year: 2025,
      fuels: [{ fuel: "methanol", tonnes: 100, wtwIntensity: 14 }],
    });
    expect(r.breakdown[0].source).toBe("supplied");
    expect(r.compliant).toBe(true); // 14 gCO2eq/MJ is far under the limit
  });

  it("refuses years before the regulation is in force", () => {
    expect(() => computeFuelEu({ year: 2024, fuels: [{ fuel: "HFO", tonnes: 10 }] })).toThrow(
      /FUELEU_NOT_IN_FORCE/
    );
  });
});
