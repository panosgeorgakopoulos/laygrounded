// Zero-day settlement clearinghouse.
//
// evaluateEligibility() is pure — rows in, verdict out — mirroring the
// engine-purity discipline (unit-tested in clearinghouse.test.ts). The
// criteria for skipping the human dispute phase are deliberately maximal:
// every single one must hold, and any evidence verdict short of
// 'corroborated' (including 'unavailable') disqualifies. When in doubt, the
// claim goes to the claim room, not the bank.

import type { SupabaseClient } from "@supabase/supabase-js";
import { clearFunds } from "./banking";

export interface EligibilityInput {
  hasCompletionEvent: boolean; // confirmed COMPLETED_LOADING / COMPLETED_DISCHARGE
  erpMatched: boolean; // claim carries external_source + external_ref
  calculation: {
    id: string;
    demurrageAmount: number;
    despatchAmount: number;
    currency: string;
  } | null;
  evidenceVerdicts: string[]; // all evidence_checks verdicts for the claim
  pendingProposals: number;
  alreadySettled: boolean; // claims.settled_at set or a live settlements row
}

export interface EligibilityResult {
  eligible: boolean;
  criteria: {
    voyage_complete: boolean;
    erp_matched: boolean;
    calculation_present: boolean;
    evidence_fully_corroborated: boolean;
    no_pending_disputes: boolean;
    not_already_settled: boolean;
    nonzero_amount: boolean;
  };
  failures: string[]; // human-readable, one per failed criterion
  amount: number;
  direction: "collect" | "pay";
  currency: string;
}

export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const demurrage = input.calculation?.demurrageAmount ?? 0;
  const despatch = input.calculation?.despatchAmount ?? 0;
  const direction: "collect" | "pay" = demurrage > 0 ? "collect" : "pay";
  const amount = demurrage > 0 ? demurrage : despatch;

  const criteria: EligibilityResult["criteria"] = {
    voyage_complete: input.hasCompletionEvent,
    erp_matched: input.erpMatched,
    calculation_present: input.calculation !== null,
    evidence_fully_corroborated:
      input.evidenceVerdicts.length > 0 &&
      input.evidenceVerdicts.every((v) => v === "corroborated"),
    no_pending_disputes: input.pendingProposals === 0,
    not_already_settled: !input.alreadySettled,
    nonzero_amount: amount > 0,
  };

  const messages: Record<keyof EligibilityResult["criteria"], string> = {
    voyage_complete: "no confirmed cargo completion event — the voyage has not finished",
    erp_matched: "claim is not anchored to ERP voyage data (external_source/external_ref)",
    calculation_present: "no laytime calculation on file",
    evidence_fully_corroborated:
      "evidence checks are not 100% corroborated (or none have been run)",
    no_pending_disputes: "counterparty proposals are still pending",
    not_already_settled: "claim already settled or a settlement is already in flight",
    nonzero_amount: "computed amount is zero — nothing to clear",
  };

  const failures = (Object.keys(criteria) as Array<keyof typeof criteria>)
    .filter((k) => !criteria[k])
    .map((k) => messages[k]);

  return {
    eligible: failures.length === 0,
    criteria,
    failures,
    amount,
    direction,
    currency: input.calculation?.currency ?? "USD",
  };
}

const COMPLETION_EVENTS = ["COMPLETED_LOADING", "COMPLETED_DISCHARGE"];

