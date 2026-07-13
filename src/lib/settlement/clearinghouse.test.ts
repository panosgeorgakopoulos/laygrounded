import { describe, expect, test } from "bun:test";
import { evaluateEligibility, EligibilityInput } from "./clearinghouse";

// A claim that passes every zero-day criterion; each case below breaks
// exactly one thing.
function eligibleBase(): EligibilityInput {
  return {
    hasCompletionEvent: true,
    erpMatched: true,
    calculation: {
      id: "calc-1",
      demurrageAmount: 42_500,
      despatchAmount: 0,
      currency: "USD",
    },
    evidenceVerdicts: ["corroborated", "corroborated", "corroborated"],
    pendingProposals: 0,
    alreadySettled: false,
  };
}

describe("evaluateEligibility", () => {
  test("perfectly matched claim is eligible, collect direction", () => {
    const r = evaluateEligibility(eligibleBase());
    expect(r.eligible).toBe(true);
    expect(r.failures).toEqual([]);
    expect(r.direction).toBe("collect");
    expect(r.amount).toBe(42_500);
    expect(r.currency).toBe("USD");
    expect(Object.values(r.criteria).every(Boolean)).toBe(true);
  });

  const singleFailureCases: Array<{
    name: string;
    mutate: (i: EligibilityInput) => void;
    failedCriterion: keyof ReturnType<typeof evaluateEligibility>["criteria"];
  }> = [
    {
      name: "voyage not complete",
      mutate: (i) => (i.hasCompletionEvent = false),
      failedCriterion: "voyage_complete",
    },
    {
      name: "no ERP anchor",
      mutate: (i) => (i.erpMatched = false),
      failedCriterion: "erp_matched",
    },
    {
      name: "missing calculation fails both presence and amount",
      mutate: (i) => (i.calculation = null),
      failedCriterion: "calculation_present",
    },
    {
      name: "one contradicted verdict poisons the well",
      mutate: (i) => (i.evidenceVerdicts = ["corroborated", "contradicted"]),
      failedCriterion: "evidence_fully_corroborated",
    },
    {
      name: "unavailable is not corroborated — no silent pass",
      mutate: (i) => (i.evidenceVerdicts = ["corroborated", "unavailable"]),
      failedCriterion: "evidence_fully_corroborated",
    },
    {
      name: "inconclusive is not corroborated",
      mutate: (i) => (i.evidenceVerdicts = ["inconclusive"]),
      failedCriterion: "evidence_fully_corroborated",
    },
    {
      name: "zero evidence checks means nothing was verified",
      mutate: (i) => (i.evidenceVerdicts = []),
      failedCriterion: "evidence_fully_corroborated",
    },
    {
      name: "pending proposals block clearing",
      mutate: (i) => (i.pendingProposals = 1),
      failedCriterion: "no_pending_disputes",
    },
    {
      name: "already settled claims never re-clear",
      mutate: (i) => (i.alreadySettled = true),
      failedCriterion: "not_already_settled",
    },
    {
      name: "zero amounts have nothing to clear",
      mutate: (i) => {
        i.calculation = { id: "calc-1", demurrageAmount: 0, despatchAmount: 0, currency: "USD" };
      },
      failedCriterion: "nonzero_amount",
    },
  ];

  for (const c of singleFailureCases) {
    test(c.name, () => {
      const input = eligibleBase();
      c.mutate(input);
      const r = evaluateEligibility(input);
      expect(r.eligible).toBe(false);
      expect(r.criteria[c.failedCriterion]).toBe(false);
      expect(r.failures.length).toBeGreaterThan(0);
    });
  }

  test("despatch-only claim clears in the pay direction", () => {
    const input = eligibleBase();
    input.calculation = {
      id: "calc-2",
      demurrageAmount: 0,
      despatchAmount: 8_750,
      currency: "USD",
    };
    const r = evaluateEligibility(input);
    expect(r.eligible).toBe(true);
    expect(r.direction).toBe("pay");
    expect(r.amount).toBe(8_750);
  });

  test("failures list one message per failed criterion", () => {
    const input = eligibleBase();
    input.hasCompletionEvent = false;
    input.erpMatched = false;
    input.pendingProposals = 3;
    const r = evaluateEligibility(input);
    expect(r.eligible).toBe(false);
    expect(r.failures).toHaveLength(3);
  });
});
