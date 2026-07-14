import { describe, expect, test } from "bun:test";
import { buildRoiReport, ROI_WINDOW_MONTHS, type RoiClaimInput } from "./roi";
import { DEFAULT_CP_TERMS } from "@/lib/laytime/types";

const NOW = new Date("2026-07-14T00:00:00Z");

const CP = { ...DEFAULT_CP_TERMS, laytime_allowed_hours: 48, port_timezone: "UTC" };

// A realistic port call: ~5 days, long enough to go on demurrage against a
// 48h allowance, spanning a Sunday (2026-03-01) so the days basis bites.
// Voyages are days, not months — the engine caps its hourly walk at 1440
// iterations, so a fixture spanning months would throw CALCULATION_TIMEOUT
// and prove nothing about the report.
function voyage(opts: { weather?: boolean; startAt?: string; completedAt?: string } = {}) {
  const start = new Date(opts.startAt ?? "2026-02-27T08:00:00Z").getTime();
  const h = (n: number) => new Date(start + n * 3600_000).toISOString();
  const events: RoiClaimInput["events"] = [
    { id: "e1", event_type: "NOR_TENDERED", occurred_at: h(0) },
    { id: "e2", event_type: "BERTHED", occurred_at: h(4) },
    { id: "e3", event_type: "ALL_FAST", occurred_at: h(5) },
    { id: "e4", event_type: "COMMENCED_LOADING", occurred_at: h(6) },
  ] as RoiClaimInput["events"];
  if (opts.weather) {
    events.push(
      { id: "w1", event_type: "WEATHER_DELAY", occurred_at: h(22) },
      { id: "w2", event_type: "WEATHER_DELAY_END", occurred_at: h(34) }
    );
  }
  events.push({
    id: "e5",
    event_type: "COMPLETED_LOADING",
    occurred_at: opts.completedAt ?? h(122),
  } as RoiClaimInput["events"][number]);
  return events;
}

// Same port call, shifted so completion lands on `completedAt`.
function voyageCompletingAt(completedAt: string, weather = false) {
  const start = new Date(new Date(completedAt).getTime() - 122 * 3600_000).toISOString();
  return voyage({ startAt: start, completedAt, weather });
}

function claim(over: Partial<RoiClaimInput> = {}): RoiClaimInput {
  return {
    claimId: "c1",
    vessel: "MV TEST",
    voyageRef: "V-1",
    port: "Rotterdam",
    timeBarDays: 90,
    cpTerms: { ...CP, days_basis: "WWDSHEX-EIU" } as RoiClaimInput["cpTerms"],
    events: voyage(),
    contradictedWeatherEventIds: [],
    settledAt: null,
    hasSofDocument: true,
    hasCalculation: true,
    ...over,
  };
}

describe("buildRoiReport — disputed weather", () => {
  test("prices only the contradicted window, as money the owner regains", () => {
    const r = buildRoiReport(
      [
        claim({
          // WWD basis: weather actually stops the clock, so striking it moves money.
          cpTerms: { ...CP, days_basis: "WWDSHEX-EIU" } as RoiClaimInput["cpTerms"],
          events: voyage({ weather: true }),
          contradictedWeatherEventIds: ["w1"],
        }),
      ],
      NOW
    );
    expect(r.disputedWeather.claimCount).toBe(1);
    const f = r.disputedWeather.findings[0];
    expect(f.windowCount).toBe(1);
    // Striking a disproven stoppage gives the owner back demurrage.
    expect(f.recoverable).toBeGreaterThan(0);
    expect(r.disputedWeather.totals[0]).toEqual({ currency: "USD", amount: f.recoverable });
  });

  test("ignores weather that no evidence check contradicts", () => {
    const r = buildRoiReport(
      [claim({ events: voyage({ weather: true }), contradictedWeatherEventIds: [] })],
      NOW
    );
    expect(r.disputedWeather.claimCount).toBe(0);
    expect(r.disputedWeather.totals).toEqual([]);
  });

  test("excludes claims completed outside the 12-month window", () => {
    const r = buildRoiReport(
      [
        claim({
          events: voyageCompletingAt("2024-03-04T10:00:00Z", true),
          contradictedWeatherEventIds: ["w1"],
        }),
      ],
      NOW
    );
    expect(r.disputedWeather.claimCount).toBe(0);
    expect(r.outOfWindowClaims).toBe(1);
    expect(r.windowMonths).toBe(ROI_WINDOW_MONTHS);
  });
});

