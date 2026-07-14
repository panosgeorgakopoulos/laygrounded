import { describe, expect, test } from "bun:test";
import {
  executeAgenticArbitration,
  MAX_NEGOTIATION_ROUNDS,
  settlementTolerance,
  type AgentLimits,
  type ArbitrationInput,
  type EvidenceVerdictInput,
} from "./autonomous";
import type { CpTerms, SofEventInput } from "@/lib/laytime/types";

// Fixture: WWDSHEX-EIU voyage with a 12h weather delay and 36h of demurrage.
// Engine ground truth (verified by direct sensitivity run):
//   baselineNet 36,000; vulnerabilities s1/s2/s3 (NOR +1/3/6h → −1k/−3k/−6k),
//   s4/s5/s6 (completion −1/3/6h → −1k/−3k/−6k), s7/s8 (weather +3/6h →
//   −3k/−6k, eventIds [w2]); opportunity s9 (weather struck out → +12k,
//   eventIds [w1, w2]).
const EVENTS: SofEventInput[] = [
  { id: "nor", occurred_at: "2026-01-05T06:00:00Z", event_type: "NOR_TENDERED" },
  { id: "berthed", occurred_at: "2026-01-05T10:00:00Z", event_type: "BERTHED" },
  { id: "af", occurred_at: "2026-01-05T11:00:00Z", event_type: "ALL_FAST" },
  { id: "cl", occurred_at: "2026-01-05T12:00:00Z", event_type: "COMMENCED_LOADING" },
  { id: "w1", occurred_at: "2026-01-07T00:00:00Z", event_type: "WEATHER_DELAY" },
  { id: "w2", occurred_at: "2026-01-07T12:00:00Z", event_type: "WEATHER_DELAY_END" },
  { id: "done", occurred_at: "2026-01-10T12:00:00Z", event_type: "COMPLETED_LOADING" },
];

const CP: CpTerms = {
  laytime_allowed_hours: 72,
  turn_time_hours: 6,
  nor_variant: "WIBON",
  days_basis: "WWDSHEX-EIU",
  demurrage_rate: 24000,
  despatch_rate: 12000,
  currency: "USD",
};

const open = (maxConcessionUsd: number, hardStopClauses: AgentLimits["hardStopClauses"] = []): AgentLimits => ({
  maxConcessionUsd,
  hardStopClauses,
});

const input = (overrides: Partial<ArbitrationInput> = {}): ArbitrationInput => ({
  events: EVENTS,
  cpTerms: CP,
  evidence: [],
  ownerLimits: open(50_000),
  chartererLimits: open(50_000),
  ...overrides,
});

describe("settlementTolerance", () => {
  test("floors at 100 and scales at 0.5% of baseline", () => {
    expect(settlementTolerance(1_000).toNumber()).toBe(100);
    expect(settlementTolerance(36_000).toNumber()).toBe(180);
    expect(settlementTolerance(-36_000).toNumber()).toBe(180);
  });
});

