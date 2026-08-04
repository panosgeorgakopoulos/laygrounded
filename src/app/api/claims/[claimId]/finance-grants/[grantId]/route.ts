import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { assertCapability, requireAuth } from "@/lib/server-auth";
import { revokeGrant, listGrantAccesses } from "@/lib/finance/grants-server";
import { apiError } from "@/lib/api-errors";

// Revoke a grant, and read its redemption history.
//
// Revocation takes effect on the next redemption with no grace period and no
// cache to wait out — `evaluateGrant` checks it before anything else. That is
// the property that makes handing a token to a bank a reversible decision.

async function assertOwned(claimId: string, companyId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("claims")
    .select("id, company_id")
    .eq("id", claimId)
    .maybeSingle();
  if (!data || data.company_id !== companyId) throw new Error("CLAIM_NOT_FOUND");
  return supabase;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string; grantId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, grantId } = await params;
    const supabase = await assertOwned(claimId, auth.companyId);

    // Revoking a bank's access is irreversible in the way that matters: on the
    // holder's side a revoked token is indistinguishable from one that never
    // existed, so it cannot be undone by resending anything.
    await assertCapability(auth, "finance.grant", {
      req,
      resourceType: "finance_grant",
      resourceId: grantId,
    });

    const reason = req.nextUrl.searchParams.get("reason") ?? undefined;
    const revoked = await revokeGrant(supabase, grantId, auth.companyId, {
      revokedBy: auth.userId,
      reason: reason?.slice(0, 500),
    });

    // Idempotent: revoking an already-revoked grant is not an error. A tenant
    // clicking twice in a panic should not be told something failed.
    return NextResponse.json({
      revoked,
      status: revoked ? "revoked" : "already_revoked_or_not_found",
    });
  } catch (e) {
    return apiError(e, "finance-grants/[id]/DELETE", { GRANT_REVOKE_FAILED: 503 });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string; grantId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId, grantId } = await params;
    const supabase = await assertOwned(claimId, auth.companyId);

    // Scoped to the claim as well as the grant id, so a grant id belonging to
    // another claim in the same company cannot be read through this path.
    const { data: grant } = await supabase
      .from("finance_grants")
      .select("id")
      .eq("id", grantId)
      .eq("claim_id", claimId)
      .maybeSingle();
    if (!grant) return NextResponse.json({ error: "GRANT_NOT_FOUND" }, { status: 404 });

    return NextResponse.json({ accesses: await listGrantAccesses(supabase, grantId) });
  } catch (e) {
    return apiError(e, "finance-grants/[id]/GET");
  }
}