describe("buildRoiReport — SHEX vs SHINC", () => {
  // Direction guard. SHEX excludes Sundays/holidays from laytime, so fewer
  // hours count and the owner earns LESS demurrage. If this ever flips
  // positive on an owner's book, the dashboard would be selling a cost as a
  // saving — which is the whole reason the sign is preserved.
  test("reports the SHEX swap as a cost to the owner, not a saving", () => {
    const r = buildRoiReport(
      [claim({ cpTerms: { ...CP, days_basis: "SHINC" } as RoiClaimInput["cpTerms"] })],
      NOW
    );
    expect(r.basisSwap.claimCount).toBe(1);
    expect(r.basisSwap.findings[0].deltaNet).toBeLessThan(0);
    expect(r.basisSwap.totals[0].amount).toBeLessThan(0);
  });

  test("only asks the question of SHINC claims", () => {
    const r = buildRoiReport(
      [claim({ cpTerms: { ...CP, days_basis: "SHEX" } as RoiClaimInput["cpTerms"] })],
      NOW
    );
    expect(r.basisSwap.claimCount).toBe(0);
  });

  test("skips the days basis under Asbatankvoy, where it is inert", () => {
    const r = buildRoiReport(
      [
        claim({
          cpTerms: {
            ...CP,
            cp_form: "ASBATANKVOY",
            days_basis: "SHINC",
          } as RoiClaimInput["cpTerms"],
        }),
      ],
      NOW
    );
    expect(r.basisSwap.claimCount).toBe(0);
  });
});

describe("buildRoiReport — time bar", () => {
  const approaching = claim({
    events: voyageCompletingAt("2026-05-01T10:00:00Z"),
    timeBarDays: 90,
  });

  test("lists unsettled claims inside the warning window, soonest first", () => {
    // From a 2026-05-01 completion at NOW=2026-07-14: an 80-day bar expires in
    // ~6 days (critical), a 90-day bar in ~16 (warning). Both are inside the
    // 21-day window, so both belong on the queue.
    const r = buildRoiReport(
      [
        { ...approaching, claimId: "later", timeBarDays: 90 },
        { ...approaching, claimId: "sooner", timeBarDays: 80 },
      ],
      NOW
    );
    expect(r.timeBar.findings.map((f) => f.state)).toEqual(["critical", "warning"]);
    expect(r.timeBar.findings.map((f) => f.claimId)).toEqual(["sooner", "later"]);
    expect(r.timeBar.findings[0].daysRemaining!).toBeLessThan(
      r.timeBar.findings[1].daysRemaining!
    );
    expect(r.timeBar.findings[0].valueAtRisk).toBeGreaterThan(0);
  });

  test("excludes settled claims — that money is no longer at risk", () => {
    const r = buildRoiReport([{ ...approaching, settledAt: "2026-06-01T00:00:00Z" }], NOW);
    expect(r.timeBar.findings).toHaveLength(0);
  });

  test("excludes claims whose deadline is comfortably away", () => {
    const r = buildRoiReport(
      [claim({ events: voyageCompletingAt("2026-07-01T10:00:00Z"), timeBarDays: 90 })],
      NOW
    );
    expect(r.timeBar.findings).toHaveLength(0);
  });

  // Regression: an unpriceable claim used to be dropped before the time bar
  // ran, so the claim most likely to be forgotten was the one silently
  // missing from the queue. The deadline is real whether or not the money
  // computes; valueAtRisk goes null rather than the claim going missing.
  test("still queues a claim the engine cannot price, with a null value", () => {
    const tooLong = voyage({
      startAt: "2026-02-01T00:00:00Z",
      completedAt: "2026-05-01T10:00:00Z", // beyond the engine's iteration cap
    });
    const r = buildRoiReport([claim({ events: tooLong, timeBarDays: 80 })], NOW);
    expect(r.timeBar.findings).toHaveLength(1);
    expect(r.timeBar.findings[0].valueAtRisk).toBeNull();
    expect(r.timeBar.findings[0].state).toBe("critical");
    // Still counted as unpriceable, and contributes nothing to the totals.
    expect(r.skippedClaims).toBe(1);
    expect(r.timeBar.totals).toEqual([]);
  });
});

describe("buildRoiReport — robustness", () => {
  test("counts unpriceable claims instead of dropping them silently", () => {
    const r = buildRoiReport(
      [
        claim({ claimId: "no-events", events: [] }),
        claim({ claimId: "no-terms", cpTerms: null as unknown as RoiClaimInput["cpTerms"] }),
      ],
      NOW
    );
    expect(r.skippedClaims).toBe(2);
    expect(r.disputedWeather.findings).toHaveLength(0);
  });

  test("an empty book produces an empty report, not a throw", () => {
    const r = buildRoiReport([], NOW);
    expect(r.disputedWeather.totals).toEqual([]);
    expect(r.basisSwap.totals).toEqual([]);
    expect(r.timeBar.findings).toEqual([]);
    expect(r.skippedClaims).toBe(0);
  });

  test("keeps currencies in separate buckets rather than summing them", () => {
    const r = buildRoiReport(
      [
        claim({ claimId: "usd", cpTerms: { ...CP, days_basis: "SHINC" } as RoiClaimInput["cpTerms"] }),
        claim({
          claimId: "eur",
          cpTerms: { ...CP, days_basis: "SHINC", currency: "EUR" } as RoiClaimInput["cpTerms"],
        }),
      ],
      NOW
    );
    expect(r.basisSwap.totals.map((t) => t.currency).sort()).toEqual(["EUR", "USD"]);
  });
});
