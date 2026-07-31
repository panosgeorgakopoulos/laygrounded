import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { loadEligibility } from "@/lib/settlement/clearinghouse";
import { apiError } from "@/lib/api-errors";

// Marks a claim agreed — the transition that emits `claim.settlement_ready`.
//
// Gated on the SAME eligibility test the clearinghouse uses (voyage complete,
// evidence corroborated, no pending proposals, not already settled). Agreement
// is the moment the numbers stop being negotiable, so it must not be a free-text
// flag a user can set over an open dispute.
//
// The write pins `agreed_calculation_id`: a later recompute changes the numbers,
// and settling against a snapshot nobody agreed is the failure this prevents.
// `escrow-server.ts` blocks the payload when the two diverge.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    const { data: claim } = await supabase
      .from("claims")
      .select("id, company_id, agreed_at")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    // Idempotent: agreeing twice is not an error, and must NOT re-stamp
    // `agreed_at` — the trigger fires on NULL → NOT NULL, so a re-stamp would
    // be silent either way, but the original agreement time is the record.
    if (claim.agreed_at) {
      return NextResponse.json({ alreadyAgreed: true, agreedAt: claim.agreed_at });
    }

    const { result: eligibility, calculationId } = await loadEligibility(supabase, claimId);
    if (!eligibility.eligible) {
      return NextResponse.json(
        {
          error: "NOT_AGREEABLE",
          message: "the claim does not yet meet the agreement criteria",
          failures: eligibility.failures,
          criteria: eligibility.criteria,
        },
        { status: 409 }
      );
    }

    // Service-role for the write: the UPDATE fires a SECURITY DEFINER trigger
    // that inserts into the outbox, and the agreement must land with its event
    // in the same transaction.
    const service = createServiceRoleClient();
    const agreedAt = new Date().toISOString();
    const { error } = await service
      .from("claims")
      .update({
        agreed_at: agreedAt,
        agreed_by: auth.userId,
        agreed_calculation_id: calculationId,
        updated_at: agreedAt,
      })
      .eq("id", claimId)
      // Decides the race: two concurrent agreements, one transition, one event.
      .is("agreed_at", null);
    if (error) throw new Error(`AGREE_FAILED: ${error.message}`);

    return NextResponse.json({
      agreed: true,
      agreedAt,
      agreedCalculationId: calculationId,
      amount: eligibility.amount,
      currency: eligibility.currency,
      direction: eligibility.direction,
    });
  } catch (e) {
    return apiError(e, "claims/agree/POST", { NOT_AGREEABLE: 409 });
  }
}
