// Team management: who belongs to this company and what they may do.
//
// WHY THE MUTATIONS USE THE SERVICE-ROLE CLIENT.
//
// `company_members` has exactly one RLS policy — SELECT — and RLS is enabled on
// it. So every write through the cookie client was silently refused: an INSERT
// with an unchecked error, and a DELETE that matched zero rows, which PostgREST
// reports as a success because deleting nothing is not an error. Both routes
// returned 200 and changed nothing. Invites appeared to work (the invitation
// EMAIL is sent by the auth admin API, which does not go through RLS) while the
// membership row was never created, so the invited user signed in and got
// bootstrapped into a brand-new company of their own.
//
// The fix is the service-role client for the writes, guarded by an explicit
// capability check in front of it. That is the documented pattern for a trusted
// server path, and the alternative — adding INSERT/UPDATE/DELETE policies to
// company_members — would put "may I change a colleague's role" into a policy
// that has to re-derive the caller's own role from the same table it is
// protecting, which is how the recursion in 20260711000000 happened.
//
// Reads stay on the cookie client, where RLS does bind and does the right thing.
//
// PHASE 16: AN INVITATION IS NO LONGER A MEMBERSHIP.
//
// This route used to insert a `company_members` row the moment an admin typed
// an address. That made an invitation and a membership the same object, and the
// consequences were not cosmetic:
//
//   * the invitee held a role in a tenant they had never agreed to join;
//   * "pending" was inferred from `auth.users.last_sign_in_at` — a property of
//     the ACCOUNT — so anyone who had ever signed in to anything read as an
//     active colleague of a company they had never seen;
//   * a never-accepted `admin` invitation counted toward the admin census in
//     `wouldOrphanCompany`, so the last real admin could demote themselves and
//     lock the tenant out, believing a second admin existed;
//   * and there was no way to withdraw an offer except to delete a membership,
//     which is a different act with a different audit meaning.
//
// Now the offer is a row in `company_invitations` with its own lifecycle, and
// the membership is created on redemption — see `invitations-server.ts`.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth, requireCapability } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { ROLES, roleOf, type Role } from "@/lib/auth/roles";
import { invitationAcceptUrl, invitationState } from "@/lib/auth/invitations";
import {
  createInvitation,
  listOutstandingInvitations,
  revokeInvitation,
} from "@/lib/auth/invitations-server";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

const RoleEnum = z.enum(ROLES as unknown as [Role, ...Role[]]);

const InviteSchema = z.object({
  email: z.string().email(),
  role: RoleEnum.default("operator"),
});

/**
 * DELETE serves two different acts, and they are deliberately not the same
 * request shape: removing a colleague (`userId`) revokes access somebody has,
 * while withdrawing an invitation (`invitationId`) cancels an offer nobody has
 * taken up. Conflating them is how the old route ended up unable to express the
 * second at all.
 */
const RemoveSchema = z.union([
  z.object({ userId: z.string().uuid() }),
  z.object({ invitationId: z.string().uuid() }),
]);

const ChangeRoleSchema = z.object({
  userId: z.string().uuid(),
  role: RoleEnum,
});

/**
 * The tenant must keep at least one admin.
 *
 * Without this, an admin can demote or remove the last admin and lock the
 * company out of its own team management permanently — there is no
 * self-service path back, because granting `team.manage` requires
 * `team.manage`. Support would have to do it by hand in the database.
 *
 * COUNTS MEMBERS, NEVER INVITATIONS, and that is now true by construction
 * rather than by care. When an invitation WAS a `company_members` row, an
 * unaccepted `admin` invite counted here as a second admin — so the last real
 * admin could demote themselves, be told it was fine, and lock the tenant out
 * on the strength of a colleague who had never clicked anything. An offer is
 * not a person who can let you back in.
 */
async function wouldOrphanCompany(
  db: ReturnType<typeof createServiceRoleClient>,
  companyId: string,
  targetUserId: string
): Promise<boolean> {
  const { data: admins } = await db
    .from("company_members")
    .select("user_id")
    .eq("company_id", companyId)
    .eq("role", "admin");

  const ids = (admins ?? []).map((a) => a.user_id);
  return ids.length <= 1 && ids.includes(targetUserId);
}

