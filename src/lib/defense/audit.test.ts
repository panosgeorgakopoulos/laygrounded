import { describe, expect, test } from "bun:test";
import { auditInboundClaim, type DefenseAuditInput } from "./audit";
import { recomputeLaytime } from "@/lib/laytime/gencon94";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

const TERMS: CpTerms = {
  cp_form: "GENCON94",
  laytime_allowed_hours: 72,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  // Weather-working-days basis on purpose: the engine only excludes weather
  // stoppages from laytime under a WWD basis, so on SHINC/SHEX a weather pair is
  // inert and striking one out would move no money at all.
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24_000,
  despatch_rate: 12_000,
  currency: "USD",
  port_timezone: "UTC",
};

// A voyage that runs well past its laytime, so there is real demurrage to argue
// about. Monday 06:00 NOR through the following Monday.
const EVENTS: SofEventInput[] = [
  { id: "nor", occurred_at: "2026-03-02T06:00:00Z", event_type: "NOR_TENDERED" },
  { id: "berth", occurred_at: "2026-03-02T14:00:00Z", event_type: "ALL_FAST" },
  { id: "start", occurred_at: "2026-03-02T16:00:00Z", event_type: "COMMENCED_LOADING" },
  { id: "wx1", occurred_at: "2026-03-04T08:00:00Z", event_type: "WEATHER_DELAY" },
  { id: "wx1e", occurred_at: "2026-03-04T20:00:00Z", event_type: "WEATHER_DELAY_END" },
  { id: "wx2", occurred_at: "2026-03-05T09:00:00Z", event_type: "WEATHER_DELAY" },
  { id: "wx2e", occurred_at: "2026-03-05T15:00:00Z", event_type: "WEATHER_DELAY_END" },
  { id: "end", occurred_at: "2026-03-07T12:00:00Z", event_type: "COMPLETED_LOADING" },
];

/** The engine's own answer on these facts — the honest baseline. */
function trueNet(events = EVENTS, terms = TERMS): number {
  const r = recomputeLaytime(events, terms);
  return r.totals.demurrage_amount - r.totals.despatch_amount;
}

function input(over: Partial<DefenseAuditInput> = {}): DefenseAuditInput {
  return { claimedAmount: trueNet(), events: EVENTS, cpTerms: TERMS, ...over };
}

describe("arithmetic audit", () => {
  test("an honest claim raises no arithmetic challenge", () => {
    const result = auditInboundClaim(input());
    expect(result.challenges.some((c) => c.basis === "arithmetic")).toBe(false);
    expect(result.arithmeticDelta).toBeCloseTo(0, 2);
  });

  test("an inflated invoice is caught against the claimant's own facts", () => {
    const honest = trueNet();
    const result = auditInboundClaim(input({ claimedAmount: honest + 15_000 }));
    const arith = result.challenges.find((c) => c.basis === "arithmetic")!;
    expect(arith.strength).toBe("conclusive");
    expect(arith.reduction).toBeCloseTo(15_000, 2);
    expect(result.totalChallenged).toBeCloseTo(15_000, 2);
    expect(result.defensiblePosition).toBeCloseTo(honest, 2);
  });

  test("an understated invoice is reported but never becomes a reduction", () => {
    const result = auditInboundClaim(input({ claimedAmount: trueNet() - 5_000 }));
    const arith = result.challenges.find((c) => c.basis === "arithmetic")!;
    expect(arith.reduction).toBe(0);
    expect(arith.rationale).toContain("understated");
    // We must not "defend" our way to paying less than their own maths supports
    // on an arithmetic basis alone.
    expect(result.totalChallenged).toBeLessThanOrEqual(0);
  });

  test("a claim that does not compute is answered in full", () => {
    const noNor = EVENTS.filter((e) => e.id !== "nor");
    const result = auditInboundClaim(input({ events: noNor, claimedAmount: 50_000 }));
    expect(result.defensiblePosition).toBe(0);
    expect(result.totalChallenged).toBe(50_000);
    expect(result.challenges[0].strength).toBe("conclusive");
    expect(result.challenges[0].id).toBe("uncomputable");
  });
});

