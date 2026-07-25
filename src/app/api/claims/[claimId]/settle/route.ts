import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadEligibility, settleClaim } from "@/lib/settlement/clearinghouse";
import { apiError } from "@/lib/api-errors";
import { requireOwnedClaim } from "@/lib/audit/claim-access";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

// HITL contract: funds never move without an explicit, literal
// human_approved: true in the request body — a defaulted/absent flag is a
// 428, and the approving user is recorded on the review row.
const SettleSchema = z.object({
  human_approved: z.boolean().default(false),
  note: z.string().max(2000).optional(),
});

// Dry run: the eligibility verdict with per-criterion detail, so the UI can
// show exactly what still blocks a zero-day clearing.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { supabase } = await requireOwnedClaim(claimId, "id, company_id", req);
    const { result } = await loadEligibility(supabase, claimId);
    return NextResponse.json({ eligibility: result });
  } catch (e) {
    return apiError(e, "settle/GET");
  }
}

// Execute: evaluate, insert the settlement (UNIQUE claim_id decides races),
// and clear funds through the banking provider — gated on human approval.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { supabase, auth } = await requireOwnedClaim(claimId, "id, company_id", req);

    const parsed = SettleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const outcome = await settleClaim(supabase, claimId, {
      humanApproved: parsed.data.human_approved,
      approvedBy: auth.userId,
      note: parsed.data.note,
    });

    // critical: funds have moved. If the trail cannot record who authorised
    // that, the caller is told the write failed rather than being handed a
    // silent, unattributable settlement. The money movement is already done
    // and idempotent (UNIQUE claim_id), so a retry reconciles rather than
    // double-paying — which is what makes failing loudly here the safe choice.
    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "settlement.cleared",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "claim",
      resourceId: claimId,
      outcome: outcome.status === "cleared" ? "allowed" : "error",
      critical: true,
      metadata: {
        settlementId: outcome.settlementId,
        status: outcome.status,
        amount: outcome.amount,
        currency: outcome.currency,
        direction: outcome.direction,
        provider: outcome.provider,
        simulated: outcome.simulated,
        humanApproved: parsed.data.human_approved,
      },
      ...requestAttribution(req),
    });

    return NextResponse.json({ settlement: outcome }, { status: 201 });
  } catch (e) {
    return apiError(e, "settle/POST", {
      NOT_ELIGIBLE: 409,
      ALREADY_SETTLED: 409,
      HUMAN_APPROVAL_REQUIRED: 428,
      AUDIT_WRITE_FAILED: 503,
    });
  }
}
