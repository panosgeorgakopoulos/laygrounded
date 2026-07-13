import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { loadEligibility, settleClaim } from "@/lib/settlement/clearinghouse";
import { apiError } from "@/lib/api-errors";

// HITL contract: funds never move without an explicit, literal
// human_approved: true in the request body — a defaulted/absent flag is a
// 428, and the approving user is recorded on the review row.
const SettleSchema = z.object({
  human_approved: z.boolean().default(false),
  note: z.string().max(2000).optional(),
});

async function requireOwnedClaim(claimId: string) {
  const auth = await requireAuth();
  const supabase = await createClient();
  const { data: claim } = await supabase
    .from("claims")
    .select("id, company_id")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");
  return { supabase, auth };
}

// Dry run: the eligibility verdict with per-criterion detail, so the UI can
// show exactly what still blocks a zero-day clearing.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const { supabase } = await requireOwnedClaim(claimId);
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
    const { supabase, auth } = await requireOwnedClaim(claimId);

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
    return NextResponse.json({ settlement: outcome }, { status: 201 });
  } catch (e) {
    return apiError(e, "settle/POST", {
      NOT_ELIGIBLE: 409,
      ALREADY_SETTLED: 409,
      HUMAN_APPROVAL_REQUIRED: 428,
    });
  }
}