// The team, with roles. Any member may see who their colleagues are — knowing
// who to ask for a settlement approval is not privileged information.
//
// Members and invitations are returned as SEPARATE LISTS rather than merged
// into one roster with a `pending` flag. They are different kinds of thing: a
// member has a user id, a role that can be changed and claims they can open; an
// invitation has an email, an expiry and nothing else. The old shape pretended
// otherwise and had to invent a `pending` boolean from `last_sign_in_at` to
// keep the fiction up.
export async function GET() {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const { data: membersData } = await supabase
      .from("company_members")
      .select("user_id, role, created_at")
      .eq("company_id", auth.companyId);

    const adminClient = createServiceRoleClient();
    const members = await Promise.all(
      (membersData ?? []).map(async (m) => {
        const { data: userData } = await adminClient.auth.admin.getUserById(m.user_id);
        const user = userData?.user;
        return {
          id: m.user_id,
          email: user?.email ?? "Unknown",
          displayName: user?.user_metadata?.display_name ?? null,
          role: roleOf(m.role),
          joinedAt: m.created_at ?? user?.created_at ?? null,
          // Genuinely "has never used the product", which is now a fact about
          // the ACCOUNT and is labelled as such. It is no longer load-bearing
          // for whether they have accepted anything — the invitation table
          // answers that, and answers it correctly.
          neverSignedIn: !user?.last_sign_in_at,
        };
      })
    );

    members.sort((a, b) => a.email.localeCompare(b.email));

    // Read through the cookie client: `company_invitations` has a SELECT policy
    // for company members, so RLS scopes this without a redundant filter and
    // any member may see who has been asked to join.
    const invitations = (await listOutstandingInvitations(supabase, auth.companyId)).map((inv) => ({
      ...inv,
      // Expired invitations are shown rather than hidden, so an admin can see
      // why somebody never appeared and re-send. Silently dropping them makes
      // the invitation look like it was never sent.
      expired: invitationState({ acceptedAt: null, revokedAt: null, expiresAt: inv.expiresAt }) ===
        "expired",
    }));

    return NextResponse.json({
      members,
      invitations,
      selfId: auth.userId,
      selfRole: auth.role,
    });
  } catch (e) {
    return apiError(e, "settings/members/GET");
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireCapability("team.manage", { req, resourceType: "company" });

    const parsed = InviteSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const email = parsed.data.email.toLowerCase().trim();
    const adminClient = createServiceRoleClient();

    // The RPC error is checked, not swallowed: a failing lookup returns null,
    // which is indistinguishable from "no such account", and that path skips the
    // USER_ALREADY_IN_ANOTHER_COMPANY guard below. When the function was missing
    // from the database entirely, that is exactly what happened, silently.
    const { data: userId, error: lookupErr } = await adminClient.rpc("get_user_id_by_email", {
      email_addr: email,
    });
    if (lookupErr) {
      console.error("[settings/members/POST] user lookup failed:", lookupErr);
      return NextResponse.json({ error: "USER_LOOKUP_FAILED" }, { status: 503 });
    }

    const targetUserId = userId as string | null;
    const existingAccount = Boolean(targetUserId);

    // The admissibility checks stay where they were, and still run BEFORE
    // anything is written. They are re-run again at redemption, because an
    // invitation lives a week and any of these facts can change inside it —
    // but refusing here means an admin learns immediately rather than after
    // their colleague has clicked a link that cannot work.
    if (targetUserId) {
      const { data: memberships } = await adminClient
        .from("company_members")
        .select("company_id")
        .eq("user_id", targetUserId);

      if ((memberships ?? []).some((m) => m.company_id === auth.companyId)) {
        return NextResponse.json({ error: "ALREADY_MEMBER" }, { status: 409 });
      }
      // This app supports a single company per user (requireAuth() assumes
      // exactly one company_members row). Admitting a user who already belongs
      // elsewhere would give them a second row and break their own requireAuth()
      // on every future request, locking them out.
      if ((memberships ?? []).length > 0) {
        return NextResponse.json({ error: "USER_ALREADY_IN_ANOTHER_COMPANY" }, { status: 409 });
      }
    }

    // The offer, written before the email is sent. If delivery fails, an
    // invitation that exists and can be copied from the team page is a better
    // outcome than an email nobody can act on because the row was never made.
    let created;
    try {
      created = await createInvitation(adminClient, {
        companyId: auth.companyId,
        email,
        role: parsed.data.role,
        invitedBy: auth.userId,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      if (message === "INVITATION_ALREADY_OUTSTANDING") {
        return NextResponse.json({ error: "INVITATION_ALREADY_OUTSTANDING" }, { status: 409 });
      }
      throw e;
    }

    const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
    const acceptUrl = invitationAcceptUrl(origin, created.token);

    // DELIVERY IS BEST-EFFORT, AND THE LINK IS RETURNED EITHER WAY.
    //
    // Supabase's `inviteUserByEmail` is the only mail channel this app has, and
    // it only works for an address with no account — it fails outright on one
    // that is already registered. So an existing account (a user who signed up
    // alone and was never in a company) gets no email at all, and would have had
    // no way to learn they had been invited.
    //
    // Two things close that: the accept URL comes back to the admin so they can
    // send it however they like, and the onboarding page shows any invitation
    // waiting for the address somebody signs in with. Neither depends on mail
    // being deliverable, which in local development it usually is not.
    let emailed = false;
    if (!existingAccount) {
      const { error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email, {
        // Without this the Supabase invite link lands on the site root, where
        // the proxy sees an auth cookie and redirects to /claims — a tenantless
        // user bounced into a workspace they cannot use. It must carry the token.
        redirectTo: acceptUrl,
      });
      if (inviteErr) {
        // Logged, not fatal. The invitation is real and the admin has the link.
        console.error("[settings/members/POST] invite email failed:", inviteErr);
      } else {
        emailed = true;
      }
    }

    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "member.invited",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "invitation",
      resourceId: created.invitation.id,
      metadata: { email, role: parsed.data.role, existingAccount, emailed },
      ...requestAttribution(req),
    });

    return NextResponse.json({
      invitation: created.invitation,
      // Shown once and never again — the token is stored only as a hash, the
      // same contract as a finance grant. Reloading the team page will not
      // reveal it, so the UI has to surface it at this moment or not at all.
      acceptUrl,
      emailed,
      existingAccount,
    });
  } catch (e) {
    return apiError(e, "settings/members/POST");
  }
}

