import { describe, it, expect } from "bun:test";
import {
  computeDelayEmissions,
  buildCarbonCostOfDelay,
  MARINE_FUELS,
  NOX_KG_PER_TONNE_FUEL,
} from "./emissions";

describe("computeDelayEmissions", () => {
  it("scales linearly with delay and burn, from a known point", () => {
    // 24h at 4 t/day VLSFO = 4 t fuel.
    const e = computeDelayEmissions({ delayHours: 24, fuel: "VLSFO", fuelTonnesPerDay: 4 });
    expect(e.fuelTonnes).toBe(4);
    // CO2 = 4 t × 3.151 = 12.604 t
    expect(e.co2Tonnes).toBeCloseTo(12.604, 3);
    // NOx tier_ii = 4 t × 78 kg/t = 312 kg
    expect(e.noxKg).toBeCloseTo(312, 2);
    // SOx = 4 t × 0.5% × 2 × 1000 = 40 kg
    expect(e.soxKg).toBeCloseTo(40, 2);
  });

  it("SOx tracks fuel sulphur: HFO (3.5%) ≫ MGO (0.1%) ≫ LNG", () => {
    const hfo = computeDelayEmissions({ delayHours: 48, fuel: "HFO", fuelTonnesPerDay: 5 });
    const mgo = computeDelayEmissions({ delayHours: 48, fuel: "MGO", fuelTonnesPerDay: 5 });
    const lng = computeDelayEmissions({ delayHours: 48, fuel: "LNG", fuelTonnesPerDay: 5 });
    expect(hfo.soxKg).toBeGreaterThan(mgo.soxKg);
    expect(mgo.soxKg).toBeGreaterThan(lng.soxKg);
    // HFO 10 t fuel × 3.5% × 2 × 1000 = 700 kg
    expect(hfo.soxKg).toBeCloseTo(700, 1);
  });

  it("NOx tracks engine tier, independent of fuel sulphur", () => {
    const t2 = computeDelayEmissions({ delayHours: 24, engineTier: "tier_ii", fuelTonnesPerDay: 4 });
    const t3 = computeDelayEmissions({ delayHours: 24, engineTier: "tier_iii", fuelTonnesPerDay: 4 });
    expect(t3.noxKg).toBeLessThan(t2.noxKg);
    expect(t3.noxKg).toBeCloseTo(4 * NOX_KG_PER_TONNE_FUEL.tier_iii, 2);
  });

  it("clamps negative delay to zero", () => {
    expect(computeDelayEmissions({ delayHours: -10 }).fuelTonnes).toBe(0);
  });

  it("defaults to VLSFO / tier_ii", () => {
    const e = computeDelayEmissions({ delayHours: 24 });
    expect(e.fuel).toBe("VLSFO");
    expect(e.engineTier).toBe("tier_ii");
  });
});

describe("buildCarbonCostOfDelay", () => {
  it("pairs demurrage with the footprint when an amount is given", () => {
    const r = buildCarbonCostOfDelay({
      delayHours: 48,
      demurrageAmount: 25000,
      currency: "USD",
      euaPriceEur: 75,
    });
    expect(r.headline).toContain("USD 25,000 in demurrage");
    expect(r.headline).toContain("tCO2");
    expect(r.headline).toContain("kg NOx");
    expect(r.headline).toContain("kg SOx");
    expect(r.etsCostEur).toBeGreaterThan(0);
    expect(r.evidence).toHaveLength(4);
  });

  it("stands as an emissions statement without a demurrage amount", () => {
    const r = buildCarbonCostOfDelay({ delayHours: 12 });
    expect(r.demurrageAmount).toBeNull();
    expect(r.headline).not.toContain("in demurrage");
    expect(r.headline).toContain("emitted");
  });

  it("uses the selected fuel's CO2 factor for the ETS cost", () => {
    const lng = buildCarbonCostOfDelay({ delayHours: 48, fuel: "LNG" });
    const mgo = buildCarbonCostOfDelay({ delayHours: 48, fuel: "MGO" });
    // LNG has a lower CO2 factor than MGO, so lower ETS cost for equal burn.
    expect(lng.etsCostEur).toBeLessThan(mgo.etsCostEur);
    expect(MARINE_FUELS.LNG.co2PerTonne).toBeLessThan(MARINE_FUELS.MGO.co2PerTonne);
  });
});
