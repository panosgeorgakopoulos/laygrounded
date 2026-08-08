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

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth, requireCapability } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { ROLES, roleOf, type Role } from "@/lib/auth/roles";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

const RoleEnum = z.enum(ROLES as unknown as [Role, ...Role[]]);

const InviteSchema = z.object({
  email: z.string().email(),
  role: RoleEnum.default("operator"),
});

const RemoveSchema = z.object({
  userId: z.string().uuid(),
});

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
          // A user who has never signed in has no confirmation timestamp: the
          // invite is still outstanding, and the UI says so rather than showing
          // them as an active colleague.
          pending: !user?.last_sign_in_at,
          joinedAt: m.created_at ?? user?.created_at ?? null,
        };
      })
    );

    members.sort((a, b) => a.email.localeCompare(b.email));

    return NextResponse.json({ members, selfId: auth.userId, selfRole: auth.role });
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

    let targetUserId = userId as string | null;
    let existingAccount = Boolean(targetUserId);

    if (targetUserId) {
      // This app supports a single company per user (requireAuth() assumes
      // exactly one company_members row). Adding a user who already belongs to
      // another company would give them a second row and break their own
      // requireAuth() on every future request, locking them out.
      const { data: memberships } = await adminClient
        .from("company_members")
        .select("company_id")
        .eq("user_id", targetUserId);

      if ((memberships ?? []).some((m) => m.company_id === auth.companyId)) {
        return NextResponse.json({ error: "ALREADY_MEMBER" }, { status: 409 });
      }
      if ((memberships ?? []).length > 0) {
        return NextResponse.json({ error: "USER_ALREADY_IN_ANOTHER_COMPANY" }, { status: 409 });
      }
    } else {
      const { data: invited, error: inviteErr } =
        await adminClient.auth.admin.inviteUserByEmail(email);
      if (inviteErr || !invited?.user) {
        console.error("[settings/members/POST] invite failed:", inviteErr);
        return NextResponse.json({ error: "FAILED_TO_INVITE" }, { status: 500 });
      }
      targetUserId = invited.user.id;
      existingAccount = false;
    }

    // Checked, unlike before. A membership that failed to insert must not be
    // reported as an invitation that worked.
    const { error: insertErr } = await adminClient.from("company_members").insert({
      company_id: auth.companyId,
      user_id: targetUserId,
      role: parsed.data.role,
    });
    if (insertErr) {
      console.error("[settings/members/POST] membership insert failed:", insertErr);
      return NextResponse.json({ error: "FAILED_TO_ADD_MEMBER" }, { status: 500 });
    }

    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "member.invited",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "user",
      resourceId: targetUserId!,
      metadata: { email, role: parsed.data.role, existingAccount },
      ...requestAttribution(req),
    });

    return NextResponse.json({
      member: { id: targetUserId, email, role: parsed.data.role },
      pending: !existingAccount,
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

    if (parsed.data.userId === auth.userId) {
      return NextResponse.json({ error: "CANNOT_REMOVE_SELF" }, { status: 400 });
    }

    const adminClient = createServiceRoleClient();
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
