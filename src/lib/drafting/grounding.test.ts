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
