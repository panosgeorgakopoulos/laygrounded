import { describe, expect, test } from "bun:test";
import {
  arbitrateSftw,
  buildMrvLedgerEntry,
  calculateBiofoulingPenalty,
  calculateCiiDegradation,
  ciiRatingFromRatio,
  computeGreenTwin,
  MaritimeCarbonEngine,
  seaConsumptionTpd,
  type ConsumptionCurve,
} from "./carbon";
import { Decimal } from "decimal.js";

// All money/EUA prices are passed explicitly: bun test auto-loads .env, so
// relying on defaultEuaPriceEur() would make expectations env-dependent.

const CURVE: ConsumptionCurve = {
  at_berth_aux_tonnes_per_day: 4,
  sea_curve: [{ speed_knots: 12, tonnes_per_day: 20 }],
};

describe("seaConsumptionTpd (cube law)", () => {
  test("doubling speed costs 8x fuel", () => {
    expect(seaConsumptionTpd(CURVE, 24).toNumber()).toBeCloseTo(160, 6);
  });
  test("anchor speed returns anchor consumption", () => {
    expect(seaConsumptionTpd(CURVE, 12).toNumber()).toBeCloseTo(20, 9);
  });
  test("nearest anchor wins on multi-point curves", () => {
    const curve: ConsumptionCurve = {
      at_berth_aux_tonnes_per_day: 4,
      sea_curve: [
        { speed_knots: 10, tonnes_per_day: 12 },
        { speed_knots: 14, tonnes_per_day: 30 },
      ],
    };
    // 13.5 kn anchors to the 14 kn point: 30 × (13.5/14)³
    expect(seaConsumptionTpd(curve, 13.5).toNumber()).toBeCloseTo(
      30 * Math.pow(13.5 / 14, 3),
      6
    );
  });
  test("rejects empty curve and non-positive speed", () => {
    expect(() => seaConsumptionTpd({ at_berth_aux_tonnes_per_day: 4, sea_curve: [] }, 12)).toThrow(
      "INVALID_CONSUMPTION_CURVE"
    );
    expect(() => seaConsumptionTpd(CURVE, 0)).toThrow("INVALID_SPEED");
  });
});

describe("ciiRatingFromRatio", () => {
  const cases: Array<[number, string]> = [
    [0.86, "A"],
    [0.8601, "B"],
    [0.94, "B"],
    [1.0, "C"],
    [1.06, "C"],
    [1.18, "D"],
    [1.181, "E"],
  ];
  for (const [ratio, want] of cases) {
    test(`${ratio} → ${want}`, () => {
      expect(ciiRatingFromRatio(new Decimal(ratio))).toBe(want);
    });
  }
});

describe("calculateCiiDegradation", () => {
  const baseCii = { attainedCii: 4.0, requiredCii: 4.5, dwt: 60_000, annualDistanceNm: 60_000 };

  test("10-day delay raises attained CII without crossing a band", () => {
    const r = calculateCiiDegradation({ delayHours: 240, baseCii, consumptionCurve: CURVE });
    expect(r.extraFuelTonnes).toBeCloseTo(40, 3);
    expect(r.extraCo2Tonnes).toBeCloseTo(124.56, 2);
    expect(r.attainedCiiAfter).toBeCloseTo(4.0346, 4);
    expect(r.ratingBefore).toBe("B");
    expect(r.ratingAfter).toBe("B");
    expect(r.ratingDropped).toBe(false);
    expect(r.carbonDowngradeLiabilityEur).toBe(0);
  });

  test("delay that crosses the B/C boundary emits a downgrade liability", () => {
    const r = calculateCiiDegradation({
      delayHours: 72,
      baseCii: { ...baseCii, attainedCii: 4.22 },
      consumptionCurve: CURVE,
    });
    expect(r.ratingBefore).toBe("B");
    expect(r.ratingAfter).toBe("C");
    expect(r.bandsDropped).toBe(1);
    expect(r.carbonDowngradeLiabilityEur).toBe(150_000);
    expect(r.evidence.some((e) => e.clause_ref === "CII-DOWNGRADE-LIABILITY")).toBe(true);
  });

  test("zero delay is a no-op", () => {
    const r = calculateCiiDegradation({ delayHours: 0, baseCii, consumptionCurve: CURVE });
    expect(r.extraFuelTonnes).toBe(0);
    expect(r.attainedCiiAfter).toBe(r.attainedCiiBefore);
    expect(r.ratingDropped).toBe(false);
  });

  test("deterministic for identical inputs", () => {
    const a = calculateCiiDegradation({ delayHours: 100, baseCii, consumptionCurve: CURVE });
    const b = calculateCiiDegradation({ delayHours: 100, baseCii, consumptionCurve: CURVE });
    expect(a).toEqual(b);
  });

  test("rejects an impossible baseline", () => {
    expect(() =>
      calculateCiiDegradation({
        delayHours: 24,
        baseCii: { ...baseCii, dwt: 0 },
        consumptionCurve: CURVE,
      })
    ).toThrow("INVALID_CII_BASELINE");
  });
});

