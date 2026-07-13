// Draft context assembly: everything the drafter may cite, in one structured
// object. The LLM sees nothing that isn't in here — that closed world is what
// makes grounding verification possible.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { GENCON94_REFERENCE } from "@/lib/clause-flagging";
import { CpTerms, LaytimeResult } from "@/lib/laytime/types";

export interface DraftContext {
  claim: {
    id: string;
    vessel: string;
    vesselImo: string | null;
    voyageRef: string;
    port: string;
    cargo: string;
    counterpartyName: string | null;
    cpForm: string;
  };
  cpTerms: CpTerms | null;
  totals: {
    allowedHours: number;
    usedHours: number;
    demurrageAmount: number;
    despatchAmount: number;
    currency: string;
  } | null;
  breakdown: LaytimeResult["breakdown"];
  events: Array<{ occurredAt: string; eventType: string; rawText: string }>;
  clauseFlags: Array<{
    clauseRef: string;
    severity: string;
    note: string;
    referenceText: string | null;
  }>;
  evidence: Array<{ checkType: string; verdict: string; summary: string }>;
  proposals: Array<{
    action: string;
    status: string;
    proposedByLabel: string;
    note: string;
    proposedOccurredAt: string | null;
    proposedEventType: string | null;
  }>;
  settlement: { settledAmount: number; settledAt: string | null } | null;
  timeBarDays: number;
  ets: { estimatedCostEur: number; co2Tonnes: number } | null;
}

export async function assembleDraftContext(
  claimId: string,
  client?: SupabaseClient
): Promise<DraftContext> {
  const supabase = client ?? (await createClient());

  const { data: claim } = await supabase
    .from("claims")
    .select("*")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim) throw new Error("CLAIM_NOT_FOUND");

  const [
    { data: calc },
    { data: events },
    { data: flags },
    { data: evidence },
    { data: proposals },
    { data: ets },
  ] = await Promise.all([
    supabase.from("laytime_calculations").select("*").eq("claim_id", claimId).maybeSingle(),
    supabase
      .from("sof_events")
      .select("occurred_at, event_type, raw_text, id, status")
      .eq("claim_id", claimId)
      .in("status", ["accepted", "edited"])
      .order("occurred_at", { ascending: true }),
    supabase
      .from("clause_flags")
      .select("clause_ref, severity, note, event_id, sof_events!inner(claim_id)")
      .eq("sof_events.claim_id", claimId),
    supabase
      .from("evidence_checks")
      .select("check_type, verdict, summary")
      .eq("claim_id", claimId),
    supabase
      .from("event_proposals")
      .select("action, status, proposed_by_label, note, proposed_occurred_at, proposed_event_type")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: true }),
    supabase
      .from("ets_estimates")
      .select("estimated_cost_eur, co2_tonnes")
      .eq("claim_id", claimId)
      .maybeSingle(),
  ]);

  return {
    claim: {
      id: claim.id,
      vessel: claim.vessel,
      vesselImo: claim.vessel_imo ?? null,
      voyageRef: claim.voyage_ref,
      port: claim.port,
      cargo: claim.cargo,
      counterpartyName: claim.counterparty_name ?? null,
      cpForm: claim.cp_form ?? "GENCON94",
    },
    cpTerms: (claim.cp_terms as CpTerms) ?? null,
    totals: calc
      ? {
          allowedHours: calc.allowed_hours,
          usedHours: calc.used_hours,
          demurrageAmount: calc.demurrage_amount ?? 0,
          despatchAmount: calc.despatch_amount ?? 0,
          currency: calc.currency,
        }
      : null,
    breakdown: Array.isArray(calc?.breakdown) ? calc.breakdown : [],
    events: (events ?? []).map((e) => ({
      occurredAt: e.occurred_at,
      eventType: e.event_type,
      rawText: e.raw_text,
    })),
    clauseFlags: (flags ?? []).map((f: any) => ({
      clauseRef: f.clause_ref,
      severity: f.severity,
      note: f.note,
      referenceText: GENCON94_REFERENCE[f.clause_ref] ?? null,
    })),
    evidence: (evidence ?? []).map((c) => ({
      checkType: c.check_type,
      verdict: c.verdict,
      summary: c.summary,
    })),
    proposals: (proposals ?? []).map((p) => ({
      action: p.action,
      status: p.status,
      proposedByLabel: p.proposed_by_label,
      note: p.note,
      proposedOccurredAt: p.proposed_occurred_at,
      proposedEventType: p.proposed_event_type,
    })),
    settlement:
      claim.settled_amount != null
        ? { settledAmount: claim.settled_amount, settledAt: claim.settled_at ?? null }
        : null,
    timeBarDays: claim.time_bar_days ?? 90,
    ets: ets
      ? { estimatedCostEur: ets.estimated_cost_eur, co2Tonnes: ets.co2_tonnes }
      : null,
  };
}
