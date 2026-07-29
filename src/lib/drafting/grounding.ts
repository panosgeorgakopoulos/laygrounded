// Grounding verification for generated legal drafts.
//
// A demand letter with a hallucinated figure is worse than no letter. Before a
// draft is stored, every monetary amount and every clause citation in the text
// is checked against the claim's database facts. Pure function — testable
// without an LLM.

import { DraftContext } from "./context";

export interface GroundingIssue {
  type: "amount" | "clause";
  value: string;
  message: string;
}

export interface GroundingResult {
  verified: boolean;
  issues: GroundingIssue[];
  amountsChecked: number;
  clausesChecked: number;
}

const AMOUNT_TOLERANCE = 0.005;

// Currency-adjacent numbers: "USD 14,583.33", "EUR 1 200.50", "€75", "$25,000",
// and the reversed "14,583.33 USD" form.
const AMOUNT_RE =
  /(?:(?:USD|EUR|GBP|€|\$)\s?)(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?)|(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?)\s?(?:USD|EUR|GBP)/g;

// Clause refs as the engine emits them: GENCON94-6, GENCON94-6c,
// GENCON94-7(d), ASBA-II-8.
//
// The sub-clause parens are matched as an explicit optional group rather than
// folded into a character class closed by \b. The previous form
// (/\b(?:GENCON94-[\w()]+|ASBA-II-\d+)\b/) truncated the trailing ")" —
// \b cannot sit after a non-word character — so a letter correctly citing
// GENCON94-7(d) was looked up as "GENCON94-7(d" and reported as a
// hallucinated clause. That false positive now blocks publishing, so the
// pattern has to be exact: it decides whether real letters can be issued.
const CLAUSE_RE = /\bGENCON94-\w+(?:\(\w+\))?|\bASBA-II-\w+/g;

function parseAmount(s: string): number {
  return parseFloat(s.replace(/[,\s]/g, ""));
}

// The closed set of figures the letter is allowed to quote.
export function allowedAmounts(ctx: DraftContext): number[] {
  const amounts: number[] = [];
  if (ctx.totals) {
    amounts.push(ctx.totals.demurrageAmount, ctx.totals.despatchAmount);
  }
  if (ctx.cpTerms) {
    amounts.push(ctx.cpTerms.demurrage_rate, ctx.cpTerms.despatch_rate);
    if (ctx.cpTerms.load_rate) amounts.push(ctx.cpTerms.load_rate);
    if (ctx.cpTerms.discharge_rate) amounts.push(ctx.cpTerms.discharge_rate);
  }
  if (ctx.settlement) amounts.push(ctx.settlement.settledAmount);
  if (ctx.ets) amounts.push(ctx.ets.estimatedCostEur);
  return amounts.filter((a) => a > 0);
}

export function allowedClauses(ctx: DraftContext): Set<string> {
  const clauses = new Set<string>();
  for (const row of ctx.breakdown) clauses.add(row.clause_ref);
  for (const f of ctx.clauseFlags) clauses.add(f.clauseRef);
  return clauses;
}

export interface GroundingOptions {
  /**
   * Reject ANY monetary amount, even one that matches a claim figure.
   *
   * Some correspondence must not quote money at all — a chase to a port agent
   * is routine operational traffic, and a figure in it turns a request for a
   * timestamp into an implied claim against the recipient. The brief tells the
   * model that; this makes it checkable rather than merely requested, which is
   * the same discipline the rest of the grounding layer applies.
   */
  forbidAmounts?: boolean;
}

export function verifyDraftGrounding(
  text: string,
  ctx: DraftContext,
  opts: GroundingOptions = {}
): GroundingResult {
  const issues: GroundingIssue[] = [];
  const amounts = allowedAmounts(ctx);
  const clauses = allowedClauses(ctx);

  let amountsChecked = 0;
  for (const m of text.matchAll(AMOUNT_RE)) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const value = parseAmount(raw);
    if (isNaN(value)) continue;
    amountsChecked++;
    if (opts.forbidAmounts) {
      issues.push({
        type: "amount",
        value: m[0].trim(),
        message: `This document must not quote any monetary amount; found ${m[0].trim()}.`,
      });
      continue;
    }
    const ok = amounts.some((a) => Math.abs(a - value) <= AMOUNT_TOLERANCE);
    if (!ok) {
      issues.push({
        type: "amount",
        value: m[0].trim(),
        message: `Amount ${m[0].trim()} does not match any figure on the claim (allowed: ${amounts.join(", ")}).`,
      });
    }
  }

  let clausesChecked = 0;
  for (const m of text.matchAll(CLAUSE_RE)) {
    clausesChecked++;
    if (!clauses.has(m[0])) {
      issues.push({
        type: "clause",
        value: m[0],
        message: `Clause ${m[0]} is not cited anywhere in this claim's calculation or flags.`,
      });
    }
  }

  return {
    verified: issues.length === 0,
    issues,
    amountsChecked,
    clausesChecked,
  };
}
