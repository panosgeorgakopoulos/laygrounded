import { describe, expect, test } from "bun:test";
import {
  planVirtualArrival,
  QUEUE_BAND,
  type VirtualArrivalInput,
} from "@/lib/optimization/virtual-arrival";
import type { ConsumptionCurve } from "@/lib/compliance/carbon";
import type { DataProvenance } from "@/lib/risk/provenance";

const CURVE: ConsumptionCurve = {
  sea_curve: [
    { speed_knots: 10, tonnes_per_day: 14 },
    { speed_knots: 12, tonnes_per_day: 22 },
    { speed_knots: 14, tonnes_per_day: 34 },
  ],
  at_berth_aux_tonnes_per_day: 4,
} as ConsumptionCurve;

const LIVE: DataProvenance = {
  source: "live",
  provider: "datalastic",
  observedAt: "2026-09-01T00:00:00.000Z",
  label: "Live AIS",
};

/** A heavy-tailed queue: most berth quickly, a few wait days. */
const HEAVY_TAIL = [0, 1, 2, 4, 6, 9, 14, 22, 40, 96];

function input(overrides: Partial<VirtualArrivalInput> = {}): VirtualArrivalInput {
  return {
    telemetry: { currentSpeedKnots: 13, distanceToPortNm: 600 },
    consumptionCurve: CURVE,
    demurrageRatePerDay: 24000,
    nowISO: "2026-09-01T00:00:00.000Z",
    queue: {
      waitingHoursSorted: HEAVY_TAIL,
      vesselsAtAnchorage: 10,
      observedAt: "2026-09-01T00:00:00.000Z",
      provenance: LIVE,
    },
    ...overrides,
  } as VirtualArrivalInput;
}

describe("queue statistic", () => {
  test("uses the MEDIAN by default, not the mean", () => {
    // The whole point: mean of HEAVY_TAIL is 19.4, median is 7.5. Using the
    // mean would overstate the queue and bias every plan toward slowing down.
    const r = planVirtualArrival(input());
    const mean = HEAVY_TAIL.reduce((a, b) => a + b, 0) / HEAVY_TAIL.length;
    expect(r.queueHours).toBeCloseTo(7.5, 1);
    expect(r.queueHours).toBeLessThan(mean);
    expect(r.queuePercentile).toBe(0.5);
  });

  test("honours an explicit percentile", () => {
    const conservative = planVirtualArrival(input({ queuePercentile: 0.9 }));
    expect(conservative.queueHours).toBeGreaterThan(
      planVirtualArrival(input({ queuePercentile: 0.5 })).queueHours
    );
  });

  test("reports the spread so the point estimate is not mistaken for certainty", () => {
    const r = planVirtualArrival(input());
    expect(r.queueSpread.p25).toBeLessThanOrEqual(r.queueSpread.p50);
    expect(r.queueSpread.p50).toBeLessThanOrEqual(r.queueSpread.p75);
    expect(r.queueSpread.p75).toBeLessThanOrEqual(r.queueSpread.p90);
    expect(r.observationCount).toBe(HEAVY_TAIL.length);
  });

  test("the caveat names the statistic and why", () => {
    const r = planVirtualArrival(input());
    expect(r.caveats.some((c) => c.includes("heavy-tailed"))).toBe(true);
    expect(r.caveats.some((c) => c.includes("P50"))).toBe(true);
  });
});

describe("the congestion feed actually drives the answer", () => {
  test("a longer queue makes slow steaming more attractive", () => {
    const quiet = planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [0, 0, 1, 1, 2] } })
    );
    const congested = planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [60, 70, 80, 90, 120] } })
    );
    // With a long queue ahead, arriving early only burns anchorage fuel.
    expect(congested.recommendation.optimal.speedKnots).toBeLessThanOrEqual(
      quiet.recommendation.optimal.speedKnots
    );
  });

  test("a congested port yields real fuel and carbon savings", () => {
    const r = planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [60, 70, 80, 90, 120] } })
    );
    expect(r.savings.fuelTonnes).toBeGreaterThan(0);
    expect(r.savings.totalUsd).toBeGreaterThanOrEqual(0);
    expect(r.savings.co2Tonnes).toBeGreaterThanOrEqual(0);
    expect(r.recommendation.action).toBe("decrease_speed");
  });

  test("an empty berth does not invent a saving", () => {
    const r = planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [0, 0, 0, 0, 0] } })
    );
    expect(r.queueHours).toBe(0);
    // Nothing to wait for, so slowing buys nothing the optimiser values.
    expect(r.savings.totalUsd).toBeGreaterThanOrEqual(0);
  });
});

