// The claim's ledger, projected at read time.
//
// A fan-out of small scoped queries, merged by `buildClaimActivity`. Deliberately
// not a stored table — see that module for why. The cost is one round of narrow
// reads, paid only when somebody opens the tab.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { buildClaimActivity, type ActivitySources } from "@/lib/audit/claim-activity";
import type { CpTerms } from "@/lib/laytime/types";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select(
        "id, company_id, created_at, agreed_at, negotiation_opened_at, settled_at, settled_amount, engine_version, external_source, cp_terms"
      )
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    // Bounded per source: a ledger is read newest-first and nobody scrolls a
    // thousand rows. The cap is stated in the response so the UI can say the
    // view is truncated rather than implying it is complete.
    const LIMIT = 200;

    const [
      events,
      proposals,
      calculation,
      evidence,
      lineage,
      domainEvents,
      notarizations,
      negotiations,
      settlements,
      drafts,
    ] = await Promise.all([
      supabase
        .from("sof_events")
        .select("id, event_type, occurred_at, created_at, source, status")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("event_proposals")
        .select("id, action, status, note, proposed_by_label, share_id, created_at, decided_at")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("laytime_calculations")
        .select("computed_at, used_hours, demurrage_amount, despatch_amount, currency")
        .eq("claim_id", claimId)
        .maybeSingle(),
      supabase
        .from("evidence_checks")
        .select("id, check_type, verdict, summary, checked_at")
        .eq("claim_id", claimId)
        .order("checked_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("data_lineage")
        .select("id, source, source_ref, step, recorded_at")
        .eq("claim_id", claimId)
        .order("recorded_at", { ascending: false })
        .limit(LIMIT),
      // Scoped by aggregate_id, NOT by a join: `domain_events.aggregate_id` is
      // deliberately not a foreign key — events outlive their aggregate — so a
      // join would silently drop the history of a deleted claim.
      supabase
        .from("domain_events")
        .select("id, event_type, occurred_at")
        .eq("aggregate_id", claimId)
        .order("occurred_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("compliance_ledger")
        .select("id, entry_kind, cryptographic_signature, recorded_at")
        .eq("claim_id", claimId)
        .order("recorded_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("autonomous_negotiation_rooms")
        .select("id, agent_rounds_completed, final_settlement_probability, settlement_matrix, created_at")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("settlement_payloads")
        .select("id, settlement_ref, ready, created_at")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(LIMIT),
      supabase
        .from("drafts")
        .select("id, kind, model, created_at")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(LIMIT),
    ]);

    const sources: ActivitySources = {
      claim: {
        created_at: claim.created_at,
        agreed_at: claim.agreed_at,
        negotiation_opened_at: claim.negotiation_opened_at,
        settled_at: claim.settled_at,
        settled_amount: claim.settled_amount,
        engine_version: claim.engine_version,
        external_source: claim.external_source,
      },
      currency: (claim.cp_terms as CpTerms | null)?.currency ?? "USD",
      events: events.data ?? [],
      proposals: proposals.data ?? [],
      calculation: calculation.data ?? null,
      evidence: evidence.data ?? [],
      lineage: lineage.data ?? [],
      domainEvents: domainEvents.data ?? [],
      notarizations: notarizations.data ?? [],
      negotiations: (negotiations.data ?? []).map((r) => ({
        ...r,
        settlement_matrix: r.settlement_matrix as Record<string, unknown> | null,
      })),
      settlements: settlements.data ?? [],
      drafts: drafts.data ?? [],
    };

    const entries = buildClaimActivity(sources);

    return NextResponse.json({
      entries,
      // Any source hitting the cap means the ledger is a window, not the whole
      // history. Said plainly rather than implied by a suspiciously round count.
      truncated: [events, proposals, evidence, lineage, domainEvents].some(
        (r) => (r.data?.length ?? 0) >= LIMIT
      ),
      limitPerSource: LIMIT,
    });
  } catch (e) {
    return apiError(e, "claims/activity/GET");
  }
}
