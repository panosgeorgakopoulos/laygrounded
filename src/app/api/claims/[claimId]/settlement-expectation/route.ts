import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import {
  loadSettlementExpectation,
  marketExpectationsEnabled,
} from "@/lib/intel/counterparty-server";
import { apiError } from "@/lib/api-errors";

// What a claim of this shape historically settles for: your own book, and —
// when PUBLIC_MARKET_EXPECTATIONS=1 — the market's figure beside it. Computed
// on demand, nothing persisted.
//
// The market side reads cross-tenant with the service-role client, so the
// ordering here is load-bearing: authenticate, prove the claim belongs to the
// caller's company, and only then construct the privileged client. The response
// carries aggregates only; the rows behind the market figure never leave the
// server, and the k-anonymity floors (>=5 settled claims from >=3 companies,
// the same numbers as the published congestion index) are enforced inside the
// pure model.
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

    // Constructed only after ownership is proven, and only when the market
    // feature is actually on — an unused service-role handle is a liability.
    const service = marketExpectationsEnabled() ? createServiceRoleClient() : undefined;
    const expectation = await loadSettlementExpectation(
      auth.companyId,
      claimId,
      supabase,
      service
    );
    return NextResponse.json({ expectation });
  } catch (e) {
    return apiError(e, "settlement-expectation/GET");
  }
}