describe("calculateBiofoulingPenalty", () => {
  const input = {
    portLabel: "Santos",
    idleDays: 20,
    seaSurfaceTempC: 25,
    consumptionCurve: {
      at_berth_aux_tonnes_per_day: 4,
      sea_curve: [{ speed_knots: 12.5, tonnes_per_day: 22 }],
    },
    serviceSpeedKnots: 12.5,
    fuelPriceUsdPerTonne: 620,
    euaPriceEur: 75,
  };

  test("warm-water idle predicts drag, fuel and a cleaning recommendation", () => {
    const r = calculateBiofoulingPenalty(input);
    // 20 days × 0.12 %/day × 2 (25°C doubles vs 15°C ref) = 4.8%
    expect(r.dragIncreasePct).toBeCloseTo(4.8, 6);
    // 22 tpd × 4.8% × 180 sea days
    expect(r.extraFuelTonnes).toBeCloseTo(190.08, 2);
    expect(r.extraFuelCostUsd).toBeCloseTo(117_849.6, 1);
    expect(r.extraCo2Tonnes).toBeCloseTo(591.909, 2);
    expect(r.etsLiabilityEur).toBeCloseTo(22_196.59, 1);
    expect(r.cleaningRecommended).toBe(true);
    expect(r.netSavingIfCleanedUsdEquivalent).toBeCloseTo(95_046.19, 1);
  });

  test("colder water grows fouling slower", () => {
    const warm = calculateBiofoulingPenalty(input);
    const cold = calculateBiofoulingPenalty({ ...input, seaSurfaceTempC: 5 });
    expect(cold.dragIncreasePct).toBeCloseTo(1.2, 6);
    expect(cold.dragIncreasePct).toBeLessThan(warm.dragIncreasePct);
  });

  test("zero idle days → zero penalty, no recommendation", () => {
    const r = calculateBiofoulingPenalty({ ...input, idleDays: 0 });
    expect(r.dragIncreasePct).toBe(0);
    expect(r.extraFuelTonnes).toBe(0);
    expect(r.cleaningRecommended).toBe(false);
  });

  test("drag is capped at the heavily-fouled ceiling", () => {
    const r = calculateBiofoulingPenalty({ ...input, idleDays: 400 });
    expect(r.dragIncreasePct).toBe(40);
  });
});