describe("executeAgenticArbitration", () => {
  test("unrestricted agents converge on the full agenda in 9 rounds", () => {
    const m = executeAgenticArbitration("claim-1", input());
    expect(m.baselineNet).toBe(36_000);
    expect(m.ownerOpening).toBe(48_000); // baseline + s9
    expect(m.chartererOpening).toBe(7_000); // baseline − 29k of attacks
    expect(m.roundsCompleted).toBe(9);
    expect(m.converged).toBe(true);
    expect(m.ownerFinal).toBe(32_000);
    expect(m.chartererFinal).toBe(32_000);
    expect(m.recommendedSettlement).toBe(32_000);
    expect(m.gap).toBe(0);
    expect(m.settlementProbability).toBe(0.95);
    expect(m.disputedValue).toBe(41_000);
    expect(m.concessions).toHaveLength(9);
    // Alternating turns, charterer first, cheapest items first.
    expect(m.concessions[0]).toMatchObject({
      round: 1,
      actor: "charterer_agent",
      amount: 1_000,
      forcedByEvidence: false,
    });
    expect(m.concessions[1]).toMatchObject({ round: 2, actor: "owner_agent", amount: 1_000 });
    expect(m.concessions[8]).toMatchObject({ round: 9, actor: "charterer_agent", amount: 12_000 });
    expect(m.heldFirm).toHaveLength(0);
  });

  test("contradicted weather evidence forces the strike-out as fact and kills extensions", () => {
    const evidence: EvidenceVerdictInput[] = [
      { eventId: "w1", verdict: "contradicted" },
      { eventId: "w2", verdict: "contradicted" },
    ];
    const m = executeAgenticArbitration("claim-1", input({ evidence }));
    // Extensions of a disproven delay are dead → excluded from openings.
    expect(m.ownerOpening).toBe(48_000);
    expect(m.chartererOpening).toBe(16_000);
    // Round 0: charterer accepts the strike-out (+12k) as fact, no budget.
    const forced = m.concessions.filter((c) => c.forcedByEvidence);
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({
      round: 0,
      actor: "charterer_agent",
      category: "weather",
      amount: 12_000,
    });
    expect(forced[0].label).toContain("struck out"); // pins the sensitivity.ts label contract
    const dead = m.heldFirm.filter((h) => h.reason === "contradicted_evidence");
    expect(dead).toHaveLength(2);
    expect(dead.every((h) => h.actor === "owner_agent" && h.category === "weather")).toBe(true);
    expect(m.roundsCompleted).toBe(6);
    expect(m.converged).toBe(true);
    expect(m.recommendedSettlement).toBe(38_000);
  });

  test("corroborated weather evidence kills every weather argument on both sides", () => {
    const evidence: EvidenceVerdictInput[] = [
      { eventId: "w1", verdict: "corroborated" },
      { eventId: "w2", verdict: "corroborated" },
    ];
    const m = executeAgenticArbitration("claim-1", input({ evidence }));
    expect(m.ownerOpening).toBe(36_000); // the +12k push is dead
    expect(m.chartererOpening).toBe(16_000); // both extensions dead
    const dead = m.heldFirm.filter((h) => h.reason === "corroborated_evidence");
    expect(dead).toHaveLength(3);
    expect(m.concessions.every((c) => !c.forcedByEvidence)).toBe(true);
    expect(m.converged).toBe(true);
    expect(m.roundsCompleted).toBe(6);
    expect(m.recommendedSettlement).toBe(26_000);
  });

  test("budgets and hard stops leave the gap open and depress the probability", () => {
    const m = executeAgenticArbitration(
      "claim-1",
      input({
        ownerLimits: open(0),
        chartererLimits: open(4_000, ["weather"]),
      })
    );
    expect(m.converged).toBe(false);
    // Two charterer concessions + one skipped owner turn; the final mutual
    // deadlock ends the exchange without consuming a round.
    expect(m.roundsCompleted).toBe(3);
    expect(m.ownerFinal).toBe(48_000);
    expect(m.chartererFinal).toBe(9_000);
    expect(m.recommendedSettlement).toBe(28_500);
    expect(m.settlementProbability).toBe(0.0939);
    const voluntary = m.concessions.filter((c) => !c.forcedByEvidence);
    expect(voluntary.every((c) => c.actor === "charterer_agent")).toBe(true);
    expect(voluntary.reduce((s, c) => s + c.amount, 0)).toBe(2_000);
    expect(m.heldFirm.filter((h) => h.reason === "hard_stop")).toHaveLength(1);
    expect(m.heldFirm.filter((h) => h.reason === "budget_exhausted")).toHaveLength(6);
  });

  test("maxRounds caps the exchange and reports rounds_exhausted leftovers", () => {
    const m = executeAgenticArbitration("claim-1", input({ maxRounds: 3 }));
    expect(m.roundsCompleted).toBe(3);
    expect(m.converged).toBe(false);
    expect(m.ownerFinal).toBe(47_000);
    expect(m.chartererFinal).toBe(11_000);
    expect(m.recommendedSettlement).toBe(29_000);
    expect(m.settlementProbability).toBe(0.1598);
    expect(m.heldFirm.some((h) => h.reason === "rounds_exhausted")).toBe(true);
  });

  test("is deterministic: identical inputs produce an identical matrix", () => {
    const a = executeAgenticArbitration("claim-1", input());
    const b = executeAgenticArbitration("claim-1", input());
    expect(b).toEqual(a);
  });

  test("rejects invalid limits", () => {
    expect(() =>
      executeAgenticArbitration("c", input({ maxRounds: MAX_NEGOTIATION_ROUNDS + 1 }))
    ).toThrow("INVALID_LIMITS");
    expect(() => executeAgenticArbitration("c", input({ maxRounds: 0 }))).toThrow("INVALID_LIMITS");
    expect(() =>
      executeAgenticArbitration("c", input({ ownerLimits: open(-1) }))
    ).toThrow("INVALID_LIMITS");
  });

  test("propagates NO_NOR when the baseline cannot compute", () => {
    const events: SofEventInput[] = [
      { id: "done", occurred_at: "2026-01-10T12:00:00Z", event_type: "COMPLETED_LOADING" },
    ];
    expect(() => executeAgenticArbitration("c", input({ events }))).toThrow("NO_NOR");
  });
});
