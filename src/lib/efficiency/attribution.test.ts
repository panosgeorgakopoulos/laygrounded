import { describe, expect, test } from "bun:test";
import type { SofEventInput } from "@/lib/laytime/types";
import { computeAchievedRate } from "@/lib/efficiency/cargo-rate";
import { attributeInefficiency, deductionEvents } from "@/lib/efficiency/attribution";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import type { CpTerms } from "@/lib/laytime/types";

const ev = (at: string, type: string): SofEventInput =>
  ({ id: at + type, occurred_at: at, event_type: type }) as SofEventInput;

// 48h to move 36,000 MT = 18,000 MT/day against a stipulated 24,000.
const EVENTS = [
  ev("2026-03-01T00:00:00Z", "COMMENCED_LOADING"),
  ev("2026-03-03T00:00:00Z", "COMPLETED_LOADING"),
];
const achieved = () => computeAchievedRate("Grain 36,000 MT", EVENTS, "net")!;

function attribute(overrides: Partial<Parameters<typeof attributeInefficiency>[0]> = {}) {
  return attributeInefficiency({
    achieved: achieved(),
    contractualTonnesPerDay: 24000,
    demurrageRatePerDay: 24000,
    currency: "USD",
    ...overrides,
  });
}

describe("a rate shortfall is measured, not automatically deducted", () => {
  // THE LEGAL BOUNDARY. A stipulated rate derives the laytime allowance; it is
  // not a warranty by the terminal. Deducting the shortfall would double-count
  // the rate and reverse the risk the parties allocated.

  test("with no basis, NOTHING is deductible", () => {
    const a = attribute();
    expect(a.contractual!.hoursLost).toBeGreaterThan(0);
    expect(a.deductibleHours).toBe(0);
    expect(a.attributedTo).toBe("unattributed");
  });

  test("and the statement says so in terms", () => {
    const a = attribute();
    expect(a.statement).toContain("NOT");
    expect(a.statement).toContain("charterer's risk");
    expect(a.caveats.some((c) => c.includes("double-count"))).toBe(true);
  });

  test("but the money value IS reported — it is the size of the argument", () => {
    // 48h used vs 36h at the stipulated rate = 12h lost = half a day.
    const a = attribute();
    expect(a.contractual!.hoursLost).toBeCloseTo(12, 1);
    expect(a.shortfallValue).toBeCloseTo(12000, 0);
  });

  test("the shortfall percentage is computed against the benchmark", () => {
    const a = attribute();
    expect(a.contractual!.achievedTonnesPerDay).toBeCloseTo(18000, 0);
    expect(a.contractual!.shortfallPct).toBeCloseTo(-25, 0);
  });
});

describe("a stated basis converts lost time into deductible time", () => {
  test("owner's fault IS deductible, and is attributed to the owner", () => {
    // The mirror image, and the genuinely defensible deduction: time lost
    // through the vessel's own gear does not count against laytime.
    const a = attribute({
      deductionBasis: { kind: "owner_fault", reference: "No. 3 crane inoperative 06:00–18:00" },
    });
    expect(a.attributedTo).toBe("owner");
    expect(a.deductibleHours).toBeCloseTo(12, 1);
    expect(a.statement).toContain("owner's own fault");
  });

  test("an express CP clause is deductible without blaming either party", () => {
    const a = attribute({
      deductionBasis: { kind: "cp_clause", reference: "Cl. 24 — shore crane breakdown excepted" },
    });
    expect(a.attributedTo).toBe("neither");
    expect(a.deductibleHours).toBeGreaterThan(0);
    expect(a.statement).toContain("Cl. 24");
  });

  test("a basis cannot deduct MORE time than was actually lost", () => {
    // A broad clause must not manufacture time out of a small shortfall.
    const a = attribute({
      deductionBasis: { kind: "owner_fault", reference: "gear", hours: 500 },
    });
    expect(a.deductibleHours).toBeCloseTo(a.contractual!.hoursLost, 1);
  });

  test("a narrower basis deducts only what it covers", () => {
    const a = attribute({
      deductionBasis: { kind: "owner_fault", reference: "gear", hours: 4 },
    });
    expect(a.deductibleHours).toBe(4);
  });
});

