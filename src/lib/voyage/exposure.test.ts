import { describe, expect, test } from "bun:test";
import {
  computeLiveExposure,
  exposureAlert,
  alertThresholds,
  APPROACHING_THRESHOLD_HOURS,
  IMMINENT_THRESHOLD_HOURS,
  type ExposureAlertLevel,
  type ExposureInput,
  type ExposureState,
} from "./exposure";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

// A deliberately simple regime: SHINC means no excepted days, so laytime
// accrues one hour per elapsed hour and the arithmetic in these tests can be
// checked by hand. Fixtures that need weather use WWDSHEX-EIU — under SHINC a
// weather pair is inert (see the engine's days-basis handling), and a test that
// asserted otherwise would be asserting nothing.
const TERMS: CpTerms = {
  laytime_allowed_hours: 72,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "SHINC",
  demurrage_rate: 24_000, // per day → 1000/hour
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "UTC",
};

function ev(id: string, type: SofEventInput["event_type"], at: string): SofEventInput {
  return { id, occurred_at: at, event_type: type };
}

// NOR at 00:00 on the 1st, +6h turn time → laytime commences 06:00.
// Allowance of 72h is therefore exhausted at 06:00 on the 4th.
const NOR = ev("e1", "NOR_TENDERED", "2026-03-01T00:00:00Z");
const COMMENCED = ev("e2", "COMMENCED_LOADING", "2026-03-01T08:00:00Z");

function input(over: Partial<ExposureInput> = {}): ExposureInput {
  return {
    events: [NOR, COMMENCED],
    terms: TERMS,
    now: "2026-03-02T06:00:00Z",
    ...over,
  };
}

describe("computeLiveExposure — state machine", () => {
  const cases: Array<{
    name: string;
    now: string;
    expectedState: ExposureState;
  }> = [
    { name: "before laytime commences", now: "2026-03-01T03:00:00Z", expectedState: "laytime_running" },
    { name: "mid-allowance", now: "2026-03-02T06:00:00Z", expectedState: "laytime_running" },
    { name: "exactly at exhaustion", now: "2026-03-04T06:00:00Z", expectedState: "demurrage_accruing" },
    { name: "past exhaustion", now: "2026-03-05T06:00:00Z", expectedState: "demurrage_accruing" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(computeLiveExposure(input({ now: c.now })).state).toBe(c.expectedState);
    });
  }

  test("no NOR reports not_started with a named reason, never a zero figure passed off as fact", () => {
    const snap = computeLiveExposure(input({ events: [COMMENCED] }));
    expect(snap.state).toBe("not_started");
    expect(snap.unavailableReason).toBe("NOR_NOT_TENDERED");
    expect(snap.laytimeExhaustedAt).toBeNull();
  });

  test("a real completion event yields the authoritative calculation, not a projection", () => {
    const events = [NOR, COMMENCED, ev("e3", "COMPLETED_LOADING", "2026-03-03T06:00:00Z")];
    const snap = computeLiveExposure(input({ events, now: "2026-03-09T00:00:00Z" }));
    expect(snap.state).toBe("completed");
    expect(snap.projection).toBeNull();
    expect(snap.laytimeExhaustedAt).toBeNull();
    // Agrees exactly with the engine run the rest of the app stores.
    expect(snap.usedHours).toBeCloseTo(recomputeLaytime(events, TERMS).totals.used_hours, 6);
  });
});

describe("computeLiveExposure — accrual", () => {
  test("used hours equal elapsed hours since commencement under SHINC", () => {
    // Commences 06:00 on the 1st; at 06:00 on the 2nd exactly 24h have run.
    const snap = computeLiveExposure(input({ now: "2026-03-02T06:00:00Z" }));
    expect(snap.usedHours).toBe(24);
    expect(snap.remainingHours).toBe(48);
    expect(snap.percentConsumed).toBeCloseTo(33.33, 1);
    expect(snap.accruedDemurrage).toBe(0);
  });

  test("demurrage accrues at the daily rate pro-rata once the allowance is gone", () => {
    // 24h past exhaustion at 24,000/day → 24,000 accrued.
    const snap = computeLiveExposure(input({ now: "2026-03-05T06:00:00Z" }));
    expect(snap.onDemurrageHours).toBe(24);
    expect(snap.accruedDemurrage).toBeCloseTo(24_000, 2);
    expect(snap.remainingHours).toBe(0);
  });

  test("the snapshot agrees with the engine run for the same cut-off", () => {
    const now = "2026-03-03T12:00:00Z";
    const snap = computeLiveExposure(input({ now }));
    const direct = recomputeLaytime(
      [NOR, COMMENCED, ev("x", "COMPLETED_LOADING", now)],
      TERMS
    ).totals;
    expect(snap.usedHours).toBeCloseTo(direct.used_hours, 6);
    expect(snap.accruedDemurrage).toBeCloseTo(direct.demurrage_amount, 6);
  });
});