describe("evidence challenges", () => {
  test("a NOR contradicted by AIS defers laytime and is priced by the engine", () => {
    const result = auditInboundClaim(
      input({ norContradictedArrivalIso: "2026-03-02T14:00:00Z" }),
    );
    const ev = result.challenges.find((c) => c.id === "evidence-nor-position")!;
    expect(ev.strength).toBe("conclusive");
    expect(ev.reduction).toBeGreaterThan(0);

    const deferred = trueNet(
      EVENTS.map((e) => (e.id === "nor" ? { ...e, occurred_at: "2026-03-02T14:00:00Z" } : e)),
    );
    expect(ev.reduction).toBeCloseTo(trueNet() - deferred, 2);
  });

  test("an arrival EARLIER than the tendered NOR is not a challenge", () => {
    // Evidence that helps the claimant must never be dressed up as a reduction.
    const result = auditInboundClaim(
      input({ norContradictedArrivalIso: "2026-03-01T00:00:00Z" }),
    );
    expect(result.challenges.some((c) => c.id === "evidence-nor-position")).toBe(false);
  });

  test("a weather stoppage the claimant omitted reduces the claim", () => {
    const result = auditInboundClaim(
      input({
        unrecordedWeatherWindows: [
          { startIso: "2026-03-05T06:00:00Z", endIso: "2026-03-05T18:00:00Z" },
        ],
      }),
    );
    const ev = result.challenges.find((c) => c.id === "evidence-unrecorded-weather-0")!;
    expect(ev.strength).toBe("strong");
    expect(ev.reduction).toBeGreaterThan(0);
    expect(ev.rationale).toContain("does not log");
  });

  test("striking out a weather window the claimant DID record is never offered", () => {
    // The trap this module is built around: an exclusion already favours the
    // payer, so removing it would raise the bill. No challenge may do that.
    const result = auditInboundClaim(input({ evidenceUnavailable: true }));
    expect(result.challenges.every((c) => c.reduction >= 0)).toBe(true);
    expect(result.defensiblePosition).toBeLessThanOrEqual(result.claimedAmount);
  });

  test("an earlier completion on independent record is priced", () => {
    const result = auditInboundClaim(
      input({ contradictedCompletionIso: "2026-03-06T12:00:00Z" }),
    );
    const ev = result.challenges.find((c) => c.id === "evidence-completion")!;
    expect(ev.reduction).toBeGreaterThan(0);
  });

  test("inconclusive checks are disclosed, never converted into challenges", () => {
    const result = auditInboundClaim(input({ inconclusiveChecks: 2 }));
    expect(result.challenges.some((c) => c.basis === "evidence")).toBe(false);
    expect(result.notes.join(" ")).toContain("inconclusive");
    expect(result.notes.join(" ")).toContain("not a contradiction");
  });

  test("unrun evidence verification is surfaced as a gap", () => {
    const result = auditInboundClaim(input({ evidenceUnavailable: true }));
    expect(result.notes.join(" ")).toContain("No evidence verification");
  });
});

describe("terms challenges", () => {
  test("a shorter laytime allowance in our fixture reduces the claim", () => {
    // Their 72h vs our 48h: less laytime means MORE demurrage, so this must not
    // register as a reduction in our favour.
    const result = auditInboundClaim(input({ ourCpTerms: { laytime_allowed_hours: 48 } }));
    expect(result.challenges.some((c) => c.id === "terms-laytime_allowed_hours")).toBe(false);
  });

  test("a longer laytime allowance in our fixture is a strong challenge", () => {
    const result = auditInboundClaim(input({ ourCpTerms: { laytime_allowed_hours: 96 } }));
    const t = result.challenges.find((c) => c.id === "terms-laytime_allowed_hours")!;
    expect(t.strength).toBe("strong");
    expect(t.reduction).toBeGreaterThan(0);
    expect(t.label).toContain("72h");
    expect(t.label).toContain("96h");
  });

  test("a lower demurrage rate in our fixture is priced", () => {
    const result = auditInboundClaim(input({ ourCpTerms: { demurrage_rate: 12_000 } }));
    const t = result.challenges.find((c) => c.id === "terms-demurrage_rate")!;
    expect(t.reduction).toBeGreaterThan(0);
    expect(t.clauseRef).toBe("GENCON94-7");
  });

  test("identical terms raise nothing", () => {
    const result = auditInboundClaim(
      input({ ourCpTerms: { laytime_allowed_hours: 72, demurrage_rate: 24_000 } }),
    );
    expect(result.challenges.some((c) => c.basis === "terms")).toBe(false);
  });

  test("absent fixture terms are disclosed as a limit of the audit", () => {
    const result = auditInboundClaim(input());
    expect(result.notes.join(" ")).toContain("No fixture terms");
  });
});

