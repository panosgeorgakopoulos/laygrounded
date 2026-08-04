import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { assertCapability, requireAuth } from "@/lib/server-auth";
import { issueGrant, listGrants } from "@/lib/finance/grants-server";
import { GRANT_PURPOSES, MAX_GRANT_EXPIRY_DAYS } from "@/lib/finance/grants";
import { apiError } from "@/lib/api-errors";

// Trade-finance grants for one claim: issue and list.
//
// SESSION-ONLY, deliberately and permanently. Issuing a grant is credential
// issuance — the same class of act as minting an API key — and a credential
// that can mint credentials makes revocation stop being a remedy. An ERP
// integration that could hand a bank access to its customer's claims without a
// human deciding so is not a feature.
const IssueSchema = z.object({
  institutionLabel: z.string().min(1).max(200),
  purpose: z.enum(GRANT_PURPOSES).default("factoring"),
  expiryDays: z.number().int().min(1).max(MAX_GRANT_EXPIRY_DAYS).optional(),
  /** Omit for unlimited reads until expiry; set to burn the token after N. */
  maxAccessCount: z.number().int().min(1).max(1000).nullable().optional(),
});

async function assertOwnedClaim(claimId: string, companyId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from("claims")
    .select("id, company_id")
    .eq("id", claimId)
    .maybeSingle();
  if (!data || data.company_id !== companyId) throw new Error("CLAIM_NOT_FOUND");
  return supabase;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await assertOwnedClaim(claimId, auth.companyId);

    // Issuing hands a third party a credential to this claim's evidence.
    await assertCapability(auth, "finance.grant", {
      req,
      resourceType: "claim",
      resourceId: claimId,
    });

    const parsed = IssueSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { grant, token } = await issueGrant(supabase, {
      claimId,
      companyId: auth.companyId,
      institutionLabel: parsed.data.institutionLabel,
      purpose: parsed.data.purpose,
      expiryDays: parsed.data.expiryDays,
      maxAccessCount: parsed.data.maxAccessCount ?? null,
      createdBy: auth.userId,
    });

    return NextResponse.json(
      {
        grant,
        // Shown once. Only the hash is stored, so this cannot be recovered —
        // a lost token is replaced by issuing a new one and revoking this.
        token,
        tokenNotice:
          "Copy this token now — it is stored only as a hash and cannot be shown again. It opens this claim and nothing else, and you can revoke it at any time.",
      },
      { status: 201 }
    );
  } catch (e) {
    return apiError(e, "finance-grants/POST", { GRANT_CREATE_FAILED: 503 });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ claimId: string }> }
) {
  try {
    const auth = await requireAuth();
    const { claimId } = await params;
    const supabase = await assertOwnedClaim(claimId, auth.companyId);
    return NextResponse.json({ grants: await listGrants(supabase, claimId) });
  } catch (e) {
    return apiError(e, "finance-grants/GET", { GRANT_QUERY_FAILED: 503 });
  }
}