describe("computeLiveExposure — exhaustion forecast", () => {
  test("finds the exhaustion instant to the minute", () => {
    const snap = computeLiveExposure(input({ now: "2026-03-02T06:00:00Z" }));
    expect(snap.laytimeExhaustedAt).not.toBeNull();
    const found = new Date(snap.laytimeExhaustedAt!).getTime();
    const expected = new Date("2026-03-04T06:00:00Z").getTime();
    expect(Math.abs(found - expected)).toBeLessThanOrEqual(60_000);
  });

  test("is null once already on demurrage — the answer is 'already'", () => {
    expect(computeLiveExposure(input({ now: "2026-03-05T06:00:00Z" })).laytimeExhaustedAt).toBeNull();
  });

  test("excepted days push exhaustion later than a linear extrapolation would", () => {
    // SHEX excludes Sundays. 2026-03-01 is a Sunday, so a SHEX voyage must
    // exhaust strictly later than the SHINC equivalent — this is the case a
    // naive "remaining ÷ rate" projection gets wrong.
    const shex = computeLiveExposure(
      input({ terms: { ...TERMS, days_basis: "SHEX" }, now: "2026-03-02T06:00:00Z" })
    );
    const shinc = computeLiveExposure(input({ now: "2026-03-02T06:00:00Z" }));
    expect(shex.laytimeExhaustedAt).not.toBeNull();
    expect(new Date(shex.laytimeExhaustedAt!).getTime()).toBeGreaterThan(
      new Date(shinc.laytimeExhaustedAt!).getTime()
    );
  });

  test("returns null when the allowance is not reached inside the search horizon", () => {
    const snap = computeLiveExposure(
      input({ terms: { ...TERMS, laytime_allowed_hours: 100_000 } })
    );
    expect(snap.laytimeExhaustedAt).toBeNull();
    expect(snap.state).toBe("laytime_running");
  });
});

describe("computeLiveExposure — projection", () => {
  test("prices a projected completion through the engine", () => {
    const snap = computeLiveExposure(
      input({ now: "2026-03-02T06:00:00Z", projectedCompletionAt: "2026-03-06T06:00:00Z" })
    );
    expect(snap.projection).not.toBeNull();
    // Completion 48h past exhaustion → 48h demurrage at 1000/h.
    expect(snap.projection!.projectedDemurrageHours).toBe(48);
    expect(snap.projection!.projectedDemurrage).toBeCloseTo(48_000, 2);
    expect(snap.projection!.projectedNet).toBeCloseTo(48_000, 2);
  });

  test("a projection earlier than the allowance yields despatch and a negative net", () => {
    const snap = computeLiveExposure(
      input({ now: "2026-03-01T12:00:00Z", projectedCompletionAt: "2026-03-02T06:00:00Z" })
    );
    expect(snap.projection!.projectedDemurrage).toBe(0);
    expect(snap.projection!.projectedDespatch).toBeGreaterThan(0);
    expect(snap.projection!.projectedNet).toBeLessThan(0);
  });

  test("a stale ETA in the past is dropped rather than shown as a forecast", () => {
    const snap = computeLiveExposure(
      input({ now: "2026-03-05T00:00:00Z", projectedCompletionAt: "2026-03-02T00:00:00Z" })
    );
    expect(snap.projection).toBeNull();
  });

  test("absent ETA yields no projection — none is invented", () => {
    expect(computeLiveExposure(input()).projection).toBeNull();
  });
});

describe("exposureAlert", () => {
  // With a 72h allowance the bands land at 25.2h (approaching) and 10.8h
  // (imminent) remaining — see alertThresholds.
  const cases: Array<{ name: string; now: string; level: ExposureAlertLevel }> = [
    { name: "comfortable", now: "2026-03-01T07:00:00Z", level: "none" },
    { name: "approaching", now: "2026-03-03T08:00:00Z", level: "approaching" },
    { name: "imminent", now: "2026-03-03T22:00:00Z", level: "imminent" },
    { name: "on demurrage", now: "2026-03-05T06:00:00Z", level: "on_demurrage" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(exposureAlert(computeLiveExposure(input({ now: c.now }))).level).toBe(c.level);
    });
  }

  test("thresholds bracket as documented", () => {
    expect(IMMINENT_THRESHOLD_HOURS).toBeLessThan(APPROACHING_THRESHOLD_HOURS);
    const b = alertThresholds(72);
    expect(b.imminent).toBeLessThan(b.approaching);
  });

  test("a short fixture is not permanently 'approaching'", () => {
    // The bug the share-based band exists to prevent: with a flat 72h band, a
    // 72h allowance alerts from its very first hour.
    expect(exposureAlert(computeLiveExposure(input({ now: "2026-03-01T07:00:00Z" }))).level).toBe(
      "none"
    );
  });

  test("bands scale with the allowance rather than staying absolute", () => {
    const short = alertThresholds(24);
    const long = alertThresholds(30 * 24);
    expect(short.approaching).toBeCloseTo(8.4, 6); // 35% of 24h
    expect(long.approaching).toBe(APPROACHING_THRESHOLD_HOURS); // capped
    expect(long.imminent).toBe(IMMINENT_THRESHOLD_HOURS);
  });

  test("an on-demurrage alert names the money already exposed", () => {
    const alert = exposureAlert(computeLiveExposure(input({ now: "2026-03-05T06:00:00Z" })));
    expect(alert.headline).toContain("USD");
    expect(alert.headline).toContain("24,000");
  });

  test("a not_started snapshot raises nothing", () => {
    expect(exposureAlert(computeLiveExposure(input({ events: [COMMENCED] }))).level).toBe("none");
  });
});

describe("determinism", () => {
  test("repeated computation is byte-identical", () => {
    const a = computeLiveExposure(input({ projectedCompletionAt: "2026-03-06T00:00:00Z" }));
    const b = computeLiveExposure(input({ projectedCompletionAt: "2026-03-06T00:00:00Z" }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("event input order does not change the result", () => {
    const forward = computeLiveExposure(input({ events: [NOR, COMMENCED] }));
    const reversed = computeLiveExposure(input({ events: [COMMENCED, NOR] }));
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  test("the synthetic cut-off event never leaks into the caller's array", () => {
    const events = [NOR, COMMENCED];
    computeLiveExposure(input({ events }));
    expect(events).toHaveLength(2);
  });
});
