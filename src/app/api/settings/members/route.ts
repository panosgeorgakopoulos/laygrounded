import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { requireAuth } from "@/lib/server-auth";
import { apiError } from "@/lib/api-errors";
import { recordSecurityEvent, requestAttribution } from "@/lib/audit/security-log";

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

const RemoveSchema = z.object({
  userId: z.string().uuid(),
});

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const body = await req.json();
    const parsed = InviteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { data: membership } = await supabase
      .from("company_members")
      .select("role")
      .eq("company_id", auth.companyId)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (!membership || membership.role !== "admin") {
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    const email = parsed.data.email.toLowerCase().trim();
    const adminClient = createServiceRoleClient();

    // Look for existing user
    const { data: userId } = await adminClient.rpc("get_user_id_by_email", { email_addr: email });

    if (userId) {
      const { data: existing } = await supabase
        .from("company_members")
        .select("*")
        .eq("company_id", auth.companyId)
        .eq("user_id", userId)
        .maybeSingle();

      if (existing) {
        return NextResponse.json({ error: "ALREADY_MEMBER" }, { status: 409 });
      }

      // This app only supports a single company per user (requireAuth() assumes
      // exactly one company_members row). Adding a user who already belongs to
      // a different company would give that user a second row and break their
      // own requireAuth() lookup on every future request, locking them out.
      const { data: otherMemberships } = await adminClient
        .from("company_members")
        .select("company_id")
        .eq("user_id", userId);

      if (otherMemberships && otherMemberships.length > 0) {
        return NextResponse.json({ error: "USER_ALREADY_IN_ANOTHER_COMPANY" }, { status: 409 });
      }

      await supabase.from("company_members").insert({
        company_id: auth.companyId,
        user_id: userId,
        role: parsed.data.role,
      });

      await recordSecurityEvent({
        companyId: auth.companyId,
        action: "member.invited",
        actorId: auth.userId,
        actorLabel: auth.email,
        resourceType: "user",
        resourceId: userId,
        metadata: { email, role: parsed.data.role, existingAccount: true },
        ...requestAttribution(req),
      });

      return NextResponse.json({
        member: { id: userId, email, role: parsed.data.role }
      });
    }

    // User does not exist, invite them
    const { data: invitedUser, error: inviteErr } = await adminClient.auth.admin.inviteUserByEmail(email);
    
    if (inviteErr || !invitedUser?.user) {
      console.error("[settings/members/POST] invite failed:", inviteErr);
      return NextResponse.json({ error: "FAILED_TO_INVITE" }, { status: 500 });
    }

    await supabase.from("company_members").insert({
      company_id: auth.companyId,
      user_id: invitedUser.user.id,
      role: parsed.data.role,
    });

    await recordSecurityEvent({
      companyId: auth.companyId,
      action: "member.invited",
      actorId: auth.userId,
      actorLabel: auth.email,
      resourceType: "user",
      resourceId: invitedUser.user.id,
      metadata: { email, role: parsed.data.role, existingAccount: false },
      ...requestAttribution(req),
    });

    return NextResponse.json({
      member: { id: invitedUser.user.id, email, role: parsed.data.role },
      pending: true
    });
  } catch (e) {
    return apiError(e, "settings/members/POST");
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requireAuth();
    const supabase = await createClient();

    const body = await req.json();
    const parsed = RemoveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    // Prevent user from removing themselves
    if (parsed.data.userId === auth.userId) {
      return NextResponse.json({ error: "CANNOT_REMOVE_SELF" }, { status: 400 });
    }

    // Verify requester is admin
    const { data: membership } = await supabase
      .from("company_members")
      .select("role")
      .eq("company_id", auth.companyId)
      .eq("user_id", auth.userId)
      .maybeSingle();

    if (!membership || membership.role !== "admin") {
      // A non-admin reaching for a colleague's membership is worth its own
      // line: denied attempts are the half of an audit trail that is usually
      // missing, and the half that shows intent.
      await recordSecurityEvent({
        companyId: auth.companyId,
        action: "member.removed",
        actorId: auth.userId,
        actorLabel: auth.email,
        resourceType: "user",
        resourceId: parsed.data.userId,
        outcome: "denied",
        metadata: { reason: "actor is not an admin" },
        ...requestAttribution(req),
      });
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    }

    // Remove target user from company
    const { error: deleteErr } = await supabase
      .from("company_members")
      .delete()
      .eq("company_id", auth.companyId)
      .eq("user_id", parsed.data.userId);

    if (deleteErr) {
      return NextResponse.json({ error: "FAILED_TO_REMOVE" }, { status: 500 });
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