describe("arbitrateSftw", () => {
  const input = {
    distanceNm: 3000,
    actualSpeedKnots: 14,
    baseSpeedKnots: 12,
    congestionHours: 48,
    consumptionCurve: CURVE,
    fuelPriceUsdPerTonne: 620,
    euaPriceEur: 75,
  };

  test("sprint into a 48h queue wastes fuel and formats a restitution claim", () => {
    const r = arbitrateSftw(input);
    expect(r.detected).toBe(true);
    expect(r.jitSpeedKnots).toBeCloseTo(11.44, 2);
    expect(r.jitSpeedKnots).toBeLessThan(r.actualSpeedKnots);
    expect(r.wastedFuelTonnes).toBeGreaterThan(100);
    expect(r.wastedFuelTonnes).toBeLessThan(105);
    expect(r.restitutionClaim).not.toBeNull();
    expect(r.restitutionClaim!.amountUsd).toBeCloseTo(r.wastedFuelTonnes * 620, 0);
    expect(r.restitutionClaim!.basis.length).toBeGreaterThan(0);
  });

  test("no congestion → no waste, no claim", () => {
    const r = arbitrateSftw({ ...input, congestionHours: 0 });
    expect(r.wastedFuelTonnes).toBe(0);
    expect(r.detected).toBe(false);
    expect(r.restitutionClaim).toBeNull();
  });

  test("waits below the detection threshold are ordinary port friction", () => {
    const r = arbitrateSftw({ ...input, congestionHours: 4 });
    expect(r.detected).toBe(false);
    expect(r.restitutionClaim).toBeNull();
  });

  test("exceeding charterer speed orders is cited in evidence", () => {
    const r = arbitrateSftw({ ...input, chartererOrders: { orderedSpeedKnots: 12 } });
    expect(r.evidence.some((e) => e.clause_ref === "CP-SPEED-ORDERS")).toBe(true);
  });

  test("rejects impossible geometry", () => {
    expect(() => arbitrateSftw({ ...input, distanceNm: 0 })).toThrow("INVALID_SFTW_INPUT");
  });
});

describe("buildMrvLedgerEntry", () => {
  test("24h delay at the documented defaults", () => {
    const e = buildMrvLedgerEntry({ delayHours: 24, euaPriceEur: 75 });
    expect(e.entry_kind).toBe("mrv_ets");
    expect(e.details.fuel_tonnes).toBeCloseTo(4, 3);
    expect(e.mrv_co2_tonnes).toBeCloseTo(12.456, 3);
    expect(e.scope3_co2_tonnes).toBeCloseTo(3.104, 3);
    expect(e.eua_liability_eur).toBeCloseTo(934.2, 1);
    expect(e.evidence).toHaveLength(3);
  });
});

describe("computeGreenTwin", () => {
  test("aggregates levers ranked by avoidable cost", () => {
    const sftw = arbitrateSftw({
      distanceNm: 3000,
      actualSpeedKnots: 14,
      baseSpeedKnots: 12,
      congestionHours: 48,
      consumptionCurve: CURVE,
      fuelPriceUsdPerTonne: 620,
      euaPriceEur: 75,
    });
    const mrv = buildMrvLedgerEntry({ delayHours: 24, euaPriceEur: 75 });
    const twin = computeGreenTwin({ sftw, mrv });
    expect(twin.levers).toHaveLength(2);
    expect(twin.levers[0].lever).toBe("eliminate_sftw_sprint");
    expect(twin.totalAvoidableCo2Tonnes).toBeCloseTo(
      sftw.wastedCo2Tonnes + mrv.mrv_co2_tonnes,
      3
    );
  });

  test("empty input → empty twin", () => {
    const twin = computeGreenTwin({});
    expect(twin.levers).toHaveLength(0);
    expect(twin.totalAvoidableCo2Tonnes).toBe(0);
  });
});

describe("MaritimeCarbonEngine facade", () => {
  test("constructor overrides flow into methods but explicit inputs win", () => {
    const engine = new MaritimeCarbonEngine({ downgradeLiabilityEurPerBand: 999_999 });
    const r = engine.calculateCiiDegradation({
      delayHours: 72,
      baseCii: { attainedCii: 4.22, requiredCii: 4.5, dwt: 60_000, annualDistanceNm: 60_000 },
      consumptionCurve: CURVE,
    });
    expect(r.carbonDowngradeLiabilityEur).toBe(999_999);

    const explicit = engine.calculateCiiDegradation({
      delayHours: 72,
      baseCii: { attainedCii: 4.22, requiredCii: 4.5, dwt: 60_000, annualDistanceNm: 60_000 },
      consumptionCurve: CURVE,
      downgradeLiabilityEurPerBand: 1,
    });
    expect(explicit.carbonDowngradeLiabilityEur).toBe(1);
  });
});
