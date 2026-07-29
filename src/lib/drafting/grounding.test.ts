/// <reference types="bun-types" />
// Run with: bun test src/lib/drafting/grounding.test.ts

import { describe, it, expect } from "bun:test";
import { verifyDraftGrounding } from "./grounding";
import { DraftContext } from "./context";

const ctx: DraftContext = {
  claim: {
    id: "c1",
    vessel: "OCEAN HARMONY",
    vesselImo: null,
    voyageRef: "V24-101",
    port: "Santos",
    cargo: "Soybeans",
    counterpartyName: "Test Chartering",
    cpForm: "GENCON94",
  },
  cpTerms: {
    laytime_allowed_hours: 12,
    turn_time_hours: 6,
    nor_variant: "WIBON",
    days_basis: "SHINC",
    demurrage_rate: 24000,
    despatch_rate: 12000,
    currency: "USD",
  },
  totals: {
    allowedHours: 12,
    usedHours: 26,
    demurrageAmount: 14583.33,
    despatchAmount: 0,
    currency: "USD",
  },
  breakdown: [
    {
      start_time: "2024-03-04T14:00:00.000Z",
      end_time: "2024-03-05T02:00:00.000Z",
      duration_hours: 12,
      status: "laytime",
      counts: true,
      clause_ref: "GENCON94-6",
      reasoning: "Laytime counting.",
    },
    {
      start_time: "2024-03-05T02:00:00.000Z",
      end_time: "2024-03-05T16:00:00.000Z",
      duration_hours: 14,
      status: "demurrage",
      counts: true,
      clause_ref: "GENCON94-8",
      reasoning: "Once on demurrage.",
    },
  ],
  events: [],
  clauseFlags: [],
  evidence: [],
  proposals: [],
  settlement: null,
  timeBarDays: 90,
  ets: null,
  timeBar: {
    timeBarDays: 90,
    anchorEventAt: "2026-05-01T00:00:00Z",
    deadline: "2026-07-30T00:00:00Z",
    daysRemaining: 30,
    state: "ok",
    completeness: [],
    complete: true,
  },
  sofGaps: [],
};

describe("verifyDraftGrounding", () => {
  it("passes a letter quoting only database figures and clauses", () => {
    const letter =
      "Pursuant to GENCON94-8, demurrage of USD 14,583.33 has accrued at the agreed rate of USD 24,000 per day. Laytime commenced per GENCON94-6.";
    const r = verifyDraftGrounding(letter, ctx);
    expect(r.verified).toBe(true);
    expect(r.amountsChecked).toBe(2);
    expect(r.clausesChecked).toBe(2);
  });

  it("flags a hallucinated amount", () => {
    const r = verifyDraftGrounding("We demand USD 15,000.00 within 14 days.", ctx);
    expect(r.verified).toBe(false);
    expect(r.issues[0].type).toBe("amount");
  });

  it("flags a clause the claim never cited, including reversed amount formats", () => {
    const r = verifyDraftGrounding(
      "Per GENCON94-7(b) and considering 14,583.33 USD due...",
      ctx
    );
    expect(r.issues.map((i) => i.type)).toEqual(["clause"]);
    expect(r.amountsChecked).toBe(1); // reversed format still parsed and passed
    // Reported in full: the operator has to recognise the clause to judge it.
    expect(r.issues[0].value).toBe("GENCON94-7(b)");
  });

  // Regression: the clause pattern used to be closed by \b, which cannot sit
  // after ")", so a sub-clause citation was truncated to "GENCON94-7(d" and
  // never matched the allowed set — a letter citing a clause the claim really
  // uses was reported as hallucinated. Publishing now refuses ungrounded
  // letters, so this false positive would block correct correspondence.
  it("accepts a sub-clause citation the claim actually uses", () => {
    const subClauseCtx = {
      ...ctx,
      breakdown: [{ ...ctx.breakdown[0], clause_ref: "GENCON94-7(d)" }],
    };
    const r = verifyDraftGrounding("Laytime is calculated per GENCON94-7(d).", subClauseCtx);
    expect(r.clausesChecked).toBe(1);
    expect(r.issues).toEqual([]);
    expect(r.verified).toBe(true);
  });

  it("still checks Asbatankvoy Part II citations", () => {
    const asbaCtx = {
      ...ctx,
      breakdown: [{ ...ctx.breakdown[0], clause_ref: "ASBA-II-8" }],
    };
    expect(verifyDraftGrounding("Per ASBA-II-8 laytime runs.", asbaCtx).verified).toBe(true);
    const bad = verifyDraftGrounding("Per ASBA-II-99 laytime runs.", asbaCtx);
    expect(bad.verified).toBe(false);
    expect(bad.issues[0].value).toBe("ASBA-II-99");
  });

  it("ignores non-monetary numbers like hours and dates", () => {
    const r = verifyDraftGrounding(
      "Laytime of 12 hours expired on 5 March 2024 after 26 hours used.",
      ctx
    );
    expect(r.amountsChecked).toBe(0);
    expect(r.verified).toBe(true);
  });
});

describe("forbidAmounts — money-free correspondence", () => {
  it("rejects an amount even when it matches a real claim figure", () => {
    // The point of the rule: for a chase, a correct figure is still wrong.
    const ok = verifyDraftGrounding("We claim USD 14,583.33.", ctx);
    expect(ok.verified).toBe(true);

    const forbidden = verifyDraftGrounding("We claim USD 14,583.33.", ctx, {
      forbidAmounts: true,
    });
    expect(forbidden.verified).toBe(false);
    expect(forbidden.issues[0].type).toBe("amount");
    expect(forbidden.issues[0].message).toContain("must not quote any monetary amount");
  });

  it("passes a genuinely money-free request", () => {
    const r = verifyDraftGrounding(
      "Please confirm the time cargo operations completed, and send the signed SoF.",
      ctx,
      { forbidAmounts: true }
    );
    expect(r.verified).toBe(true);
    expect(r.amountsChecked).toBe(0);
  });

  it("still ignores hours and dates under the stricter rule", () => {
    const r = verifyDraftGrounding(
      "Operations ran 26 hours and finished on 5 March 2024.",
      ctx,
      { forbidAmounts: true }
    );
    expect(r.verified).toBe(true);
  });

  it("reports every offending amount, not just the first", () => {
    const r = verifyDraftGrounding("USD 14,583.33 and USD 25,000.", ctx, {
      forbidAmounts: true,
    });
    expect(r.issues).toHaveLength(2);
  });

  it("leaves clause checking untouched", () => {
    const r = verifyDraftGrounding("Per GENCON94-99 we ask for the SoF.", ctx, {
      forbidAmounts: true,
    });
    expect(r.verified).toBe(false);
    expect(r.issues[0].type).toBe("clause");
  });
});
