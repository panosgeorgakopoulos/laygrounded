import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { bootstrapUserCompany } from "@/lib/auth-helpers";
import { pendingInvitationsForEmail } from "@/lib/auth/invitations-server";

// Company creation for a user who has none — the "create your workspace" half
// of `/onboarding`.
//
// IT NO LONGER ACCEPTS A MISSING NAME. `bootstrapUserCompany` falls back to
// `${localpart}'s Fleet`, which was reached whenever the old sign-up form's
// field was empty, and is how tenants ended up named after an email address.
// The helper keeps that fallback for the demo seeder, which genuinely has no
// user to ask; a real person is asked, and this route insists on the answer.
//
// AND IT REFUSES WHEN AN INVITATION IS OUTSTANDING. That is the guard against
// the orphaned-company bug reappearing by another route: a user who has been
// invited and clicks "create workspace" anyway would consume their one allowed
// membership on a company of their own and could then never accept. The
// onboarding UI puts the invitation first, but a stale tab, a double submit, or
// a direct API call all reach here, and the UI is not the enforcement.
export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !user.email) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as { companyName?: unknown };
    const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";

    if (!companyName) {
      return NextResponse.json({ error: "COMPANY_NAME_REQUIRED" }, { status: 400 });
    }
    if (companyName.length > 120) {
      return NextResponse.json({ error: "VALIDATION_ERROR" }, { status: 400 });
    }

    // Idempotent by design: a user who already has a company gets it back
    // rather than a second one, so a double-submit is harmless. Checked before
    // the invitation guard so somebody who already finished is never told they
    // have an invitation blocking them.
    const { data: existing } = await supabase
      .from("company_members")
      .select("company_id")
      .eq("user_id", user.id)
      .maybeSingle();

    if (!existing) {
      const pending = await pendingInvitationsForEmail(createServiceRoleClient(), user.email);
      if (pending.length > 0) {
        return NextResponse.json(
          {
            error: "INVITATION_OUTSTANDING",
            invitations: pending.map((p) => ({ companyName: p.companyName, role: p.role })),
          },
          { status: 409 }
        );
      }
    }

    const result = await bootstrapUserCompany(user.id, user.email, companyName);
    return NextResponse.json({
      companyId: result.companyId,
      companyName: result.companyName,
    });
  } catch (e) {
    console.error("[api/bootstrap]", e);
    return NextResponse.json({ error: "BOOTSTRAP_FAILED" }, { status: 500 });
  }
}
