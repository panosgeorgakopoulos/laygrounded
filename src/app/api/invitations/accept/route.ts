// Redemption: the one route by which somebody joins a company they did not
// create.
//
// WHY THIS IS NOT `requireAuth()`.
//
// Every other authenticated route in this app resolves the caller's tenant from
// `company_members` and refuses with NO_COMPANY when there isn't one. This
// route exists precisely for the person who has no tenant yet, so
// `requireAuth()` would reject exactly the caller it is meant to serve. It
// authenticates the SESSION and takes the tenant from the invitation instead.
//
// THE TOKEN IS THE ONLY THING THE CALLER SUPPLIES, and it never names a
// company. The company id comes out of the stored row, so a caller cannot
// nominate the tenant they would like to join — the same reason the claim-room
// routes take a token and never a claim id from the guest.
//
// The write is service-role because it must be: the person accepting is by
// definition not yet a member, so there is no RLS policy that could authorise
// their `company_members` insert without also authorising a stranger's. See
// `invitations-server.ts`.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/api-errors";
import { redeemInvitation } from "@/lib/auth/invitations-server";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

/**
 * Two ways in, and the union is deliberate — a single optional-both shape would
 * let a caller send neither, or both, and leave the route deciding which wins.
 *
 * `token` is the emailed secret. `invitationId` is the onboarding page, where
 * a user with no token is shown an invitation addressed to them; that path
 * additionally requires a CONFIRMED email address, enforced in
 * `decideRedemption`. See `RedemptionProof` for why they are not equivalent.
 */
const AcceptSchema = z.union([
  z.object({ token: z.string().min(1).max(200) }),
  z.object({ invitationId: z.string().uuid() }),
]);

export async function POST(req: NextRequest) {
  try {
    // The session, not the tenant. `getUser()` revalidates against the auth
    // server rather than trusting the cookie's contents, which matters here
    // more than anywhere: this request grants tenant membership.
    const supabase = await createClient();
    const {
      data: { user },
      error: sessionErr,
    } = await supabase.auth.getUser();

    if (sessionErr || !user?.email) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const parsed = AcceptSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
    }

    const adminClient = createServiceRoleClient();
    const outcome = await redeemInvitation(adminClient, {
      lookup: parsed.data,
      userId: user.id,
      // FROM THE SESSION, never from the request body. This is the whole
      // binding: the invitation names an address, and the only address the
      // caller can present is the one they authenticated with.
      email: user.email,
      // Supabase sets this when the address has actually been confirmed. It is
      // what makes the tokenless path safe on a deployment where sign-up does
      // not require confirmation — without it, anyone could register as
      // somebody else's address and claim what was waiting for them.
      emailVerified: Boolean(user.email_confirmed_at),
    });

    if (!outcome.ok) {
      if (outcome.reason === "REDEMPTION_FAILED") {
        return NextResponse.json({ error: "REDEMPTION_FAILED" }, { status: 500 });
      }
      // Every other reason is a mapped sentinel in `api-errors.ts`, carrying a
      // status that distinguishes "ask for another" from "sign in as yourself".
      return apiError(new Error(outcome.reason), "invitations/accept");
    }

    // Recorded against the tenant that was JOINED, which is the company whose
    // audit trail the new member now appears in. A failure to log must not undo
    // a membership that already exists, so this is not allowed to throw.
    try {
      await recordSecurityEvent({
        companyId: outcome.companyId,
        action: "invitation.accepted",
        actorId: user.id,
        actorLabel: user.email,
        resourceType: "invitation",
        resourceId: outcome.invitationId,
        metadata: { role: outcome.role },
        ...requestAttribution(req),
      });
    } catch (e) {
      console.error("[invitations/accept] failed to record acceptance", e);
    }

    return NextResponse.json({
      ok: true,
      companyId: outcome.companyId,
      companyName: outcome.companyName,
      role: outcome.role,
    });
  } catch (e) {
    return apiError(e, "invitations/accept");
  }
}
