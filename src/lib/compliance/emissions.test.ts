import { describe, it, expect } from "bun:test";
import {
  computeDelayEmissions,
  buildCarbonCostOfDelay,
  FULLY_PHASED_IN_YEAR,
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

describe("EU-ETS scope is applied, not assumed", () => {
  // Regression guard for a real bug: the EUA figure was computed at a flat
  // 100% coverage regardless of geography, so every non-EEA delay was billed a
  // liability that does not exist. Two of the five live claims are Australian.

  it("a non-EEA berth carries NO EUA liability", () => {
    const r = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: false, year: 2026 });
    expect(r.etsCostEur).toBe(0);
    expect(r.etsScope.share).toBe(0);
    expect(r.etsScope.scopeCertain).toBe(true);
    expect(r.headline).toContain("no EU-ETS liability");
    // The emissions themselves are unchanged — the fuel still burned.
    expect(r.emissions.co2Tonnes).toBeGreaterThan(0);
  });

  it("an EEA berth in the fully phased-in era carries the full liability", () => {
    const r = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: true, year: 2026 });
    expect(r.etsCostEur).toBeGreaterThan(0);
    expect(r.etsScope.share).toBe(1);
    expect(r.etsScope.scopeCertain).toBe(true);
  });

  it("phase-in scales the liability by year", () => {
    const y2024 = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: true, year: 2024 });
    const y2025 = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: true, year: 2025 });
    const y2026 = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: true, year: 2026 });

    expect(y2024.etsCostEur).toBeLessThan(y2025.etsCostEur);
    expect(y2025.etsCostEur).toBeLessThan(y2026.etsCostEur);
    // 40% / 70% / 100% of the same emissions.
    expect(y2024.etsCostEur).toBeCloseTo(y2026.etsCostEur * 0.4, 1);
    expect(y2025.etsCostEur).toBeCloseTo(y2026.etsCostEur * 0.7, 1);
  });

  it("before 2024 shipping was outside the ETS entirely", () => {
    const r = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: true, year: 2023 });
    expect(r.etsCostEur).toBe(0);
  });

  it("an UNKNOWN port is flagged uncertain, never silently treated as EEA", () => {
    const r = buildCarbonCostOfDelay({ delayHours: 72, year: 2026 });
    expect(r.etsScope.scopeCertain).toBe(false);
    // Shown as potential exposure so nobody invoices it as settled.
    expect(r.headline).toContain("IF this is an EEA call");
    expect(r.etsScope.note).toContain("unknown");
  });

  it("the evidence line states the scope rather than asserting 100%", () => {
    const nonEea = buildCarbonCostOfDelay({ delayHours: 72, eeaPort: false, year: 2026 });
    const line = nonEea.evidence.find((e) => e.clause_ref.startsWith("EU-ETS"))!;
    expect(line.finding).toContain("No EUA surrender liability");
    expect(line.finding).not.toContain("100%");
  });

  it("the year default is a constant, so the same delay never reprices on New Year", () => {
    const a = buildCarbonCostOfDelay({ delayHours: 48, eeaPort: true });
    const b = buildCarbonCostOfDelay({ delayHours: 48, eeaPort: true, year: FULLY_PHASED_IN_YEAR });
    expect(a.etsCostEur).toBe(b.etsCostEur);
    expect(Number.isFinite(a.etsCostEur)).toBe(true);
    expect(a.etsScope.note).not.toContain("NaN");
  });
});
