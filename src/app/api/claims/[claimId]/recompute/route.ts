import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { recomputeLaytimeServerFn } from "@/lib/laytime/recompute-server";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";

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
      .select("company_id")
      .eq("id", claimId)
      .single();
      
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }
    const result = await recomputeLaytimeServerFn(claimId);
    return NextResponse.json({ result });
  } catch (e) {
    // NO_NOR / CHRONOLOGY / INVALID_CP_TERMS are surfaced as safe client
    // errors; PERSIST_FAILED and any other fault are masked as a generic 500.
    return apiError(e, "recompute/POST", {
      "CHRONOLOGY_ERROR: ALL_FAST cannot precede NOR_TENDERED": 400,
    });
  }
}