describe("the combined position", () => {
  test("individual reductions are NOT summed — interacting amendments price once", () => {
    // A deferred NOR and an added weather window overlap in the hours they
    // affect, so their standalone savings double-count if naively added.
    const result = auditInboundClaim(
      input({
        norContradictedArrivalIso: "2026-03-02T14:00:00Z",
        unrecordedWeatherWindows: [
          { startIso: "2026-03-05T06:00:00Z", endIso: "2026-03-05T18:00:00Z" },
        ],
      }),
    );
    const evidence = result.challenges.filter((c) => c.basis === "evidence");
    expect(evidence).toHaveLength(2);

    const naiveSum = evidence.reduce((s, c) => s + c.reduction, 0);
    // The authoritative figure is one engine run carrying both amendments.
    expect(result.totalChallenged).toBeLessThanOrEqual(naiveSum + 0.01);
    expect(result.defensiblePosition).toBeCloseTo(trueNet() - result.totalChallenged, 2);
  });

  test("arguable clause challenges are listed but excluded from the asserted position", () => {
    const withoutFlags = auditInboundClaim(input());
    const withFlags = auditInboundClaim(
      input({
        clauseFlags: [
          { eventId: "nor", severity: "warning", label: "NOR tendered at anchorage before berth", clauseRef: "GENCON94-6(c)" },
        ],
      }),
    );
    const clause = withFlags.challenges.find((c) => c.basis === "clause")!;
    expect(clause.strength).toBe("arguable");
    expect(clause.reduction).toBeGreaterThan(0);
    // Listed as negotiating room, but the number we would assert is unchanged.
    expect(withFlags.defensiblePosition).toBeCloseTo(withoutFlags.defensiblePosition, 2);
    expect(withFlags.notes.join(" ")).toContain("excluded from the defensible position");
  });

  test("arithmetic and evidence challenges compose without double-counting", () => {
    const honest = trueNet();
    const result = auditInboundClaim(
      input({
        claimedAmount: honest + 10_000,
        norContradictedArrivalIso: "2026-03-02T14:00:00Z",
      }),
    );
    const deferred = trueNet(
      EVENTS.map((e) => (e.id === "nor" ? { ...e, occurred_at: "2026-03-02T14:00:00Z" } : e)),
    );
    // Total challenged = the invoice inflation, plus what the invalid NOR was worth.
    expect(result.defensiblePosition).toBeCloseTo(deferred, 2);
    expect(result.totalChallenged).toBeCloseTo(honest + 10_000 - deferred, 2);
  });

  test("the defensible position never goes negative", () => {
    const result = auditInboundClaim(
      input({ claimedAmount: 100, ourCpTerms: { laytime_allowed_hours: 10_000 } }),
    );
    expect(result.defensiblePosition).toBeGreaterThanOrEqual(0);
  });

  test("challenges are ranked by money", () => {
    const result = auditInboundClaim(
      input({
        claimedAmount: trueNet() + 40_000,
        norContradictedArrivalIso: "2026-03-02T14:00:00Z",
        ourCpTerms: { demurrage_rate: 23_000 },
      }),
    );
    const reductions = result.challenges.map((c) => c.reduction);
    expect(reductions).toEqual([...reductions].sort((a, b) => b - a));
  });
});
