import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";
import { createGrant, listGrants, DEFAULT_GRANT_EXPIRY_DAYS } from "@/lib/interop/efti-grants";
import { normalizeScopes, MVSD_SCOPES } from "@/lib/interop/efti-federation";

// eFTI federation — owner side. Mint a scoped, revocable grant for a named
// authority (POST) and list existing grants (GET). The share token is returned
// exactly once, on creation; afterwards only its hash is stored.

const CreateSchema = z.object({
  claimId: z.string().uuid(),
  authorityLabel: z.string().max(200).default(""),
  // Validated loosely, then narrowed by normalizeScopes (unknown scopes dropped).
  scopes: z.array(z.string()).optional(),
  expiresInDays: z.number().int().min(1).max(365).default(DEFAULT_GRANT_EXPIRY_DAYS),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const claimId = new URL(req.url).searchParams.get("claimId") || undefined;
    const db = createServiceRoleClient();
    const grants = await listGrants(db, auth.companyId, claimId);
    return NextResponse.json({ grants });
  } catch (e) {
    return apiError(e, "efti/grants/GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const parsed = CreateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const db = createServiceRoleClient();

    // Tenancy: the claim must belong to the caller's company.
    const { data: claim } = await db
      .from("claims")
      .select("company_id")
      .eq("id", parsed.data.claimId)
      .maybeSingle();
    if (!claim || claim.company_id !== auth.companyId) {
      return NextResponse.json({ error: "CLAIM_NOT_FOUND" }, { status: 404 });
    }

    const scopes = normalizeScopes(parsed.data.scopes);
    const effectiveScopes = scopes.length ? scopes : MVSD_SCOPES;
    const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 86400_000).toISOString();

    const { grant, token } = await createGrant(db, {
      claimId: parsed.data.claimId,
      companyId: auth.companyId,
      authorityLabel: parsed.data.authorityLabel,
      scopes: effectiveScopes,
      createdBy: auth.userId,
      expiresAt,
    });

    // Sharing claim data with an external authority is logged like a room share
    // (reusing share.created + metadata.event, per the decision-route convention).
    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "share.created",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "efti_grant",
      resourceId: grant.id,
      metadata: {
        event: "efti_grant_created",
        claimId: parsed.data.claimId,
        authorityLabel: parsed.data.authorityLabel,
        scopes: effectiveScopes,
      },
      ...requestAttribution(req),
    });

    const sharedUrl = `${new URL(req.url).origin}/api/v1/interoperability/efti/shared/${token}`;
    return NextResponse.json({ grant, token, sharedUrl }, { status: 201 });
  } catch (e) {
    return apiError(e, "efti/grants/POST");
  }
}
