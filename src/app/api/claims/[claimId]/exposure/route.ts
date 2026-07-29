import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { loadClaimExposure } from "@/lib/voyage/exposure-server";
import { apiError } from "@/lib/api-errors";

// Live demurrage meter for one claim: computed on demand from the confirmed
// events, nothing persisted. A stored snapshot would be stale the moment it was
// written — the whole value of this number is that it is current.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await createClient();

    // Defence in depth: RLS already scopes the read, and the tenancy check is
    // repeated explicitly, per the convention every claim-scoped route follows.
    const { data: claim } = await supabase
      .from("claims")
      .select("company_id")
      .eq("id", claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const exposure = await loadClaimExposure(claimId, supabase);
    return NextResponse.json({ exposure });
  } catch (e) {
    return apiError(e, "exposure/GET");
  }
}
