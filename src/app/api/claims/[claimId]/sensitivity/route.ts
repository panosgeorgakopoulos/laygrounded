import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { loadClaimComputationInputs } from "@/lib/laytime/recompute-server";
import { analyzeSensitivity } from "@/lib/laytime/sensitivity";
import { apiError } from "@/lib/api-errors";

// Dispute sensitivity: computed on demand from the confirmed events — always
// in sync with the live calculation, nothing persisted.
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

    const { cpTerms, sofInputs } = await loadClaimComputationInputs(claimId, supabase);
    const report = analyzeSensitivity(sofInputs, cpTerms);
    return NextResponse.json({ report });
  } catch (e) {
    return apiError(e, "sensitivity/GET");
  }
}
