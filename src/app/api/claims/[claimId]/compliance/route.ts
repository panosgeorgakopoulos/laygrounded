import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { runComplianceScan } from "@/lib/compliance/service";
import { apiError } from "@/lib/api-errors";

function serializeCheck(c: any) {
  return {
    id: c.id,
    subjectType: c.subject_type,
    subject: c.subject,
    verdict: c.verdict,
    riskScore: c.risk_score,
    matches: c.matches,
    source: c.source,
    checkedAt: c.checked_at,
  };
}

function serializeEts(e: any) {
  if (!e) return null;
  return {
    delayHours: e.delay_hours ?? e.delayHours,
    co2Tonnes: e.co2_tonnes ?? e.co2Tonnes,
    estimatedCostEur: e.estimated_cost_eur ?? e.estimatedCostEur,
    euaPriceEur: e.eua_price_eur ?? e.euaPriceEur,
    fuelTonnesPerDay: e.fuel_tonnes_per_day ?? e.fuelTonnesPerDay,
    coveragePct: e.coverage_pct ?? e.coveragePct,
  };
}

async function requireOwnedClaim(claimId: string) {
  const auth = await requireAuth();
  const supabase = await createClient();
  const { data: claim } = await supabase
    .from("claims")
    .select("company_id")
    .eq("id", claimId)
    .maybeSingle();
  if (!claim || claim.company_id !== auth.companyId) throw new Error("CLAIM_NOT_FOUND");
  return supabase;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const supabase = await requireOwnedClaim(claimId);

    const [{ data: checks }, { data: ets }] = await Promise.all([
      supabase.from("compliance_checks").select("*").eq("claim_id", claimId),
      supabase.from("ets_estimates").select("*").eq("claim_id", claimId).maybeSingle(),
    ]);

    return NextResponse.json({
      checks: (checks ?? []).map(serializeCheck),
      ets: serializeEts(ets),
    });
  } catch (e) {
    return apiError(e, "compliance/GET");
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const { claimId } = await params;
    const supabase = await requireOwnedClaim(claimId);
    const result = await runComplianceScan(claimId, supabase);
    return NextResponse.json({
      checks: result.checks.map(serializeCheck),
      ets: serializeEts(result.ets),
    });
  } catch (e) {
    return apiError(e, "compliance/POST");
  }
}