// Loads everything eligibility needs for one claim. Callers pass a client
// already scoped correctly (RLS cookie client for user requests, service
// client for the cron sweep after ownership is established).
export async function loadEligibility(
  supabase: SupabaseClient,
  claimId: string
): Promise<{
  result: EligibilityResult;
  claim: {
    id: string;
    voyage_ref: string;
    counterparty_name: string | null;
  };
  calculationId: string | null;
}> {
  const { data: claim, error: claimErr } = await supabase
    .from("claims")
    .select("id, voyage_ref, counterparty_name, external_source, external_ref, settled_at")
    .eq("id", claimId)
    .maybeSingle();
  if (claimErr || !claim) throw new Error("CLAIM_NOT_FOUND");

  const [{ data: calc }, { data: events }, { data: evidence }, { count: pending }, { data: settlement }] =
    await Promise.all([
      supabase
        .from("laytime_calculations")
        .select("id, demurrage_amount, despatch_amount, currency")
        .eq("claim_id", claimId)
        .maybeSingle(),
      supabase
        .from("sof_events")
        .select("id, event_type")
        .eq("claim_id", claimId)
        .in("status", ["accepted", "edited"])
        .in("event_type", COMPLETION_EVENTS),
      supabase.from("evidence_checks").select("verdict").eq("claim_id", claimId),
      supabase
        .from("event_proposals")
        .select("id", { count: "exact", head: true })
        .eq("claim_id", claimId)
        .eq("status", "pending"),
      supabase
        .from("settlements")
        .select("id, status")
        .eq("claim_id", claimId)
        .maybeSingle(),
    ]);

  const result = evaluateEligibility({
    hasCompletionEvent: (events ?? []).length > 0,
    erpMatched: Boolean(claim.external_source && claim.external_ref),
    calculation: calc
      ? {
          id: calc.id,
          demurrageAmount: calc.demurrage_amount ?? 0,
          despatchAmount: calc.despatch_amount ?? 0,
          currency: calc.currency ?? "USD",
        }
      : null,
    evidenceVerdicts: (evidence ?? []).map((e) => e.verdict),
    pendingProposals: pending ?? 0,
    alreadySettled:
      claim.settled_at != null ||
      (settlement != null && settlement.status !== "failed"),
  });

  return {
    result,
    claim: {
      id: claim.id,
      voyage_ref: claim.voyage_ref,
      counterparty_name: claim.counterparty_name ?? null,
    },
    calculationId: calc?.id ?? null,
  };
}

export interface SettlementOutcome {
  settlementId: string;
  status: "cleared" | "failed";
  amount: number;
  currency: string;
  direction: "collect" | "pay";
  provider: string;
  providerRef: string | null;
  simulated: boolean;
  error: string | null;
}

export interface SettlementApproval {
  humanApproved: boolean; // must be an explicit true from the request body
  approvedBy: string | null; // auth user id, recorded on the review row
  note?: string;
}

