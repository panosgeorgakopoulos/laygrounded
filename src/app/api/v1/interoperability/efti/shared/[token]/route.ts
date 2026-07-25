import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { resolveGrant, loadEftiConsignment } from "@/lib/interop/efti-grants";
import { scopeConsignment } from "@/lib/interop/efti-federation";

// eFTI federation — authority side. An external authority fetches the
// scope-filtered, re-signed consignment with its unguessable token. No session:
// the token is the credential, validated by resolveGrant, which alone decides
// which claim is exposed — the caller never supplies a claim id (mirrors the
// claim-room guest model). An unknown / revoked / expired token is a flat 404;
// we do not confirm that a token exists.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const db = createServiceRoleClient();

    const resolved = await resolveGrant(db, token);
    if (!resolved) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    // claimId comes from the validated grant, never from the request.
    const full = await loadEftiConsignment(db, resolved.claimId);
    const consignment = scopeConsignment(full, resolved.scopes);

    return NextResponse.json(
      { consignment },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    return apiError(e, "efti/shared/GET", {
      CLAIM_NOT_FOUND: 404,
      NO_CONFIRMED_EVENTS: 404,
      NO_EXPORTABLE_MILESTONES: 422,
    });
  }
}
