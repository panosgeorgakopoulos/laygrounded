import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { apiError } from "@/lib/api-errors";

const DecisionSchema = z.object({
  decision: z.enum(["accepted", "rejected"]),
});

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

// Owner decides on a counterparty proposal. Accepting applies the amendment
// to the live event set and recomputes; rejecting only records the decision.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; proposalId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, proposalId } = await params;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const parsed = DecisionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { data: proposal } = await supabase
      .from("event_proposals")
      .select("*")
      .eq("id", proposalId)
      .eq("claim_id", claimId)
      .maybeSingle();
    if (!proposal) {
      return NextResponse.json({ error: "PROPOSAL_NOT_FOUND" }, { status: 404 });
    }
    if (proposal.status !== "pending") {
      return NextResponse.json({ error: "PROPOSAL_ALREADY_DECIDED" }, { status: 409 });
    }

    if (parsed.data.decision === "accepted") {
      if (proposal.action === "amend") {
        const patch: any = {
          status: "edited",
          updated_at: new Date().toISOString(),
        };
        if (proposal.proposed_occurred_at) patch.occurred_at = proposal.proposed_occurred_at;
        if (proposal.proposed_event_type) patch.event_type = proposal.proposed_event_type;
        const { error } = await supabase
          .from("sof_events")
          .update(patch)
          .eq("id", proposal.event_id)
          .eq("claim_id", claimId);
        if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);
      } else if (proposal.action === "remove") {
        // Soft-remove: rejected events fall out of the calculation but keep
        // their provenance trail.
        const { error } = await supabase
          .from("sof_events")
          .update({ status: "rejected", updated_at: new Date().toISOString() })
          .eq("id", proposal.event_id)
          .eq("claim_id", claimId);
        if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);
      } else if (proposal.action === "add") {
        // sof_events requires a parent document; reuse the claim's first or
        // create the same manual stub the events POST route uses.
        let { data: doc } = await supabase
          .from("documents")
          .select("id")
          .eq("claim_id", claimId)
          .limit(1)
          .maybeSingle();
        if (!doc) {
          const res = await supabase
            .from("documents")
            .insert({
              claim_id: claimId,
              storage_path: `manual/${claimId}`,
              mime: "manual",
              extraction_status: "extracted",
            })
            .select("id")
            .single();
          doc = res.data;
        }
        if (!doc) throw new Error("PERSIST_FAILED: no document for proposed event");

        const { error } = await supabase.from("sof_events").insert({
          claim_id: claimId,
          document_id: doc.id,
          occurred_at: proposal.proposed_occurred_at,
          event_type: proposal.proposed_event_type,
          raw_text: proposal.note || `Added via claim room by ${proposal.proposed_by_label}`,
          page: 1,
          bbox: { x: 0, y: 0, width: 0, height: 0 },
          confidence: 1.0,
          source: "counterparty",
          status: "accepted",
        });
        if (error) throw new Error(`PERSIST_FAILED: ${error.message}`);
      }
    }

    const { data: decided, error: decideErr } = await supabase
      .from("event_proposals")
      .update({
        status: parsed.data.decision,
        decided_at: new Date().toISOString(),
      })
      .eq("id", proposalId)
      .select("*")
      .single();
    if (decideErr || !decided) throw new Error(`PERSIST_FAILED: ${decideErr?.message}`);

    // Recompute after acceptance; a failed recompute (e.g. proposal removed
    // the NOR) is reported alongside the decision rather than rolling it back.
    let result: Awaited<ReturnType<typeof recomputeLaytimeServerFn>> | null = null;
    let calcError: string | null = null;
    if (parsed.data.decision === "accepted") {
      try {
        result = await recomputeLaytimeServerFn(claimId);
      } catch (e) {
        calcError = e instanceof Error ? e.message : String(e);
      }
    }

    return NextResponse.json({
      proposal: serializeProposal(decided),
      result,
      calcError,
    });
  } catch (e) {
    return apiError(e, "proposals/PATCH", {
      PROPOSAL_NOT_FOUND: 404,
      PROPOSAL_ALREADY_DECIDED: 409,
    });
  }
}
