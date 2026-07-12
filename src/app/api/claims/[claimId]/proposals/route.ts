import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { loadClaimComputationInputs } from "@/lib/laytime/recompute-server";
import { diffScenarios, ProposalInput, ScenarioDiff } from "@/lib/laytime/diff";
import { apiError } from "@/lib/api-errors";

function serializeProposal(p: any) {
  return {
    id: p.id,
    shareId: p.share_id,
    action: p.action,
    eventId: p.event_id,
    proposedOccurredAt: p.proposed_occurred_at,
    proposedEventType: p.proposed_event_type,
    note: p.note,
    proposedByLabel: p.proposed_by_label,
    status: p.status,
    createdAt: p.created_at,
    decidedAt: p.decided_at,
  };
}

// Owner-side view of the negotiation: every proposal on the claim plus the
// redline diff (baseline vs all-pending-applied).
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
      .select("company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const { data: proposals } = await supabase
      .from("event_proposals")
      .select("*")
      .eq("claim_id", claimId)
      .order("created_at", { ascending: true });

    let diff: ScenarioDiff | null = null;
    try {
      const { cpTerms, sofInputs } = await loadClaimComputationInputs(claimId, supabase);
      const pending: ProposalInput[] = (proposals || [])
        .filter((p) => p.status === "pending")
        .map((p) => ({
          id: p.id,
          action: p.action,
          event_id: p.event_id,
          proposed_occurred_at: p.proposed_occurred_at,
          proposed_event_type: p.proposed_event_type,
        }));
      diff = diffScenarios(sofInputs, cpTerms, pending);
    } catch {
      // Claims without valid CP terms have no diff to show; the proposal
      // list is still useful on its own.
    }

    return NextResponse.json({
      proposals: (proposals || []).map(serializeProposal),
      diff,
    });
  } catch (e) {
    return apiError(e, "proposals/GET");
  }
}