describe("robustness across queue uncertainty", () => {
  test("evaluates the whole band", () => {
    const r = planVirtualArrival(input());
    expect(r.sensitivity.map((s) => s.percentile)).toEqual([...QUEUE_BAND]);
    // Queue hours rise monotonically across the band.
    for (let i = 1; i < r.sensitivity.length; i++) {
      expect(r.sensitivity[i].queueHours).toBeGreaterThanOrEqual(r.sensitivity[i - 1].queueHours);
    }
  });

  test("a uniformly congested port gives a robust action", () => {
    const r = planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [70, 75, 80, 85, 90] } })
    );
    expect(r.actionRobust).toBe(true);
    expect(new Set(r.sensitivity.map((s) => s.action)).size).toBe(1);
  });

  test("a flip across the band is flagged rather than hidden", () => {
    // A queue spanning "berth is free" to "two days" can genuinely change the
    // instruction. If it does, the caveat must say so.
    const r = planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [0, 0, 1, 40, 60] } })
    );
    if (!r.actionRobust) {
      expect(r.caveats.some((c) => c.includes("NOT stable"))).toBe(true);
    }
    // Either way the band is reported, so the reader can see it themselves.
    expect(r.sensitivity).toHaveLength(QUEUE_BAND.length);
  });
});

describe("provenance and refusals", () => {
  test("a mock queue is flagged and must not reach a master", () => {
    const r = planVirtualArrival(
      input({
        queue: {
          ...input().queue,
          provenance: { ...LIVE, source: "mock", provider: "laygrounded-mock-ais" },
        },
      })
    );
    expect(r.provenance.source).toBe("mock");
    expect(r.caveats.some((c) => c.includes("SYNTHETIC QUEUE"))).toBe(true);
  });

  test("no observations is an error, not a free berth", () => {
    // Defaulting an unmeasurable queue to zero would tell the master to keep
    // steaming into an unknown port — the expensive direction to be wrong in.
    expect(() =>
      planVirtualArrival(input({ queue: { ...input().queue, waitingHoursSorted: [] } }))
    ).toThrow("NO_QUEUE_OBSERVATIONS");
  });

  test("a thin sample is called out", () => {
    const r = planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [12, 18] } })
    );
    expect(r.caveats.some((c) => c.includes("coarse"))).toBe(true);
  });

  test("bad telemetry still surfaces the optimiser's own refusal", () => {
    expect(() =>
      planVirtualArrival(input({ telemetry: { currentSpeedKnots: 0, distanceToPortNm: 600 } }))
    ).toThrow("INVALID_TELEMETRY");
  });
});

describe("determinism", () => {
  test("the same inputs give the same plan", () => {
    expect(JSON.stringify(planVirtualArrival(input()))).toBe(
      JSON.stringify(planVirtualArrival(input()))
    );
  });
});

describe("sign conventions — the footgun", () => {
  // `ecospeed` mixes two conventions in one object: netSavingUsd is
  // current−optimal (positive = saving) while deltaFuelUsd/deltaEtsUsd are
  // optimal−current (negative = saving). Publishing the raw deltas under the
  // word "savings" shows a fuel saving as a negative number and a carbon
  // saving as negative tonnes. These pin the corrected orientation.
  const congested = () =>
    planVirtualArrival(
      input({ queue: { ...input().queue, waitingHoursSorted: [60, 70, 80, 90, 120] } })
    );

  test("slowing down reports POSITIVE fuel, ETS and CO2 savings", () => {
    const r = congested();
    expect(r.recommendation.action).toBe("decrease_speed");
    expect(r.savings.fuelTonnes).toBeGreaterThan(0);
    expect(r.savings.fuelUsd).toBeGreaterThan(0);
    expect(r.savings.etsUsd).toBeGreaterThan(0);
    expect(r.savings.co2Tonnes).toBeGreaterThan(0);
    expect(r.savings.totalUsd).toBeGreaterThanOrEqual(0);
  });

  test("the published saving is the negation of the raw delta", () => {
    const r = congested();
    expect(r.savings.fuelUsd).toBeCloseTo(-r.recommendation.deltaFuelUsd, 2);
    expect(r.savings.etsUsd).toBeCloseTo(-r.recommendation.deltaEtsUsd, 2);
  });

  test("totalUsd is NOT negated — it already points the right way upstream", () => {
    const r = congested();
    expect(r.savings.totalUsd).toBe(r.recommendation.netSavingUsd);
  });

  test("CO2 tonnage reconciles with the ETS money beside it", () => {
    const r = congested();
    const { euaPriceEur, eurUsd } = r.recommendation.assumptions;
    expect(r.savings.co2Tonnes).toBeCloseTo(r.savings.etsUsd / (euaPriceEur * eurUsd), 2);
  });

  test("the sensitivity band uses the same orientation", () => {
    const r = congested();
    for (const s of r.sensitivity) {
      if (s.action === "decrease_speed") expect(s.etsSavedUsd).toBeGreaterThanOrEqual(0);
    }
  });
});
