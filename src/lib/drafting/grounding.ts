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

const CLAUSE_RE = /\b(?:GENCON94-[\w()]+|ASBA-II-\d+)\b/g;

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

export function verifyDraftGrounding(text: string, ctx: DraftContext): GroundingResult {
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
