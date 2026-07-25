import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/server-auth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";
import { revokeGrant } from "@/lib/interop/efti-grants";

// eFTI federation — revoke a grant. The authority's token stops resolving
// immediately (resolveGrant refuses a revoked grant).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ grantId: string }> }) {
  try {
    const auth = await requireAuth();
    const { grantId } = await params;
    const db = createServiceRoleClient();

    const revoked = await revokeGrant(db, auth.companyId, grantId);
    if (!revoked) {
      return NextResponse.json({ error: "GRANT_NOT_FOUND" }, { status: 404 });
    }

    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "share.revoked",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "efti_grant",
      resourceId: grantId,
      metadata: { event: "efti_grant_revoked" },
      ...requestAttribution(req),
    });

    return NextResponse.json({ revoked: true });
  } catch (e) {
    return apiError(e, "efti/grants/[grantId]/DELETE");
  }
}
