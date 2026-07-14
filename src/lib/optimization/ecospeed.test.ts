import { describe, expect, test } from "bun:test";
import { calculateOptimalArrivalSpeed, type EcoSpeedInput } from "./ecospeed";
import type { ConsumptionCurve } from "@/lib/compliance/carbon";

// Single-anchor curve: cons(v) = 20 × (v/12)³ t/d, aux 4 t/d — every figure
// below is hand-computable. All prices explicit (bun test loads .env; the
// expectations must not depend on it).
const CURVE: ConsumptionCurve = {
  at_berth_aux_tonnes_per_day: 4.0,
  sea_curve: [{ speed_knots: 12, tonnes_per_day: 20 }],
};

const base = (overrides: Partial<EcoSpeedInput> = {}): EcoSpeedInput => ({
  telemetry: { currentSpeedKnots: 14, distanceToPortNm: 1680, predictedCongestionDelayHours: 72 },
  consumptionCurve: CURVE,
  demurrageRatePerDay: 24_000,
  nowISO: "2026-07-01T00:00:00Z",
  fuelPriceUsdPerTonne: 600,
  euaPriceEur: 80,
  eurUsd: 1.05,
  minSpeedKnots: 8,
  maxSpeedKnots: 16,
  speedStepKnots: 1,
  ...overrides,
});

describe("calculateOptimalArrivalSpeed", () => {
  test("recommends slowing into a known queue (just-in-time arrival)", () => {
    const r = calculateOptimalArrivalSpeed(base());
    // At 14 kn: 120h steaming, 158.796 t, $95,277.78 fuel; the 72h queue has
    // long cleared, so the only way to save is to stop sprinting.
    expect(r.current.steamingHours).toBe(120);
    expect(r.current.fuelTonnes).toBeCloseTo(158.796, 2);
    expect(r.current.fuelCostUsd).toBeCloseTo(95_277.78, 1);
    expect(r.current.waitingHours).toBe(0);
    // 8 kn: 210h, 51.852 t, $31,111.11 fuel — cheapest of the whole grid.
    expect(r.action).toBe("decrease_speed");
    expect(r.optimal.speedKnots).toBe(8);
    expect(r.optimal.fuelTonnes).toBeCloseTo(51.852, 2);
    expect(r.optimal.fuelCostUsd).toBeCloseTo(31_111.11, 1);
    expect(r.netSavingUsd).toBeCloseTo(78_153.71, 0);
    expect(r.recommendation).toContain("Reduce speed to 8 kn");
    // Slow-steaming needs charterer cover.
    expect(r.evidence.some((e) => e.clause_ref === "CP-UTMOST-DESPATCH")).toBe(true);
  });

  test("prices waiting: aux fuel, at-berth ETS and demurrage exposure", () => {
    const r = calculateOptimalArrivalSpeed(
      base({
        telemetry: { currentSpeedKnots: 14, distanceToPortNm: 480, predictedCongestionDelayHours: 96 },
        laytimeBufferHours: 24,
      })
    );
    // 480/14 = 34.29h steaming → 61.71h at anchor; 37.71h beyond the buffer.
    expect(r.current.waitingHours).toBeCloseTo(61.71, 2);
    expect(r.current.demurrageExposureUsd).toBeCloseTo(37_714.29, 1);
    // Waiting burns 61.71/24 × 4 t aux = 10.286 t → $6,171.43 fuel plus
    // 10.286 × 3.114 × 1.0 × 80 × 1.05 = $2,690.28 ETS.
    expect(r.current.waitingCostUsd).toBeCloseTo(8_861.71, 0);
    // Slowing to 8 kn (60h steaming) still waits 36h but pays 12h demurrage.
    expect(r.action).toBe("decrease_speed");
    expect(r.optimal.speedKnots).toBe(8);
    expect(r.optimal.waitingHours).toBe(36);
    expect(r.optimal.demurrageExposureUsd).toBe(12_000);
  });

  test("recommends speeding up when the laycan is otherwise lost", () => {
    const r = calculateOptimalArrivalSpeed(
      base({
        telemetry: { currentSpeedKnots: 11, distanceToPortNm: 1680, predictedCongestionDelayHours: 0 },
        cancellingAt: "2026-07-06T12:00:00Z", // 132h from now
        fixtureLossUsd: 500_000,
      })
    );
    // 11 kn arrives in 152.7h — cancelled. 13 kn arrives in 129.2h and is the
    // cheapest speed that makes the date.
    expect(r.current.laycanMissed).toBe(true);
    expect(r.current.laycanPenaltyUsd).toBe(500_000);
    expect(r.action).toBe("increase_speed");
    expect(r.optimal.speedKnots).toBe(13);
    expect(r.optimal.laycanMissed).toBe(false);
    expect(r.optimal.steamingHours).toBeCloseTo(129.23, 2);
    expect(r.netSavingUsd).toBeGreaterThan(400_000);
    expect(r.recommendation).toContain("Increase speed to 13 kn");
    expect(
      r.evidence.some((e) => e.clause_ref === "CP-LAYCAN-CANCELLING" && e.finding.includes("before the cancelling date"))
    ).toBe(true);
  });

  test("maintains speed when already at the optimum", () => {
    const r = calculateOptimalArrivalSpeed(
      base({
        telemetry: { currentSpeedKnots: 8, distanceToPortNm: 1680, predictedCongestionDelayHours: 0 },
        minSpeedKnots: 8,
        maxSpeedKnots: 8,
      })
    );
    expect(r.action).toBe("maintain_speed");
    expect(r.netSavingUsd).toBe(0);
    expect(r.recommendation).toContain("Maintain 8 kn");
  });

  test("is deterministic for identical inputs", () => {
    expect(calculateOptimalArrivalSpeed(base())).toEqual(calculateOptimalArrivalSpeed(base()));
  });

  test("rejects invalid telemetry and speed ranges", () => {
    expect(() =>
      calculateOptimalArrivalSpeed(
        base({ telemetry: { currentSpeedKnots: 14, distanceToPortNm: 0, predictedCongestionDelayHours: 0 } })
      )
    ).toThrow("INVALID_TELEMETRY");
    expect(() => calculateOptimalArrivalSpeed(base({ nowISO: "not a date" }))).toThrow(
      "INVALID_TELEMETRY"
    );
    expect(() =>
      calculateOptimalArrivalSpeed(base({ minSpeedKnots: 12, maxSpeedKnots: 10 }))
    ).toThrow("INVALID_SPEED_RANGE");
    expect(() =>
      calculateOptimalArrivalSpeed(
        base({ consumptionCurve: { at_berth_aux_tonnes_per_day: 4, sea_curve: [] } })
      )
    ).toThrow("INVALID_CONSUMPTION_CURVE");
  });
});
