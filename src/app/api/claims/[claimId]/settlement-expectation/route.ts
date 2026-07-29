import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { loadSettlementExpectation } from "@/lib/intel/counterparty-server";
import { apiError } from "@/lib/api-errors";

// What a claim of this shape historically settles for, learned from the
// company's own settled claims. Computed on demand, nothing persisted.
//
// Unlike the pricing oracle this does not 422 on a thin sample: an expectation
// that refuses is still a useful answer here ("you have no settlement history
// to price this against"), and the pure model already returns that as a
// first-class verdict with its reason attached.
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

    const expectation = await loadSettlementExpectation(auth.companyId, claimId, supabase);
    return NextResponse.json({ expectation });
  } catch (e) {
    return apiError(e, "settlement-expectation/GET");
  }
}
