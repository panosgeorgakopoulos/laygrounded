import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { verifyClaimEvidence } from "@/lib/evidence/verify";
import { apiError } from "@/lib/api-errors";

function serialize(check: any) {
  return {
    id: check.id,
    eventId: check.event_id,
    checkType: check.check_type,
    verdict: check.verdict,
    summary: check.summary,
    data: check.data,
    checkedAt: check.checked_at,
  };
}

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

    const { data: checks } = await supabase
      .from("evidence_checks")
      .select("*")
      .eq("claim_id", claimId)
      .order("checked_at", { ascending: false });

    return NextResponse.json({ checks: (checks || []).map(serialize) });
  } catch (e) {
    return apiError(e, "verify-evidence/GET");
  }
}

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
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const checks = await verifyClaimEvidence(claimId, supabase);
    return NextResponse.json({ checks: checks.map(serialize) });
  } catch (e) {
    return apiError(e, "verify-evidence/POST");
  }
}