export async function settleClaim(
  supabase: SupabaseClient,
  claimId: string,
  approval: SettlementApproval
): Promise<SettlementOutcome> {
  // HITL gate: automation may PROPOSE a clearing (runClearinghouse) but funds
  // move only behind an explicit human_approved flag. This check lives in the
  // service, not the route, so no future caller can drift around it.
  if (approval.humanApproved !== true) throw new Error("HUMAN_APPROVAL_REQUIRED");

  const { result, claim, calculationId } = await loadEligibility(supabase, claimId);
  if (!result.eligible) throw new Error("NOT_ELIGIBLE");

  // The settlements.claim_id UNIQUE constraint decides insert races; the
  // idempotency key pins the clearing to the calculation snapshot that was
  // eligible, so a recompute cannot silently re-price an in-flight transfer.
  const { data: settlement, error: insErr } = await supabase
    .from("settlements")
    .insert({
      claim_id: claimId,
      calculation_id: calculationId,
      amount: result.amount,
      currency: result.currency,
      direction: result.direction,
      status: "initiated",
      eligibility: result.criteria,
      idempotency_key: `settle:${claimId}:${calculationId}`,
    })
    .select("id")
    .single();
  if (insErr) {
    if (insErr.code === "23505") throw new Error("ALREADY_SETTLED");
    throw new Error(`PERSIST_FAILED: ${insErr.message}`);
  }

  // Close the review trail: whoever approved, and the settlement it produced.
  await supabase
    .from("pending_human_reviews")
    .update({
      status: "approved",
      subject_id: settlement.id,
      reviewed_by: approval.approvedBy,
      reviewed_at: new Date().toISOString(),
      review_note: approval.note ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("claim_id", claimId)
    .eq("subject_type", "settlement")
    .eq("status", "pending");

  const clearing = await clearFunds({
    idempotencyKey: `settle:${claimId}:${calculationId}`,
    claimId,
    voyageRef: claim.voyage_ref,
    amount: result.amount,
    currency: result.currency,
    direction: result.direction,
    counterpartyName: claim.counterparty_name,
  });

  const now = new Date().toISOString();
  await supabase
    .from("settlements")
    .update({
      status: clearing.status,
      provider: clearing.provider,
      provider_ref: clearing.providerRef,
      simulated: clearing.simulated,
      last_error: clearing.error,
      cleared_at: clearing.status === "cleared" ? now : null,
      updated_at: now,
    })
    .eq("id", settlement.id);

  if (clearing.status === "cleared") {
    // Feed the existing settlement-recording surface (clause P&L recovery
    // KPI). Owner's perspective: collect = money in, pay = money out.
    await supabase
      .from("claims")
      .update({
        settled_amount: result.direction === "collect" ? result.amount : -result.amount,
        settled_at: now,
        status: "settled",
      })
      .eq("id", claimId);
  }

  return {
    settlementId: settlement.id,
    status: clearing.status,
    amount: result.amount,
    currency: result.currency,
    direction: result.direction,
    provider: clearing.provider,
    providerRef: clearing.providerRef,
    simulated: clearing.simulated,
    error: clearing.error,
  };
}

export interface ClearinghouseReport {
  scanned: number;
  proposed: number; // eligible claims queued for human approval this run
  alreadyQueued: number;
  ineligible: number;
  errors: Array<{ claimId: string; error: string }>;
}

// The sweep: every unsettled ERP-anchored claim with a calculation gets an
// eligibility pass. Qualifying claims are PROPOSED into pending_human_reviews
// — the sweep never moves funds; only settleClaim behind human_approved does.
export async function runClearinghouse(
  supabase: SupabaseClient,
  opts: { companyId?: string; limit?: number } = {}
): Promise<ClearinghouseReport> {
  let query = supabase
    .from("claims")
    .select("id, laytime_calculations!inner(id)")
    .is("settled_at", null)
    .not("external_ref", "is", null)
    .order("updated_at", { ascending: false })
    .limit(opts.limit ?? 20);
  if (opts.companyId) query = query.eq("company_id", opts.companyId);

  const { data: candidates, error } = await query;
  if (error) throw new Error(`SWEEP_QUERY_FAILED: ${error.message}`);

  const report: ClearinghouseReport = {
    scanned: 0,
    proposed: 0,
    alreadyQueued: 0,
    ineligible: 0,
    errors: [],
  };
  for (const c of candidates ?? []) {
    report.scanned += 1;
    try {
      const { result, calculationId } = await loadEligibility(supabase, c.id);
      if (!result.eligible) {
        report.ineligible += 1;
        continue;
      }
      const { error: reviewErr } = await supabase.from("pending_human_reviews").insert({
        claim_id: c.id,
        subject_type: "settlement",
        summary: `Zero-day clearing proposed: ${result.direction} ${result.currency} ${result.amount}`,
        payload: {
          criteria: result.criteria,
          amount: result.amount,
          direction: result.direction,
          currency: result.currency,
          calculation_id: calculationId,
        },
        requested_by: "clearinghouse",
      });
      if (reviewErr) {
        // 23505 on the live-review index: this claim is already awaiting a
        // decision — that's the dedupe contract, not an error.
        if (reviewErr.code === "23505") report.alreadyQueued += 1;
        else report.errors.push({ claimId: c.id, error: reviewErr.message });
        continue;
      }
      report.proposed += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "ALREADY_SETTLED" || msg === "NOT_ELIGIBLE") report.ineligible += 1;
      else report.errors.push({ claimId: c.id, error: msg });
    }
  }
  return report;
}