// Change a colleague's role. The half of team management that was missing:
// before this, the only way to correct a role was to remove the person and
// re-invite them, which for an existing account meant deleting their
// membership and hoping they accepted again.
export async function PATCH(req: NextRequest) {
  try {
    const auth = await requireCapability("team.manage", { req, resourceType: "company" });

    const parsed = ChangeRoleSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const adminClient = createServiceRoleClient();
    const { data: target } = await adminClient
      .from("company_members")
      .select("user_id, role")
      .eq("company_id", auth.companyId)
      .eq("user_id", parsed.data.userId)
      .maybeSingle();

    // Scoped to the caller's own company, so this is "not in your team" rather
    // than "no such user" — the route never confirms a stranger's user id.
    if (!target) {
      return NextResponse.json({ error: "MEMBER_NOT_FOUND" }, { status: 404 });
    }

    const previousRole = roleOf(target.role);
    if (previousRole === parsed.data.role) {
      return NextResponse.json({ member: { id: target.user_id, role: previousRole } });
    }

    if (parsed.data.role !== "admin" && (await wouldOrphanCompany(adminClient, auth.companyId, target.user_id))) {
      return NextResponse.json({ error: "LAST_ADMIN" }, { status: 409 });
    }

    const { error: updateErr } = await adminClient
      .from("company_members")
      .update({ role: parsed.data.role, updated_at: new Date().toISOString() })
      .eq("company_id", auth.companyId)
      .eq("user_id", target.user_id);

    if (updateErr) {
      console.error("[settings/members/PATCH] role update failed:", updateErr);
      return NextResponse.json({ error: "FAILED_TO_CHANGE_ROLE" }, { status: 500 });
    }

    // Both roles recorded. "X is now a finance manager" is far less useful to an
    // investigation than "X was an operator and is now a finance manager".
    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "member.role_changed",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "user",
      resourceId: target.user_id,
      metadata: { from: previousRole, to: parsed.data.role, self: target.user_id === auth.userId },
      ...requestAttribution(req),
    });

    return NextResponse.json({
      member: { id: target.user_id, role: parsed.data.role, previousRole },
    });
  } catch (e) {
    return apiError(e, "settings/members/PATCH");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireCapability("team.manage", { req, resourceType: "company" });

    const parsed = RemoveSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const adminClient = createServiceRoleClient();

    // Withdrawing an offer nobody has taken up. Scoped to the caller's own
    // company and to the not-yet-terminal state inside `revokeInvitation`, so
    // this can neither reach another tenant's invitation nor "revoke" one that
    // was already accepted — that person is a member, and removing them is the
    // branch below.
    if ("invitationId" in parsed.data) {
      const result = await revokeInvitation(adminClient, {
        invitationId: parsed.data.invitationId,
        companyId: auth.companyId,
        revokedBy: auth.userId,
      });
      if (!result.ok) {
        return NextResponse.json({ error: "INVITATION_NOT_FOUND" }, { status: 404 });
      }

      await recordSecurityEvent({
        companyId: auth.companyId,
        action: "invitation.revoked",
        actorId: auth.userId,
        actorLabel: auth.email,
        resourceType: "invitation",
        resourceId: parsed.data.invitationId,
        metadata: { email: result.email },
        ...requestAttribution(req),
      });

      return NextResponse.json({ ok: true });
    }

    if (parsed.data.userId === auth.userId) {
      return NextResponse.json({ error: "CANNOT_REMOVE_SELF" }, { status: 400 });
    }

    if (await wouldOrphanCompany(adminClient, auth.companyId, parsed.data.userId)) {
      return NextResponse.json({ error: "LAST_ADMIN" }, { status: 409 });
    }

    // `.select()` so the count is knowable. Previously this ran through the
    // cookie client, where RLS matched no rows and PostgREST reported the
    // no-op as a success — the caller was told a colleague had been removed
    // who was still a member.
    const { data: removed, error: deleteErr } = await adminClient
      .from("company_members")
      .delete()
      .eq("company_id", auth.companyId)
      .eq("user_id", parsed.data.userId)
      .select("user_id");

    if (deleteErr) {
      console.error("[settings/members/DELETE] remove failed:", deleteErr);
      return NextResponse.json({ error: "FAILED_TO_REMOVE" }, { status: 500 });
    }
    if (!removed || removed.length === 0) {
      return NextResponse.json({ error: "MEMBER_NOT_FOUND" }, { status: 404 });
    }

    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "member.removed",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "user",
      resourceId: parsed.data.userId,
      ...requestAttribution(req),
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return apiError(e, "settings/members/DELETE");
  }
}