describe("beating the benchmark", () => {
  test("a fast terminal loses no time and creates no deduction", () => {
    const a = attribute({ contractualTonnesPerDay: 12000 });
    expect(a.contractual!.hoursLost).toBe(0);
    expect(a.shortfallValue).toBe(0);
    expect(a.attributedTo).toBe("neither");
    expect(a.statement).toContain("met or beat");
  });

  test("outperformance is never reported as a negative deduction", () => {
    expect(attribute({ contractualTonnesPerDay: 12000 }).deductibleHours).toBe(0);
  });
});

describe("the dual benchmark degrades gracefully", () => {
  test("contractual works with no market data at all", () => {
    const a = attribute({
      marketTonnesPerDay: null,
      marketUnavailableReason: "Only 3 voyages on this lane; k-anonymity floor is 5.",
    });
    expect(a.contractual).not.toBeNull();
    expect(a.market).toBeNull();
    expect(a.caveats.some((c) => c.includes("k-anonymity"))).toBe(true);
  });

  test("market is reported alongside contractual when available", () => {
    const a = attribute({ marketTonnesPerDay: 20000, marketSampleSize: 9 });
    expect(a.market!.benchmarkTonnesPerDay).toBe(20000);
    expect(a.market!.source).toContain("n=9");
    expect(a.evidence.some((e) => e.clause_ref === "MARKET-BENCHMARK")).toBe(true);
  });

  test("the CONTRACTUAL rate governs when both exist", () => {
    // The market is context; the rate the parties agreed is the operative one.
    const a = attribute({ contractualTonnesPerDay: 24000, marketTonnesPerDay: 6000 });
    expect(a.contractual!.hoursLost).toBeGreaterThan(0);
  });

  test("market alone still yields an assessment", () => {
    const a = attribute({ contractualTonnesPerDay: null, marketTonnesPerDay: 24000 });
    expect(a.contractual).toBeNull();
    expect(a.market!.hoursLost).toBeGreaterThan(0);
  });

  test("no benchmark at all says so rather than inventing one", () => {
    const a = attribute({ contractualTonnesPerDay: null, marketTonnesPerDay: null });
    expect(a.deductibleHours).toBe(0);
    expect(a.statement).toContain("No benchmark");
  });
});

describe("caveats surface data weaknesses", () => {
  test("an ambiguous cargo quantity is flagged", () => {
    const a = attributeInefficiency({
      achieved: computeAchievedRate("Grain 30,000 MT / 36,000 MT", EVENTS, "net")!,
      contractualTonnesPerDay: 24000,
      demurrageRatePerDay: 24000,
      currency: "USD",
    });
    expect(a.caveats.some((c) => c.includes("more than one figure"))).toBe(true);
  });

  test("a gross-basis rate warns about comparing against a WWD rate", () => {
    const a = attributeInefficiency({
      achieved: computeAchievedRate("Grain 36,000 MT", EVENTS, "gross")!,
      contractualTonnesPerDay: 24000,
      demurrageRatePerDay: 24000,
      currency: "USD",
    });
    expect(a.caveats.some((c) => c.includes("weather working day"))).toBe(true);
  });
});

