import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { listUserConsents, revokeClientAccess } from "@/lib/oauth/store";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";
import { apiError } from "@/lib/api-errors";

// "Which AI clients can reach my claims" — and the button to cut one off.
//
// The human-facing companion to the OAuth/MCP flow: /oauth/authorize GRANTS an
// AI client access; this route LISTS what a user has granted and REVOKES it.
// Session-authenticated — the logged-in user manages their OWN grants. The
// service role is used only to reach across the token tables that end-user JWTs
// deliberately cannot touch (RLS-no-policy), and every query is scoped to the
// caller's own user id, so one user can never see or revoke another's grants.

export async function GET() {
  try {
    const auth = await requireAuth();
    const db = createServiceRoleClient();
    const consents = await listUserConsents(db, auth.userId);
    return NextResponse.json({ consents });
  } catch (e) {
    return apiError(e, "oauth/consents/GET");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const clientId = new URL(req.url).searchParams.get("client_id");
    if (!clientId) {
      return NextResponse.json({ error: "client_id is required." }, { status: 400 });
    }

    const db = createServiceRoleClient();
    const result = await revokeClientAccess(db, auth.userId, clientId);
    if (!result.found) {
      return NextResponse.json({ error: "NO_SUCH_CONSENT" }, { status: 404 });
    }

    // Revoking a machine credential's reach into the tenant's data is exactly
    // the kind of act the tamper-evident trail records. The grant path in
    // /oauth/authorize/decision logs api_key.created; revocation mirrors it as
    // api_key.revoked, disambiguated by metadata.event (no new enum action —
    // the same convention that route already uses).
    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "api_key.revoked",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "oauth_client",
      resourceId: clientId,
      metadata: {
        event: "oauth_consent_revoked",
        accessRevoked: result.accessRevoked,
        refreshRevoked: result.refreshRevoked,
      },
      ...requestAttribution(req),
    });

    return NextResponse.json({ revoked: true, ...result });
  } catch (e) {
    return apiError(e, "oauth/consents/DELETE");
  }
}