describe("deductions reach the engine as EVENTS, never as an engine change", () => {
  // The WWD resolver precedent. Changing gencon94.ts would alter the 500-case
  // conformance corpus and the published WASM root, breaking whole-object
  // verification for every settled claim.

  test("no basis produces NO events, so a shortfall cannot silently alter a calculation", () => {
    expect(deductionEvents(attribute(), "2026-03-01T00:00:00Z")).toEqual([]);
  });

  test("a basis produces a paired excepted period of exactly the deductible hours", () => {
    const a = attribute({
      deductionBasis: { kind: "owner_fault", reference: "crane", hours: 6 },
    });
    const events = deductionEvents(a, "2026-03-01T00:00:00Z");
    expect(events.map((e) => e.event_type)).toEqual([
      "EXCEPTED_PERIOD_START",
      "EXCEPTED_PERIOD_END",
    ]);
    const span =
      (Date.parse(events[1].occurred_at) - Date.parse(events[0].occurred_at)) / 3_600_000;
    expect(span).toBeCloseTo(6, 6);
  });

  test("the emitted events actually reduce counted laytime in the REAL engine", () => {
    const cp: CpTerms = {
      laytime_allowed_hours: 24,
      turn_time_hours: 0,
      nor_variant: "WIBON",
      // NOT SHINC: verified against the engine that GENCON 94 + SHINC silently
      // ignores agreed excepted periods. Pinned as its own test below.
      days_basis: "SHEX",
      demurrage_rate: 24000,
      despatch_rate: 0,
      currency: "USD",
    } as CpTerms;

    // Anchored on a MONDAY. 1 March 2026 is a Sunday, which SHEX already
    // excepts in full — the deduction would have had nothing marginal to
    // remove and the test would have proved nothing.
    const timeline = [
      ev("2026-03-02T00:00:00Z", "NOR_TENDERED"),
      ev("2026-03-02T00:00:00Z", "COMMENCED_LOADING"),
      ev("2026-03-04T00:00:00Z", "COMPLETED_LOADING"),
    ];
    const before = recomputeLaytime(timeline, cp).totals;

    const a = attribute({
      deductionBasis: { kind: "owner_fault", reference: "crane", hours: 6 },
    });
    const after = recomputeLaytime(
      [...timeline, ...(deductionEvents(a, "2026-03-02T06:00:00Z") as SofEventInput[])],
      cp
    ).totals;

    expect(after.used_hours).toBeLessThan(before.used_hours);
    expect(before.used_hours - after.used_hours).toBeCloseTo(6, 1);
  });

  test("an invalid anchor yields no events rather than an invalid timeline", () => {
    const a = attribute({ deductionBasis: { kind: "owner_fault", reference: "crane" } });
    expect(deductionEvents(a, "not-a-date")).toEqual([]);
  });
});

describe("the GENCON 94 + SHINC gap is surfaced, not silently swallowed", () => {
  // Probed against the real engine: explicit EXCEPTED_PERIOD events are
  // honoured on every CP form and days basis EXCEPT GENCON 94 + SHINC, where
  // isExceptedHour folds agreed exceptions in with Sundays/holidays and the
  // SHINC rule counts them. Reporting deductible hours the calculation then
  // ignores is worse than reporting none.

  const withBasis = (daysBasis: string, cpForm: "GENCON94" | "ASBATANKVOY" = "GENCON94") =>
    attribute({
      deductionBasis: { kind: "owner_fault", reference: "crane", hours: 6 },
      daysBasis,
      cpForm,
    });

  test("GENCON 94 + SHINC warns that the deduction will not apply", () => {
    const a = withBasis("SHINC");
    expect(a.deductibleHours).toBe(6);
    expect(a.caveats.some((c) => c.includes("ENGINE LIMITATION"))).toBe(true);
  });

  test("other bases carry no such warning", () => {
    for (const basis of ["SHEX", "WWDSHEX-EIU", "SSHEX"]) {
      expect(withBasis(basis).caveats.some((c) => c.includes("ENGINE LIMITATION"))).toBe(false);
    }
  });

  test("ASBATANKVOY under SHINC is unaffected — it has its own branch", () => {
    expect(
      withBasis("SHINC", "ASBATANKVOY").caveats.some((c) => c.includes("ENGINE LIMITATION"))
    ).toBe(false);
  });

  test("no warning when there is nothing to deduct", () => {
    expect(
      attribute({ daysBasis: "SHINC" }).caveats.some((c) => c.includes("ENGINE LIMITATION"))
    ).toBe(false);
  });
});

describe("market scope is labelled, never implied", () => {
  test("a terminal-level median says which terminal", () => {
    const a = attribute({
      marketTonnesPerDay: 20000,
      marketSampleSize: 7,
      marketScope: "terminal",
      marketLabel: "ECT Delta",
    });
    expect(a.market!.label).toContain("ECT Delta");
    expect(a.market!.source).toContain("scope=terminal");
  });

  test("a port-level fallback is disclosed as a caveat", () => {
    // A specialised berth measured against a port-wide median is a different
    // claim from a like-for-like comparison, so it is never silent.
    const a = attribute({
      marketTonnesPerDay: 20000,
      marketScope: "port",
      marketLabel: "Rotterdam",
      marketFellBackToPortReason:
        "Not enough data for ECT Delta specifically, so the median is for Rotterdam as a whole.",
    });
    expect(a.market!.label).toContain("Rotterdam");
    expect(a.caveats.some((c) => c.includes("ECT Delta specifically"))).toBe(true);
  });
});
